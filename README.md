# @zkp2p/cash

Route any Relay-supported EVM source asset into Base USDC, then cash out to fiat
on Venmo, Revolut, Wise, Zelle, and more at the live Chainlink market rate,
with zero spread and no centralized off-ramp provider.

Peer Cash is an **offramp-only** SDK for the [ZKP2P](https://peer.xyz)
protocol. The cashing-out user is the maker: their USDC becomes a deposit in
the protocol contracts, a buyer pays them fiat and proves the payment, and the
SDK gives the integrator a small set of typed verbs plus readable order state.
No hosted widget, no provider custody, no quote engine to maintain.

**[npm](https://www.npmjs.com/package/@zkp2p/cash)** · **[Lifecycle and recovery](docs/lifecycle-and-recovery.md)** · **[Agent integration manual](AGENTS.md)**

## Pick the right SDK

Peer Cash and the general ZKP2P SDK serve different integration depths:

| Package       | Use it when                                       | Boundary                                                                                                                                                                                  |
| ------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@zkp2p/cash` | Cash-out is the product                           | Offramp only. The user is always the maker, the destination is Base USDC, pricing is the live Chainlink rate at fill with zero spread, and the SDK owns the resumable order lifecycle.    |
| `@zkp2p/sdk`  | You are composing directly with the Peer protocol | General maker and taker operations, deposits, intents, proofs, quotes, vaults, rate managers, referrals, hooks, and API helpers. Your application owns the workflow and protocol choices. |

Peer Cash is a narrow facade over `@zkp2p/sdk`, not a replacement for it. It
cannot express custom spreads, buyer-side proof flows, vaults, disputes, or
arbitrary protocol operations.

```ts
import { createCashClient, usdc } from '@zkp2p/cash';

const cash = createCashClient({ environment: 'production' });

const est = await cash.estimate({ amount: usdc(1000), currency: 'USD' });
// { rate: 1, receiveAmount: 1000, kind: 'oracle-estimate', eta: { seconds, label } }
// "≈", never a locked quote. Base USDC remains the default source.

const { depositId } = await cash.cashout(
  {
    amount: usdc(1000),
    receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@you' } },
  },
  { signer }, // any viem WalletClient on Base
);

for await (const order of cash.watch(depositId)) {
  console.log(order.state, order.explain());
  if (order.state === 'delivered') break;
}
```

Source asset path:

```ts
const { depositId, source } = await cash.cashout(
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
```

## The core verbs

| Verb                                                           | What it does                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `capabilities()`                                               | Sync discovery: Base USDC destination/default source, platforms × currencies × payee hints × amount bounds                      |
| `capabilities({ includeRelaySources: true })`                  | Async discovery: adds live Relay SDK EVM source chains/tokens                                                                   |
| `quoteSource(input)` / `executeSourceQuote(quote, { signer })` | Relay SDK EVM source routing into Base USDC before cashout                                                                      |
| `relayStatus(requestId)`                                       | Relay request status from the Relay SDK request path                                                                            |
| `estimate({ amount, currency })`                               | Base USDC oracle estimate plus simple recent-fill ETA                                                                           |
| `cashout(input, { signer })`                                   | Registers your payee, creates the protocol-held order, returns the `depositId`                                                  |
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
cashout. Every Peer Cash transaction, including approves, carries ERC-8021
attribution: `peer-cash` first, your own `referrer` code(s) after it.

The default/minimal flow is unchanged: pass Base USDC base units to
`estimate()` and `cashout()`. For any other source asset, pass `source` to
`cashout()` with a source-chain signer. The SDK settles the Base allowance,
executes the Relay route into Base USDC, then creates the Peer Cash order. Use
`EXACT_INPUT` in cash-out UIs so `amount` always means source-token base units.
The destination is always canonical Base USDC
(`8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`); source support is
discovered and quoted by `@relayprotocol/relay-sdk`, not a static token
allowlist.

Routes that submit more than one source-chain transaction (approve, then
route) require a nonce-managed source signer -
`privateKeyToAccount(pk, { nonceManager })` from viem. Without one the SDK
refuses the route preflight with `SOURCE_NONCE_MANAGER_REQUIRED` instead of
letting the route transaction reuse the approval's nonce and revert
mid-route. Browser wallets are unaffected.

`capabilities()` tells you which platforms need a verified identity for a new
payee registration (`requiresIdentityAttestation` - Wise and PayPal today).
An already-registered Wise or PayPal handle can be reused with bare payee data.
A new handle without its signed attestation fails during curator registration
with `PAYEE_VERIFICATION_REQUIRED`, before funds move on-chain.

## Source-route recovery

Persist `depositId`, transaction hashes, and the Relay `requestId` as soon as
they are available. A source-routed result includes both a flat
`source.txHashes` list and chain-aware `source.transactions.origin` /
`.destination` entries.

- `SOURCE_EXECUTION_FAILED` where only the approval landed: the Relay request
  can stay in `relayStatus` `waiting` indefinitely. Decide from the error's
  recovery payload and origin transactions, never by waiting for a terminal
  Relay status.
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
  by rolling 30-day indexer data from zero-spread (`spreadBps: 0`) market-rate
  deposits in the same payout corridor, measured from deposit creation to first
  fulfilled fill.
- **Everything is resumable.** An order is reconstructed from the chain by
  `depositId` alone. Close the tab, switch devices, crash the process - then
  call `order(depositId)`.
- **Unwind is one verb.** Buyer never paid? Their intent expires; `withdraw()`
  prunes it and returns your USDC. You never choose between cancel and recover.

Deep dive: [docs/lifecycle-and-recovery.md](docs/lifecycle-and-recovery.md).

## For agents

- `cashout`/`withdraw`/`topUp` have unsigned counterparts (`prepare`,
  `prepareWithdraw`, `prepareTopUp`) - inspect readable `steps[]` and calldata
  before signing, then submit the matching `txs[]` in order.
- Mutating tool calls return unsigned transactions by default; signing stays
  with the host that owns custody, policy, and user approval.
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

## Install

```sh
npm install @zkp2p/cash viem
```

## Examples

Runnable first-party examples in [`examples/`](examples):

- [`node-cashout.ts`](examples/node-cashout.ts) - server-side cash-out with a private-key signer, plus order tracking.
- [`agent-tool-use.ts`](examples/agent-tool-use.ts) - wiring the verbs into an agent tool-use loop with host-side signing.

## Trust model, honestly

The published package depends on `@zkp2p/sdk` for protocol internals; that
dependency currently ships from private source. Onchain custody is enforced by
the protocol: only the contract holds funds, and only the maker can withdraw
an unmatched deposit.

## License

MIT
