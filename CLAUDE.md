# @zkp2p/cash contributor guide

Peer Cash is an offramp-only facade over `@zkp2p/sdk` plus Relay and NEAR
Intents adapters. It routes supported assets into canonical Base USDC and
creates a zero-spread maker deposit. `AGENTS.md` is the shipped integrator
manual; this file owns contributor rules.

## Product invariants

- `cashout` is the only product mutation. Do not add onramp, buyer, dispute,
  vault, rate-control, or arbitrary contract surfaces.
- Base USDC is the only destination. Source support comes from live provider
  metadata and quotes, not static chain or token allowlists.
- `spreadBps: 0` is constant. Say `estimate`, never quote; the binding
  Chainlink rate resolves when a buyer fills.
- `withdraw(depositId)` is the single unwind verb and handles pruning.
- Every public wire type has a zod schema and lossless JSON codec.
- The chain and indexer own state. `depositId` alone must resume an order.
- Preserve route request IDs, transaction evidence, and unknown-outcome
  boundaries. Never turn an uncertain submission into an automatic retry.
- NEAR Intents remains an external-deposit flow. The caller sends once; browser
  credentials stay behind the same-origin proxy.
- Wise and PayPal identity attestations apply to new payee registration. Cash
  accepts but does not mint them.
- Venmo and PayPal require one method-scoped Peer Pay policy after deposit
  confirmation. Prepared hosts iterate `accessPolicyPaymentMethods`. Never
  recreate a deposit after policy failure.
- Access restriction and stake-backed dispute protection are separate. Venmo
  and PayPal currently have nonzero risk windows and default-on protection.
  Cash App is non-chargebackable, stays public, and does not require stake.
- Environment selects Curator: production, preproduction, or staging. Preserve
  explicit `curatorUrl` overrides.

## Layout

- `src/engine/`: deterministic state, deposit params, and receipt parsing; no I/O.
- `src/client/`: client facade, source routing, verbs, and typed errors.
- `src/codecs/`: schemas and JSON codecs.
- `src/tools/`: JSON-schema agent manifest.
- `src/react/`: optional hooks. Nothing outside it may import React.

## Verification

Bun owns the lockfile. `bun run ci` is the merge gate: typecheck, lint, format,
tests, production audit, build, and packed-artifact checks. Unit tests are
hermetic; maker-side live coverage belongs in `scripts/verify-staging.ts`.

When the public surface changes, update README, `AGENTS.md`, `llms.txt`, the
integration skill, examples, schemas/codecs, and tests in the same PR.

## Dependencies and releases

- Pin `@zkp2p/sdk` exactly and adopt it deliberately. Keep viem as
  `>=2.37.3 <3` peer dependency and React optional.
- Release PRs change only `package.json` version and use
  `chore: release @zkp2p/cash X.Y.Z`. Pre-1.0 breaking changes bump minor;
  compatible changes bump patch; candidates use `-rc.N`.
- After the release PR merges, publish from a clean checkout with
  `bun install --frozen-lockfile && bun run ci && npm publish`. Publishing is
  manual and maintainer-only; there are no release tags.
- The packed allowlist is `dist/`, `docs/`, `examples/`, `skills/`,
  `AGENTS.md`, `README.md`, `LICENSE`, and `llms.txt`. Do not ship tests,
  scripts, lockfiles, or environment files.

Use conventional imperative PR and commit subjects. Keep changes focused and
update tests with behavior.
