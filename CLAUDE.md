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
  identity attestation for a new registration. The SDK accepts but does not
  mint it; first-party Peer web obtains it through the Peer TEE browser
  extension. A previously registered bare handle can be reused.
- **Restricted cash-outs finish sequentially.** If any payout leg uses Venmo,
  Cash App, or PayPal, attach the canonical four-group policy after the deposit
  confirms. Preserve `accessPolicyRequired`, `depositId`, and any policy hash.
  Never repeat the cash-out after a policy failure; inspect an existing policy
  transaction before resubmitting.
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
GitHub Actions runs the identical gate (`bun install --frozen-lockfile && bun
run ci`) on Node 22; a PR is mergeable only when it is green.

## Testing

`test/` uses vitest. The engine has golden-file coverage: every state
transition, partial fills, dust. Client verbs are tested against mocked
`Zkp2pClient` surfaces. Never call live networks from unit tests; the staging
regression lives in `scripts/verify-staging.ts` and runs maker-side only.

## Pull requests

- Branch as `type/short-description`; commit and PR titles use conventional
  prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `chore(deps):`).
- When the public surface changes, update every consumer-facing artifact in
  the same PR: the README verb table, `AGENTS.md`, `llms.txt`,
  `skills/peer-cash-integration/SKILL.md`, `examples/`, and the codecs
  (`src/codecs/` schema + JSON codec + tests). Doc drift is a defect, not a
  follow-up.
- `AGENTS.md` is the _shipped integrator manual_ for agents using the package;
  this file (`CLAUDE.md`) is the contributor entry point. Keep that split.

## Dependency policy

- `@zkp2p/sdk` is pinned exact and adopted deliberately via its own PR
  (`chore(deps): bump @zkp2p/sdk to X.Y.Z`). Everything else uses caret
  ranges; refresh them with `bun update` and a green `bun run ci`.
- viem is a peer dependency (`>=2.37.3 <3`); never move it into
  `dependencies`. React stays an optional peer, and nothing outside
  `src/react/` may import it.
- Hold a toolchain major (TypeScript, ESLint) until typescript-eslint and
  tsup verify against it; a version bump the gate cannot typecheck is not an
  upgrade.

## Releasing and publishing

1. Release PRs are titled `chore: release @zkp2p/cash X.Y.Z` and change only
   the `version` field in `package.json`. Pre-1.0 semver: minor for breaking
   surface changes, patch otherwise; release candidates use `-rc.N`. There are
   no git tags and no changelog file - history lives in the PR titles.
2. Merge the release PR, then publish from a clean checkout of that commit:
   `bun install --frozen-lockfile && bun run ci && npm publish`. `prepack`
   rebuilds `dist/`; publishing is manual and maintainer-only (no CI publish
   job). `npm view @zkp2p/cash maintainers` lists who can.
3. The packed artifact ships exactly the package.json `files` allowlist:
   `dist/`, `docs/`, `examples/`, `skills/`, `AGENTS.md`, `README.md`,
   `LICENSE`, `llms.txt`. `scripts/check-packed-package.ts` (part of
   `bun run ci`) fails if a required file is missing or a forbidden one
   (`test/`, `scripts/`, lockfiles, `.env*`) leaks in.
4. An agent without publish rights stops at the merged release PR and hands
   off to a maintainer.
