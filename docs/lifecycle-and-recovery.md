# Lifecycle and recovery

The one deep guide: what states exist, how source routing works, how partial
fills and ETA work, how unwinding works, and why every order survives a crash.

## The model: you are the maker

A Peer Cash order is a **deposit** in the ZKP2P protocol. When you
`cashout()`, Base USDC becomes protocol-held funds priced at the live Chainlink
oracle rate with zero spread. A buyer (a standard protocol taker) _signals an
intent_ against your deposit, pays you fiat offchain (Venmo, Revolut, Wise,
...), and proves the payment via TEE-TLS. The protocol then releases your USDC
to them.
The protocol runs in its normal direction - nothing here is inverted or
special-cased.

Because your deposit is priced at market with no spread, it is the best price
a rational maker can offer. That is the fill incentive.

## Source routing

The cashout destination is always canonical Base USDC. The minimal/default path
is still same-chain Base USDC: pass USDC base units to `estimate()` and
`cashout()`.

For any other EVM source asset, Peer Cash uses `@relayprotocol/relay-sdk`:

1. `capabilities({ includeRelaySources: true })` or `sourceCapabilities()`
   fetches live Relay-supported EVM chains and tokens, excluding disabled,
   deposit-disabled, and block-lagging chains.
2. `quoteSource()` calls Relay SDK `actions.getQuote` for source to Base USDC.
3. `cashout({ amount, source, receive }, { signer, sourceSigner })` settles
   Base allowance, calls Relay SDK `actions.execute`, then creates the Peer Cash
   order with Relay's guaranteed minimum Base USDC output. Non-Base source
   chains require `sourceSigner`.
   `executeSourceQuote()` remains available for apps that want a separate
   bridge step.

Routes that need more than one source-chain transaction (an ERC-20 `approve`,
then the route transaction) are submitted back-to-back by the Relay SDK. On a
plain local account the route transaction reuses the approval's nonce and
reverts mid-route, so `executeSourceQuote()` and `cashout({ source })` refuse
multi-transaction routes up front with `SOURCE_NONCE_MANAGER_REQUIRED` unless
the source signer carries a viem nonce manager:
`privateKeyToAccount(pk, { nonceManager })`. The check fires before anything
is submitted. Browser (`json-rpc`) wallets are unaffected - the node
allocates their nonces.

Cash-out interfaces should use `tradeType: 'EXACT_INPUT'` (also the default),
so `amount` always means source-token base units. A `RelayQuote.outputAmount`
is the guaranteed minimum Base USDC output. The same value becomes
`CashoutResult.source.amount` and the exact amount deposited into the Peer Cash
order; it is not a claim about the route's actual output.

When a source route succeeds, `CashoutResult.source` also retains the Relay
`requestId`, a flat `txHashes` list, and chain-aware
`transactions.origin` / `transactions.destination` entries. Persist them with
the `depositId` so route and deposit recovery do not depend on browser state.

The unsigned `prepare()` path is Base-USDC-only and rejects `source` with
`SOURCE_ROUTE_UNSUPPORTED_IN_PREPARE`. The tool manifest follows the same
boundary: `cash_source_quote` and `cash_source_status` quote and observe Relay,
but the host or a signer-backed client must execute the route before
`cash_cashout` prepares the Base-USDC order.

There is no static chain/token allowlist in Peer Cash. Relay decides source
support through its metadata and quote execution, filtered to the viem/EVM
execution surface this SDK can sign. Peer Cash hardcodes only the Base USDC
destination constant.

### Source-route failure boundaries

Do not retry a source route merely because the Base cashout did not finish:

- `SOURCE_NONCE_MANAGER_REQUIRED` is preflight: nothing was submitted.
  Recreate the source signer with viem's nonce manager and execute a fresh
  quote.
- `SOURCE_EXECUTION_FAILED` means Relay execution did not report success. Check
  its `inspect-relay-route` recovery evidence, submitted wallet transactions,
  and `relayStatus(requestId)` before taking another action; a blind retry can
  route twice. A failed route whose only landed transaction is the approval
  can sit in `relayStatus` `waiting` indefinitely - it never becomes terminal,
  so decide from the persisted recovery payload and the origin transactions,
  not from Relay reaching a final status.
- `SOURCE_ROUTE_COMPLETED_CASHOUT_FAILED` means Relay completed, but the Base
  cashout was not created. Its recovery payload has
  `kind: 'retry-base-usdc-cashout'`, the guaranteed Base USDC `amount`, Relay
  request and transaction evidence. Do not route again; retry without `source`.
- `SOURCE_CASHOUT_SUBMISSION_UNKNOWN` means Relay completed, but Base
  submission returned no transaction hash. Inspect recent Base wallet activity
  and `orders(recovery.depositor)` to prove no deposit exists before retrying.
- `SOURCE_CASHOUT_STATUS_UNKNOWN` means Relay completed and the Base cashout
  transaction was submitted, but its receipt could not be confirmed. Its
  recovery payload has `kind: 'inspect-base-cashout-transaction'` and
  `depositTxHash`. Do not submit anything again until that Base transaction is
  known. If it succeeded, recover `depositId` from `DepositReceived`; if it
  reverted, retry a Base-USDC-only cashout with the recovery amount.

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

## The ETA principle

`estimate().eta` is historical, not a promise. It uses rolling 30-day indexer
data from deposit/order creation to the first fulfilled fill through the
intent's actual platform and currency pair. It deliberately does **not**
measure buyer signal to fulfillment; that would miss the buyer-arrival wait
that users actually care about. The public shape is small: `{ seconds, label }`.

`fillStats()` exposes the sampler's raw evidence for catalog filtering as
`Record<"platform:currency", { fills, medianFillSeconds? }>`. Bank-scoped Zelle
methods aggregate to `zelle:USD`. Consumers own thresholding; the recommended
gate is `fills >= 10 && medianFillSeconds <= 48h`, with a fail-open fallback to
the full capability catalog when the read fails or filtering would empty it.
Medians are per-deposit first-fill latencies, never means or censored cohorts.
The client caches one raw environment snapshot for 15 minutes and de-duplicates
concurrent reads; ETA resolution still uses only the requested normalized
`platform:currency` key. A progressive UI can call
`estimate(input, { includeEta: false })` to render rate/receive immediately,
then read that pair from `fillStats()` without coupling the two loading states.

- **Buyer arrival time is market-driven.** A deposit at market rate should
  fill fast, but the ETA is only a recent historical sample.
- **The binding rate resolves at fill time.** `estimate()` reads the same
  Chainlink feed the escrow will read, but between estimate and fill the
  market moves. `kind: 'oracle-estimate'` is the API telling you this.
- **The label is display-ready.** Use `eta.label` in simple UIs; use
  `eta.seconds` only if you need your own formatting.

Anything that looks like a committed quote or guaranteed delivery timer in a
UI built on this SDK is a bug in that UI.

## Managing a live order

- **Top up** - `topUp(depositId, amount)` adds USDC to a live order: same
  payee, same market-rate pricing, no new registration. Closed orders reject
  with `ORDER_NOT_ACTIVE`; start a new `cashout()` instead.
- **Partial withdrawal** - `withdraw(depositId, { amount })` pulls part of
  the _unlocked_ balance back out. A live buyer intent does not block it
  (their locked portion is untouched); asking for more than the unlocked
  balance fails with `INSUFFICIENT_AVAILABLE_FUNDS`. Accounting note: a
  partial withdrawal increments `returnedAmount`; `totalAmount` records
  everything the order has ever held and does not shrink.
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
convention the first-party Peer clients display it with - and the SDK
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
- **Wise and PayPal** require a signed identity attestation for a new payee
  registration. A previously registered handle can be reused with bare payee
  data. If the handle is new and no attestation is supplied, the SDK surfaces
  `PAYEE_VERIFICATION_REQUIRED`; `capabilities()` flags these platforms with
  `requiresIdentityAttestation: true`.

The client selects a curator with its environment. Preproduction defaults to
`https://api-preprod.zkp2p.xyz`, staging defaults to
`https://api-staging.zkp2p.xyz`, and `curatorUrl` remains available as an
explicit override.

## Failure table

| Code                                    | Retryable | What happened / what to do                                                                                                                   |
| --------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORACLE_UNSUPPORTED_CURRENCY`           | no        | Currency has no Chainlink feed. Pick from `capabilities()`.                                                                                  |
| `ORACLE_READ_FAILED`                    | yes       | The live Chainlink read failed. Retry through a healthy Base RPC; do not present a cached value as live.                                     |
| `UNSUPPORTED_PLATFORM`                  | no        | Platform is absent from this environment's catalog. Pick from `capabilities()`.                                                              |
| `UNSUPPORTED_PLATFORM_CURRENCY`         | no        | The platform does not support that currency. Use its `capabilities()` currencies.                                                            |
| `AMOUNT_BELOW_MINIMUM`                  | no        | Amount is below the $0.01 hard floor. The recommended minimum is 1 USDC.                                                                     |
| `INVALID_INTENT_AMOUNT_RANGE`           | no        | Min/max is non-positive, inverted, or exceeds the deposit. Correct the range.                                                                |
| `PAYEE_VERIFICATION_REQUIRED`           | no        | A new Wise/PayPal payee needs an attestation. Register it through Peer first; an existing registration can be reused.                        |
| `PAYEE_REGISTRATION_FAILED`             | yes       | Curator rejected the handle or was unavailable. Check `payeeHint` and retry.                                                                 |
| `SOURCE_ROUTE_UNSUPPORTED_IN_PREPARE`   | no        | `prepare()` accepts Base USDC only. Use signed source execution, or complete Relay first and then prepare the Base cashout.                  |
| `SOURCE_RECIPIENT_MISMATCH`             | no        | Relay output recipient differs from the cashout depositor. Use the depositor address.                                                        |
| `SOURCE_CAPABILITIES_FAILED`            | yes       | Relay source discovery failed. Retry or use Base USDC.                                                                                       |
| `SOURCE_QUOTE_FAILED`                   | yes       | Relay returned no valid canonical Base-USDC route. Refresh capabilities and quote again.                                                     |
| `SOURCE_NONCE_MANAGER_REQUIRED`         | no        | Preflight; nothing was submitted. Recreate the source signer with viem's `nonceManager` and execute a fresh quote.                           |
| `SOURCE_EXECUTION_FAILED`               | no        | Route execution did not report success. Inspect source transactions and Relay status before retrying.                                        |
| `SOURCE_STATUS_FAILED`                  | yes       | Relay status is temporarily unavailable. Retry the status read without resubmitting.                                                         |
| `SOURCE_ROUTE_COMPLETED_CASHOUT_FAILED` | no        | Relay completed but no Base cashout was created. Use the recovery amount for a Base-USDC-only retry; never repeat Relay.                     |
| `SOURCE_CASHOUT_SUBMISSION_UNKNOWN`     | no        | Relay completed but Base submission returned no hash. Inspect wallet activity and orders before any retry.                                   |
| `SOURCE_CASHOUT_STATUS_UNKNOWN`         | no        | Relay completed and the Base tx was submitted, but its receipt is unknown. Inspect `depositTxHash`; do not resubmit while status is unknown. |
| `INSUFFICIENT_TOKEN_BALANCE`            | no        | Wallet lacks the required token amount. Fund it, then retry.                                                                                 |
| `ALLOWANCE_NOT_VISIBLE`                 | yes       | Approval mined but a stale RPC replica hid it. Retry the same call after the allowance becomes visible.                                      |
| `TRANSACTION_FAILED`                    | no        | The on-chain call failed or reverted. Inspect the cause and transaction before another action.                                               |
| `TRANSACTION_SUBMISSION_UNKNOWN`        | no        | A Base mutation returned no hash but may have broadcast. Inspect wallet/protocol state and its recovery action before any retry.             |
| `TRANSACTION_STATUS_UNKNOWN`            | no        | A transaction was submitted but its receipt is unknown. Inspect `recovery.transactionHash` before resubmitting.                              |
| `DEPOSIT_RESOLUTION_FAILED`             | no        | Base tx succeeded but no `DepositReceived` was decoded. Inspect its logs and recover the composite id.                                       |
| `INVALID_DEPOSIT_ID`                    | no        | The id is not `escrowAddress_onchainId`. A bare number cannot cold-hydrate; use the value returned by `cashout()`.                           |
| `ORDER_NOT_FOUND`                       | yes       | Unknown id or immediate indexer lag. Verify the id and retry shortly after creation.                                                         |
| `INDEXER_LAG`                           | yes       | Indexer trails the chain. Retry the read shortly.                                                                                            |
| `INDEXER_UNAVAILABLE`                   | yes       | The indexer read failed. Retry only that read with the same id or owner; never repeat an on-chain transaction.                               |
| `ACTIVE_INTENT_BLOCKS_WITHDRAWAL`       | yes       | A buyer may still deliver. Wait for fill or expiry, or withdraw only the unlocked amount.                                                    |
| `INSUFFICIENT_AVAILABLE_FUNDS`          | yes       | Partial withdrawal exceeds unlocked funds. Lower the amount.                                                                                 |
| `NOTHING_TO_WITHDRAW`                   | no        | Order is terminal. Reconcile `order(depositId)`.                                                                                             |
| `ORDER_NOT_ACTIVE`                      | no        | A closed order cannot be topped up. Start a new cashout.                                                                                     |
| `SIGNER_REQUIRED`                       | no        | Pass a signer or use a Base-USDC `prepare*` path.                                                                                            |
| `SIGNER_CHAIN_MISMATCH`                 | no        | Switch the signer to the required chain and refresh any Relay quote before retrying.                                                         |
| `SIGNER_CHAIN_UNAVAILABLE`              | yes       | The wallet could not report its live chain. Reconnect it and prove the required chain before retrying.                                       |
| `WATCH_TIMEOUT`                         | yes       | Order remains live. Resume `watch()` or `order()` later.                                                                                     |
| `ESCROW_PAUSED`                         | yes       | Deposits are paused. Existing funds remain withdrawable.                                                                                     |
