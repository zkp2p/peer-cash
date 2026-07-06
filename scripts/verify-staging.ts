/**
 * Staging regression — maker-side only, zero buyer dependency.
 *
 * Proves the full maker lifecycle against the live staging deployment:
 *   1. capabilities() + estimate() sanity
 *   2. prepare() returns well-formed unsigned txs (read-only path)
 *   3. cashout() a small real deposit → depositId from the receipt
 *   4. order(depositId) + orders(owner) show it awaiting-buyer (indexer proven)
 *   5. withdraw() immediately → order shows returned; balance restored minus gas
 *
 * Never waits on a buyer — buyer-side is known-working and out of scope.
 *
 * Run: bun --env-file=../.env scripts/verify-staging.ts
 * Needs TEST_WALLET_PRIVATE_KEY (funded: ≥1.1 USDC + Base ETH gas); optional ALCHEMY_API_KEY.
 */
import { createWalletClient, createPublicClient, erc20Abi, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { createCashClient, usdc, formatUsdc, isCashError, BASE_USDC_ADDRESS } from '../src';
import type { CashOrder } from '../src';

const AMOUNT = usdc(1);
// The curator validates payee handles against the live platform, so this must
// be a real account — the workspace's standing test payee (see test-wallet-ops).
const RECEIVE = {
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

const pk = process.env.TEST_WALLET_PRIVATE_KEY;
if (!pk) fail('TEST_WALLET_PRIVATE_KEY missing (run with --env-file=../.env)');

const alchemyKey = process.env.ALCHEMY_API_KEY;
const rpcUrl = alchemyKey
  ? `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`
  : 'https://mainnet.base.org';

const account = privateKeyToAccount(pk as `0x${string}`);
const signer = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

const cash = createCashClient({ environment: 'staging', rpcUrl });

async function usdcBalance(): Promise<bigint> {
  return publicClient.readContract({
    address: BASE_USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  });
}

async function pollOrder(
  depositId: string,
  predicate: (order: CashOrder) => boolean,
  label: string,
  timeoutMs = 120_000,
): Promise<CashOrder> {
  const startedAt = Date.now();
  for (;;) {
    try {
      const order = await cash.order(depositId);
      if (predicate(order)) return order;
      console.log(`  … ${label}: state=${order.state} (waiting)`);
    } catch (err) {
      if (isCashError(err) && err.code === 'ORDER_NOT_FOUND') {
        console.log(`  … ${label}: not indexed yet (indexer lag)`);
      } else {
        throw err;
      }
    }
    if (Date.now() - startedAt > timeoutMs) fail(`${label} timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
}

console.log(`wallet: ${account.address}`);
console.log(`environment: staging | amount: ${formatUsdc(AMOUNT)} USDC\n`);

// --- 1. capabilities + estimate ---
console.log('[1/5] capabilities + estimate');
const caps = cash.capabilities();
if (!caps.platforms.some((p) => p.platform === 'venmo' && p.currencies.includes('USD'))) {
  fail('capabilities() is missing the venmo/USD corridor');
}
ok(`capabilities: ${caps.platforms.length} platforms, ${caps.currencies.length} currencies`);

const est = await cash.estimate({ amount: AMOUNT, currency: 'USD' });
if (est.kind !== 'oracle-estimate' || est.rate !== 1)
  fail(`unexpected USD estimate: ${JSON.stringify(est)}`);
ok(`estimate: ${formatUsdc(AMOUNT)} USDC ≈ ${est.receiveAmount} USD`);

// --- 2. prepare (unsigned path, no submission) ---
console.log('[2/5] prepare() unsigned path');
const preparedResult = await cash.prepare({
  amount: AMOUNT,
  receive: RECEIVE,
});
if (preparedResult.txs.length !== 2)
  fail(`prepare() returned ${preparedResult.txs.length} txs, expected 2`);
if (!preparedResult.txs[0]!.data.startsWith('0x095ea7b3'))
  fail('first prepared tx is not an ERC20 approve');
if (preparedResult.register.hashedOnchainIds.length !== 1) fail('prepare() returned no payee hash');
ok(
  `prepare: [approve → ${preparedResult.txs[0]!.to.slice(0, 10)}…, createDeposit → ${preparedResult.txs[1]!.to.slice(0, 10)}…]`,
);

// --- 3. cashout ---
console.log('[3/5] cashout()');
const balanceBefore = await usdcBalance();
console.log(`  balance before: ${formatUsdc(balanceBefore)} USDC`);

const result = await cash.cashout({ amount: AMOUNT, receive: RECEIVE }, { signer });
console.log(`  depositId: ${result.depositId}`);
console.log(`  tx: https://basescan.org/tx/${result.txHash}`);
if (result.order.state !== 'awaiting-buyer')
  fail(`optimistic order state is ${result.order.state}`);
ok('deposit created and composite id resolved from DepositReceived');

// --- 4. indexer round-trip ---
console.log('[4/5] order() + orders() show awaiting-buyer');
const live = await pollOrder(result.depositId, (o) => o.state === 'awaiting-buyer', 'order()');
if (live.totalAmount !== AMOUNT) fail(`indexed totalAmount ${live.totalAmount} != ${AMOUNT}`);
if (!live.nextActions.includes('withdraw'))
  fail(`nextActions ${JSON.stringify(live.nextActions)} missing withdraw`);
ok(
  `order(): state=${live.state}, total=${formatUsdc(live.totalAmount)} USDC, nextActions=${live.nextActions.join(',')}`,
);
ok(`explain(): "${live.explain()}"`);

const mine = await cash.orders(account.address, { inFlight: true });
if (!mine.some((o) => o.depositId === result.depositId)) {
  fail('orders(owner, { inFlight: true }) does not contain the new deposit');
}
ok(`orders(): ${mine.length} in-flight order(s), new deposit present`);

// --- 5. withdraw + returned ---
console.log('[5/5] withdraw() → returned');
const withdrawn = await cash.withdraw(result.depositId, { signer });
console.log(`  tx: https://basescan.org/tx/${withdrawn.withdrawTxHash}`);
if (withdrawn.pruneTxHash)
  console.log(`  prune tx: https://basescan.org/tx/${withdrawn.pruneTxHash}`);

const terminal = await pollOrder(result.depositId, (o) => o.state === 'returned', 'returned');
ok(`order(): state=${terminal.state}, returned=${formatUsdc(terminal.returnedAmount)} USDC`);
ok(`explain(): "${terminal.explain()}"`);

const balanceAfter = await usdcBalance();
console.log(`  balance after: ${formatUsdc(balanceAfter)} USDC`);
if (balanceAfter !== balanceBefore) {
  fail(`USDC balance not restored: before=${balanceBefore} after=${balanceAfter}`);
}
ok('USDC balance fully restored (gas paid in ETH)');

console.log('\nSTAGING VERIFICATION PASSED — full maker lifecycle proven, no buyer involved.');
