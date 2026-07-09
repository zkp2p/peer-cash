# @zkp2p/cash

Route any Relay-supported source asset into Base USDC, then cash out to fiat
on Venmo, Revolut, Wise, Zelle, and more at the live Chainlink market rate,
with zero spread and no centralized off-ramp provider.

Peer Cash is an **offramp-only** SDK for the [ZKP2P](https://peer.xyz)
protocol. The cashing-out user is the maker: their USDC becomes a
protocol-held deposit, Peer handles the buyer side, and the SDK gives the
integrator a small set of typed verbs plus readable order state. No hosted
widget, no provider custody, no quote engine to maintain.

**[Live demo](https://react-cashout-demo.vercel.app)** · **[Product page](https://peer.xyz/cash)**

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
    amount: 100000n, // source-token base units
    source: { chainId: 1, currency: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
    receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@you' } },
  },
  { signer },
);
// source.amount is the Base USDC amount Relay delivered before the cash-out order.
```

## The core verbs

| Verb                                                           | What it does                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `capabilities()`                                               | Sync discovery: Base USDC destination/default source, platforms × currencies × payee hints × amount bounds                      |
| `capabilities({ includeRelaySources: true })`                  | Async discovery: adds live Relay SDK source chains/tokens                                                                       |
| `quoteSource(input)` / `executeSourceQuote(quote, { signer })` | Relay SDK source routing into Base USDC before cashout                                                                          |
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
transaction does before signing. Source-routed cashout runs Relay first, so it
uses the signed `cashout({ source }, { signer })` path or an explicit
`quoteSource()` / `executeSourceQuote()` pre-step. Every Peer Cash transaction
including approves carries ERC-8021 attribution: `peer-cash` first, your own
`referrer` code(s) after it.

The default/minimal flow is unchanged: pass Base USDC base units to
`estimate()` and `cashout()`. For any other source asset, pass `source` to
`cashout()` and the SDK first executes the Relay route into Base USDC, then
creates the Peer Cash order. The destination is always canonical Base USDC
(`8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`); source support is
discovered and quoted by `@relayprotocol/relay-sdk`, not a static token
allowlist.

`capabilities()` tells you which platforms need a verified identity to
register a payee (`requiresIdentityAttestation` - Wise and PayPal today); a
bare-handle `cashout()` to those fails fast with `PAYEE_VERIFICATION_REQUIRED`
rather than reverting on-chain.

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
  by rolling 7-day indexer data from deposit creation to first fulfilled fill.
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

`production` | `preproduction` | `staging` - selects contracts, curator, and
indexer. Indexer, curator, and Relay options are overridable via
`createCashClient` options. Base USDC on Base is the default source and the
only destination asset for cashout orders.

## Install

```sh
npm install @zkp2p/cash viem
```

## Examples

Runnable first-party examples in [`examples/`](examples):

- [`node-cashout.ts`](examples/node-cashout.ts) - server-side cash-out with a private-key signer, plus order tracking.
- [`agent-tool-use.ts`](examples/agent-tool-use.ts) - wiring the verbs into an agent tool-use loop with host-side signing.

## Trust model, honestly

This SDK is open source, so the code that constructs the parameters moving
your USDC into protocol-held funds is auditable. It depends on the published
`@zkp2p/sdk` for protocol internals, which currently ships from private source.
The Peer Cash facade is verifiable here; the dependency is not yet fully open.
Onchain custody is still enforced by the protocol: only the contract holds
funds, and only you can withdraw an unmatched deposit.

## License

MIT
