# @zkp2p/cash

Cash out Base USDC to fiat on Venmo, Revolut, Wise, Zelle, and more at the
live Chainlink market rate, with zero spread and no custodial off-ramp provider.

Peer Cash is an **offramp-only** SDK for the [ZKP2P](https://peer.xyz)
protocol. Your USDC is secured by the protocol until a buyer pays you fiat and
proves the payment with TEE-TLS. No hosted widget, no provider custody, no
separate Peer identity flow. Eight verbs cover the whole lifecycle.

```ts
import { createCashClient, usdc } from '@zkp2p/cash';

const cash = createCashClient({ environment: 'production' });

const est = await cash.estimate({ amount: usdc(1000), currency: 'USD' });
// { rate: 1, receiveAmount: 1000, kind: 'oracle-estimate' } — "≈", never a locked quote

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

## The eight verbs

| Verb                                       | What it does                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `capabilities()`                           | Sync discovery: platforms × currencies × payee format hints × amount bounds                                                     |
| `estimate({ amount, currency })`           | Live oracle rate — no payee, no side effects, idempotent                                                                        |
| `cashout(input, { signer })`               | Registers your payee, creates the protocol-held order, returns the `depositId`                                                  |
| `prepare(input)`                           | Same as cashout but returns unsigned `txs[]` — agent wallets, AA, server keys                                                   |
| `order(depositId)` / `orders(owner)`       | Resume any order from its id alone; list all orders for a wallet                                                                |
| `watch(depositId)`                         | Async iterator: yields on every state change until terminal, abort, or timeout                                                  |
| `withdraw(depositId, { signer, amount? })` | The ONE unwind verb — partial with an `amount` (live intents don't block it), full close without (prunes expired intents first) |
| `topUp(depositId, amount, { signer })`     | Add USDC to a live order — same payee, same market rate                                                                         |
| `buyer(address)`                           | A buyer's track record from their intent history — who just matched your order?                                                 |

Every mutating verb has an unsigned counterpart (`prepare`, `prepareWithdraw`,
`prepareTopUp`), and every transaction — including approves — carries ERC-8021
attribution: `peer-cash` first, your own `referrer` code(s) after it, so
onchain analytics can segment cash flow end to end.

`capabilities()` tells you which platforms need a verified identity to
register a payee (`requiresIdentityAttestation` — Wise and PayPal today); a
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
  with `spreadBps: 0`, making it the best offer on the book by construction.
- **There is no quote.** The binding rate resolves at the oracle when a buyer
  fills. `estimate()` says "approximately"; nothing in this API pretends to
  lock a price.
- **Everything is resumable.** An order is reconstructed from the chain by
  `depositId` alone. Close the tab, switch devices, crash the process — then
  call `order(depositId)`.
- **Unwind is one verb.** Buyer never paid? Their intent expires; `withdraw()`
  prunes it and returns your USDC. You never choose between cancel and recover.

Deep dive: [docs/lifecycle-and-recovery.md](docs/lifecycle-and-recovery.md).

## For agents

- `cashout`/`withdraw`/`topUp` have unsigned counterparts (`prepare`,
  `prepareWithdraw`, `prepareTopUp`) — inspect calldata before signing, sign
  anywhere.
- Every error carries `code`, `retryable`, and a `remediation` sentence.
- Every order carries `nextActions: ('wait' | 'withdraw')[]` — no heuristics.
- Every wire type has a zod schema + JSON codec — state crosses process
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

React is an optional peer dependency — the root entry never imports it.

## Environments

`production` | `preproduction` | `staging` — selects contracts, curator, and
indexer. Indexer and curator URLs are overridable via `createCashClient`
options. v1 is same-chain only: Base USDC in.

## Install

```sh
npm install @zkp2p/cash viem
```

## Trust model, honestly

This SDK is open source, so the code that constructs the parameters moving
your USDC into protocol-held funds is auditable. It depends on the published
`@zkp2p/sdk` for protocol internals, which currently ships from private source.
The Peer Cash facade is verifiable here; the dependency is not yet fully open.
Onchain custody is still enforced by the protocol: only the contract holds
funds, and only you can withdraw an unmatched deposit.

## License

MIT
