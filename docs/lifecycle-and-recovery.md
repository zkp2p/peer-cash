# Lifecycle and recovery

The one deep guide: what states exist, how partial fills work, why there is no
ETA, how unwinding works, and why every order survives a crash.

## The model: you are the maker

A Peer Cash order is a **deposit** in the ZKP2P protocol. When you
`cashout()`, your USDC becomes protocol-held funds priced at the live Chainlink
oracle rate with zero spread. A buyer (a standard protocol taker) _signals an
intent_ against your deposit, pays you fiat offchain (Venmo, Revolut, Wise,
...), and proves the payment via TEE-TLS. The protocol then releases your USDC
to them.
The protocol runs in its normal direction - nothing here is inverted or
special-cased.

Because your deposit is priced at market with no spread, it is the best offer
on the book by construction. That is the fill incentive.

## States

Every state derives from on-chain events. There are no synthetic states.

| State            | On-chain meaning                                    | `nextActions`                                                 |
| ---------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| `awaiting-buyer` | Deposit live, no active intent                      | `['wait', 'withdraw']`                                        |
| `matched`        | A buyer signaled; funds locked                      | `['wait']` (or `['wait','withdraw']` once the intent expires) |
| `delivering`     | Partial fill in progress: some delivered, more live | `['wait']` / `['wait','withdraw']`                            |
| `delivered`      | Fully paid and proven; protocol released funds      | `[]`                                                          |
| `returned`       | Funds back in your wallet (withdrawn)               | `[]`                                                          |

Intent statuses underneath: `SIGNALED → FULFILLED` (paid + proven),
`PRUNED` (expired unpaid), `MANUALLY_RELEASED` (support path, counts as
fulfilled). Always query the full set - the indexer defaults to `SIGNALED`
only, which silently hides terminal states.

## Partial fills

A 1,000 USDC order does not need one 1,000 USDC buyer. The deposit accepts
intents between `intentAmountRange.min` (default 1 USDC) and the full amount.
Three buyers can take 400 + 350 + 250. The order shows each as a `fill` and
passes through `delivering` until the last one completes. `filledAmount`,
`pendingAmount`, and `totalAmount` always add up against the chain.

## The honest-ETA principle

`order.explain()` returns one sentence built from live data. It will never
show a countdown, a progress percentage, or an "estimated arrival" - because
none of those are knowable:

- **Buyer arrival time is market-driven.** A deposit at market rate should
  fill fast, but "should" is not a number we can print.
- **The binding rate resolves at fill time.** `estimate()` reads the same
  Chainlink feed the escrow will read, but between estimate and fill the
  market moves. `kind: 'oracle-estimate'` is the API telling you this.

Anything that looks like a committed quote or a delivery timer in a UI built
on this SDK is a bug in that UI.

## Managing a live order

- **Top up** - `topUp(depositId, amount)` adds USDC to a live order: same
  payee, same market-rate pricing, no new registration. Closed orders reject
  with `ORDER_NOT_ACTIVE`; start a new `cashout()` instead.
- **Partial withdrawal** - `withdraw(depositId, { amount })` pulls part of
  the _unlocked_ balance back out. A live buyer intent does not block it
  (their locked portion is untouched); asking for more than the unlocked
  balance fails with `INSUFFICIENT_AVAILABLE_FUNDS`.
- There is no retain-on-empty or rate knob to manage - a cash order cleans
  itself up when fully filled, and the market rate is not configurable.

## Receipts, decoded

Everything an order serves is decoded to human units: platform ids and
currency codes instead of bytes32 hashes, plain-number rates instead of 1e18
bigints (raw values stay available as `*Hash` / `conversionRate` fields).

Each fill is a receipt that sharpens over its life:

- **At signal**: `rate` (the oracle rate locked for THIS fill - the moment
  "approximately" becomes exact) and `fiatOwed` (`amount × rate`, rounded up
  to the cent, matching what the buyer's client tells them to pay).
- **After the proof**: `fiatPaid` (the verified amount actually sent),
  `paidCurrency`, `paymentId` (the platform's own payment reference),
  `paidAt`, `releasedAmount` (USDC actually released), and
  `fillLatencySeconds` (signal → proven delivery).

`fiatOwed` and `fiatPaid` are decoded to whole currency units. The verified
`paymentAmount` arrives from the indexer in cents (2 decimals) - the same
convention the first-party ZKP2P clients display it with - and the SDK
divides by 100. The signal-time `fiatOwed` derives from `amount × rate` at
1e18 precision; `resolveIntentFiatAmount` in the reference clients uses the
same ceil-to-cent math, and the decode is verified against live production
receipts.

Orders also carry their `payouts` legs reconstructed from the chain -
platform, currency, payee hash, and a pricing proof (`spreadBps: 0`,
`kind: 'oracle_chainlink'`, `marketRate: true`): the zero-spread claim is a
queryable fact, not marketing copy.

## Who is this buyer?

`buyer(address)` aggregates the matched buyer's full intent history into a
track record: lifetime intents, fulfilled vs pruned counts, a success rate in
basis points, first/last seen. Use it during `matched` - the moment a
stranger's address is holding your order is exactly when a 95%-success,
200-order counterparty reads very differently from a fresh wallet.

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

There is deliberately no `cancel` vs `recover` split - the deposit state
decides, not the caller. Agents needing host-side signing use
`prepareWithdraw(depositId)` for the same logic as unsigned `txs[]`.
Prepare results also carry `steps[]` in the same order as `txs[]`, so a host
can show `pruneExpiredIntents` before `withdrawDeposit` instead of asking a
user or policy engine to approve opaque calldata.

## Resumability

The `depositId` (composite `escrow_onchainId`) is the only key you need:

- `cashout()` returns it, parsed from the `DepositReceived` event in the
  transaction receipt - available immediately, no indexer wait.
- `order(depositId)` reconstructs the full order from the indexer at any
  time, on any machine. There is no session, no cache, no local store.
- Bind orders to your own users with one column in **your** database:
  `userId → depositId`.

## Indexer lag

Right after `cashout()`, the indexer may not have seen the deposit yet
(typically a few seconds). `order()` throws `ORDER_NOT_FOUND` with
`retryable: true`; `watch()` and the React hooks absorb this and keep
polling. Do not treat an immediate `ORDER_NOT_FOUND` as a lost deposit - the
transaction receipt you already hold is the source of truth.

## Payee registration, over time

`cashout()` registers your payee with the curator once, keyed by a hash of the
handle; the registration has no TTL and stays resolvable for the deposit's
whole life. Two things to know for long-lived orders:

- For the **live-validated platforms** (Venmo, Revolut, Cash App, Monzo), if
  the underlying account is later deleted, the curator can revoke the payee at
  a buyer's intent-signing time - a buyer then cannot take the deposit until
  the payee is re-registered. Format-only platforms (Zelle, Chime, …) are
  never re-checked.
- **Wise and PayPal** require a signed identity attestation to register at all;
  this SDK surfaces that as `PAYEE_VERIFICATION_REQUIRED` and `capabilities()`
  flags those platforms with `requiresIdentityAttestation: true`.

## Failure table

| Code                              | Retryable | What happened / what to do                                                                                        |
| --------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `ORACLE_UNSUPPORTED_CURRENCY`     | no        | Currency has no Chainlink feed. Pick from `capabilities()`.                                                       |
| `UNSUPPORTED_PLATFORM`            | no        | Platform not in this environment's catalog. Pick from `capabilities()`.                                           |
| `AMOUNT_BELOW_MINIMUM`            | no        | Below the $0.01 hard floor. Recommended minimum is 1 USDC.                                                        |
| `PAYEE_VERIFICATION_REQUIRED`     | no        | Wise/PayPal need a signed identity attestation; register the payee via the ZKP2P app first.                       |
| `PAYEE_REGISTRATION_FAILED`       | yes       | Curator rejected or was unreachable. Check the handle hint, retry (curator caps at 20 registrations/min per IP).  |
| `ALLOWANCE_NOT_VISIBLE`           | yes       | Approve mined but a stale RPC replica hid it. Retry the same call in a few seconds.                               |
| `TRANSACTION_FAILED`              | no        | An on-chain call reverted (or a raw error was wrapped). Funds unchanged if it reverted pre-acceptance.            |
| `DEPOSIT_RESOLUTION_FAILED`       | no        | Tx succeeded but no `DepositReceived` found. Recover the id from the receipt log manually.                        |
| `ORDER_NOT_FOUND`                 | yes       | Unknown id or indexer lag. Verify the id; retry within seconds of creation.                                       |
| `INDEXER_LAG`                     | yes       | Indexer behind the chain. Retry shortly.                                                                          |
| `ACTIVE_INTENT_BLOCKS_WITHDRAWAL` | yes       | A buyer may still deliver. Wait for fill or expiry, withdraw again - or withdraw the unlocked part with `amount`. |
| `INSUFFICIENT_AVAILABLE_FUNDS`    | yes       | Partial amount exceeds the unlocked balance. Lower it.                                                            |
| `NOTHING_TO_WITHDRAW`             | no        | Order is terminal. Check `order(depositId).state`.                                                                |
| `ORDER_NOT_ACTIVE`                | no        | Cannot top up a closed order. Start a new `cashout()`.                                                            |
| `SIGNER_REQUIRED`                 | no        | Pass `{ signer }` or use the `prepare*` path.                                                                     |
| `WATCH_TIMEOUT`                   | yes       | Order still live; resume `watch()`/`order()` any time.                                                            |
| `ESCROW_PAUSED`                   | yes       | Protocol paused deposits. Existing funds stay withdrawable.                                                       |
