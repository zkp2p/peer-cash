/**
 * Production maker and Relay verification.
 *
 * Exercises the published SDK's real production dependencies with the
 * workspace test wallet, then cleans up every created deposit:
 *
 *   1. discovery, estimate, and unsigned prepare
 *   2. Base-USDC cashout -> indexer/order listing -> top-up -> partial/full unwind
 *   3. a live same-chain Relay ETH -> Base-USDC cashout -> indexer -> unwind
 *
 * This intentionally excludes the buyer payment/proof flow. It spends a small
 * amount of Base ETH on the Relay route plus gas. Never rerun blindly after a
 * source-route error: inspect the recovery evidence first.
 *
 * Run: bun scripts/verify-production-maker.ts
 * Needs TEST_WALLET_PRIVATE_KEY (>= 0.35 USDC and enough Base ETH for gas +
 * the 0.0001 ETH Relay input); optional ALCHEMY_API_KEY.
 */
import { createPublicClient, createWalletClient, erc20Abi, http, nonceManager } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import {
  BASE_USDC_ADDRESS,
  createCashClient,
  formatUsdc,
  isCashError,
  usdc,
  type CashOrder,
} from '../src';

const DIRECT_AMOUNT = usdc('0.25');
const TOP_UP_AMOUNT = usdc('0.1');
const RELAY_ETH_AMOUNT = 100_000_000_000_000n; // 0.0001 ETH
const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';
const RECEIVE = {
  // Zelle is format-validated rather than identity-attested, so the test does
  // not require a pre-registered Peer-app identity.
  platform: 'zelle',
  currency: 'USD',
  payee: { offchainId: 'richard2015@gmail.com' },
} as const;

function fail(message: string): never {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

function ok(message: string): void {
  console.log(`  ok: ${message}`);
}

const privateKey = process.env.TEST_WALLET_PRIVATE_KEY;
if (!privateKey) fail('TEST_WALLET_PRIVATE_KEY is missing');

const rpcUrl = process.env.ALCHEMY_API_KEY
  ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
  : 'https://mainnet.base.org';
// A local account otherwise defaults to a `latest` nonce read. Use viem's
// pending-nonce manager so sequential maker operations cannot race an RPC
// replica that has not caught up with the preceding receipt.
const account = privateKeyToAccount(privateKey as `0x${string}`, { nonceManager });
const signer = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
const cash = createCashClient({ environment: 'production', rpcUrl });

async function baseUsdcBalance(): Promise<bigint> {
  return publicClient.readContract({
    address: BASE_USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  });
}

async function waitForOrder(
  depositId: string,
  predicate: (order: CashOrder) => boolean,
  label: string,
  timeoutMs = 120_000,
): Promise<CashOrder> {
  const started = Date.now();
  for (;;) {
    try {
      const order = await cash.order(depositId);
      if (predicate(order)) return order;
      console.log(`  … ${label}: ${order.state}`);
    } catch (error) {
      if (!(isCashError(error) && error.code === 'ORDER_NOT_FOUND')) throw error;
      console.log(`  … ${label}: waiting for indexer`);
    }
    if (Date.now() - started > timeoutMs) fail(`${label} timed out after ${timeoutMs / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
}

async function assertListed(depositId: string): Promise<void> {
  const orders = await cash.orders(account.address, { inFlight: true });
  if (!orders.some((order) => order.depositId === depositId)) {
    fail(`orders(owner) omitted ${depositId}`);
  }
  ok(`orders(owner) contains the live deposit (${orders.length} in flight)`);
}

console.log(`wallet: ${account.address}`);
console.log('environment: production');

// 1. Read and prepare paths.
console.log('\n[1/5] production discovery, estimate, and prepare');
const capabilities = cash.capabilities();
if (!capabilities.platforms.some((platform) => platform.platform === RECEIVE.platform)) {
  fail(`${RECEIVE.platform} is absent from production capabilities`);
}
const estimate = await cash.estimate({ amount: DIRECT_AMOUNT, currency: RECEIVE.currency });
if (estimate.kind !== 'oracle-estimate' || estimate.rate !== 1) {
  fail(`unexpected USD estimate (${estimate.kind}, ${estimate.rate})`);
}
const prepared = await cash.prepare({ amount: DIRECT_AMOUNT, receive: RECEIVE });
if (
  prepared.txs.length !== 2 ||
  prepared.steps.map((step) => step.kind).join(',') !== 'approve,createDeposit'
) {
  fail('prepare() did not return the expected approve -> createDeposit plan');
}
ok(
  `${capabilities.platforms.length} payout platforms; estimate is oracle-priced; prepare plan is valid`,
);

// 2. Direct Base-USDC lifecycle, including partial withdrawal.
console.log('\n[2/5] direct Base-USDC maker lifecycle');
const directBalanceBefore = await baseUsdcBalance();
const direct = await cash.cashout({ amount: DIRECT_AMOUNT, receive: RECEIVE }, { signer });
console.log(`  deposit: ${direct.depositId}`);
console.log(`  create: https://basescan.org/tx/${direct.txHash}`);
const directLive = await waitForOrder(
  direct.depositId,
  (order) => order.state === 'awaiting-buyer' && order.totalAmount === DIRECT_AMOUNT,
  'direct deposit indexing',
);
if (!directLive.nextActions.includes('withdraw')) fail('direct order omitted withdraw action');
await assertListed(direct.depositId);
ok(`order is ${directLive.state}; zero-spread USD payout is indexed`);

const toppedUp = await cash.topUp(direct.depositId, TOP_UP_AMOUNT, { signer });
console.log(`  top-up: https://basescan.org/tx/${toppedUp.txHash}`);
await waitForOrder(
  direct.depositId,
  (order) => order.totalAmount === DIRECT_AMOUNT + TOP_UP_AMOUNT,
  'top-up indexing',
);
ok('top-up increased the live order');

const partial = await cash.withdraw(direct.depositId, { signer, amount: TOP_UP_AMOUNT });
console.log(`  partial unwind: https://basescan.org/tx/${partial.withdrawTxHash}`);
await waitForOrder(
  direct.depositId,
  (order) => order.state === 'awaiting-buyer' && order.returnedAmount === TOP_UP_AMOUNT,
  'partial withdrawal indexing',
);
ok('partial withdrawal returned only the unlocked top-up and left the order live');

const directWithdrawal = await cash.withdraw(direct.depositId, { signer });
console.log(`  final unwind: https://basescan.org/tx/${directWithdrawal.withdrawTxHash}`);
await waitForOrder(
  direct.depositId,
  (order) => order.state === 'returned',
  'direct final withdrawal',
);
const directBalanceAfter = await baseUsdcBalance();
if (directBalanceAfter !== directBalanceBefore) {
  fail(
    `direct USDC balance was not restored (${formatUsdc(directBalanceBefore)} -> ${formatUsdc(directBalanceAfter)})`,
  );
}
ok('direct maker lifecycle returned all USDC; only Base gas was spent');

// 3. Relay source discovery and a live quote before execution.
console.log('\n[3/5] Relay source discovery and live quote');
const relayCapabilities = await cash.capabilities({ includeRelaySources: true });
const baseSource = relayCapabilities.source.relay?.chains.find((chain) => chain.id === base.id);
if (!baseSource?.tokens.some((token) => token.address.toLowerCase() === NATIVE_TOKEN)) {
  fail('Relay source capabilities omit Base native ETH');
}
const quote = await cash.quoteSource({
  user: account.address,
  recipient: account.address,
  amount: RELAY_ETH_AMOUNT,
  source: { chainId: base.id, currency: NATIVE_TOKEN },
});
if (
  quote.destination.address.toLowerCase() !== BASE_USDC_ADDRESS ||
  quote.outputAmount < usdc('0.01')
) {
  fail('Relay quote did not produce a usable canonical Base-USDC amount');
}
ok(`Relay returned ${formatUsdc(quote.outputAmount)} USDC minimum output from 0.0001 ETH`);

// 4. The one-call Relay -> maker cashout path. Keep the returned order short-lived.
console.log('\n[4/5] live Relay ETH -> Base USDC -> cashout');
const relayProgress = new Set<string>();
const routed = await cash.cashout(
  {
    amount: RELAY_ETH_AMOUNT,
    source: { chainId: base.id, currency: NATIVE_TOKEN },
    receive: RECEIVE,
  },
  {
    signer,
    sourceSigner: signer,
    onSourceProgress: (progress) => {
      for (const step of progress.steps ?? []) {
        for (const item of step.items ?? []) relayProgress.add(`${step.action}:${item.status}`);
      }
    },
  },
);
if (!routed.source || routed.source.txHashes.length === 0) {
  fail('cashout(source) returned no Relay transaction evidence');
}
console.log(
  `  relay: ${routed.source.txHashes.map((hash) => `https://basescan.org/tx/${hash}`).join(', ')}`,
);
console.log(`  deposit: https://basescan.org/tx/${routed.txHash}`);
const routedLive = await waitForOrder(
  routed.depositId,
  (order) => order.state === 'awaiting-buyer' && order.totalAmount === routed.source!.amount,
  'Relay cashout indexing',
);
await assertListed(routed.depositId);
ok(
  `Relay progress ${[...relayProgress].join(', ') || 'reported by final transaction evidence'}; deposit is ${routedLive.state}`,
);
if (routed.source.requestId) {
  const status = await cash.relayStatus(routed.source.requestId);
  if (status.status !== 'success')
    fail(`Relay request ${routed.source.requestId} is ${status.status}`);
  ok(`Relay request ${routed.source.requestId} is success`);
}

// 5. Do not leave test liquidity open.
console.log('\n[5/5] relay-created order unwind');
const routedWithdrawal = await cash.withdraw(routed.depositId, { signer });
console.log(`  unwind: https://basescan.org/tx/${routedWithdrawal.withdrawTxHash}`);
const terminal = await waitForOrder(
  routed.depositId,
  (order) => order.state === 'returned',
  'Relay withdrawal',
);
ok(`Relay deposit is ${terminal.state}; all protocol-held USDC returned`);

console.log('\nPRODUCTION MAKER + RELAY VERIFICATION PASSED');
