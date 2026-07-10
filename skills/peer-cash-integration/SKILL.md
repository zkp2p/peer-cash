---
name: peer-cash-integration
description: Integrate Peer Cash (@zkp2p/cash) into any codebase - React app, Node service, or agent runtime. Covers the maker-inversion mental model, oracle-at-fill pricing, the verbs, indexer-native order tracking, the failure playbook, and the maker-side staging verification that proves the integration works. Use when adding crypto-to-fiat cash-out to a product or wiring the cash tools into an agent host.
---

# Peer Cash integration

Onboard this codebase to `@zkp2p/cash`: an offramp-only SDK that routes any
Relay-supported EVM source asset into Base USDC, then cashes out Base USDC to fiat
at the live Chainlink market rate (0% spread), with protocol-held funds and no
custodial off-ramp provider.

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
- **Oracle-at-fill pricing. There is no quote.** The deposit carries
  `oracleRateConfig { spreadBps: 0 }`; the binding rate is whatever the
  Chainlink feed says when a buyer fills. `estimate()` is deliberately named
  - anything in your UI or agent output implying a locked rate is a bug.
- **Custody story.** Funds are held by the protocol contract only. An unmatched
  deposit is withdrawable by the maker at any time. The SDK never holds keys.
- **Honest ETA.** Use `estimate().eta`: `{ seconds, label }` backed by rolling
  30-day indexer data from zero-spread (`spreadBps: 0`) market-rate deposits in
  the same payout corridor, measured from deposit creation to first fill. Do
  not use signal-to-fulfillment latency and never render it as a guarantee.

## 2. Decision tree - entry point by runtime

| Runtime                   | Entry                                                            | Signer pattern                                                                      |
| ------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| React app                 | `@zkp2p/cash/react` hooks + one `createCashClient` in a provider | wagmi/viem `WalletClient` from the connected wallet                                 |
| Node service              | `createCashClient` + `cashout()`/`withdraw()`                    | `createWalletClient({ account: privateKeyToAccount(...), chain: base, transport })` |
| Agent host / policy layer | Base-USDC `prepare*()` -> unsigned `txs[]` + `steps[]`           | Host signs; source quote/status tools do not execute Relay                          |

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
const est = await cash.estimate({ amount: usdc(100), currency: 'USD' }); // 1 estimate + ETA
const res = await cash.cashout(
  {
    // 2 execute
    amount: usdc(100),
    receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@handle' } },
  },
  { signer },
);
const { txs, steps } = await cash.prepare({/* same input */}); // 2b unsigned plan
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

Base-USDC cashout, withdraw, and top-up also have unsigned `prepare*`
counterparts. `prepare()` rejects `source`. Source-routed cashout runs Relay
first; use signed `cashout({ source }, { signer, sourceSigner })`, or execute
and confirm Relay in the host before preparing a Base-USDC cashout.
`cash_source_quote` and `cash_source_status` are quote/read tools, not a
host-side execution path.
Every protocol transaction carries ERC-8021 attribution (`peer-cash` + your
`createCashClient({ referrer })` codes).

Wise and PayPal require an identity attestation for a new payee registration.
Do not disable them outright: a previously registered handle can be reused
with bare payee data. Handle `PAYEE_VERIFICATION_REQUIRED` when registration
is still needed.

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
- `TRANSACTION_STATUS_UNKNOWN` = a Base transaction may already have
  succeeded. Inspect `error.recovery.transactionHash` before resubmitting.
- `TRANSACTION_SUBMISSION_UNKNOWN` = a Base mutation returned no hash but may
  have broadcast. Follow `error.recovery`, inspect Base wallet/protocol state,
  and do not retry until absence is proven.
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

1. Create a real 1–2 USDC Base-USDC deposit; retain `depositId` and Base tx.
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
