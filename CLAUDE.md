# @zkp2p/cash - contributor guide

Peer Cash is an offramp-only SDK: route any Relay-supported source asset into
Base USDC, then cash out Base USDC to fiat at the live Chainlink oracle market
rate (0% spread, always). It is a thin facade over the published `@zkp2p/sdk`
plus `@relayprotocol/relay-sdk`. Minimal is judged at the API surface, not the
dependency tree.

## Ground rules

- **Offramp only.** `cashout` is the only mutating product verb. No onramp
  vocabulary anywhere in code, types, or docs.
- **Base USDC is the only destination.** The default path is same-chain Base
  USDC. Source assets come from Relay SDK metadata and quote execution; do not
  add static chain/token allowlists. High-level cash-out examples use
  `EXACT_INPUT`: `amount` is source-token base units, and `source.amount` is
  Relay's guaranteed minimum Base USDC output and the exact deposit amount,
  not the route's actual output.
- **No rate control.** `spreadBps: 0` is a constant, not a parameter. The API
  must remain physically unable to express rate/spread configuration,
  buyer-side operations, disputes, SAR, vaults/DRM, or corridor gating.
- **`estimate`, never `quote`.** There is no committed rate; the binding rate
  resolves at the Chainlink oracle when a buyer fills. Anything that implies a
  locked price is a bug.
- **ETA is indexer-derived.** `estimate().eta` is `{ seconds, label }` backed
  by rolling 30-day data from deposit creation to first fill. Do not use
  signal-to-fulfillment latency as the ETA.
- **Serializable wire types.** Every public wire type has a zod schema and
  JSON codec in `src/codecs/`. New public types must ship with both.
- **One unwind verb.** `withdraw(depositId)` is state-aware (prunes expired
  intents first when needed). Never split it back into cancel/recover.
- **Source recovery is explicit.** Preserve Relay request IDs and chain-aware
  transaction hashes. A completed route followed by a failed Base cashout
  retries Base-only; a submission without a hash or an unknown Base receipt
  must be inspected before any resubmission.
- **Payee attestation is registration-scoped.** Wise and PayPal require an
  identity attestation for a new registration, but a previously registered
  bare handle can be reused.
- **Environment owns curator routing.** Preproduction defaults to
  `https://api-preprod.zkp2p.xyz`, staging to
  `https://api-staging.zkp2p.xyz`; retain explicit `curatorUrl` overrides.
- **The chain is the database.** No storage layer. Orders derive from the
  indexer by `depositId`; resumability from the id alone is an invariant.

## Layout

- `src/engine/` — pure, deterministic logic (state derivation, deposit-param
  construction, receipt parsing). No I/O. Ported from the reviewed reference
  implementation; keep it dependency-light and fully unit-tested.
- `src/client/` — `createCashClient` facade over a read-only `Zkp2pClient`,
  Relay SDK source routing, the verbs, typed errors.
- `src/codecs/` — zod schemas + JSON (de)serialization for every wire type.
- `src/tools/` — JSON-schema tool manifest of the verbs for agent runtimes.
- `src/react/` — optional hooks (`useEstimate`, `useCashout`, `useOrder`,
  `useOrders`). React is an optional peer dep; nothing outside `src/react/`
  may import it.

## Commands

bun is the package manager. `bun run ci` is the full gate:
typecheck → lint → format:check → test → production audit → build → packed
artifact compatibility check. Run it before every commit that touches `src/`.

## Testing

`test/` uses vitest. The engine has golden-file coverage: every state
transition, partial fills, dust. Client verbs are tested against mocked
`Zkp2pClient` surfaces. Never call live networks from unit tests; the staging
regression lives in `scripts/verify-staging.ts` and runs maker-side only.
