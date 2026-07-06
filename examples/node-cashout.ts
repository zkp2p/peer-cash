/**
 * Example: server-side cash-out with a private-key signer, plus order tracking.
 *
 * Run: PRIVATE_KEY=0x... bun examples/node-cashout.ts
 * (Use environment 'staging' and a throwaway dev wallet with a few USDC.)
 */
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { createCashClient, usdc, formatUsdc, isCashError } from '@zkp2p/cash';

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const signer = createWalletClient({ account, chain: base, transport: http() });

const cash = createCashClient({ environment: 'staging' });

// 0 — What can we do?
const caps = cash.capabilities();
console.log(
  'platforms:',
  caps.platforms.map((p) => `${p.platform}(${p.currencies.join(',')})`).join(' '),
);

// 1 — What would 2 USDC get us, roughly?
const est = await cash.estimate({ amount: usdc(2), currency: 'USD' });
console.log(`estimate: ≈ ${est.receiveAmount} USD at rate ${est.rate} (${est.kind})`);

// 2 — Cash out.
const result = await cash.cashout(
  {
    amount: usdc(2),
    receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@your-venmo' } },
  },
  { signer },
);
console.log(`deposit created: ${result.depositId} (tx ${result.txHash})`);
// Persist this in YOUR system: userId → result.depositId

// 3/5 — Track it until terminal (or bail out after 10 minutes).
try {
  for await (const order of cash.watch(result.depositId, { timeoutMs: 10 * 60_000 })) {
    console.log(`[${order.state}] ${order.explain()}`);
    if (order.nextActions.length === 0) break;
  }
} catch (err) {
  if (isCashError(err) && err.code === 'WATCH_TIMEOUT') {
    console.log('still live — resume later with order(depositId)');
  } else {
    throw err;
  }
}

// 4 — The wallet's full order history, in-flight first.
const open = await cash.orders(account.address, { inFlight: true });
console.log(`in-flight orders: ${open.length}`);
for (const order of open) {
  console.log(`  ${order.depositId}: ${order.state}, ${formatUsdc(order.totalAmount)} USDC`);
}

// 6 — Unwind example (uncomment to withdraw the deposit created above):
// const withdrawn = await cash.withdraw(result.depositId, { signer });
// console.log(`returned via ${withdrawn.withdrawTxHash}`);
