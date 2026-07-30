---
name: zkp2p-stack-impact
description: Coordinate ZKP2P stack-impact analysis and downstream PRs across the protocol monorepo, clients, Pay, mobile, proxy, CLI, admin, support, notification, and mirrored package owners. Use for payment-method, API, schema, package, proof, provider, client, release, or deployment changes that can cross repository boundaries.
---

# ZKP2P Stack Impact

Use this skill before finishing any change that can affect another ZKP2P repo.
The goal is to prevent dropped downstream work while still allowing one-shot
features across the whole stack.

Core rule: do not stop at the current repo for a stack-affecting change. Produce
an impact report, identify downstream PRs, then ask the developer whether to
create them unless the user already asked for one-shot or full-stack execution.

`zkp2p/protocol` is the canonical source for contracts, indexer, Curator,
attestor, and PeerHQ. Treat its service directories as independently
installable, testable, publishable, and deployable. The standalone
`zkp2p-contracts` repository mirrors `protocol/contracts` while migration
finishes; verify the active package/deploy owner before changing both. Do not
route new work to the legacy split Curator, indexer, or attestation repositories.

## Current Graph

The active core stack is:

```text
protocol/contracts
  -> protocol/attestor
  -> protocol/indexer -> protocol/curator -> zkp2p-clients -> pay
                                             -> zkp2p-mobile
                                             -> peer-cash / peer-cli
                                             -> protocol/hq and active dashboards
                      -> zkp2p-indexer-proxy -> public/private GraphQL consumers
                      -> notification-server -> mobile/web notification consumers

protocol/attestor -> protocol/curator -> zkp2p-clients -> pay
                                      -> zkp2p-mobile
                                      -> zkp2p-support-bot / dispute tooling

protocol/curator provider templates/API
  -> zkp2p-clients extension/web proof capture
  -> zkp2p-mobile/packages/zkp2p-react-native-sdk proof capture
  -> pay platform/rail availability when checkout behavior changes
  -> support/docs/support-bot prompts when behavior is user-visible

protocol/curator notification events
  -> notification-server -> zkp2p-mobile/web notification consumers

product, developer integration, support, fee, platform, or error semantics
  -> zkp2p-clients/clients/developer integration workbench
  -> zkp2p-clients/clients/support help center
  -> zkp2p-clients/clients/docs public developer/protocol docs
  -> zkp2p-support-bot prompts, tools, and runbooks
```

Deprecated or archived context:

- `providers` is archived/deprecated. Provider template ownership now lives in
  `protocol/curator` under `src/api/providers/**` and the hosted `/providers`
  and `/providers/mobile` endpoints.
- Standalone `zkp2p-react-native-sdk` is archived/deprecated. The active React
  Native SDK lives inside `zkp2p-mobile/packages/zkp2p-react-native-sdk`.
- Standalone `docs` is archived. Active public developer and support content
  lives in `zkp2p-clients/clients/docs` and
  `zkp2p-clients/clients/support`.
- `zkp2p-miniapps-monorepo`, `earnmo`, `orderbook-dashboard`, and
  `zkp2p-dispute-resolution-dashboard` are archived and are never PR, publish,
  release, or deploy targets.
- The unarchived standalone `curator`, `zkp2p-indexer`,
  `attestation-service`, and `zkp2p-v2-contracts` repositories are legacy
  migration snapshots. Their operational owners are the matching
  `protocol/*` directories.

## Stack Map

| Owner                                                  | Role                                                                                                                                                                    | Upstream inputs                                                                                    | Downstream consumers                                                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `protocol/contracts`                                   | Canonical contracts, ABIs, addresses, deployments, and `@zkp2p/contracts-v2`; V2 guardian/group/policy is live on production and staging, while V3 is staging-only.     | Solidity and deployment changes.                                                                   | `protocol/{attestor,indexer,curator}`, clients, Pay, mobile, relayer, notifications.                                       |
| `zkp2p-contracts`                                      | Temporary standalone mirror of `protocol/contracts`.                                                                                                                    | Canonical contract changes that still require a mirror or package release.                         | Consumers or deploys verified to track the standalone repository.                                                          |
| `protocol/attestor`                                    | Payment-proof verification, EIP-712 attestations, buyer TEE, seller credentials, Nitro deployment, and `@zkp2p/zkp2p-attestation`.                                      | Contract package, payment-app behavior, Curator provider templates.                                | `protocol/curator`, clients SDK/extension/web, Pay, mobile.                                                                |
| `protocol/indexer`                                     | Envio events/GraphQL, guardian/group/policy projections, and `@zkp2p/indexer-schema`.                                                                                   | Contract package, events, and deployment config.                                                   | `protocol/curator`, clients, Pay analytics/admin, notifications, indexer proxy, support bot, CLI/SDK products, dashboards. |
| `protocol/curator`                                     | Quote, orderbook, tier, relay, credential, notification, and provider APIs; provider manifests live under `src/api/providers/**`.                                       | Indexer schema, contracts, attestation package/service, payment-app behavior.                      | Clients, Pay, mobile, notification server, `protocol/hq`, support/admin workflows.                                         |
| `protocol/hq`                                          | Canonical PeerHQ admin dashboard and direct Curator-schema control plane.                                                                                               | Curator Prisma schema/runtime config, indexer queries, attestation/Pay enrichment.                 | Ops/admin users; Curator remains the migration owner.                                                                      |
| `zkp2p-clients`                                        | Web, extension, developer portal, docs, support, `@zkp2p/sdk`, `@zkp2p/core`, React hooks, and group/access-policy state APIs that do not yet enforce intent admission. | Protocol services/packages and user-visible product behavior.                                      | Web users, integrators, Pay, mobile's embedded SDK, Peer Cash, Peer CLI, external SDK consumers.                           |
| `pay`                                                  | Merchant checkout/API surfaces using Curator, attestor, and `@zkp2p/sdk`.                                                                                               | SDK, Curator APIs, attestation verification shape, contracts.                                      | Merchants, checkout users, support workflows.                                                                              |
| `zkp2p-mobile`                                         | Peer mobile app plus active `packages/zkp2p-react-native-sdk` workspace.                                                                                                | Embedded SDK, `@zkp2p/sdk`, attestation package, contracts, Curator APIs/provider manifests.       | App releases, mobile users, published mobile SDK.                                                                          |
| `notification-server`                                  | Push service consuming indexer and Curator events/GraphQL plus contract metadata; owns preferences and delivery APIs.                                                   | Protocol indexer/Curator payloads and contracts.                                                   | Mobile/web notification consumers and support workflows.                                                                   |
| `zkp2p-indexer-proxy`                                  | Authenticated/quota-aware GraphQL proxy with fixtures and x402 overflow.                                                                                                | Indexer transport, schema, root fields, errors, fixtures.                                          | Public/private API consumers, dashboards, CLIs, external integrators.                                                      |
| `zkp2p-support-bot`                                    | Slack support and ops tools over Pay DB, Curator DB, indexer, SDK viewer, analytics, logs, and knowledge base.                                                          | SDK, indexer queries, Curator/Pay schemas and APIs, attestation shape, runbooks.                   | Support agents, incident workflows, commands, triage/evals.                                                                |
| `zkp2p-clients/clients/{developer,support,docs}`       | Developer workbench plus active public documentation and help-center surfaces.                                                                                          | Integration contracts and user-visible behavior, fees, rails, errors, screenshots.                 | Integrators, support readers, support-bot knowledge.                                                                       |
| `peer-cash`                                            | Public cash-out SDK/facade over `@zkp2p/sdk`.                                                                                                                           | SDK, Curator registration, indexer aggregates, identity-attestation requirements, payment methods. | Cash-out integrators and React/Node users.                                                                                 |
| `peer-cli`                                             | CLI/MCP over `@zkp2p/sdk`, ProtocolViewer, indexer reads, Curator registration, and attestation fulfillment.                                                            | SDK, indexer schema, Curator semantics, attestation shape, payment catalogs.                       | CLI users, docs, MCP tools.                                                                                                |
| `protocol-dashboard`, `SAR-dashboard`, `arm-dashboard` | Standalone active ops dashboards until separately retired.                                                                                                              | Curator APIs/DB, indexer fields, attestation/relayer semantics, contract addresses.                | Protocol, SAR, and ARM/feed operators.                                                                                     |
| `zkp2p-relayer`                                        | OpenZeppelin Relayer configuration for Pay and Curator submission.                                                                                                      | Contract addresses/allowlists, signer/relayer IDs, chain config, Pay/Curator flows.                | Pay signal/fulfill relays and Curator guardian operations.                                                                 |

## Trigger Matrix

Treat these as downstream-impact triggers:

- Provider template, provider manifest, payment app parser, header/cookie,
  mobile capture, or metadata changes: inspect
  `protocol/curator/src/api/providers/**`, `zkp2p-clients` extension/web capture
  code, `zkp2p-mobile/packages/zkp2p-react-native-sdk`, mobile app payment
  platform config, `zkp2p-skills` provider-authoring references, and Pay
  checkout support when platform availability or merchant-visible rails
  change.
- Attestation route, payment query or resolution mode, action type, platform
  key, response shape, error code, signer, typed-data, nullifier, release
  amount, metadata, or package export changes: inspect `protocol/curator`,
  `zkp2p-clients` SDK/extension/web, `pay`, and `zkp2p-mobile` embedded RN
  SDK/app. Also inspect `zkp2p-support-bot` and any active admin tool when
  attestation responses, proof resubmission, payment matching, or support/debug
  tooling can observe the changed shape.
- Contract package, deployment address, ABI, event, payment method, verifier,
  guardian, address group, whitelist/access policy, hook, fee, or oracle
  changes: inspect `protocol/indexer`, `protocol/attestor`,
  `protocol/curator`, SDK/core, Pay, mobile embedded SDK/app, `peer-cash`,
  `peer-cli`, `zkp2p-relayer` when relayer allowlists or signer flows are
  affected, and `notification-server` when events, webhooks, or address
  matching are affected. Inspect standalone `zkp2p-contracts` only after
  verifying a mirror/package/deploy still depends on it.
- Indexer entity, GraphQL schema, enum, webhook event, contract binding,
  access-policy projection, field naming, or published
  `@zkp2p/indexer-schema` changes: inspect `protocol/curator` typed consumers,
  clients SDK/core/indexer queries, pay/admin analytics, `notification-server`,
  `zkp2p-indexer-proxy` fixtures/query assumptions, `zkp2p-support-bot`,
  `peer-cash`, `peer-cli`, active miniapps, PeerHQ/admin
  dashboards, and other dashboards that read those fields.
- Curator API request/response/status/auth/quote, including authenticated Relay
  deposit quotes, orderbook/tier/signing/verify/provider, deployment-guard, or
  notification webhook changes:
  inspect `zkp2p-clients`, `pay`, `zkp2p-mobile`, `peer-cash`, `peer-cli`,
  active miniapps, PeerHQ/admin dashboards, `notification-server`,
  `zkp2p-support-bot`, `clients/support`, and `clients/docs`
  if public or support-visible API behavior changes.
- Indexer or Curator notification event, payload, HMAC contract, preference
  field, delivery API, deep link, or alert semantics changes: inspect
  `notification-server`, the producing owner, `zkp2p-mobile`, web consumers,
  and affected support or ops tooling.
- SDK exports, group/access-policy APIs, package versions, or runtime
  URL/routing defaults: inspect
  `pay`, `zkp2p-mobile`, `peer-cash`, `peer-cli`, `zkp2p-support-bot`,
  extension/web callers, external SDK docs, and mobile's embedded RN SDK if the
  mobile runtime wraps or re-exports the changed surface.
- Curator Prisma schema, control-plane table, platform/rail toggle, fee,
  tier, API key, referral, blocklist, or global-config changes: inspect
  `protocol/hq` first, then `clients/support`, `zkp2p-support-bot`, dashboards,
  `pay`, `zkp2p-mobile`, and `zkp2p-clients` when user-visible behavior
  changes.
- Support-visible error text, remediation, platform availability, screenshots,
  fee/currency copy, SLA expectations, or troubleshooting flow changes:
  inspect `clients/support`, `clients/docs`, `zkp2p-support-bot` prompts/runbooks/evals,
  `pay` support surfaces, and mobile/web copy.
- Operational dashboard, proxy, CLI, miniapp, or support tool changes:
  identify the exact upstream boundary they consume before planning PRs. For
  example, `zkp2p-indexer-proxy` is affected by GraphQL schema/transport and
  fixture assumptions; `peer-cash`/`peer-cli` are affected by SDK/indexer/curator
  API changes; dashboards are affected by Curator DB/API and indexer fields.
- Trusted Takers is legacy client-side: new deposits have no enable path, and
  its management tab appears only when a whitelist is already live. Groups and
  access policies supersede it as the current configuration surface, but those
  saved policies do not yet enforce intent admission. Keep legacy whitelist
  capability and impact checks because existing whitelist hooks still enforce
  restrictions; never describe a recorded access policy as gating or blocking
  orders.
- For changes inside `protocol`, start with the owning service directory and
  follow its service-local package manager and deployment branch. Verify the
  active deploy/package consumer before mirroring a change to a legacy
  standalone repository.

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
7. Link PRs, call out publish/deploy order, and follow the producer's
   `NPM_RELEASE.md` workflow.

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
- Environment/deployment gates:
- Validation run:
- Open questions:
```

## PR Target Rules

- Target `protocol/main` for contracts, indexer, Curator, attestor, or PeerHQ
  source changes. Keep each PR and validation set scoped to the owning service
  directories.
- Treat `zkp2p-contracts` as a temporary mirror. Create a paired PR only when
  the active package/deploy owner or an explicit rollout requires it; record
  which direction is canonical.
- Do not create PRs for archived/deprecated `providers`, standalone
  `zkp2p-react-native-sdk`, `docs`, `zkp2p-miniapps-monorepo`, `earnmo`,
  `orderbook-dashboard`, or `zkp2p-dispute-resolution-dashboard`. Route active
  work to its current in-repository owner.
- Do not create duplicate PRs in the legacy standalone `curator`,
  `zkp2p-indexer`, `attestation-service`, or `zkp2p-v2-contracts` repositories
  unless live deployment/package evidence proves one still owns the affected
  surface.
- Create PRs for `notification-server` only when indexer or Curator webhook
  payloads, GraphQL queries, contract address matching, notification
  preferences/delivery APIs, deep links, or alert semantics change.
- Create PRs for `zkp2p-indexer-proxy` only when indexer GraphQL transport,
  schema/root fields, fixture assumptions, auth/quota behavior, or public API
  compatibility changes.
- Create PRs for `zkp2p-support-bot` when SDK/indexer/Curator/Pay DB shapes,
  attestation response handling, Slack command behavior, prompts, runbooks, or
  support triage/eval expectations change.
- Update `clients/support` in the same `zkp2p-clients` PR when user-facing behavior, fees, limits, supported
  platforms/rails, troubleshooting steps, screenshots, or support copy changes.
  This is a docs/support lane, not a runtime package dependency.
- Create PRs for `peer-cash` and `peer-cli` when `@zkp2p/sdk`, indexer query
  shapes, curator registration semantics, contract/payment catalogs, or
  attestation fulfillment surfaces used by those products change.
- Change `protocol/hq` when Curator Prisma models, runtime config,
  platform/tier/fee/API-key/referral tables, or indexer payout/tier queries
  change. Keep Curator migrations owned by `protocol/curator`.
- Create PRs for active dashboards (`protocol-dashboard`, `SAR-dashboard`, and
  `arm-dashboard`) only when their concrete Curator, indexer, attestation,
  relayer, or contract inputs change. PeerHQ consolidation alone does not
  retire the standalone deployments.
- Create PRs for `zkp2p-relayer` when contract whitelist addresses, relayer IDs,
  signer flow, chain env, or Pay/Curator transaction submission semantics
  change. Do not mutate live relayer config without explicit approval.
- Update `clients/docs` in the same `zkp2p-clients` PR when public documentation is affected.
- Update `clients/developer` in the same `zkp2p-clients` PR when the developer workbench, extension message contract, attestation response, or integration flow is affected.
- Include `zkp2p-client-sdk`, `zkp2p-skills`, and public bots/examples in impact
  reports when affected. In particular, inspect `zkp2p-skills` when provider
  manifest, capture, runtime, or attestation authoring contracts change. Do not
  create public-repo PRs unless the user asks or the docs/examples are
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
- Prefer the current Mac checkout for integration and external actions. If the
  workspace `andrew-dev-worker` placement gate passes, use its disposable
  committed-ref worktree and return a patch/evidence bundle; never mutate a
  shared remote checkout.
- Use GitHub search for precedent:
  `gh search prs "<feature terms>" --owner zkp2p --merged --json repository,title,number,url,closedAt`.
- Do not publish npm packages, deploy services, promote release branches, or
  mutate production config unless the user explicitly asks.

## Past Rollout Evidence

Use these as patterns, then re-prove the current boundary from source:

- Provider hosting moved to Curator in PRs 361/389/398, with mobile following
  in PR 213. Route provider templates to Curator and mobile capture to the
  embedded SDK.
- PayPal identifiers, buyer TEE, seller credentials, and generic Zelle required
  coordinated attestation, Curator, clients, Pay, mobile, and docs changes.
  Shared method keys, proof shapes, and user-visible errors are cross-layer
  contracts.
- Indexer schema and notification work in indexer PRs 159/160/170/171,
  Curator PRs 261/299/300/407/408, clients PRs 385/957, and notification PRs
  24/33 showed that typed consumers must update before relying on new fields.
- PeerHQ mirrors Curator schema but never owns migrations. The support bot,
  Peer Cash, and Peer CLI consume internal schemas, indexer fields, or
  `@zkp2p/sdk`; inspect them when those concrete inputs change.
- Contracts PR 217 and Curator PR 523 established the current OrchestratorV3
  and `/v3` quote/orderbook/tier/sign boundary. Keep it staging-gated until
  contracts deployment metadata exposes a non-zero production address; the
  Curator route guard must fail the complete surface closed before that.

## Validation Pointers

Use focused checks for the touched boundary:

- `protocol/contracts`: run service-local `corepack pnpm build`,
  `corepack pnpm test`, `corepack pnpm test:forge`, and
  `corepack pnpm pkg:build` when the package changes.
- `protocol/attestor`: run service-local `corepack pnpm build`,
  `corepack pnpm exec biome ci src/`, and `corepack pnpm test`, plus
  platform-specific provider-hash, buyer-TEE, seller-credential, or transformer
  tests.
- `protocol/indexer`: run service-local
  `corepack pnpm schema-package:build`, `corepack pnpm check:config-sync`,
  `corepack pnpm build`, `corepack pnpm typecheck`, and `corepack pnpm test`
  when schema/runtime changes.
- `protocol/curator`: run service-local `corepack pnpm build`,
  `corepack pnpm exec tsc --noEmit`, `corepack pnpm exec biome ci src/`, and
  `corepack pnpm test`, plus provider-router, quote/verify, V3
  deployment-guard, and API smoke tests when relevant.
- `protocol/hq`: run service-local `npm ci`, `npx prisma generate`,
  `npm run typecheck`, `npm run lint`, and `npm run build` when its Curator
  schema mirror or UI changes.
- `zkp2p-clients`: focused package tests such as
  `pnpm --filter @zkp2p/sdk test -- --run`, package typecheck/build,
  extension capture tests, and `zkp2p-clients-smoke` when settlement behavior changes.
- `pay`: `npm run build:packages`, `npm --workspace apps/api run test`, and
  checkout/API tests for merchant-visible changes.
- `zkp2p-mobile`: run `bun run typecheck`, `bun run lint:strict`, `bun run format:check`,
  `bun run sdk:typecheck`, `bun run sdk:test`, and
  `peer-mobile-testing`/Maestro when UI or payment flow behavior changes.
- `notification-server`: `pnpm build`, focused `pnpm test` coverage around
  indexer/Curator webhook DTOs, GraphQL quote reads, preference APIs, and
  delivery templates; pair mobile preference/deep-link checks when affected.
- `zkp2p-indexer-proxy`: `npm run build`, `npm test`, and fixture/proxy tests
  around changed GraphQL fields, auth, quota, x402, or error mapping behavior.
- `zkp2p-support-bot`: `pnpm typecheck`, `pnpm backend:test`, focused client or
  Slack-command tests, and prompt/eval runs when support behavior changes.
- `clients/support`: `pnpm --filter @zkp2p/support typecheck`, `pnpm --filter @zkp2p/support build`, and a local page check for
  touched articles/screenshots.
- `clients/docs`: `pnpm --filter @zkp2p/docs build` and a local page/link check for touched public documentation.
- `peer-cash`: `bun run ci` or focused `bun run typecheck`, `bun run test`, and
  `bun run build` for SDK/indexer/curator changes.
- `peer-cli`: run `npm run typecheck`, `npm test`, `npm run build`, and `npm run docs:build`
  when command docs or generated catalogs change.
- Dashboards: run their package-specific `build`/`lint`; for Next dashboards
  use `npm run build`, for Vite dashboards use `npm run build`. Add a manual
  smoke check against staging when env-backed data shapes change.
- `zkp2p-relayer`: config diff review, whitelist/address review, and dry-run
  or staging relayer smoke only with explicit approval.

When validation cannot be run locally, state why in the PR body and list the
smallest checks reviewers or CI should run.
