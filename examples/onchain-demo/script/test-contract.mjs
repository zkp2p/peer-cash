// Verify PeerCashPage end-to-end in a local EVM before the immutable deploy:
// install page chunks as code, deploy the wrapper, and assert html() /
// request() / resolveMode() / chunks() return byte-exact ABI encodings with
// view gas under public eth_call caps.
import { createVM } from '@ethereumjs/vm';
import * as util from '@ethereumjs/util';
import {
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  encodeDeployData,
  bytesToHex,
} from 'viem';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, MAX_CHUNK, chunkCountFor } from './lib.mjs';

const addr = (s) => (util.createAddressFromString ?? util.Address.fromString)(s);
const hexToBytes = (hex) => Uint8Array.from(Buffer.from(hex.slice(2), 'hex'));

const artifact = JSON.parse(readFileSync(join(root, 'out/PeerCashPage.json'), 'utf8'));
const page = readFileSync(join(root, 'out/PeerCash.html'), 'utf8')
  .replaceAll('__PAGE_ADDRESS__', `0x${'f'.repeat(40)}`);
const pageBytes = Buffer.from(page, 'utf8');
const chunkCount = chunkCountFor(pageBytes.length);

const vm = await createVM();
const putCode = (a, code) =>
  (vm.stateManager.putCode ?? vm.stateManager.putContractCode).call(vm.stateManager, a, code);

const chunkAddresses = [];
for (let i = 0; i < chunkCount; i++) {
  const address = `0x${(0x1000 + i).toString(16).padStart(40, '0')}`;
  await putCode(addr(address), pageBytes.subarray(i * MAX_CHUNK, (i + 1) * MAX_CHUNK));
  chunkAddresses.push(address);
}

const caller = addr(`0x${'c'.repeat(40)}`);
const call = async (data, to) => {
  const result = await vm.evm.runCall({
    caller,
    to,
    data: hexToBytes(data),
    gasLimit: 200_000_000n,
  });
  return result;
};

// constructor rejects an empty chunk list
const emptyDeploy = await call(
  encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [[]] }),
);
if (!emptyDeploy.execResult.exceptionError) throw new Error('empty chunk list should revert');

// deploy the wrapper over the chunks
const deploy = await call(
  encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [chunkAddresses] }),
);
if (deploy.execResult.exceptionError) {
  throw new Error(`deploy reverted: ${deploy.execResult.exceptionError.error}`);
}
const wrapper = deploy.createdAddress;
console.log(`✓ wrapper deployed over ${chunkCount} chunks (${pageBytes.length} bytes)`);

const view = async (functionName, args = []) => {
  const result = await call(encodeFunctionData({ abi: artifact.abi, functionName, args }), wrapper);
  if (result.execResult.exceptionError) {
    throw new Error(`${functionName} reverted: ${result.execResult.exceptionError.error}`);
  }
  return {
    gas: result.execResult.executionGasUsed,
    raw: bytesToHex(result.execResult.returnValue),
  };
};

// html(): byte-exact string, canonically encoded
const htmlResult = await view('html');
const served = decodeFunctionResult({ abi: artifact.abi, functionName: 'html', data: htmlResult.raw });
if (served !== page) throw new Error('html() != page bytes');
const canonicalHtml = encodeFunctionResult({ abi: artifact.abi, functionName: 'html', result: served });
if (htmlResult.raw !== canonicalHtml) throw new Error('html() encoding is not canonical ABI');
console.log(`✓ html()    byte-exact · ${(htmlResult.gas / 1_000_000n)}M gas`);

// request(): 200, byte-exact body, exact headers, canonical tuple encoding
const requestResult = await view('request', [[], []]);
const [status, body, headers] = decodeFunctionResult({
  abi: artifact.abi,
  functionName: 'request',
  data: requestResult.raw,
});
if (status !== 200) throw new Error(`status ${status}`);
if (body !== page) throw new Error('request() body != page bytes');
const expectedHeaders = [
  { key: 'Content-Type', value: 'text/html' },
  { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
];
if (JSON.stringify(headers) !== JSON.stringify(expectedHeaders)) {
  throw new Error(`headers mismatch: ${JSON.stringify(headers)}`);
}
const canonicalRequest = encodeFunctionResult({
  abi: artifact.abi,
  functionName: 'request',
  result: [status, body, headers],
});
if (requestResult.raw !== canonicalRequest) throw new Error('request() encoding is not canonical ABI');
console.log(`✓ request() 200 + headers byte-exact · ${(requestResult.gas / 1_000_000n)}M gas`);

// resolveMode() and chunks()
const mode = decodeFunctionResult({
  abi: artifact.abi,
  functionName: 'resolveMode',
  data: (await view('resolveMode')).raw,
});
if (!mode.startsWith('0x35323139')) throw new Error(`resolveMode ${mode}`);
const list = decodeFunctionResult({
  abi: artifact.abi,
  functionName: 'chunks',
  data: (await view('chunks')).raw,
});
if (list.length !== chunkCount) throw new Error('chunks() length mismatch');
console.log('✓ resolveMode "5219" · chunks() intact');

const CALL_CAP = 50_000_000n;
if (htmlResult.gas > CALL_CAP || requestResult.gas > CALL_CAP) {
  throw new Error('view gas exceeds common eth_call caps');
}
console.log('CONTRACT TEST OK');
