# Lifecycle and recovery

The one deep guide: what states exist, how partial fills work, why there is no
ETA, how unwinding works, and why every order survives a crash.

## The model: you are the maker

A Peer Cash order is a **deposit** in the ZKP2P EscrowV2 contract. When you
`cashout()`, your USDC moves into escrow at the live Chainlink oracle rate
with zero spread. A buyer (a standard protocol taker) *signals an intent*
against your deposit, pays you fiat off-chain (Venmo, Revolut, Wise, …), and
proves the payment via TEE-TLS. The escrow then releases your USDC to them.
The protocol runs in its normal direction — nothing here is inverted or
special-cased.

Because your deposit is priced at market with no spread, it is the best offer
on the book by construction. That is the fill incentive.

## States

Every state derives from on-chain events. There are no synthetic states.

| State | On-chain meaning | `nextActions` |
|---|---|---|
| `awaiting-buyer` | Deposit live, no active intent | `['wait', 'withdraw']` |
| `matched` | A buyer signaled; funds locked | `['wait']` (or `['wait','withdraw']` once the intent expires) |
| `delivering` | Partial fill in progress: some delivered, more live | `['wait']` / `['wait','withdraw']` |
| `delivered` | Fully paid and proven; escrow released | `[]` |
| `returned` | Funds back in your wallet (withdrawn) | `[]` |

Intent statuses underneath: `SIGNALED → FULFILLED` (paid + proven),
`PRUNED` (expired unpaid), `MANUALLY_RELEASED` (support path, counts as
fulfilled). Always query the full set — the indexer defaults to `SIGNALED`
only, which silently hides terminal states.

## Partial fills

A 1,000 USDC order does not need one 1,000 USDC buyer. The deposit accepts
intents between `intentAmountRange.min` (default 1 USDC) and the full amount.
Three buyers can take 400 + 350 + 250. The order shows each as a `fill` and
passes through `delivering` until the last one completes. `filledAmount`,
`pendingAmount`, and `totalAmount` always add up against the chain.

## The honest-ETA principle

`order.explain()` returns one sentence built from live data. It will never
show a countdown, a progress percentage, or an "estimated arrival" — because
none of those are knowable:

- **Buyer arrival time is market-driven.** A deposit at market rate should
  fill fast, but "should" is not a number we can print.
- **The binding rate resolves at fill time.** `estimate()` reads the same
  Chainlink feed the escrow will read, but between estimate and fill the
  market moves. `kind: 'oracle-estimate'` is the API telling you this.

Anything that looks like a committed quote or a delivery timer in a UI built
on this SDK is a bug in that UI.

## Unwinding: one verb

`withdraw(depositId, { signer })` handles every recovery case:

1. **No buyer yet** (`awaiting-buyer`): withdraws directly. Funds return in
   one transaction.
2. **Buyer signaled but never paid**: their intent expires on-chain. The
   escrow still counts it as active, so `withdraw()` first sends
   `pruneExpiredIntents`, then withdraws. Two transactions, one call.
3. **Buyer is actively paying** (live intent): withdrawal would strand the
   buyer, so the escrow blocks it and the SDK throws
   `ACTIVE_INTENT_BLOCKS_WITHDRAWAL` (`retryable: true`). Wait for delivery
   or expiry, then call `withdraw()` again.
4. **Nothing left** (`delivered`/`returned`): throws `NOTHING_TO_WITHDRAW`.

There is deliberately no `cancel` vs `recover` split — the deposit state
decides, not the caller. Agents needing host-side signing use
`prepareWithdraw(depositId)` for the same logic as unsigned `txs[]`.

## Resumability

The `depositId` (composite `escrow_onchainId`) is the only key you need:

- `cashout()` returns it, parsed from the `DepositReceived` event in the
  transaction receipt — available immediately, no indexer wait.
- `order(depositId)` reconstructs the full order from the indexer at any
  time, on any machine. There is no session, no cache, no local store.
- Bind orders to your own users with one column in **your** database:
  `userId → depositId`.

## Indexer lag

Right after `cashout()`, the indexer may not have seen the deposit yet
(typically a few seconds). `order()` throws `ORDER_NOT_FOUND` with
`retryable: true`; `watch()` and the React hooks absorb this and keep
polling. Do not treat an immediate `ORDER_NOT_FOUND` as a lost deposit — the
transaction receipt you already hold is the source of truth.

## Failure table

| Code | Retryable | What happened / what to do |
|---|---|---|
| `ORACLE_UNSUPPORTED_CURRENCY` | no | Currency has no Chainlink feed. Pick from `capabilities()`. |
| `UNSUPPORTED_PLATFORM` | no | Platform not in this environment's catalog. Pick from `capabilities()`. |
| `AMOUNT_BELOW_MINIMUM` | no | Below the $0.01 hard floor. Recommended minimum is 1 USDC. |
| `PAYEE_REGISTRATION_FAILED` | yes | Curator rejected or was unreachable. Check the handle format hint, retry. |
| `TRANSACTION_FAILED` | no | The deposit tx reverted. Funds unchanged; inspect on Basescan. |
| `DEPOSIT_RESOLUTION_FAILED` | no | Tx succeeded but no `DepositReceived` found. Recover the id from the receipt log manually. |
| `ORDER_NOT_FOUND` | yes | Unknown id or indexer lag. Verify the id; retry within seconds of creation. |
| `INDEXER_LAG` | yes | Indexer behind the chain. Retry shortly. |
| `ACTIVE_INTENT_BLOCKS_WITHDRAWAL` | yes | A buyer may still deliver. Wait for fill or expiry, withdraw again. |
| `NOTHING_TO_WITHDRAW` | no | Order is terminal. Check `order(depositId).state`. |
| `SIGNER_REQUIRED` | no | Pass `{ signer }` or use the `prepare*` path. |
| `WATCH_TIMEOUT` | yes | Order still live; resume `watch()`/`order()` any time. |
| `ESCROW_PAUSED` | yes | Protocol paused deposits. Existing funds stay withdrawable. |
