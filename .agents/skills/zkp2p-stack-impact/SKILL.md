---
name: zkp2p-stack-impact
description: End-to-end ZKP2P stack impact workflow for upstream and downstream feature changes across contracts, attestation-service, zkp2p-indexer, curator-owned provider templates/APIs, zkp2p-clients SDK/web/extension, pay, zkp2p-mobile app plus embedded React Native SDK, indexer proxies, CLIs/SDK products, admin dashboards, support tooling, support/docs surfaces, and notification consumers. Use when adding or changing payment methods, attestation routes, provider templates, contracts package versions, indexer schema/entities/events, curator APIs, SDK exports, proof or verification flows, support-visible behavior, or any change that may require coordinated downstream PRs.
---

# ZKP2P Stack Impact

Use this skill before finishing any change that can affect another ZKP2P repo.
The goal is to prevent dropped downstream work while still allowing one-shot
features across the whole stack.

Core rule: do not stop at the current repo for a stack-affecting change. Produce
an impact report, identify downstream PRs, then ask the developer whether to
create them unless the user already asked for one-shot or full-stack execution.

## Current Graph

The active core stack is:

```text
zkp2p-contracts
  -> attestation-service
  -> zkp2p-indexer -> curator -> zkp2p-clients -> pay
                               -> zkp2p-mobile
                               -> peer-cash / peer-cli / miniapps
                               -> PeerHQ/admin dashboards
                 -> zkp2p-indexer-proxy -> public/private GraphQL consumers
                 -> signal-dispatcher -> notifications/ops automations
                 -> notification-server

attestation-service -> curator -> zkp2p-clients -> pay
                    -> zkp2p-mobile
                    -> zkp2p-support-bot / dispute tooling

curator provider templates/API
  -> zkp2p-clients extension/web proof capture
  -> zkp2p-mobile/packages/zkp2p-react-native-sdk proof capture
  -> pay platform/rail availability when checkout behavior changes
  -> support/docs/support-bot prompts when behavior is user-visible

product, support, fee, platform, or error semantics
  -> support private help center
  -> docs public developer/protocol docs
  -> zkp2p-support-bot prompts, tools, and runbooks
```

Deprecated repos:

- `providers` is archived/deprecated. Provider template ownership now lives in
  `curator` under `src/api/providers/**` and the hosted `/providers` and
  `/providers/mobile` endpoints.
- Standalone `zkp2p-react-native-sdk` is archived/deprecated. The active React
  Native SDK lives inside `zkp2p-mobile/packages/zkp2p-react-native-sdk`.

## Stack Map

| Repo | Role | Upstream inputs | Downstream consumers |
| --- | --- | --- | --- |
| `zkp2p-contracts` | Public contracts package, ABIs, addresses, constants, payment-method catalogs, deployment metadata. | Solidity/deploy changes. | `attestation-service`, `zkp2p-indexer`, `curator`, `zkp2p-clients`, `pay`, `zkp2p-mobile`, `notification-server`. Skip PRs here unless explicitly requested. |
| `attestation-service` | Verifies payment proofs, signs EIP-712 attestations, owns buyer TEE and seller credential attestation surfaces, publishes `@zkp2p/zkp2p-attestation`. | `@zkp2p/contracts-v2`, payment app behavior, Curator provider templates, Nitro deployment config. | `curator`, `zkp2p-clients` SDK/extension/web, `pay`, `zkp2p-mobile` embedded RN SDK/app. |
| `zkp2p-indexer` | Envio event ingestion, GraphQL entities, webhook/event payloads, and published `@zkp2p/indexer-schema`. | `@zkp2p/contracts-v2`, contract events, deployment config. | `curator`, `zkp2p-clients`, `pay` analytics/admin flows, `notification-server`, `signal-dispatcher`, `zkp2p-indexer-proxy`, support bot, CLIs/SDK products, miniapps, and dashboards. |
| `curator` | Quotes, maker/taker APIs, seller verification, credential store, indexer-backed API aggregation, provider template hosting at `/providers` and `/providers/mobile`. | `@zkp2p/indexer-schema`, `@zkp2p/contracts-v2`, `@zkp2p/zkp2p-attestation`, attestation-service behavior, payment app/provider behavior. | `zkp2p-clients`, `pay`, `zkp2p-mobile`, PeerHQ/admin tools, support/admin workflows. |
| `zkp2p-clients` | Web app, browser extension, public `@zkp2p/sdk`, `@zkp2p/core`, and React hooks. | Contracts, indexer schema, curator APIs/provider templates, attestation-service routes/package. | Web users, extension, `pay`, `zkp2p-mobile` embedded RN SDK via `@zkp2p/sdk`, external SDK consumers. |
| `pay` | Merchant checkout/API surfaces using curator, attestation-service, and `@zkp2p/sdk`. | `@zkp2p/sdk`, curator APIs, attestation-service verification shape, contracts. | Merchants, checkout users, support workflows. |
| `zkp2p-mobile` | Peer mobile app plus active `packages/zkp2p-react-native-sdk` workspace for mobile proof capture, attestation helpers, and SDK wrapping. | Embedded RN SDK package, `@zkp2p/sdk`, `@zkp2p/zkp2p-attestation`, contracts, curator `/providers/mobile` and APIs, attestation-service URL/routing. | App releases, mobile users, published mobile SDK package when released from this monorepo. |
| `notification-server` | Push notification service consuming indexer webhooks/GraphQL and contract address metadata. | Indexer webhook payloads/schema, indexer GraphQL, `@zkp2p/contracts-v2`. | Mobile/web notifications and notification workflows. |
| `zkp2p-indexer-proxy` | Express GraphQL proxy for the Envio indexer with auth, quotas, fixtures, and x402 paid overflow. | Indexer GraphQL URL, schema, root fields, error shape, fixtures, payment method fixture metadata. | Public/private indexer API consumers, dashboards, miniapps, CLIs, and external integrators. |
| `signal-dispatcher` | Generic event dispatcher/orchestrator for upstream domain events. | Indexer GraphQL/client behavior, chain events, deposit/intent state semantics. | Notification workflows, ops automations, downstream action dispatch. |
| `zkp2p-support-bot` | Slack support and ops bot with read tools for Pay DB, Curator DB, indexer GraphQL, SDK viewer, PostHog, logs, and Notion KB. | `@zkp2p/sdk`, indexer GraphQL queries, Curator/Pay DB schemas, Curator API/config, attestation response shape, support runbooks. | Support agents, incident/debug workflows, Slack commands, automated triage/evals. |
| `support` | Private user-support/help center site. | User-visible product behavior, fees, rails, app/platform availability, screenshots/copy, error/remediation semantics. | Customer support articles and troubleshooting flows. |
| `docs` | Public developer/protocol docs. | SDK, contracts, attestation, provider, Pay/offramp, and mobile SDK behavior. | External developers, integrators, agent/LLM docs. Public repo; include in reports and create PRs only when requested or explicitly in scope. |
| `peer-cash` | Public-facing cash-out SDK/facade over `@zkp2p/sdk`. | `@zkp2p/sdk`, curator payee registration, indexer deposit/intent aggregates, identity-attestation requirements, payment methods. | Cash-out integrators and React/Node SDK users. |
| `peer-cli` | CLI/MCP surface over `@zkp2p/sdk`, ProtocolViewer, indexer reads, curator payee registration, and proof/attestation fulfillment commands. | `@zkp2p/sdk`, indexer schema/root fields, curator registration behavior, attestation fulfillment shape, contract/payment method catalogs. | Internal and external CLI users, docs, MCP tools. |
| `PeerHQ-Admin` | Private control-plane dashboard that mirrors Curator Prisma schema and reads indexer payout/tier state. | Curator DB schema/migrations, Curator runtime config semantics, indexer GraphQL payout/tier queries. | Ops/admin users; sometimes paired Curator PRs are required first. |
| `protocol-dashboard`, `SAR-dashboard`, `arm-dashboard`, `orderbook-dashboard`, `zkp2p-dispute-resolution-dashboard`, `internal-dashboard`, `zkp2p-admin` | Private operational dashboards. | Curator APIs/DB mirrors, indexer GraphQL fields, attestation/relayer semantics, contract addresses, env names. | Ops, SAR monitoring, ARM/feed monitoring, orderbook, disputes, and admin workflows. |
| `zkp2p-miniapps-monorepo` | Miniapps/offramp frontends and order tracking services. | Curator/Pay/zkp2p API behavior, indexer deposits/order polling, provider/platform support, webhook processing. | TBA/World miniapp users and miniapp support workflows. |
| `earnmo` | Liquidity/deposit management UI. | Indexer deposit/orderbook reads, market intel, contracts/payment method state. | Liquidity operators. |
| `zkp2p-relayer` | Shared OpenZeppelin Relayer configuration for Pay and Curator transaction submission. | Contract addresses/whitelists, signer/relayer IDs, chain env, Pay/Curator transaction flow. | Pay signal/fulfill relays and Curator guardian operations. |
| `protocol` | Private monorepo mirror/consolidation of contracts, indexer, attestation-service, curator, providers, and indexer-proxy code. | Same core stack surfaces as the split repos. | Protocol migration work and copied package/service code. Treat as affected when changes are authored there or need to be mirrored. |

## Trigger Matrix

Treat these as downstream-impact triggers:

- Provider template, provider manifest, payment app parser, header/cookie,
  mobile capture, or metadata changes: inspect `curator/src/api/providers/**`,
  `zkp2p-clients` extension/web capture code, `zkp2p-mobile/packages/zkp2p-react-native-sdk`,
  mobile app payment platform config, and Pay checkout support when platform
  availability or merchant-visible rails change.
- Attestation route, action type, platform key, response shape, error code,
  signer, typed-data, nullifier, release amount, metadata, or package export
  changes: inspect `curator`, `zkp2p-clients` SDK/extension/web, `pay`, and
  `zkp2p-mobile` embedded RN SDK/app. Also inspect `zkp2p-support-bot` and
  `zkp2p-dispute-resolution-dashboard` when attestation responses, proof
  resubmission, or support/debug tooling can observe the changed shape.
- Contract package, deployment address, ABI, event, payment method, verifier,
  hook, fee, or oracle changes: inspect `zkp2p-indexer`, attestation-service
  contract resolution, curator contract usage, SDK/core, pay, mobile embedded
  SDK/app, `peer-cash`, `peer-cli`, `zkp2p-relayer` when relayer whitelists or
  signer flows are affected, and `notification-server`/`signal-dispatcher` when
  events/webhooks or address matching are affected.
- Indexer entity, GraphQL schema, enum, webhook event, field naming, or
  published `@zkp2p/indexer-schema` changes: inspect curator typed consumers,
  clients SDK/core/indexer queries, pay/admin analytics, `notification-server`,
  `signal-dispatcher`, `zkp2p-indexer-proxy` fixtures/query assumptions,
  `zkp2p-support-bot`, `peer-cash`, `peer-cli`, miniapps, PeerHQ/admin
  dashboards, and other dashboards that read those fields.
- Curator API request/response/status/auth/quote/verify/provider changes:
  inspect `zkp2p-clients`, `pay`, `zkp2p-mobile`, `peer-cash`, `peer-cli`,
  miniapps, PeerHQ/admin dashboards, `zkp2p-support-bot`, `support`, and docs
  if public or support-visible API behavior changes.
- SDK exports, package versions, or runtime URL/routing defaults: inspect
  `pay`, `zkp2p-mobile`, `peer-cash`, `peer-cli`, `zkp2p-support-bot`,
  extension/web callers, external SDK docs, and mobile's embedded RN SDK if the
  mobile runtime wraps or re-exports the changed surface.
- Curator Prisma schema, control-plane table, platform/rail toggle, fee,
  tier, API key, referral, blocklist, or global-config changes: inspect
  `PeerHQ-Admin` first, then `support`, `zkp2p-support-bot`, dashboards, `pay`,
  `zkp2p-mobile`, and `zkp2p-clients` when user-visible behavior changes.
- Support-visible error text, remediation, platform availability, screenshots,
  fee/currency copy, SLA expectations, or troubleshooting flow changes:
  inspect `support`, public `docs`, `zkp2p-support-bot` prompts/runbooks/evals,
  `pay` support surfaces, and mobile/web copy.
- Operational dashboard, proxy, CLI, miniapp, or support tool changes:
  identify the exact upstream boundary they consume before planning PRs. For
  example, `zkp2p-indexer-proxy` is affected by GraphQL schema/transport and
  fixture assumptions; `peer-cash`/`peer-cli` are affected by SDK/indexer/curator
  API changes; dashboards are affected by Curator DB/API and indexer fields.
- Private `protocol` monorepo changes: inspect whether the same change must be
  mirrored to the split repo (`attestation-service`, `zkp2p-indexer`, `curator`,
  `zkp2p-indexer-proxy`, or `zkp2p-contracts`) or whether the split repo is the
  source of truth and `protocol` is stale context.

## Workflow

1. Identify the current repo with `git remote get-url origin` and `pwd`.
2. Read local repo guidance first: `AGENTS.md`, `CLAUDE.md`, `.claude/*.md`,
   or existing relevant skills.
3. Inspect the proposed change or diff. Use `rg` for boundary terms such as
   `@zkp2p/contracts-v2`, `@zkp2p/indexer-schema`,
   `@zkp2p/zkp2p-attestation`, `@zkp2p/sdk`,
   `@zkp2p/zkp2p-react-native-sdk`, `packages/zkp2p-react-native-sdk`,
   `src/api/providers`, `/providers/mobile`, `configBaseUrl`,
   `PROVIDER_TEMPLATE_API_ROOT`, `attestationServiceUrl`, `verifyConfig`,
   `actionType`, `platform`, `offchainId`, `intentHash`, `releaseAmount`,
   `sellerCredential`, `identityAttestation`, `buyerTee`,
   `INDEXER_GRAPHQL_URL`, `INDEXER_API_KEY`, `CURATOR_BASE_URL`,
   `DATABASE_URL`, `curator-db`, `pay-db`, `ProtocolViewer`, `graphql`,
   `support`, `remediation`, `payee registration`, `tier`, `platform cap`,
   `GlobalConfig`, `ReferralCode`, and `relayer`.
4. Produce an impact report using the template below.
5. If downstream repos are affected and the user did not already request
   one-shot/full-stack execution, ask:

   `I found downstream changes for <repos>. Do you want me to create the relevant PRs now?`

6. If approved or explicitly requested, create focused downstream PRs in
   topological order: upstream package/schema/API first, consumers second.
7. Link every downstream PR to its upstream PR and call out publish/deploy order.

## Impact Report Template

```text
Stack impact:
- Current repo:
- Change summary:
- Upstream assumptions:
- Direct boundary changed:
- Downstream repos to inspect:
- Downstream PRs recommended:
- Deprecated repos explicitly excluded:
- Breaking-change stance:
- Package publish or deploy order:
- Validation run:
- Open questions:
```

## PR Target Rules

- Skip `zkp2p-contracts` PRs by default because it is public and often handled
  separately. Include it only when the user explicitly asks.
- Do not create PRs for archived/deprecated `providers` or standalone
  `zkp2p-react-native-sdk`. Route provider-template work to `curator`; route
  React Native SDK work to `zkp2p-mobile/packages/zkp2p-react-native-sdk`.
- Create PRs for `notification-server` only when indexer webhook payloads,
  GraphQL queries, contract address matching, or notification semantics change.
- Create PRs for `zkp2p-indexer-proxy` only when indexer GraphQL transport,
  schema/root fields, fixture assumptions, auth/quota behavior, or public API
  compatibility changes.
- Create PRs for `signal-dispatcher` only when indexer event/query semantics,
  chain event interpretation, or downstream dispatch actions change.
- Create PRs for `zkp2p-support-bot` when SDK/indexer/Curator/Pay DB shapes,
  attestation response handling, Slack command behavior, prompts, runbooks, or
  support triage/eval expectations change.
- Create PRs for `support` when user-facing behavior, fees, limits, supported
  platforms/rails, troubleshooting steps, screenshots, or support copy changes.
  This is a docs/support lane, not a runtime package dependency.
- Create PRs for `peer-cash` and `peer-cli` when `@zkp2p/sdk`, indexer query
  shapes, curator registration semantics, contract/payment catalogs, or
  attestation fulfillment surfaces used by those products change.
- Create PRs for `PeerHQ-Admin` when Curator Prisma models, runtime config,
  platform/tier/fee/API-key/referral tables, or indexer payout/tier queries
  change. Pair the PR with the Curator PR when migrations or source-of-truth
  behavior change.
- Create PRs for dashboards (`protocol-dashboard`, `SAR-dashboard`,
  `arm-dashboard`, `orderbook-dashboard`, `zkp2p-dispute-resolution-dashboard`,
  `internal-dashboard`, `zkp2p-admin`) only when their concrete Curator,
  indexer, attestation, relayer, or contract inputs change.
- Create PRs for `zkp2p-miniapps-monorepo` when miniapp order tracking,
  deposits, off-ramp, webhook processing, provider/platform support, or
  Curator/Pay/indexer APIs it calls change.
- Create PRs for `earnmo` when liquidity/deposit management, indexer reads,
  market intel, payment methods, or contract data it uses change.
- Create PRs for `zkp2p-relayer` when contract whitelist addresses, relayer IDs,
  signer flow, chain env, or Pay/Curator transaction submission semantics
  change. Do not mutate live relayer config without explicit approval.
- Include `protocol` in impact reports when a change is authored there or when
  split-repo changes must be mirrored. Do not create duplicate protocol PRs
  unless the user asks or the monorepo is the active source of truth for the
  touched files.
- Include public `docs`, `zkp2p-dev-client`, `zkp2p-client-sdk`,
  `zkp2p-skills`, and public bots/examples in impact reports when affected, but
  do not create public-repo PRs unless the user asks or the docs/examples are
  explicitly part of the requested rollout.
- Do not include repos just because they are in the `zkp2p` org. Repos such as
  reward services, access-code services, status pages, or unrelated marketing/
  prototype repos need concrete boundary evidence before they become downstream
  PR targets.
- If an affected repo is archived or read-only, include it in the impact report
  with the required change and owner decision needed; do not silently drop it
  from downstream planning just because a PR cannot be opened.
- Only create PRs for repos with real code, config, package, skill, or docs
  impact. Do not create empty awareness PRs.
- Prefer sibling checkouts under `/home/ubuntu/zkp2p/<repo>`. If the working
  tree is dirty or on an unrelated branch, use a clean worktree from `origin/main`.
- Use GitHub search for precedent:
  `gh search prs "<feature terms>" --owner zkp2p --merged --json repository,title,number,url,closedAt`.
- Do not publish npm packages, deploy services, promote release branches, or
  mutate production config unless the user explicitly asks.

## Past Rollout Examples

Use these as patterns when deciding which repos a new feature should touch:

- Curator-hosted provider templates, May to June 2026:
  `curator` PRs 361, 389, 398 and `zkp2p-mobile` PR 213.
  Pattern: provider JSON moved out of the deprecated `providers` repo and into
  Curator's `/providers` plus `/providers/mobile` endpoints; mobile config now
  points at `api.zkp2p.xyz/providers/mobile`.
- PayPal username/offchainId hard cut, April 2026:
  `curator` PR 321, `zkp2p-clients` PR 649, `pay` PR 195, plus docs PRs 68/70.
  Pattern: backend data semantics, client registration/copy, and merchant
  checkout copy/API had to land together.
- Buyer TEE, May to June 2026:
  `attestation-service` PRs 151, 178, 232; `zkp2p-clients` PRs 815, 844, 1024;
  legacy standalone RN SDK PR 133 before the mobile monorepo migration;
  `pay` PRs 281, 300, 334; docs PR 98.
  Pattern: attestation route and response changes required SDK helpers,
  extension/web capture changes, Pay API changes, mobile runtime handling, and
  user-facing error propagation.
- Seller credentials, SAR, and identity registration, May to July 2026:
  `attestation-service` PRs 89, 122, 182, 206, 267; `curator` PRs 353, 377,
  381, 486, 491; `zkp2p-clients` PRs 761, 762, 769, 780, 782, 885, 886, 1075,
  1094, 1100; `zkp2p-mobile` PR 223.
  Pattern: encrypted uploads, signer checks, credential storage, identity
  semantics, SDK polyfills, and UI retry/error states must stay aligned.
- Generic Zelle hard cut, June to July 2026:
  contracts PRs 159/160 as context; `attestation-service` PR 251;
  `zkp2p-indexer` PRs 167/168; `curator` PRs 437, 446, 480;
  `zkp2p-clients` PRs 956, 976, 978, 987, 989; legacy standalone RN SDK PR 140;
  `pay` PRs 320, 326, 339.
  Pattern: method keys and action routing affect contract labels, historical
  indexer data, quotes, SDK metadata, extension/mobile routing, and Pay rails.
- Indexer schema and notification propagation:
  `zkp2p-indexer` PRs 159, 160, 170, 171; `curator` PRs 261, 299, 300, 407,
  408; `zkp2p-clients` PRs 385, 957; notification PRs 24, 33.
  Pattern: schema/entity changes require a package publish plan and typed
  consumer updates before downstream runtime code can rely on new fields.
- Curator admin/control-plane migration, June 2026:
  `PeerHQ-Admin` refs and plans mirror Curator Prisma schema and port indexer
  payout/tier queries while Curator keeps migrations as source of truth.
  Pattern: Curator DB/schema or runtime config changes require a paired
  dashboard/schema-mirror check, but PeerHQ must not run Curator migrations.
- Support bot bang commands and support dashboard, April to May 2026:
  `zkp2p-support-bot` docs/plans added Pay DB, Curator DB, indexer, SDK viewer,
  and Slack command read tools.
  Pattern: operational/support tools often consume internal shapes directly;
  indexer, Curator DB, Pay DB, or SDK changes can break Slack support workflows
  even when end-user clients still compile.
- Peer Cash and Peer CLI, 2026:
  `peer-cash` and `peer-cli` wrap `@zkp2p/sdk`, indexer reads, Curator payee
  registration, and contract/payment catalogs.
  Pattern: SDK or indexer changes should be checked against facade products and
  generated command/docs surfaces, not just the main web/mobile clients.

## Validation Pointers

Use focused checks for the touched boundary:

- `attestation-service`: `yarn lint`, `yarn test`, and platform-specific
  provider hash, buyer TEE, seller credential, or transformer tests.
- `zkp2p-indexer`: `pnpm build`, `pnpm typecheck`, `pnpm check:schema-breaking`,
  and `pnpm schema-package:build` when schema changes.
- `curator`: `yarn lint`, focused `yarn test ...`, provider-router tests,
  quote/verify tests, and API smoke tests when route behavior changes.
- `zkp2p-clients`: focused package tests such as
  `pnpm --filter @zkp2p/sdk test -- --run`, package typecheck/build,
  extension capture tests, and `zkp2p-clients-smoke` when settlement behavior changes.
- `pay`: `npm run build:packages`, `npm --workspace apps/api run test`, and
  checkout/API tests for merchant-visible changes.
- `zkp2p-mobile`: `bun run typecheck`, `bun run lint:strict`, `bun run
  format:check`, `bun run sdk:typecheck`, `bun run sdk:test`, and
  `peer-mobile-testing`/Maestro when UI or payment flow behavior changes.
- `notification-server`: `npm run typecheck`, focused Jest tests around webhook
  DTOs/templates, and an indexer webhook payload fixture when event shape changes.
- `zkp2p-indexer-proxy`: `npm run build`, `npm test`, and fixture/proxy tests
  around changed GraphQL fields, auth, quota, x402, or error mapping behavior.
- `signal-dispatcher`: `npm run build` plus focused tests or local event
  fixtures for changed indexer/chain event semantics.
- `zkp2p-support-bot`: `pnpm typecheck`, `pnpm backend:test`, focused client or
  Slack-command tests, and prompt/eval runs when support behavior changes.
- `support`: `npm run typecheck`, `npm run build`, and a local page check for
  touched articles/screenshots.
- `peer-cash`: `bun run ci` or focused `bun run typecheck`, `bun run test`, and
  `bun run build` for SDK/indexer/curator changes.
- `peer-cli`: `npm run typecheck`, `npm test`, `npm run build`, and `npm run
  docs:build` when command docs or generated catalogs change.
- `PeerHQ-Admin`: `npm run typecheck`, `npm run lint`, `npm run build`, and
  `prisma generate` when the mirrored Curator schema changes.
- Dashboards: run their package-specific `build`/`lint`; for Next dashboards
  use `npm run build`, for Vite dashboards use `npm run build`. Add a manual
  smoke check against staging when env-backed data shapes change.
- `zkp2p-miniapps-monorepo`: run the touched app's typecheck/build/test scripts
  from `world-miniapp` or `tba-miniapp`, plus order polling/webhook fixtures
  when indexer or Pay/Curator API behavior changes.
- `earnmo`: `npm run typecheck`, focused `npm test`, and `npm run build`.
- `zkp2p-relayer`: config diff review, whitelist/address review, and dry-run
  or staging relayer smoke only with explicit approval.
- `protocol`: use workspace-level `pnpm build`, `pnpm test`, `pnpm typecheck`,
  or service-specific commands; also verify whether split repos need mirrored
  PRs.

When validation cannot be run locally, state why in the PR body and list the
smallest checks reviewers or CI should run.
