# @zkp2p/cash

Cash out Base USDC to fiat — Venmo, Revolut, Wise, Zelle, and more — at the
live Chainlink market rate, with zero spread, non-custodially.

Peer Cash is an **offramp-only** SDK for the [ZKP2P](https://peer.xyz)
protocol. Your USDC sits in an audited escrow contract until a buyer pays you
fiat and proves it cryptographically (TEE-TLS). No account, no KYC form, no
custodian. Six verbs cover the whole lifecycle.

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

## The six verbs

| Verb                                 | What it does                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| `capabilities()`                     | Sync discovery: platforms × currencies × payee format hints × amount bounds    |
| `estimate({ amount, currency })`     | Live oracle rate — no payee, no side effects, idempotent                       |
| `cashout(input, { signer })`         | Registers your payee, creates the escrow deposit, returns the `depositId`      |
| `prepare(input)`                     | Same as cashout but returns unsigned `txs[]` — agent wallets, AA, server keys  |
| `order(depositId)` / `orders(owner)` | Resume any order from its id alone; list all orders for a wallet               |
| `watch(depositId)`                   | Async iterator: yields on every state change until terminal, abort, or timeout |
| `withdraw(depositId, { signer })`    | The ONE unwind verb — prunes expired intents first when needed                 |

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
  with `spreadBps: 0` — the best offer on the book, by construction.
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

- `cashout`/`withdraw` have unsigned counterparts (`prepare`,
  `prepareWithdraw`) — inspect calldata before signing, sign anywhere.
- Every error carries `code`, `retryable`, and a `remediation` sentence.
- Every order carries `nextActions: ('wait' | 'withdraw')[]` — no heuristics.
- Every wire type has a zod schema + JSON codec — state crosses process
  boundaries losslessly.
- `@zkp2p/cash/tools` exports a JSON-schema tool manifest of the six verbs.

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
your money into escrow is auditable. It depends on the published `@zkp2p/sdk`
for protocol internals, which currently ships from private source — the
non-custodial claim is verifiable here, and the dependency's claim is not
(yet). Escrow custody is on-chain either way: only the escrow contract holds
funds, and only you can withdraw an unmatched deposit.

## License

MIT
