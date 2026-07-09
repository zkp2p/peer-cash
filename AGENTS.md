# @zkp2p/cash - agent integration manual

You are integrating Peer Cash: an offramp that routes any Relay-supported EVM
source asset into Base USDC, then converts Base USDC to fiat (Venmo, Revolut,
Wise, Zelle, ...) at the live Chainlink market rate. The user whose USDC you
manage is the **maker**; a buyer pays them fiat and proves it with TEE-TLS; the
protocol releases the USDC. Funds are held by the protocol, and only the maker
can withdraw an unmatched deposit.

## Decision tree: pick your entry point

1. **You control a signer in-process** (viem `WalletClient`, e.g. a local
   key or embedded wallet) → use `cashout()` / `topUp()` / `withdraw()`
   directly.
2. **Signing happens elsewhere** (AA bundler, policy engine, custody service,
   human approval step) → use `prepare()` / `prepareTopUp()` /
   `prepareWithdraw()`. Each returns unsigned `txs[]`
   (`{ to, data, value, chainId }`) plus same-index `steps[]` labels; inspect
   the plan, submit the transactions in order, and wait for each receipt.
3. **You are a tool-use host** (MCP server, CLI) → import the manifest from
   `@zkp2p/cash/tools` and map the tool names to the verbs above. Base-USDC
   mutating tools return unsigned transactions; source routing should use
   `cash_source_quote` / `cash_source_status`, then a Base-USDC cashout.

Every transaction (including approves) carries ERC-8021 attribution:
`peer-cash`, then any `referrer` codes from `createCashClient` options, then
the Base builder code.

**Two platform caveats, both surfaced in `capabilities()`:**

- **Wise and PayPal** carry `requiresIdentityAttestation: true`. Their curator
  registration needs a signed maker identity attestation this SDK cannot mint
  (it comes from the Peer app/extension). A bare-handle `cashout()` to these
  fails fast with `PAYEE_VERIFICATION_REQUIRED` before any transaction.
- **Venmo, Revolut, Cash App, Monzo** validate the handle against the live
  platform at registration - the account must exist. The rest (Zelle, Chime,
  etc.) are format-checked only. Match handles to the `payeeHint`.

## The loop

```ts
import { createCashClient, usdc, isCashError } from '@zkp2p/cash';

const cash = createCashClient({ environment: 'production' });

// 1. Discover - Base USDC default path is sync.
const caps = cash.capabilities();
// Optional: live Relay EVM source chains/tokens.
const relayCaps = await cash.capabilities({ includeRelaySources: true });

// 2. Estimate - idempotent, cacheable, no side effects. Includes rolling ETA.
const est = await cash.estimate({ amount: usdc(500), currency: 'EUR' });

// 3. Execute.
const { depositId } = await cash.cashout(
  {
    amount: usdc(500),
    receive: { platform: 'revolut', currency: 'EUR', payee: { offchainId: 'revtag' } },
  },
  { signer },
);

// 4. Persist depositId ↔ your user. That row is the entire integration state.

// 5. Drive the lifecycle from nextActions - no heuristics.
const order = await cash.order(depositId);
if (order.nextActions.includes('withdraw') && shouldUnwind) {
  await cash.withdraw(depositId, { signer });
} else if (order.nextActions.includes('wait')) {
  // poll again later, or `for await (const o of cash.watch(depositId))`
}
```

## Rules that prevent wrong behavior

- **Never promise a rate.** `estimate()` is `kind: 'oracle-estimate'`; the
  binding rate resolves at the oracle when a buyer fills. Do not display or
  log it as a locked price.
- **Do not invent an ETA.** Use `estimate().eta`: `{ seconds, label }` backed
  by rolling 7-day indexer data from deposit creation to first fill. Use
  `order.explain()` for live order state.
- **Do not hardcode Relay source assets.** Use Relay SDK-backed EVM
  `capabilities({ includeRelaySources: true })` and `cashout({ source, ... })`.
  Destination is always Base USDC. Non-Base source chains require `sourceSigner`.
- **`ORDER_NOT_FOUND` seconds after `cashout()` is indexer lag**, not a lost
  deposit. The tx receipt you hold is the truth. Retry; `watch()` absorbs
  this automatically.
- **Unwind with `withdraw()` only.** It is state-aware (prunes expired
  intents first). Do not call escrow functions directly.
- **Read fills as receipts.** `fiatOwed` is the buyer's obligation at the
  locked rate; after the proof, `fiatPaid`/`paymentId`/`releasedAmount` are
  the verified outcome. Reconcile against those, not your own math.
- **Check the buyer during `matched`.** `buyer(address)` (tool: `cash_buyer`)
  returns their fulfilled/pruned history and success rate - surface it
  instead of a raw address.
- **Serialize with the codecs.** `orderToJson`/`orderFromJson` etc. round-trip
  bigints losslessly and re-attach `explain()`. Plain `JSON.stringify` on a
  live object throws on bigints.

## Error → remediation table

Every `CashError` carries `code`, `retryable`, `remediation`. Behavior:

| Code                                  | Retryable | Agent action                                                                                                            |
| ------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ORACLE_UNSUPPORTED_CURRENCY`         | no        | Re-pick currency from `capabilities()`                                                                                  |
| `UNSUPPORTED_PLATFORM`                | no        | Re-pick platform from `capabilities()`                                                                                  |
| `AMOUNT_BELOW_MINIMUM`                | no        | Raise amount (hard floor $0.01, recommended ≥ 1 USDC)                                                                   |
| `PAYEE_VERIFICATION_REQUIRED`         | no        | Wise/PayPal need a signed identity attestation - register the payee via the Peer app first                              |
| `SOURCE_ROUTE_UNSUPPORTED_IN_PREPARE` | no        | Use signer-backed `cashout({ source })` with a source signer, or bridge with Relay first and then `prepare()` Base USDC |
| `PAYEE_REGISTRATION_FAILED`           | yes       | Validate handle against `payeeHint`, retry with backoff (curator caps at 20 registrations/min)                          |
| `ALLOWANCE_NOT_VISIBLE`               | yes       | Approve mined but a stale RPC replica hid it; retry the same call in a few seconds                                      |
| `TRANSACTION_FAILED`                  | no        | The on-chain call reverted or was mapped from a raw error; surface to operator; funds unchanged                         |
| `DEPOSIT_RESOLUTION_FAILED`           | no        | Extract depositId from the `DepositReceived` log in the receipt                                                         |
| `ORDER_NOT_FOUND`                     | yes       | Retry (indexer lag) unless the id is provably wrong                                                                     |
| `INDEXER_LAG`                         | yes       | Retry after a few seconds                                                                                               |
| `ACTIVE_INTENT_BLOCKS_WITHDRAWAL`     | yes       | Wait; retry full `withdraw()` after intent expiry (or withdraw the unlocked part with `amount`)                         |
| `INSUFFICIENT_AVAILABLE_FUNDS`        | yes       | Partial amount exceeds the unlocked balance; lower it or close fully later                                              |
| `NOTHING_TO_WITHDRAW`                 | no        | Order is terminal; reconcile your records                                                                               |
| `ORDER_NOT_ACTIVE`                    | no        | Top-up target is closed; start a new `cashout()` instead                                                                |
| `SIGNER_REQUIRED`                     | no        | Provide `{ signer }` or switch to the prepare path                                                                      |
| `WATCH_TIMEOUT`                       | yes       | Resume `watch(depositId)` whenever convenient                                                                           |
| `ESCROW_PAUSED`                       | yes       | Back off; existing funds remain withdrawable                                                                            |

`isCashError(err)` narrows unknown errors; `err.toJSON()` is safe for logs
and tool results.

## Verification checklist (staging, maker-side only)

Prove your integration against `environment: 'staging'` with a funded test
wallet. Never wait on a buyer - buyer-side is out of your scope:

1. `cashout()` a small amount (1–2 USDC) → capture `depositId`.
2. `order(depositId)` shows `awaiting-buyer` (retry through indexer lag).
3. `orders(owner)` includes the deposit.
4. `withdraw(depositId)` → transaction succeeds.
5. `order(depositId)` shows `returned`; wallet balance is restored minus gas.

If step 4 ever fails with funds stuck, stop and escalate - do not retry
blindly.
