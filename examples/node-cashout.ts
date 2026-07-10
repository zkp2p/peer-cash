/**
 * Example: server-side cash-out with a private-key signer, plus order tracking.
 *
 * Run: PRIVATE_KEY=0x... bun examples/node-cashout.ts
 * (Use environment 'staging' and a throwaway dev wallet with a few USDC.)
 *
 * By default this demo withdraws its own deposit at the end so the test wallet
 * is left untouched. A real integration leaves the deposit open for buyers -
 * set CASH_KEEP_OPEN=1 for that behavior.
 *
 * The curator validates supported handles against the live platform, so the
 * payee must be a real account. A new Wise/PayPal registration also needs the
 * identity attestation created by Peer; an existing registered handle can be
 * reused. Override the demo corridor with:
 *   CASH_PLATFORM=venmo CASH_CURRENCY=USD CASH_PAYEE=@your-venmo
 */
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { createCashClient, usdc, formatUsdc, isCashError } from '@zkp2p/cash';
import type { CurrencyType } from '@zkp2p/cash';

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const signer = createWalletClient({ account, chain: base, transport: http() });

const receive = {
  platform: process.env.CASH_PLATFORM ?? 'venmo',
  currency: (process.env.CASH_CURRENCY ?? 'USD') as CurrencyType,
  payee: { offchainId: process.env.CASH_PAYEE ?? '@your-venmo' },
};

const cash = createCashClient({ environment: 'staging' });

// 0 - What can we do?
const caps = cash.capabilities();
console.log(
  'platforms:',
  caps.platforms.map((p) => `${p.platform}(${p.currencies.join(',')})`).join(' '),
);

// 1 - What would 1 USDC get us, roughly?
const est = await cash.estimate({ amount: usdc(1), currency: receive.currency });
console.log(
  `estimate: ≈ ${est.receiveAmount} ${receive.currency} at rate ${est.rate} (${est.kind})`,
);

// 2 - Cash out.
const result = await cash.cashout({ amount: usdc(1), receive }, { signer });
console.log(`deposit created: ${result.depositId} (tx ${result.txHash})`);
// Persist this in YOUR system: userId → result.depositId

// 3/5 - Track it. A real service would watch until terminal; the demo bails
// out after 30s (an unmatched deposit stays awaiting-buyer until someone bites).
try {
  for await (const order of cash.watch(result.depositId, { timeoutMs: 30_000 })) {
    console.log(`[${order.state}] ${order.explain()}`);
    if (order.nextActions.length === 0) break;
  }
} catch (err) {
  if (isCashError(err) && err.code === 'WATCH_TIMEOUT') {
    console.log('still live - resume any time with order(depositId)');
  } else {
    throw err;
  }
}

// 4 - The wallet's full order history, in-flight first.
const open = await cash.orders(account.address, { inFlight: true });
console.log(`in-flight orders: ${open.length}`);
for (const order of open) {
  console.log(`  ${order.depositId}: ${order.state}, ${formatUsdc(order.totalAmount)} USDC`);
}

// 6 - Unwind. The demo cleans up after itself; a real integration would leave
// the deposit open for buyers instead (CASH_KEEP_OPEN=1).
if (!process.env.CASH_KEEP_OPEN) {
  const withdrawn = await cash.withdraw(result.depositId, { signer });
  console.log(`returned via ${withdrawn.withdrawTxHash}`);
}
