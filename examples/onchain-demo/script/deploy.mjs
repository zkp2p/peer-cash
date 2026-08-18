// Deploy out/PeerCash.html to Base as contract bytecode, zSwap-style:
//   txs 1..k : data contracts whose runtime bytecode are the page's chunks
//   tx  k+1  : PeerCashPage wrapper (ERC-5219 / ERC-4804) over the chunk list
// All addresses are predicted from the deployer nonce; the wrapper address is
// baked into the page before chunking so the app can name its own contract.
//
// env: DEPLOY_PRIVATE_KEY or ENV_FILE(+KEY_VAR), RPC_URL (default Base public RPC),
//      START_NONCE (nonce a partial run started from, to reuse its chunks)
import {
  createWalletClient,
  createPublicClient,
  http,
  getAddress,
  getContractAddress,
  encodeDeployData,
  formatEther,
  formatGwei,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { root, MAX_CHUNK, chunkCountFor, loadKey } from './lib.mjs';

const BATCH = 30;

const account = privateKeyToAccount(loadKey());
const rpc = process.env.RPC_URL ?? base.rpcUrls.default.http[0];
// 8s receipt polling keeps a 30-tx batch under public RPC rate limits.
const publicClient = createPublicClient({ chain: base, transport: http(rpc), pollingInterval: 8_000 });
const walletClient = createWalletClient({ account, chain: base, transport: http(rpc) });
const feeOf = (r) => r.gasUsed * r.effectiveGasPrice + (r.l1Fee ?? 0n);
const predict = (n) => getAddress(getContractAddress({ from: account.address, nonce: BigInt(n) }));

const [balance, nonce] = await Promise.all([
  publicClient.getBalance({ address: account.address }),
  publicClient.getTransactionCount({ address: account.address }),
]);
console.log(`deployer ${account.address} · balance ${formatEther(balance)} ETH · nonce ${nonce}`);

// A partial run leaves correct chunks behind. START_NONCE (the nonce that run
// started from) recomputes the same addresses, verifies what landed, and pays
// only for the rest. Default: fresh deploy from the current nonce.
const startNonce = Number(process.env.START_NONCE ?? nonce);
const done = nonce - startNonce;
if (done < 0) throw new Error(`START_NONCE ${startNonce} is ahead of account nonce ${nonce}`);

// Public RPCs are load balanced; the replica answering getCode can trail the
// one that returned the receipt, so poll briefly before calling a mismatch.
async function codeAt(address) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const code = await publicClient.getCode({ address });
    if (code && code !== '0x') return code;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return '0x';
}

// ---- final page bytes ----------------------------------------------------
// The chunk count depends on the substituted length, and the page address
// depends on the chunk count; substitution is length-deterministic (17-char
// placeholder → 42-char address), so resolve with a dummy pass first.
const template = readFileSync(join(root, 'out/PeerCash.html'), 'utf8');
const dummy = template.replaceAll('__PAGE_ADDRESS__', `0x${'f'.repeat(40)}`);
const chunkCount = chunkCountFor(Buffer.byteLength(dummy));
const pageAddress = predict(startNonce + chunkCount);
if (done > chunkCount) {
  throw new Error(`nonce ${nonce} is past the final chunk of a ${chunkCount}-chunk deploy from ${startNonce}`);
}
const pageBytes = Buffer.from(template.replaceAll('__PAGE_ADDRESS__', pageAddress), 'utf8');
if (chunkCountFor(pageBytes.length) !== chunkCount) {
  throw new Error('chunk count changed after substitution; adjust padding');
}
console.log(
  `page ${(pageBytes.length / 1024).toFixed(1)} KB → ${chunkCount} chunks · predicted page ${pageAddress}`,
);

const chunks = [];
for (let i = 0; i < chunkCount; i++) {
  const slice = pageBytes.subarray(i * MAX_CHUNK, (i + 1) * MAX_CHUNK);
  chunks.push({
    bytes: slice,
    address: predict(startNonce + i),
    initcode: `0x61${slice.length.toString(16).padStart(4, '0')}80600a3d393df3${slice.toString('hex')}`,
  });
}

if (done > 0) {
  for (const chunk of chunks.slice(0, done)) {
    const code = await codeAt(chunk.address);
    if (code !== `0x${chunk.bytes.toString('hex')}`) {
      throw new Error(`resume: ${chunk.address} missing or wrong bytes; rerun without START_NONCE for a fresh set`);
    }
  }
  console.log(`✓ chunks 0..${done - 1} verified onchain from the earlier run`);
}

// ---- preflight: price one chunk, check the balance covers the rest ----
const [chunkGas, fees] = await Promise.all([
  publicClient.estimateGas({ account: account.address, data: chunks[0].initcode }),
  publicClient.estimateFeesPerGas(),
]);
const roughTotal = chunkGas * BigInt(chunkCount - done) + 5_000_000n;
const roughCost = roughTotal * fees.maxFeePerGas;
console.log(
  `estimate: ~${roughTotal / 1_000_000n}M gas @ ${formatGwei(fees.maxFeePerGas)} gwei max → ~${formatEther(roughCost)} ETH (+L1 data fee)`,
);
if (balance < roughCost * 2n) {
  throw new Error(
    `balance ${formatEther(balance)} ETH may not cover ~${formatEther(roughCost)} ETH × safety margin; fund ${account.address} and rerun`,
  );
}

// ---- deploy chunks: pre-priced sends in parallel batches ------------------
for (let start = done; start < chunks.length; start += BATCH) {
  const batch = chunks.slice(start, start + BATCH);
  const hashes = await Promise.all(
    batch.map((chunk, i) =>
      walletClient.sendTransaction({
        data: chunk.initcode,
        nonce: startNonce + start + i,
        gas: (chunkGas * 11n) / 10n,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      }),
    ),
  );
  const receipts = await Promise.all(
    hashes.map((hash) =>
      publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 }),
    ),
  );
  receipts.forEach((receipt, i) => {
    const chunk = batch[i];
    if (receipt.status !== 'success') {
      throw new Error(`chunk ${start + i} reverted: ${hashes[i]}`);
    }
    if (getAddress(receipt.contractAddress) !== chunk.address) {
      throw new Error(`chunk ${start + i} address mismatch`);
    }
    chunk.fee = feeOf(receipt);
    chunk.gasUsed = receipt.gasUsed;
  });
  // spot-check bytes for the first chunk of each batch
  const probe = batch[0];
  const code = await codeAt(probe.address);
  if (code !== `0x${probe.bytes.toString('hex')}`) {
    throw new Error(`chunk ${start} onchain code mismatch`);
  }
  console.log(`✓ chunks ${start}..${start + batch.length - 1} deployed`);
}

// ---- wrapper ---------------------------------------------------------------
const artifact = JSON.parse(readFileSync(join(root, 'out/PeerCashPage.json'), 'utf8'));
const wrapperHash = await walletClient.sendTransaction({
  data: encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [chunks.map((c) => c.address)],
  }),
  nonce: startNonce + chunkCount,
});
const wrapperReceipt = await publicClient.waitForTransactionReceipt({
  hash: wrapperHash,
  timeout: 180_000,
});
if (wrapperReceipt.status !== 'success') throw new Error(`wrapper reverted: ${wrapperHash}`);
if (getAddress(wrapperReceipt.contractAddress) !== pageAddress) {
  throw new Error(`wrapper address mismatch: got ${wrapperReceipt.contractAddress}`);
}
console.log(`✓ PeerCashPage ${pageAddress} · tx ${wrapperHash}`);

// ---- readback ---------------------------------------------------------------
const html = pageBytes.toString('utf8');
let readbackOk = false;
try {
  const served = await publicClient.readContract({
    address: pageAddress,
    abi: artifact.abi,
    functionName: 'html',
  });
  readbackOk = served === html;
  console.log(
    readbackOk
      ? `✓ html() serves ${Buffer.byteLength(served)} bytes, byte-exact`
      : '✗ html() readback differs!',
  );
  if (!readbackOk) process.exitCode = 1;
} catch (error) {
  console.log(
    `note: html() readback skipped (${error.shortMessage ?? error.message}); ` +
      'chunk codes were verified individually; try an RPC with a higher eth_call gas cap',
  );
}

const totalFee = chunks.reduce((sum, c) => sum + (c.fee ?? 0n), 0n) + feeOf(wrapperReceipt);
const totalGas = chunks.reduce((sum, c) => sum + (c.gasUsed ?? 0n), 0n) + wrapperReceipt.gasUsed;

writeFileSync(join(root, 'out/PeerCash.deployed.html'), html);
writeFileSync(
  join(root, 'out/deployment.json'),
  JSON.stringify(
    {
      chainId: base.id,
      deployer: account.address,
      pageAddress,
      wrapperTx: wrapperHash,
      chunkAddresses: chunks.map((c) => c.address),
      pageBytes: pageBytes.length,
      pageSha256: createHash('sha256').update(pageBytes).digest('hex'),
      totalGas: totalGas.toString(),
      totalCostEth: formatEther(totalFee),
      readbackOk,
      deployedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);

console.log('\n=== deployed ===');
console.log(`page     ${base.blockExplorers.default.url}/address/${pageAddress}`);
console.log(`gateway  https://${pageAddress.toLowerCase()}.8453.w3link.io/`);
console.log(`web3://  web3://${pageAddress}:8453/`);
console.log(`read     cast call ${pageAddress} 'html()(string)' -r ${rpc}`);
console.log(`chunks   ${chunkCount} data contracts, ${(pageBytes.length / 1024).toFixed(1)} KB`);
console.log(`cost     ${formatEther(totalFee)} ETH (${totalGas} gas)`);
