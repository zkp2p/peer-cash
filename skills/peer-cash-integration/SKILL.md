---
name: peer-cash-integration
description: Integrate Peer Cash (@zkp2p/cash) into any codebase - React app, Node service, or agent runtime. Covers the maker-inversion mental model, oracle-at-fill pricing, the verbs, indexer-native order tracking, the failure playbook, and the maker-side staging verification that proves the integration works. Use when adding crypto-to-fiat cash-out to a product or wiring the cash tools into an agent host.
---

# Peer Cash integration

Onboard this codebase to `@zkp2p/cash`: an offramp-only SDK that routes Relay
EVM assets or NEAR Intents 1Click external deposits into Base USDC, then cashes
out Base USDC to fiat at the live Chainlink market rate (0% spread), with
protocol-held funds and no custodial off-ramp provider.

## 1. Mental model (read before writing code)

- **Maker inversion.** The cashing-out user is the _maker_: their USDC becomes
  a protocol-held deposit. A buyer (taker) pays them fiat and proves it
  with TEE-TLS; the protocol releases the USDC. The protocol runs in its normal
  direction - Peer Cash is a lens on it, not a fork of it.
- **Source routing.** Destination is always canonical Base USDC. Same-chain
  Base USDC remains the default/minimal path. Other source chains/tokens come
  from `@relayprotocol/relay-sdk` metadata and quote execution, filtered to
  EVM chains this viem SDK can sign. Non-Base source chains require
  `sourceSigner`. Use `EXACT_INPUT` for high-level cash-out flows: `amount` is
  source-token base units, while `source.amount` is Relay's guaranteed minimum
  Base USDC output and the exact order deposit amount, not actual route output.
- **NEAR Intents routing.** Non-EVM origins use an external-deposit boundary:
  discover live 1Click assets, persist the signed quote/address/memo/deadline,
  send once with the origin wallet, optionally register that existing hash,
  poll status to `SUCCESS`, reconcile Base evidence, then cash out Base-only.
  Browser integrations use a same-origin proxy so the 1Click JWT stays server-side.
- **Oracle-at-fill pricing. There is no quote.** The deposit carries
  `oracleRateConfig { spreadBps: 0 }`; the binding rate is whatever the
  Chainlink feed says when a buyer fills. `estimate()` is deliberately named
  - anything in your UI or agent output implying a locked rate is a bug.
- **Custody story.** Funds are held by the protocol contract only. An unmatched
  deposit is withdrawable by the maker at any time. The SDK never holds keys.
- **Restricted intent signaling.** If any payout leg uses Venmo, Cash App, or
  PayPal, a method-scoped Peer Pay merchant policy attaches after the deposit
  confirms. Signed `cashout()` handles every sequential follow-up with the same
  viem wallet. Prepared hosts must finish them explicitly; any EOA works.
- **Honest ETA.** Use `estimate().eta`: `{ seconds, label }` backed by rolling
  30-day indexer data from zero-spread (`spreadBps: 0`) market-rate deposits in
  the same payout corridor, measured from deposit creation to first fill. Do
  not use signal-to-fulfillment latency and never render it as a guarantee.

## 2. Decision tree - entry point by runtime

| Runtime                   | Entry                                                            | Signer pattern                                                                      |
| ------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| React app                 | `@zkp2p/cash/react` hooks + one `createCashClient` in a provider | wagmi/viem `WalletClient` from the connected wallet                                 |
| Node service              | `createCashClient` + `cashout()`/`withdraw()`                    | `createWalletClient({ account: privateKeyToAccount(...), chain: base, transport })` |
| Agent host / policy layer | Base-USDC `prepare*()` -> unsigned `txs[]` + `steps[]`           | Host signs; Relay tools do not execute, and NEAR tools never send origin funds      |

## 3. Recipes - the verbs

Authoritative signatures live in the package's typedoc and `AGENTS.md` - do
not copy types from here; import them.

```ts
import { createCashClient, usdc } from '@zkp2p/cash';

// env: 'production' | 'preproduction' | 'staging'. Preproduction and staging
// select api-preprod.zkp2p.xyz and api-staging.zkp2p.xyz curators by default.
const cash = createCashClient({ environment: 'staging' });

const caps = cash.capabilities(); // 0 discover (sync)
const relayCaps = await cash.capabilities({ includeRelaySources: true }); // 0b source discovery
const nearCaps = await cash.capabilities({ includeNearIntentsSources: true }); // 0c 1Click assets
const est = await cash.estimate({ amount: usdc(100), currency: 'USD' }); // 1 estimate + ETA
const res = await cash.cashout(
  {
    // 2 execute
    amount: usdc(100),
    // or an array of legs to offer several platforms on one order:
    // receive: [{ platform: 'venmo', ... }, { platform: 'revolut', ... }]
    receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@handle' } },
  },
  { signer },
);
const { txs, steps, accessPolicyPaymentMethods, disputeProtectionPaymentMethods } =
  await cash.prepare({/* same input */}); // 2b unsigned plan
// Submit txs in order. After createDeposit confirms:
const prepared = cash.finalizePreparedCashout(createDepositReceipt);
for (const paymentMethod of accessPolicyPaymentMethods) {
  const policyTx = cash.prepareAccessPolicy(prepared.depositId, paymentMethod);
  await hostSubmitAndConfirm(policyTx);
}
for (const paymentMethod of disputeProtectionPaymentMethods) {
  const protectionTx = await cash.prepareDisputeProtection(prepared.depositId, paymentMethod);
  await hostSubmitAndConfirm(protectionTx);
}
const order = await cash.order(res.depositId); // 3 observe
const mine = await cash.orders(ownerAddress, { inFlight: true }); // 4 list
for await (const o of cash.watch(res.depositId)) {
  // 5 watch
  if (!o.isInFlight) break;
}
await cash.withdraw(res.depositId, { signer }); // 6 unwind (amount: for partial)
await cash.topUp(res.depositId, usdc(50), { signer }); // 7 top up a live order
```

Signer-backed exact-input source path:

```ts
const routed = await cash.cashout(
  {
    amount: sourceAmount,
    source: {
      chainId: sourceChainId,
      currency: sourceToken,
      tradeType: 'EXACT_INPUT',
    },
    receive,
  },
  { signer, sourceSigner },
);

persist({
  depositId: routed.depositId,
  guaranteedBaseUsdc: routed.source?.amount,
  requestId: routed.source?.requestId,
  transactions: routed.source?.transactions,
});
```

External-deposit NEAR Intents source path:

```ts
const quote = await cash.quoteNearIntentsSource({
  sourceAsset: nearAssetId,
  amount: usdc(1),
  recipient: signer.account.address,
  refundTo: originRefundAddress,
  tradeType: 'EXACT_OUTPUT',
  deadline: new Date(Date.now() + 3 * 60_000).toISOString(),
});
persist(quote);
const txHash = await originWallet.send(quote.depositAddress!, quote.inputAmount);
await cash.submitNearIntentsDeposit({
  depositAddress: quote.depositAddress!,
  ...(quote.depositMemo ? { depositMemo: quote.depositMemo } : {}),
  txHash,
});
const route = await cash.nearIntentsStatus({
  depositAddress: quote.depositAddress!,
  ...(quote.depositMemo ? { depositMemo: quote.depositMemo } : {}),
  expectedQuote: quote,
});
// Reconcile Base delivery after SUCCESS, then use a Base-only prepare/cashout.
```

Base-USDC cashout, withdraw, and top-up also have unsigned `prepare*`
counterparts. `prepare()` rejects `source`. Source-routed cashout runs Relay
first; use signed `cashout({ source }, { signer, sourceSigner })`, or execute
and confirm Relay in the host before preparing a Base-USDC cashout.
`cash_source_quote` and `cash_source_status` are quote/read tools, not a
host-side execution path. The built-in tool manifest also does not expose
receipt finalization, access-policy submission, or dispute-protection
submission as separate tools; the host adapter calls those `CashClient`
methods after its signer confirms `createDeposit`.
Every protocol transaction carries ERC-8021 attribution. To receive the
deposit-level integration share, copy the six-character code from your Peer
mobile or web referral screen and configure it directly:

```ts
const cash = createCashClient({
  environment: 'production',
  referralCode: 'ABC123',
});
```

The SDK emits `peer-cash`, then `peer-ref-ABC123`, then any analytics-only
`createCashClient({ referrer })` codes. No API key or referral-enrollment
transaction is required. Curator pays the eligible code owner 50 bps (capped
by the Peer service-fee budget) instead of applying the maker L1/L2 ladder for
that deposit. Use one referral code per deposit. Renaming the displayed code
later does not change the owner of an already-attributed open deposit.

Wise and PayPal require an identity attestation for a new payee registration.
The SDK accepts the structured attestation but does not mint it; first-party
Peer web obtains it through the Peer TEE browser extension. Do not disable these
platforms outright: a previously registered handle can be reused with bare
payee data. Handle `PAYEE_VERIFICATION_REQUIRED` when registration is still
needed.

## 4. Order management - indexer-native

- A cash order IS a deposit; the chain is the database. No storage layer.
- Bind orders to your users with one column in _your_ system:
  `userId → depositId`, populated from `cashout()`'s return value.
- `order(depositId)` cold-hydrates from the id alone - resumable across
  processes, devices, and crashes.
- Serialize across boundaries with the exported codecs
  (`orderToJson`/`orderFromJson`) - they handle bigints and re-attach
  `explain()`.

## 5. Failure playbook

Every error is a `CashError` with `code`, `retryable`, `remediation`. The
full table lives in `AGENTS.md` and `docs/lifecycle-and-recovery.md` - quote
those, don't re-derive. The recovery boundaries that matter most in practice:

- `ORDER_NOT_FOUND` seconds after `cashout()` = indexer lag. The receipt is
  the truth; retry. `watch()` and the React hooks absorb it.
- `ACTIVE_INTENT_BLOCKS_WITHDRAWAL` = a buyer may still deliver. Retry
  `withdraw()` after their intent expires; it prunes automatically.
- `SOURCE_ROUTE_COMPLETED_CASHOUT_FAILED` = Relay completed but the Base
  cashout did not. Never repeat Relay; retry Base-only with
  `BigInt(error.recovery.amount)`.
- `SOURCE_CASHOUT_SUBMISSION_UNKNOWN` = Relay completed but Base submission
  returned no hash. Inspect Base wallet activity and
  `orders(error.recovery.depositor)` before any retry.
- `SOURCE_CASHOUT_STATUS_UNKNOWN` = Relay completed and a Base transaction was
  submitted, but its receipt is unknown. Inspect
  `error.recovery.depositTxHash`; do not route or submit again until it is
  known.
- `SOURCE_DEPOSIT_SUBMISSION_FAILED` = the NEAR Intents origin transaction may
  already be final. Retry only the notification with the same address/hash;
  never resend source funds.
- `TRANSACTION_STATUS_UNKNOWN` = a Base transaction may already have
  succeeded. Inspect `error.recovery.transactionHash` before resubmitting.
- `TRANSACTION_SUBMISSION_UNKNOWN` = a Base mutation returned no hash but may
  have broadcast. Follow `error.recovery`, inspect Base wallet/protocol state,
  and do not retry until absence is proven.
- `ACCESS_POLICY_CONFIGURATION_FAILED` = the deposit exists but its required
  policy was not confirmed. Never cash out again. Inspect
  `error.recovery.transactionHash` when present; prepare another policy only
  if that transaction is absent or confirmed reverted.
- `DISPUTE_PROTECTION_UNAVAILABLE` = no deposit was created; retry when the
  protected stack is ready or choose an unrestricted rail.
- `DISPUTE_PROTECTION_CONFIGURATION_FAILED` = the deposit exists. Inspect its
  recovery hash before preparing protection again; never repeat the cash-out.
- `INDEXER_UNAVAILABLE` / `ORACLE_READ_FAILED` = retry the read only. Do not
  repeat the transaction that produced the id or balance being inspected.
- `SIGNER_CHAIN_MISMATCH` = switch to the required chain and obtain a fresh
  Relay quote before retrying.
- `SIGNER_CHAIN_UNAVAILABLE` = reconnect the wallet and verify its live chain
  before any quote or mutation.
- Buyer never pays → nothing to do: the intent expires, `nextActions` gains
  `'withdraw'`, one `withdraw()` call returns the funds (prune + withdraw).

## 6. Verification checklist (mandatory before calling the integration done)

Run against `environment: 'staging'` with a small funded wallet.
**Maker-side only - never wait on a buyer.**

Prove both routes without waiting for a buyer:

1. Create a real 1–2 USDC Base-USDC deposit; retain `depositId`, the Base tx,
   and every `accessPolicyTxHashes` entry when using Venmo, Cash App, or PayPal.
2. Retry through indexer lag until `order(depositId)` is `awaiting-buyer`, and
   assert `orders(owner)` contains it.
3. Withdraw it; assert `returned` and the Base USDC balance is restored minus
   gas.
4. Select a live supported source from capabilities and create a real
   exact-input route whose guaranteed Base USDC output is at least 1 USDC.
   Retain Relay `requestId`, origin/destination transaction hashes, Base tx,
   and `depositId`.
5. Assert the routed order becomes `awaiting-buyer` and appears in
   `orders(owner)`, then withdraw and confirm `returned` plus restored balance.

If withdrawal fails with funds stuck: stop, do not retry blindly, escalate to
a human with the `depositId` and tx hashes.
