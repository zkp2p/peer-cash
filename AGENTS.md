# @zkp2p/cash agent integration manual

This file is for agents using the package. Contributors should start with
[`CLAUDE.md`](https://github.com/zkp2p/peer-cash/blob/main/CLAUDE.md). Detailed
recipes and error recovery live in `README.md` and
`docs/lifecycle-and-recovery.md`.

Peer Cash is an offramp-only SDK. The cashing-out user is the maker: their
asset reaches canonical Base USDC, becomes a protocol-held zero-spread deposit,
and is released when a buyer proves the fiat payment. The SDK never holds keys.

## Choose the entry point

1. With a viem `WalletClient`, use `cashout()`, `topUp()`, and `withdraw()`.
2. When signing happens elsewhere, use `prepare()`, `prepareTopUp()`, and
   `prepareWithdraw()`. Review the same-index `txs[]` and `steps[]`, submit in
   order, wait for receipts, then call `finalizePreparedCashout()` with the
   confirmed `createDeposit` receipt.
3. Tool hosts import `@zkp2p/cash/tools`. Base-USDC mutations return unsigned
   transactions. Source-route tools quote or observe; the host owns execution.

Persist `depositId` immediately. It is the durable key for `order()`,
`orders()`, `watch()`, `topUp()`, and `withdraw()`.

## Core loop

```ts
import { createCashClient, usdc } from '@zkp2p/cash';

const cash = createCashClient({ environment: 'production' });
const capabilities = cash.capabilities();
const estimate = await cash.estimate({
  amount: usdc(100),
  currency: 'USD',
  platform: 'chime',
});
const result = await cash.cashout(
  {
    amount: usdc(100),
    receive: {
      platform: 'chime',
      currency: 'USD',
      payee: { offchainId: '$handle' },
    },
  },
  { signer },
);
persist(result.depositId);
const order = await cash.order(result.depositId);
```

Discover platforms, currencies, payee hints, bounds, and source assets from
`capabilities()`; do not hardcode them. `estimate()` is an oracle estimate, not
a quote. The binding rate resolves when a buyer fills. Treat `estimate().eta`
and `fillStats()` as historical evidence, never a guarantee.

## Access policy and dispute protection

Venmo and PayPal restrict intent signaling to Peer Pay merchants. That access
rule is separate from stake-backed dispute protection. Both methods currently
have nonzero risk windows and default-on protection. Cash App is
non-chargebackable, stays public, and does not require stake.

Signed `cashout()` confirms the deposit, then submits one method-scoped access
policy per restricted payout method with the same wallet. The follow-up is
sequential and briefly leaves the new deposit open to all takers. Prepared
hosts must complete the same flow:

```ts
const plan = await cash.prepare(input);
// Submit plan.txs in order and confirm createDeposit.
const result = cash.finalizePreparedCashout(createDepositReceipt);
for (const paymentMethod of plan.accessPolicyPaymentMethods) {
  await submitAndConfirm(cash.prepareAccessPolicy(result.depositId, paymentMethod));
}
```

Do not present the order as ready until every required policy confirms. On
`ACCESS_POLICY_CONFIGURATION_FAILED`, the deposit already exists. Inspect any
recovery transaction before retrying the policy, and never repeat the cash-out.
`requiresAtomicAccessPolicy` is deprecated, always `false`, and must not drive
control flow. Cash does not readiness-gate deposit creation or submit an
explicit protection-enable transaction.

## Source routing

- Base USDC is the only destination and the minimal path.
- Relay EVM routes come from live metadata and quotes. Non-Base routes require
  `sourceSigner`; high-level cash-outs use `EXACT_INPUT`. `source.amount` is
  the guaranteed minimum Base USDC output and exact deposit amount.
- Multi-transaction Relay routes require a nonce-managed local signer. Browser
  wallets manage their own nonces.
- NEAR Intents is an external-deposit boundary. Persist the quote, address,
  memo, deadline, and origin hash before sending once. Browser JWTs stay behind
  a same-origin proxy. Poll to `SUCCESS`, reconcile Base evidence, then cash out
  Base USDC.
- `prepare()` is Base-USDC-only. Never pass `source` to it.

Never repeat an uncertain source transfer. Preserve Relay request IDs and
chain-aware transaction evidence. A completed route followed by a failed cash-
out retries Base-only with the recovered amount. A failed NEAR notification
retries only the notification with the same deposit address and origin hash.

## Payees, state, and recovery

- Wise and PayPal need a signed identity attestation for a new registration;
  the SDK accepts but does not mint it. Existing registered handles can be
  reused.
- Venmo, Revolut, Cash App, and Monzo validate live handles. Follow
  `payeeHint` for every platform.
- Drive UI and automation from `order.nextActions` and `order.explain()`.
  `ORDER_NOT_FOUND` immediately after a confirmed cash-out can be indexer lag.
- Never resubmit `TRANSACTION_SUBMISSION_UNKNOWN` or
  `TRANSACTION_STATUS_UNKNOWN` until wallet, receipt, and protocol evidence
  prove the prior attempt did not land.
- Use `withdraw()` for full or partial unwind; it handles expired-intent
  pruning. Do not call escrow functions directly.
- Reconcile fills from verified `fiatPaid`, `paidCurrency`, `paymentId`,
  `paidAt`, and `releasedAmount`, not the original estimate.
- Use the package codecs for persistence; live objects contain bigints.

Every transaction carries ERC-8021 attribution: `peer-cash`, optional
`peer-ref-XXXXXX` from `referralCode`, analytics-only `referrer` codes, then the
Base builder code. Keep secrets and signer material outside prompts and tracked
files.

## Verification

Run maker-side staging with a small, separately funded wallet:

1. Cash out 1–2 USDC and persist the deposit and policy hashes.
2. Retry reads through indexing lag until `awaiting-buyer`.
3. Confirm `orders(owner)` includes the deposit.
4. Withdraw it and confirm `returned` plus the wallet balance change.

Do not wait for a buyer. If withdrawal leaves funds stuck, stop and escalate
with the deposit and transaction evidence.
