# @zkp2p/cash

Route Relay-supported EVM assets or NEAR Intents 1Click external deposits into
Base USDC, then cash out to fiat on Venmo, Revolut, Wise, Zelle, and more at the
live Chainlink market rate, with zero spread and no centralized off-ramp
provider.

Peer Cash is an **offramp-only** SDK for the [ZKP2P](https://peer.xyz)
protocol. The cashing-out user is the maker: their USDC becomes a deposit in
the protocol contracts, a buyer pays them fiat and proves the payment, and the
SDK gives the integrator a small set of typed verbs plus readable order state.
No hosted widget, no provider custody, no quote engine to maintain.

**[npm](https://www.npmjs.com/package/@zkp2p/cash)** · **[Lifecycle and recovery](docs/lifecycle-and-recovery.md)** · **[Agent integration manual](AGENTS.md)**

## Install

```sh
npm install @zkp2p/cash viem
```

## Quickstart

```ts
import { createCashClient, usdc } from '@zkp2p/cash';

const cash = createCashClient({ environment: 'production' });

const est = await cash.estimate({ amount: usdc(1000), currency: 'USD' });
// { rate: 1, receiveAmount: 1000, kind: 'oracle-estimate', eta: { seconds, label } }
// "≈", never a locked quote. Base USDC remains the default source.

// Progressive UI: render rate/receive first, then resolve the exact pair ETA.
const rateOnly = await cash.estimate(
  { amount: usdc(1000), currency: 'USD' },
  { includeEta: false },
);
const fillStats = await cash.fillStats();
const pairStats = fillStats['venmo:USD'];
const multiCurrencyStats = fillStats['revolut:EUR+GBP+USD'];

const { depositId, accessPolicyTxHashes } = await cash.cashout(
  {
    amount: usdc(1000),
    receive: { platform: 'venmo', currency: 'USD', payee: '@you' },
  },
  { signer }, // any viem WalletClient on Base, including an EOA
);
// Venmo, Cash App, and PayPal return only after their access policy confirms.
console.log(depositId, accessPolicyTxHashes);

// One method can offer several currencies. The buyer chooses the fill
// currency, and each option resolves at its own live oracle rate.
const fastFill = await cash.cashout(
  {
    amount: usdc(1000),
    receive: {
      platform: 'revolut',
      currencies: ['EUR', 'GBP', 'USD'],
      payee: { offchainId: 'revtag' },
    },
  },
  { signer },
);

// One order can also offer several platforms (each at most once). The buyer
// picks the leg they can pay; every leg fills at the live oracle market rate.
const widestReach = await cash.cashout(
  {
    amount: usdc(1000),
    receive: [
      { platform: 'venmo', currency: 'USD', payee: '@you' },
      { platform: 'revolut', currencies: ['EUR', 'GBP'], payee: { offchainId: 'revtag' } },
    ],
  },
  { signer },
);

for await (const order of cash.watch(depositId)) {
  console.log(order.state, order.explain());
  if (order.state === 'delivered') break;
}
```

## Pick the right SDK

Peer Cash and the general ZKP2P SDK serve different integration depths:

| Package       | Use it when                                       | Boundary                                                                                                                                                                                  |
| ------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@zkp2p/cash` | Cash-out is the product                           | Offramp only. The user is always the maker, the destination is Base USDC, pricing is the live Chainlink rate at fill with zero spread, and the SDK owns the resumable order lifecycle.    |
| `@zkp2p/sdk`  | You are composing directly with the Peer protocol | General maker and taker operations, deposits, intents, proofs, quotes, vaults, rate managers, referrals, hooks, and API helpers. Your application owns the workflow and protocol choices. |

Peer Cash is a narrow facade over `@zkp2p/sdk`, not a replacement for it. It
cannot express custom spreads, buyer-side proof flows, vaults, disputes, or
arbitrary protocol operations.

## The core verbs

| Verb                                                           | What it does                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `capabilities()`                                               | Sync discovery: Base USDC destination/default source, platforms × currencies × payee hints × amount bounds                      |
| `capabilities({ includeRelaySources: true })`                  | Async discovery: adds live Relay SDK EVM source chains/tokens                                                                   |
| `capabilities({ includeNearIntentsSources: true })`            | Async discovery: adds live NEAR Intents 1Click source assets                                                                    |
| `fillStats()`                                                  | Cached 30-day fill counts and median first-fill time per exact `platform:currency` pair or sorted multi-currency set            |
| `quoteSource(input)` / `executeSourceQuote(quote, { signer })` | Relay SDK EVM source routing into Base USDC before cashout                                                                      |
| `relayStatus(requestId)`                                       | Relay request status from the Relay SDK request path                                                                            |
| `quoteNearIntentsSource(input)`                                | Signed 1Click quote with an origin-chain deposit address and optional memo                                                      |
| `submitNearIntentsDeposit(input)` / `nearIntentsStatus(input)` | Optionally register an origin tx, then track 1Click delivery/refund evidence                                                    |
| `estimate({ amount, currency }, { includeEta? })`              | Base USDC oracle estimate; optionally skip the historical ETA for progressive rendering                                         |
| `cashout(input, { signer })`                                   | Creates the order with any viem wallet; restricted methods then attach the Peer Pay merchant policy                             |
| `prepare(input)` / `finalizePreparedCashout(receipt)`          | Prepare external signing, resolve the deposit, then iterate `accessPolicyPaymentMethods` for follow-ups                         |
| `prepareAccessPolicy(depositId, paymentMethod)`                | Prepare one post-deposit, method-scoped Peer Pay merchant policy transaction                                                    |
| `order(depositId)` / `orders(owner)`                           | Resume any order from its id alone; list all orders for a wallet                                                                |
| `watch(depositId)`                                             | Async iterator: yields on every state change until terminal, abort, or timeout                                                  |
| `withdraw(depositId, { signer, amount? })`                     | The ONE unwind verb - partial with an `amount` (live intents don't block it), full close without (prunes expired intents first) |
| `topUp(depositId, amount, { signer })`                         | Add USDC to a live order - same payee, same market rate                                                                         |
| `buyer(address)`                                               | A buyer's track record from their intent history - who just matched your order?                                                 |

Base-USDC cashout, withdraw, and top-up have unsigned counterparts (`prepare`,
`prepareWithdraw`, `prepareTopUp`). The unsigned path returns raw `txs[]` plus
a same-index `steps[]` plan such as `approve`, `createDeposit`, or
`withdrawDeposit`, so wallets, AA systems, and agents can show what each
transaction does before signing. `prepare()` is Base-USDC-only and rejects a
`source` with `SOURCE_ROUTE_UNSUPPORTED_IN_PREPARE`. A signer-backed app can
use `cashout({ source }, { signer, sourceSigner })`; a custody-separated host
must execute and confirm its Relay route before preparing the Base-USDC
cashout. After externally executing a prepared `createDeposit`, pass its
confirmed receipt to `finalizePreparedCashout()` to recover the same
`CashoutResult` shape as `cashout()` without importing protocol ABIs. Every
Peer Cash transaction, including approves, carries ERC-8021 attribution:
`peer-cash` first, optional `peer-ref-XXXXXX` from `referralCode` next, and your
analytics-only `referrer` code(s) after it.

Order reads fail closed against the same active catalog. If any method on an
indexed deposit is unsupported, `orders()` excludes the whole deposit and
`order()` returns `ORDER_NOT_FOUND`; Peer Cash never partially reclassifies a
mixed historical deposit.

## Payout rails and access policies

| Payout rail           | Access-policy behavior                                                     | New payee registration                                                                 |
| --------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Venmo / Cash App      | Peer Pay merchant policy attaches for that payment method                  | Curator validates the live handle                                                      |
| PayPal                | Same method-scoped Peer Pay follow-up                                      | Requires a Peer TEE browser-extension identity attestation                             |
| Wise                  | No access-policy follow-up                                                 | Requires a Peer TEE browser-extension identity attestation                             |
| Other supported rails | No access-policy follow-up; use `capabilities()` for currencies and format | Follow the `payeeHint`; live-validation behavior is described in the integration guide |

No platform requires an atomic access-policy flow. `cashout()` and `prepare()`
work with any viem `WalletClient`, including a local or externally connected
EOA; no Privy wallet or signer API is required. The deprecated
`requiresAtomicAccessPolicy` capability remains for wire compatibility and is
always `false`.

Venmo, Cash App, and PayPal cash-outs restrict intent signaling to the Peer Pay
merchant group by default. Each restricted payout method gets its own policy.
Signed `cashout()` creates the deposit first, then uses the same wallet to
submit and confirm every required policy transaction; this intentionally
leaves a brief non-atomic interval. Prepared integrations receive
`accessPolicyPaymentMethods`; after confirming `createDeposit`, call
`finalizePreparedCashout(receipt)`, then submit
`prepareAccessPolicy(depositId, paymentMethod)` once for every returned method.
Other platforms do not need the follow-up.

If policy attachment fails, `ACCESS_POLICY_CONFIGURATION_FAILED.recovery`
identifies the existing deposit and any submitted policy transaction. Never
create another cash-out. When `recovery.transactionHash` is present, inspect
that transaction before resubmitting; otherwise prepare the policy again with
the same depositor wallet.

`capabilities()` presents Zelle as one platform. A cashout with
`receive.platform: 'zelle'` attaches only the generic Zelle payment method to
the deposit. Bank-specific capture routing is outside this maker-side SDK and
never changes the on-chain payment method.

`capabilities()` tells you which platforms need a verified identity for a new
payee registration (`requiresIdentityAttestation` - Wise and PayPal today).
The SDK accepts an `identityAttestation` in structured payee data but does not
mint one. First-party Peer web obtains it through the Peer TEE browser
extension. An already-registered Wise or PayPal handle can be reused with bare
payee data. A new handle without its signed attestation fails during curator
registration with `PAYEE_VERIFICATION_REQUIRED`, before funds move on-chain.

## Source routing

### Relay (signed EVM route)

The default/minimal flow is unchanged: pass Base USDC base units to
`estimate()` and `cashout()`. For any other source asset, pass `source` to
`cashout()` with a source-chain signer. The SDK settles the Base allowance,
executes the Relay route into Base USDC, then creates the Peer Cash order. Use
`EXACT_INPUT` in cash-out UIs so `amount` always means source-token base units.
The destination is always canonical Base USDC
(`8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`); source support is
discovered and quoted by `@relayprotocol/relay-sdk`, not a static token
allowlist.

```ts
const { depositId, accessPolicyTxHashes, source } = await cash.cashout(
  {
    amount: 10_000_000n, // exact input: 10 USDC in source-token base units
    source: {
      chainId: 1,
      currency: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      tradeType: 'EXACT_INPUT',
    },
    receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@you' } },
  },
  { signer, sourceSigner },
);

// source.amount is Relay's guaranteed minimum Base USDC output and the exact
// amount deposited into the cash-out order. It is not the route's actual output.
console.log(source?.amount, source?.requestId);
console.log(source?.transactions?.origin, source?.transactions?.destination);
console.log(accessPolicyTxHashes); // one entry because this example uses Venmo
```

Routes that submit more than one source-chain transaction (approve, then
route) require a nonce-managed source signer -
`privateKeyToAccount(pk, { nonceManager })` from viem. Without one the SDK
refuses the route preflight with `SOURCE_NONCE_MANAGER_REQUIRED` instead of
letting the route transaction reuse the approval's nonce and revert
mid-route. Browser wallets are unaffected.

### NEAR Intents (external-deposit route)

NEAR Intents 1Click supports non-EVM origins such as Zcash, so the SDK does
not pretend a viem wallet can execute the source transfer. It returns a signed
quote with an origin-chain `depositAddress` and optional `depositMemo`; your
wallet sends exactly once, then the SDK tracks the provider route into
canonical Base USDC. Use `EXACT_OUTPUT` when the Peer order amount must be
known before the origin send.

```ts
const cash = createCashClient({
  environment: 'production',
  nearIntents: {
    // Browser-safe same-origin proxy; it keeps the 1Click JWT server-side.
    apiUrl: '/api/v1/near',
    transport: 'proxy',
  },
});

const sources = await cash.capabilities({ includeNearIntentsSources: true });
const zec = sources.source.nearIntents?.assets.find((asset) => asset.symbol === 'ZEC');
const quote = await cash.quoteNearIntentsSource({
  sourceAsset: zec!.assetId,
  amount: 1_000_000n, // exact 1 Base USDC output
  recipient: baseSigner.account.address,
  refundTo: transparentZcashRefundAddress,
  tradeType: 'EXACT_OUTPUT',
  deadline: new Date(Date.now() + 3 * 60_000).toISOString(),
});

persist(quote); // before sending: address, memo, signed response, deadline
const originTxHash = await zcashWallet.send(quote.depositAddress!, quote.inputAmount);
await cash.submitNearIntentsDeposit({
  depositAddress: quote.depositAddress!,
  ...(quote.depositMemo ? { depositMemo: quote.depositMemo } : {}),
  txHash: originTxHash,
});
const route = await cash.nearIntentsStatus({
  depositAddress: quote.depositAddress!,
  ...(quote.depositMemo ? { depositMemo: quote.depositMemo } : {}),
  expectedQuote: quote,
});
// On SUCCESS, reconcile the Base receipt/balance, then call Base-only cashout().
```

Direct server integrations may pass `nearIntents: { token }`. Browser code
must use a same-origin proxy and must never receive the 1Click JWT. Never reuse
an expired deposit address, resend funds after an uncertain wallet submission,
or infer success from a wallet-wide balance alone. If optional deposit
registration fails, retry only `submitNearIntentsDeposit()` with the same hash;
1Click can also detect the transfer on-chain.

## Source-route recovery

Persist `depositId`, transaction hashes, and the Relay `requestId` as soon as
they are available. A source-routed result includes both a flat
`source.txHashes` list and chain-aware `source.transactions.origin` /
`.destination` entries.

- `SOURCE_EXECUTION_FAILED` where only the approval landed: the Relay request
  can stay in `relayStatus` `waiting` indefinitely. Decide from the error's
  recovery payload and origin transactions, never by waiting for a terminal
  Relay status.
- `SOURCE_DEPOSIT_SUBMISSION_FAILED`: the NEAR Intents origin transaction may
  already be final. Retry only the provider notification with the same address
  and hash; never resend source funds.
- `SOURCE_ROUTE_COMPLETED_CASHOUT_FAILED`: Relay completed, but the Base
  cashout was not created. Do not route again. Retry a Base-USDC-only
  `cashout()` with `BigInt(error.recovery.amount)`.
- `SOURCE_CASHOUT_SUBMISSION_UNKNOWN`: Relay completed, but Base submission
  returned no transaction hash. Inspect recent Base wallet activity and
  `orders(error.recovery.depositor)` to prove no deposit exists before retrying.
- `SOURCE_CASHOUT_STATUS_UNKNOWN`: the Base cashout transaction was submitted,
  but its receipt is unknown. Do not route or submit again. Inspect
  `error.recovery.depositTxHash`; recover the `depositId` from its
  `DepositReceived` log if it succeeded, or use the recovery amount for a
  Base-USDC-only retry only after confirming it reverted.
- `TRANSACTION_SUBMISSION_UNKNOWN`: a Base-only cashout or another mutation
  returned no hash. Treat it as potentially broadcast. Inspect recent Base
  wallet activity and the supplied recovery action before any retry.
- `ACCESS_POLICY_CONFIGURATION_FAILED`: the deposit exists, but its required
  Venmo, Cash App, or PayPal policy was not confirmed. Do not cash out again;
  inspect `recovery.transactionHash` when present, then retry
  `prepareAccessPolicy(error.recovery.depositId, error.recovery.paymentMethod)`
  only if the prior policy
  transaction did not succeed.

Wallet clients pinned to the wrong chain fail with `SIGNER_CHAIN_MISMATCH`
before a quote or transaction is submitted. Chainless wallets are checked
through `getChainId()`; a disconnected wallet returns retryable
`SIGNER_CHAIN_UNAVAILABLE`. Indexer and oracle transport outages are typed as
retryable `INDEXER_UNAVAILABLE` and `ORACLE_READ_FAILED` reads; retry the read
without repeating any transaction. `TRANSACTION_STATUS_UNKNOWN` carries the
submitted hash in `error.recovery.transactionHash` so recovery never depends
on parsing an error message.

## Lifecycle

```
            buyer signals            fiat proven
awaiting-buyer ──────────► matched ──────────► delivered
      │                       │    (partial fills pass through "delivering")
      │ withdraw()            │ buyer never pays → intent expires
      ▼                       ▼ withdraw() prunes + returns funds
   returned ◄─────────────────┘
```

- **You are the maker.** Your deposit is priced by the live Chainlink oracle
  with `spreadBps: 0`, making it the best price a rational maker can offer.
- **There is no quote.** The binding rate resolves at the oracle when a buyer
  fills. `estimate()` says "approximately"; nothing in this API pretends to
  lock a price.
- **ETA is historical.** `estimate().eta` is just `{ seconds, label }`, backed
  by the same rolling 30-day, intent-attributed pair sampler as `fillStats()`,
  measured from deposit creation to the first fulfilled fill through the pair.
  The raw snapshot is cached for 15 minutes per client and each ETA is still
  resolved from its exact normalized `platform:currency` key. Multi-currency
  deposits also produce sorted keys such as `revolut:EUR+GBP+USD`, measured to
  the first fill in any offered currency. Use
  `{ includeEta: false }` when rate and receive amount should render first.
- **Availability thresholds belong to the consumer.** `fillStats()` returns raw
  evidence. A recommended gate is `fills >= 10 && medianFillSeconds <= 48h`.
  Fail open to the full `capabilities()` catalog when stats are unavailable or
  the gate would empty the offered catalog.
- **Everything is resumable.** An order is reconstructed from the chain by
  `depositId` alone. Close the tab, switch devices, crash the process - then
  call `order(depositId)`.
- **Unwind is one verb.** Buyer never paid? Their intent expires; `withdraw()`
  prunes it and returns your USDC. You never choose between cancel and recover.

Deep dive: [docs/lifecycle-and-recovery.md](docs/lifecycle-and-recovery.md).

## Earn the integration share

Use the same six-character referral code shown in your Peer mobile or web app.
No API key, registration transaction, or separate receiving address is needed:
the referral code already belongs to your Peer Privy wallet.

```ts
const cash = createCashClient({
  environment: 'production',
  referralCode: 'ABC123',
});
```

The SDK normalizes the value and stamps `peer-ref-ABC123` into ERC-8021
attribution on the deposit transaction. When that liquidity is filled, Curator
pays the code owner 50 bps, capped by the configured Peer service fee. This is
the deposit-level integration path: it replaces the maker L1/L2 referral split
for that deposit instead of enrolling the cashing-out user as your referee.

The mapping is permanent. If you later customize your displayed Peer referral
code, open deposits carrying the old code still pay the same wallet. Include at
most one `peer-ref-XXXXXX` marker; an unknown or conflicting marker receives no
integration share. The existing `referrer` option remains available for
analytics-only ERC-8021 codes such as `acme-app`.

## For agents

- `cashout`/`withdraw`/`topUp` have unsigned counterparts (`prepare`,
  `prepareWithdraw`, `prepareTopUp`) - inspect readable `steps[]` and calldata
  before signing, then submit the matching `txs[]` in order.
- Mutating tool calls return unsigned transactions by default; signing stays
  with the host that owns custody, policy, and user approval.
- After a prepared restricted cash-out confirms, the host adapter must call
  `finalizePreparedCashout(receipt)` and submit
  `prepareAccessPolicy(depositId, paymentMethod)` for every value in
  `accessPolicyPaymentMethods`; these receipt/signing operations are
  `CashClient` methods, not built-in tool calls.
- Every error carries `code`, `retryable`, and a `remediation` sentence.
- Every order carries `nextActions: ('wait' | 'withdraw')[]` - no heuristics.
- Every wire type has a zod schema + JSON codec - state crosses process
  boundaries losslessly.
- Everything arrives decoded: platform ids and currency codes instead of
  bytes32 hashes, plain-number rates instead of 1e18 bigints.
- Fills are receipts: the locked rate and fiat owed at signal, then the
  verified fiat paid, currency, platform payment id, released USDC, and
  fill latency once the proof lands.
- `@zkp2p/cash/tools` exports a JSON-schema tool manifest of the verbs.

Start at [AGENTS.md](AGENTS.md), or load the
[`peer-cash-integration` skill](skills/peer-cash-integration/SKILL.md).

## React

```ts
import { useEstimate, useCashout, useOrder, useOrders } from '@zkp2p/cash/react';
```

React is an optional peer dependency - the root entry never imports it.

## Environments

`production` | `preproduction` | `staging` selects contracts, curator, and
indexer. Preproduction defaults to `https://api-preprod.zkp2p.xyz`; staging
defaults to `https://api-staging.zkp2p.xyz`. Indexer, curator, and Relay
options remain overridable via `createCashClient` options. Base USDC on Base
is the default source and the only destination asset for cashout orders.

## Examples

Runnable first-party examples in [`examples/`](examples):

- [`node-cashout.ts`](examples/node-cashout.ts) - server-side cash-out with a private-key signer, plus order tracking.
- [`agent-tool-use.ts`](examples/agent-tool-use.ts) - wiring the verbs into an agent tool-use loop with host-side signing.
- [`carpe-diem-provider-cashout`](examples/carpe-diem-provider-cashout) - cash out confirmed Carpe Diem provider DIEM revenue through the connected Base wallet.
- [`mpp-merchant-cashout`](examples/mpp-merchant-cashout) - turn confirmed MPP merchant revenue into an unsigned Peer Cash plan while the merchant keeps custody and signing.
- [`onchain-demo`](examples/onchain-demo) - the Peer Cash Demo: the express sell flow as one page that bundles the SDK and is stored on Base as contract bytecode, served by an immutable ERC-5219 wrapper,
  [live on Base](https://basescan.org/address/0x6d6c7af86bfc6f49f32761e1718cf982224cf343).

## Trust model, honestly

The published package depends on `@zkp2p/sdk` for protocol internals; that
dependency currently ships from private source. Onchain custody is enforced by
the protocol: only the contract holds funds, and only the maker can withdraw
an unmatched deposit.

## Contributing

[CLAUDE.md](https://github.com/zkp2p/peer-cash/blob/main/CLAUDE.md) is the
contributor guide: ground rules, repo layout, the `bun run ci` gate, and the
release/publish process. `AGENTS.md` is the shipped manual for agents using
the package, not the contributor entry point.

## License

MIT
