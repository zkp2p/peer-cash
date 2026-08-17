/**
 * Flush a PeerCashRevenueHook's Base USDC claims to its beneficiary, then
 * create a normal Peer Cash order from that beneficiary wallet.
 *
 * The hook never performs this step during a swap. This operator process owns
 * signing, transaction confirmation, and Peer Cash recovery semantics.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  parseUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { createCashClient, isCashError } from '@zkp2p/cash';
import type { CurrencyType } from '@zkp2p/cash';

const BASE_USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const hookAbi = parseAbi([
  'function beneficiary() view returns (address)',
  'function cashAsset() view returns (address)',
  'function revenueAvailable() view returns (uint256)',
  'function flushRevenue() returns (uint256 amount)',
  'event RevenueFlushed(address indexed caller, address indexed beneficiary, uint256 amount)',
]);

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const account = privateKeyToAccount(requiredEnvironmentVariable('PRIVATE_KEY') as `0x${string}`);
  const hookAddress = getAddress(requiredEnvironmentVariable('HOOK_ADDRESS'));
  const minimumCashout = parseUnits(process.env.MIN_CASHOUT_USDC ?? '1', 6);

  const publicClient = createPublicClient({ chain: base, transport: http() });
  const signer = createWalletClient({ account, chain: base, transport: http() });
  const cash = createCashClient({ environment: 'production' });
  const receive = {
    platform: process.env.CASH_PLATFORM ?? 'revolut',
    currency: (process.env.CASH_CURRENCY ?? 'USD') as CurrencyType,
    payee: { offchainId: requiredEnvironmentVariable('CASH_PAYEE') },
  };

  const platform = cash
    .capabilities()
    .platforms.find((candidate) => candidate.platform === receive.platform);
  if (!platform) {
    throw new Error(`Unsupported cash-out platform: ${receive.platform}`);
  }
  if (!platform.currencies.includes(receive.currency)) {
    throw new Error(`${receive.platform} does not support cash-out currency ${receive.currency}`);
  }

  const [beneficiary, cashAsset, revenueAvailable] = await Promise.all([
    publicClient.readContract({ address: hookAddress, abi: hookAbi, functionName: 'beneficiary' }),
    publicClient.readContract({ address: hookAddress, abi: hookAbi, functionName: 'cashAsset' }),
    publicClient.readContract({
      address: hookAddress,
      abi: hookAbi,
      functionName: 'revenueAvailable',
    }),
  ]);

  if (getAddress(beneficiary) !== account.address) {
    throw new Error(`Connected wallet is not the immutable beneficiary (${beneficiary})`);
  }
  if (getAddress(cashAsset) !== BASE_USDC) {
    throw new Error(`Hook cash asset is not canonical Base USDC (${cashAsset})`);
  }
  if (revenueAvailable < minimumCashout) {
    console.log(
      `Revenue remains in PoolManager claims: ${revenueAvailable} base units is below the ${minimumCashout} threshold.`,
    );
    return;
  }

  const flushRequest = await signer.prepareTransactionRequest({
    account,
    to: hookAddress,
    data: encodeFunctionData({ abi: hookAbi, functionName: 'flushRevenue' }),
  });
  const serializedFlush = await signer.signTransaction(flushRequest);
  const flushHash = keccak256(serializedFlush);
  console.log(`Prepared revenue flush ${flushHash}; inspect this hash before any retry.`);

  try {
    await publicClient.sendRawTransaction({ serializedTransaction: serializedFlush });
  } catch (error) {
    throw new Error(
      `Revenue flush submission status is unknown. Inspect ${flushHash} before retrying.`,
      { cause: error },
    );
  }

  const flushReceipt = await publicClient.waitForTransactionReceipt({ hash: flushHash });
  if (flushReceipt.status !== 'success') {
    throw new Error(`Revenue flush reverted: ${flushHash}`);
  }

  const [flushed] = parseEventLogs({
    abi: hookAbi,
    eventName: 'RevenueFlushed',
    logs: flushReceipt.logs,
    strict: true,
  });
  if (!flushed) throw new Error(`RevenueFlushed event missing from ${flushHash}`);

  const amount = flushed.args.amount;
  console.log(`Flushed ${amount} Base USDC base units in ${flushHash}.`);

  try {
    const result = await cash.cashout({ amount, receive }, { signer });
    console.log(`Peer Cash deposit ${result.depositId} created in ${result.txHash}.`);
    if (result.accessPolicyTxHash) {
      console.log(`Access policy attached in ${result.accessPolicyTxHash}.`);
    }
  } catch (error) {
    // The flush is already confirmed, but a cash-out error does not prove where
    // the USDC is. Follow CashError recovery before retrying any transaction.
    if (isCashError(error)) {
      console.error(JSON.stringify(error.toJSON()));
    }
    throw error;
  }
}

await main();
