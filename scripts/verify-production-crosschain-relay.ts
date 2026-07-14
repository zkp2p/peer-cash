/**
 * Production cross-chain Relay verification.
 *
 * Funds the test wallet on Arbitrum from Base, then proves the SDK's signed
 * Arbitrum-USDC -> Base-USDC -> Peer Cash maker route and returns the deposit.
 * Buyer payment/proof is intentionally out of scope.
 *
 * Run: bun scripts/verify-production-crosschain-relay.ts
 * Needs TEST_WALLET_PRIVATE_KEY, Base ETH, and >= 1.5 USDC on Base.
 */
import { createClient as createRelayClient, MAINNET_RELAY_API } from '@relayprotocol/relay-sdk';
import type { ProgressData } from '@relayprotocol/relay-sdk';
import { fetchChainConfigs } from '@relayprotocol/relay-sdk/chain-utils';
import { createPublicClient, createWalletClient, erc20Abi, http, nonceManager } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, base } from 'viem/chains';
import { BASE_USDC_ADDRESS, createCashClient, formatUsdc, isCashError, usdc } from '../src';
import { readRelayStatus } from '../src/client/relay';
import type { CashOrder } from '../src';

const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';
const ARBITRUM_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const FUNDING_ARBITRUM_GAS_USDC = usdc('0.5');
const FUNDING_USDC = usdc(1);
const RECEIVE = {
  platform: 'zelle',
  currency: 'USD',
  payee: { offchainId: 'richard2015@gmail.com' },
} as const;

function fail(message: string): never {
  throw new Error(message);
}

function ok(message: string): void {
  console.log(`  ok: ${message}`);
}

function errorDetails(error: unknown): string {
  if (isCashError(error)) return JSON.stringify(error.toJSON(), null, 2);
  return error instanceof Error ? error.message : String(error);
}

function relayEvidence(steps: ProgressData['steps']): {
  requestId?: string;
  txHashes: string[];
} {
  const requestId = steps
    .map((step) => step.requestId)
    .find((id): id is string => id !== undefined);
  const txHashes = steps.flatMap((step) =>
    step.items.flatMap((item) => (item.txHashes ?? []).map((transaction) => transaction.txHash)),
  );
  return { ...(requestId ? { requestId } : {}), txHashes };
}

const privateKey = process.env.TEST_WALLET_PRIVATE_KEY;
if (!privateKey) fail('TEST_WALLET_PRIVATE_KEY is missing');
const alchemyKey = process.env.ALCHEMY_API_KEY;
const baseRpc = alchemyKey
  ? `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`
  : 'https://mainnet.base.org';
const arbitrumRpc = process.env.ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';

const account = privateKeyToAccount(privateKey as `0x${string}`, { nonceManager });
const baseSigner = createWalletClient({ account, chain: base, transport: http(baseRpc) });
const arbitrumSigner = createWalletClient({
  account,
  chain: arbitrum,
  transport: http(arbitrumRpc),
});
const arbitrumPublic = createPublicClient({ chain: arbitrum, transport: http(arbitrumRpc) });
const cash = createCashClient({ environment: 'production', rpcUrl: baseRpc });
let openDepositId: string | undefined;
const relayClient = createRelayClient({
  baseApiUrl: MAINNET_RELAY_API,
  source: 'peer-cash-production-verification',
});
relayClient.chains = await fetchChainConfigs(
  relayClient.baseApiUrl,
  relayClient.source,
  relayClient.apiKey,
);

async function arbitrumUsdcBalance(): Promise<bigint> {
  return arbitrumPublic.readContract({
    address: ARBITRUM_USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  });
}

async function waitFor(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 300_000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - startedAt > timeoutMs) fail(`${label} timed out after ${timeoutMs / 1000}s`);
    console.log(`  … ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function waitForRelaySuccess(requestId: string, label: string): Promise<void> {
  await waitFor(label, async () => {
    const status = await readRelayStatus(requestId, { client: relayClient });
    if (status.status === 'failure' || status.status === 'refund') {
      fail(`${label} ended ${status.status}${status.details ? `: ${status.details}` : ''}`);
    }
    return status.status === 'success';
  });
}

async function waitForOrder(
  depositId: string,
  predicate: (order: CashOrder) => boolean,
): Promise<CashOrder> {
  const startedAt = Date.now();
  for (;;) {
    try {
      const order = await cash.order(depositId);
      if (predicate(order)) return order;
      console.log(`  … cash order is ${order.state}`);
    } catch (error) {
      if (!(isCashError(error) && error.code === 'ORDER_NOT_FOUND')) throw error;
      console.log('  … waiting for the Cash indexer');
    }
    if (Date.now() - startedAt > 120_000) fail('cash order indexing timed out');
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
}

async function cleanupOpenDeposit(): Promise<void> {
  if (!openDepositId) return;
  try {
    const order = await waitForOrder(openDepositId, () => true);
    if (!order.nextActions.includes('withdraw')) {
      console.error(`  cleanup blocked for ${openDepositId}: order is ${order.state}`);
      return;
    }
    const withdrawal = await cash.withdraw(openDepositId, { signer: baseSigner });
    console.error(
      `  cleanup withdrew ${openDepositId}: https://basescan.org/tx/${withdrawal.withdrawTxHash}`,
    );
    openDepositId = undefined;
  } catch (error) {
    console.error(`  cleanup failed for ${openDepositId}: ${errorDetails(error)}`);
  }
}

async function bridgeFromBase(
  currency: string,
  destinationCurrency: string,
  amount: bigint,
  label: string,
): Promise<void> {
  const quote = await relayClient.actions.getQuote(
    {
      chainId: base.id,
      currency,
      toChainId: arbitrum.id,
      toCurrency: destinationCurrency,
      user: account.address,
      recipient: account.address,
      amount: amount.toString(),
      tradeType: 'EXACT_INPUT',
    },
    false,
  );
  let evidence = relayEvidence(quote.steps);
  let data;
  try {
    ({ data } = await relayClient.actions.execute({
      quote,
      wallet: baseSigner,
      onProgress: (progress) => {
        evidence = relayEvidence(progress.steps);
      },
    }));
  } catch (error) {
    const summary = [
      evidence.requestId ? `request ${evidence.requestId}` : undefined,
      ...evidence.txHashes,
    ]
      .filter((value): value is string => value !== undefined)
      .join(', ');
    throw new Error(
      `${label} Relay execution failed (${summary || 'no transaction evidence'}): ${errorDetails(error)}`,
      { cause: error },
    );
  }
  const { requestId, txHashes } = relayEvidence(data.steps);
  if (!requestId || txHashes.length === 0) fail(`${label} returned no Relay evidence`);
  console.log(
    `  ${label}: ${txHashes.map((hash) => `https://basescan.org/tx/${hash}`).join(', ')}`,
  );
  await waitForRelaySuccess(requestId, `${label} completion`);
}

async function main(): Promise<void> {
  console.log(`wallet: ${account.address}`);
  console.log('environment: production | route: Base -> Arbitrum -> Base');

  console.log('\n[1/5] fund Arbitrum gas from Base');
  const ethBefore = await arbitrumPublic.getBalance({ address: account.address });
  await bridgeFromBase(
    BASE_USDC_ADDRESS,
    NATIVE_TOKEN,
    FUNDING_ARBITRUM_GAS_USDC,
    'Base USDC -> Arbitrum ETH',
  );
  await waitFor(
    'Arbitrum ETH arrival',
    async () => (await arbitrumPublic.getBalance({ address: account.address })) > ethBefore,
  );
  ok('Arbitrum source signer has native gas');

  console.log('\n[2/5] fund Arbitrum USDC from Base');
  const usdcBefore = await arbitrumUsdcBalance();
  await bridgeFromBase(
    BASE_USDC_ADDRESS,
    ARBITRUM_USDC,
    FUNDING_USDC,
    'Base USDC -> Arbitrum USDC',
  );
  await waitFor('Arbitrum USDC arrival', async () => (await arbitrumUsdcBalance()) > usdcBefore);
  const sourceAmount = (await arbitrumUsdcBalance()) - usdcBefore;
  if (sourceAmount < usdc('0.01'))
    fail(`Arbitrum USDC funding is too small (${formatUsdc(sourceAmount)})`);
  ok(`Arbitrum received ${formatUsdc(sourceAmount)} USDC`);

  console.log('\n[3/5] live cross-chain quote');
  const quote = await cash.quoteSource({
    user: account.address,
    recipient: account.address,
    amount: sourceAmount,
    source: { chainId: arbitrum.id, currency: ARBITRUM_USDC },
  });
  if (
    quote.destination.address.toLowerCase() !== BASE_USDC_ADDRESS ||
    quote.outputAmount < usdc('0.01')
  ) {
    fail('cross-chain quote did not return usable canonical Base USDC');
  }
  ok(`Arbitrum USDC -> Base USDC quote minimum: ${formatUsdc(quote.outputAmount)} USDC`);

  console.log('\n[4/5] Arbitrum USDC -> Base USDC -> Peer Cash cashout');
  const routed = await cash.cashout(
    {
      amount: sourceAmount,
      source: { chainId: arbitrum.id, currency: ARBITRUM_USDC },
      receive: RECEIVE,
    },
    { signer: baseSigner, sourceSigner: arbitrumSigner },
  );
  openDepositId = routed.depositId;
  if (!routed.source || routed.source.txHashes.length === 0)
    fail('cross-chain cashout returned no Relay evidence');
  console.log(`  source: ${routed.source.txHashes.join(', ')}`);
  console.log(`  deposit: https://basescan.org/tx/${routed.txHash}`);
  const order = await waitForOrder(
    routed.depositId,
    (candidate) =>
      candidate.state === 'awaiting-buyer' && candidate.totalAmount === routed.source!.amount,
  );
  if (!order.nextActions.includes('withdraw')) fail('cross-chain order omitted withdraw');
  if (routed.source.requestId)
    await waitForRelaySuccess(routed.source.requestId, 'Arbitrum -> Base route completion');
  ok(`cross-chain route produced ${formatUsdc(order.totalAmount)} USDC in an indexed maker order`);

  console.log('\n[5/5] unwind the cross-chain maker order');
  const withdrawal = await cash.withdraw(routed.depositId, { signer: baseSigner });
  openDepositId = undefined;
  console.log(`  return: https://basescan.org/tx/${withdrawal.withdrawTxHash}`);
  const terminal = await waitForOrder(
    routed.depositId,
    (candidate) => candidate.state === 'returned',
  );
  ok(`order is ${terminal.state}; no cross-chain test liquidity remains in Peer Cash`);

  console.log('\nPRODUCTION CROSS-CHAIN RELAY VERIFICATION PASSED');
}

try {
  await main();
} catch (error) {
  console.error(`\nFAIL: ${errorDetails(error)}`);
  await cleanupOpenDeposit();
  process.exitCode = 1;
}
