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
   the plan, submit the transactions in order, and wait for each receipt. After
   `createDeposit` confirms, pass its receipt to `finalizePreparedCashout()` and
   persist the returned `depositId`.
3. **You are a tool-use host** (MCP server, CLI) → import the manifest from
   `@zkp2p/cash/tools` and map the tool names to the verbs above. Base-USDC
   mutating tools return unsigned transactions. `cash_source_quote` is a quote,
   not an execution tool; the host must execute and confirm Relay through its
   signer/runtime, use `cash_source_status` to monitor it, then call the
   Base-USDC `cash_cashout` tool. Never pass `source` into `prepare()`.

Every transaction (including approves) carries ERC-8021 attribution:
`peer-cash`, then any `referrer` codes from `createCashClient` options, then
the Base builder code.

**Two platform caveats, both surfaced in `capabilities()`:**

- **Wise and PayPal** carry `requiresIdentityAttestation: true`. A new curator
  registration needs a signed maker identity attestation this SDK cannot mint
  (it comes from the Peer app/extension). An already-registered handle can be
  reused with bare payee data. A new handle without its attestation fails with
  `PAYEE_VERIFICATION_REQUIRED` before funds move on-chain.
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

// Progressive UI: do not let indexer-backed history hold up the oracle rate.
const rateOnly = await cash.estimate({ amount: usdc(500), currency: 'EUR' }, { includeEta: false });

// Optional: raw demand + speed evidence per offered platform:currency pair.
const stats = await cash.fillStats();

// 3. Execute.
const { depositId } = await cash.cashout(
  {
    amount: usdc(500),
    receive: { platform: 'revolut', currency: 'EUR', payee: 'revtag' },
  },
  { signer },
);

// Faster matching: one Revolut method, three live-oracle currency options.
const multiCurrency = await cash.cashout(
  {
    amount: usdc(500),
    receive: {
      platform: 'revolut',
      currencies: ['EUR', 'GBP', 'USD'],
      payee: { offchainId: 'revtag' },
    },
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

Signed source route (exact-input cash-out):

```ts
const routed = await cash.cashout(
  {
    amount: sourceAmount, // source-token base units
    source: {
      chainId: sourceChainId,
      currency: sourceToken,
      tradeType: 'EXACT_INPUT',
    },
    receive,
  },
  { signer, sourceSigner },
);

// Guaranteed minimum Base USDC and exact order deposit amount, not actual route output.
console.log(routed.source?.amount);
console.log(routed.source?.transactions?.origin, routed.source?.transactions?.destination);
```

## Rules that prevent wrong behavior

- **Never promise a rate.** `estimate()` is `kind: 'oracle-estimate'`; the
  binding rate resolves at the oracle when a buyer fills. Do not display or
  log it as a locked price.
- **Do not invent an ETA.** Use `estimate().eta`: `{ seconds, label }` backed
  by the same rolling 30-day, intent-attributed pair sample as `fillStats()`,
  measured from deposit creation to first fill. Use `order.explain()` for live
  order state. For progressive UIs, call `estimate(..., { includeEta: false })`
  and load `fillStats()["platform:CURRENCY"]` separately. The SDK caches the
  raw snapshot for 15 minutes, but never substitutes another pair's data.
- **Do not hardcode Relay source assets.** Use Relay SDK-backed EVM
  `capabilities({ includeRelaySources: true })` and `cashout({ source, ... })`.
  Destination is always Base USDC. Non-Base source chains require
  `sourceSigner`. Use `EXACT_INPUT` in high-level cash-out flows so `amount`
  remains source-token base units. `source.amount` is Relay's guaranteed
  minimum output and the exact Base USDC deposit amount.
- **Use a nonce-managed source signer for routed cashouts.** Relay routes
  with more than one source-chain transaction (approve, then route) are
  refused preflight with `SOURCE_NONCE_MANAGER_REQUIRED` on plain local
  accounts - create the source signer with
  `privateKeyToAccount(pk, { nonceManager })`. Browser (`json-rpc`) wallets
  are unaffected.
- **Persist source evidence.** A routed result carries `requestId`, flat
  `txHashes`, and chain-aware `transactions.origin` / `.destination` arrays.
- **Never repeat a completed or uncertain route.** On `SOURCE_EXECUTION_FAILED`,
  inspect its Relay request and transaction recovery evidence. A failed
  approval-only route can sit in `relayStatus` `waiting` indefinitely - decide
  from the recovery payload and origin transactions, never by waiting for a
  terminal Relay status. On
  `SOURCE_ROUTE_COMPLETED_CASHOUT_FAILED`, retry without `source` using
  `BigInt(err.recovery.amount)`. On `SOURCE_CASHOUT_SUBMISSION_UNKNOWN`, inspect
  Base wallet activity and `orders(err.recovery.depositor)`. On
  `SOURCE_CASHOUT_STATUS_UNKNOWN`, inspect
  `err.recovery.depositTxHash`; do not submit again until its receipt is known.
- **Never resubmit an unknown Base transaction.**
  `TRANSACTION_SUBMISSION_UNKNOWN` means a call returned no hash but may have
  broadcast; follow its recovery action and inspect wallet/protocol state.
  `TRANSACTION_STATUS_UNKNOWN` means the returned hash may already have
  succeeded. Inspect `err.recovery.transactionHash` first.
- **`ORDER_NOT_FOUND` seconds after `cashout()` is indexer lag**, not a lost
  deposit. The tx receipt you hold is the truth. Retry; `watch()` absorbs
  this automatically.
- **Unwind with `withdraw()` only.** It is state-aware (prunes expired
  intents first). Do not call escrow functions directly. Partial withdrawals
  increment `returnedAmount`; `totalAmount` is historical and never shrinks.
- **Read fills as receipts.** `fiatOwed` is the buyer's obligation at the
  locked rate; after the proof, `fiatPaid`/`paymentId`/`releasedAmount` are
  the verified outcome. Reconcile against those, not your own math.
- **Check the buyer during `matched`.** `buyer(address)` (tool: `cash_buyer`)
  returns their fulfilled/pruned history and success rate - surface it
  instead of a raw address.
- **Serialize with the codecs.** `orderToJson`/`orderFromJson` etc. round-trip
  bigints losslessly and re-attach `explain()`. Plain `JSON.stringify` on a
  live object throws on bigints.
- **Environment selects the curator.** Preproduction defaults to
  `https://api-preprod.zkp2p.xyz`; staging defaults to
  `https://api-staging.zkp2p.xyz`. Use `curatorUrl` only for an explicit
  override.

## Error → remediation table

Every `CashError` carries `code`, `retryable`, `remediation`. Behavior:

| Code                                    | Retryable | Agent action                                                                               |
| --------------------------------------- | --------- | ------------------------------------------------------------------------------------------ |
| `ORACLE_UNSUPPORTED_CURRENCY`           | no        | Re-pick currency from `capabilities()`                                                     |
| `ORACLE_READ_FAILED`                    | yes       | Retry the read through a healthy Base RPC; do not present a cached value as live           |
| `UNSUPPORTED_PLATFORM`                  | no        | Re-pick platform from `capabilities()`                                                     |
| `UNSUPPORTED_PLATFORM_CURRENCY`         | no        | Use a currency listed for that platform                                                    |
| `AMOUNT_BELOW_MINIMUM`                  | no        | Raise amount (hard floor $0.01, recommended at least 1 USDC)                               |
| `INVALID_INTENT_AMOUNT_RANGE`           | no        | Use a positive min, max at least min, and max no greater than amount                       |
| `INVALID_PAYOUT_CURRENCIES`             | no        | Pass one or more unique currencies listed for the platform                                 |
| `PAYEE_VERIFICATION_REQUIRED`           | no        | Register a new Wise/PayPal payee through Peer; an existing registered handle can be reused |
| `PAYEE_REGISTRATION_FAILED`             | yes       | Validate against `payeeHint`, then retry                                                   |
| `SOURCE_ROUTE_UNSUPPORTED_IN_PREPARE`   | no        | Execute Relay with a signer first, then prepare a Base-USDC cashout                        |
| `SOURCE_RECIPIENT_MISMATCH`             | no        | Route Base USDC to the cashout depositor                                                   |
| `SOURCE_CAPABILITIES_FAILED`            | yes       | Retry discovery or fall back to Base USDC                                                  |
| `SOURCE_QUOTE_FAILED`                   | yes       | Refresh capabilities and request a new canonical Base-USDC quote                           |
| `SOURCE_NONCE_MANAGER_REQUIRED`         | no        | Preflight; recreate the source signer with viem's `nonceManager`, then quote again         |
| `SOURCE_EXECUTION_FAILED`               | no        | Inspect source transactions and Relay status before any retry                              |
| `SOURCE_STATUS_FAILED`                  | yes       | Retry only the status read                                                                 |
| `SOURCE_ROUTE_COMPLETED_CASHOUT_FAILED` | no        | Do not route again; retry Base-only with `recovery.amount`                                 |
| `SOURCE_CASHOUT_SUBMISSION_UNKNOWN`     | no        | Inspect Base activity and orders; prove no deposit exists before retrying                  |
| `SOURCE_CASHOUT_STATUS_UNKNOWN`         | no        | Inspect `recovery.depositTxHash`; do not resubmit while its receipt is unknown             |
| `INSUFFICIENT_TOKEN_BALANCE`            | no        | Fund the required token amount, then retry                                                 |
| `ALLOWANCE_NOT_VISIBLE`                 | yes       | Approval mined but a stale RPC hid it; retry after it becomes visible                      |
| `TRANSACTION_REJECTED`                  | yes       | Retry when ready and approve the wallet request                                            |
| `TRANSACTION_FAILED`                    | no        | Inspect the failed/reverted call before another action                                     |
| `TRANSACTION_SUBMISSION_UNKNOWN`        | no        | Inspect Base wallet/protocol state and the recovery action before any resubmission         |
| `TRANSACTION_STATUS_UNKNOWN`            | no        | Inspect `recovery.transactionHash` before resubmitting                                     |
| `DEPOSIT_RESOLUTION_FAILED`             | no        | Inspect the confirmed Base receipt and recover the id from `DepositReceived`               |
| `INVALID_DEPOSIT_ID`                    | no        | Use the exact id returned by `cashout()`                                                   |
| `ORDER_NOT_FOUND`                       | yes       | Retry through immediate indexer lag; otherwise verify the id                               |
| `INDEXER_LAG`                           | yes       | Retry after a few seconds                                                                  |
| `INDEXER_UNAVAILABLE`                   | yes       | Retry only the failed read; keep the id/owner and never repeat a transaction               |
| `ACTIVE_INTENT_BLOCKS_WITHDRAWAL`       | yes       | Wait for fill/expiry, or withdraw only the unlocked amount                                 |
| `INSUFFICIENT_AVAILABLE_FUNDS`          | yes       | Lower the partial withdrawal amount                                                        |
| `NOTHING_TO_WITHDRAW`                   | no        | Order is terminal; reconcile records                                                       |
| `ORDER_NOT_ACTIVE`                      | no        | Start a new cashout instead of topping up                                                  |
| `SIGNER_REQUIRED`                       | no        | Provide a signer or use a Base-USDC prepare path                                           |
| `SIGNER_CHAIN_MISMATCH`                 | no        | Switch to the required chain and refresh any Relay quote before retrying                   |
| `SIGNER_CHAIN_UNAVAILABLE`              | yes       | Reconnect the wallet and prove its chain before retrying                                   |
| `WATCH_TIMEOUT`                         | yes       | Resume `watch(depositId)` later                                                            |
| `ESCROW_PAUSED`                         | yes       | Back off; existing funds remain withdrawable                                               |

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
