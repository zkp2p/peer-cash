---
name: zkp2p-stack-impact
description: Coordinate ZKP2P stack-impact analysis and downstream PRs across standalone contract, attestation, indexer, Curator, client, Pay, mobile, proxy, CLI, admin, support, and notification owners. Use for payment-method, API, schema, package, proof, provider, client, release, or deployment changes that can cross repository boundaries.
---

# ZKP2P Stack Impact

Use this skill before finishing any change that can affect another ZKP2P repo.
The goal is to prevent dropped downstream work while still allowing one-shot
features across the whole stack.

Core rule: do not stop at the current repo for a stack-affecting change. Produce
an impact report, identify downstream PRs, then ask the developer whether to
create them unless the user already asked for one-shot or full-stack execution.

Treat each active standalone repository's current default branch as the source
of truth for what it owns. `zkp2p/protocol` is deprecated context: do not use it
as a source, mirror, coordination root, validation root, or PR target.

## Current Graph

The active core stack is:

```text
zkp2p-contracts
  -> attestation-service
  -> zkp2p-indexer -> curator -> zkp2p-clients -> pay
                               -> zkp2p-mobile
                               -> peer-cash / peer-cli
                               -> PeerHQ/admin dashboards
                 -> zkp2p-indexer-proxy -> public/private GraphQL consumers
                 -> notification-server -> mobile/web notification consumers

attestation-service -> curator -> zkp2p-clients -> pay
                    -> zkp2p-mobile
                    -> zkp2p-support-bot / dispute tooling

curator provider templates/API
  -> zkp2p-clients extension/web proof capture
  -> zkp2p-mobile/packages/zkp2p-react-native-sdk proof capture
  -> pay platform/rail availability when checkout behavior changes
  -> support/docs/support-bot prompts when behavior is user-visible

curator notification events
  -> notification-server -> zkp2p-mobile/web notification consumers

product, developer integration, support, fee, platform, or error semantics
  -> zkp2p-clients/clients/developer integration workbench
  -> zkp2p-clients/clients/support help center
  -> zkp2p-clients/clients/docs public developer/protocol docs
  -> zkp2p-support-bot prompts, tools, and runbooks
```

Deprecated or archived context:

- `providers` is archived/deprecated. Provider template ownership now lives in
  `curator` under `src/api/providers/**` and the hosted `/providers` and
  `/providers/mobile` endpoints.
- Standalone `zkp2p-react-native-sdk` is archived/deprecated. The active React
  Native SDK lives inside `zkp2p-mobile/packages/zkp2p-react-native-sdk`.
- Standalone `docs` and `support` are archived. Their active owners are
  `zkp2p-clients/clients/docs` and `zkp2p-clients/clients/support`.
- `signal-dispatcher`, `zkp2p-miniapps-monorepo`, `earnmo`,
  `orderbook-dashboard`, `internal-dashboard`, and
  `zkp2p-dispute-resolution-dashboard` are archived and are never PR, publish,
  release, or deploy targets.
- `zkp2p/protocol` is deprecated even though the GitHub repository is not
  archived. Inspect and change the owning standalone repositories directly.

## Stack Map

| Repo                                                                                                                                                     | Role                                                                                                                                                                | Upstream inputs                                                                                                                                      | Downstream consumers                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zkp2p-contracts`                                                                                                                                        | Public contracts package, ABIs, addresses, constants, payment-method catalogs, deployment metadata; OrchestratorV3 is currently staging-only.                       | Solidity/deploy changes.                                                                                                                             | `attestation-service`, `zkp2p-indexer`, `curator`, `zkp2p-clients`, `pay`, `zkp2p-mobile`, `notification-server`. Skip PRs here unless explicitly requested.                          |
| `attestation-service`                                                                                                                                    | Verifies payment proofs, signs EIP-712 attestations, owns buyer TEE and seller credential attestation surfaces, publishes `@zkp2p/zkp2p-attestation`.               | `@zkp2p/contracts-v2`, payment app behavior, Curator provider templates, Nitro deployment config.                                                    | `curator`, `zkp2p-clients` SDK/extension/web, `pay`, `zkp2p-mobile` embedded RN SDK/app.                                                                                              |
| `zkp2p-indexer`                                                                                                                                          | Envio event ingestion, GraphQL entities, webhook/event payloads, and published `@zkp2p/indexer-schema`.                                                             | `@zkp2p/contracts-v2`, contract events, deployment config.                                                                                           | `curator`, `zkp2p-clients`, `pay` analytics/admin flows, `notification-server`, `zkp2p-indexer-proxy`, support bot, CLIs/SDK products, and active dashboards.                         |
| `curator`                                                                                                                                                | Quotes, maker/taker APIs, deployment-gated `/v3` quote/orderbook/tier/signing, seller verification, credential store, provider hosting at `/providers` and `/providers/mobile`. | `@zkp2p/indexer-schema`, `@zkp2p/contracts-v2`, `@zkp2p/zkp2p-attestation`, attestation-service behavior, payment app/provider behavior.             | `zkp2p-clients`, `pay`, `zkp2p-mobile`, `notification-server`, PeerHQ/admin tools, support/admin workflows.                                                                           |
| `zkp2p-clients`                                                                                                                                          | Web app, browser extension, developer portal, public docs, support center, public `@zkp2p/sdk`, `@zkp2p/core`, and React hooks.                                     | Contracts, indexer schema, curator APIs/provider templates, attestation-service routes/package, user-visible product behavior.                       | Web users, extension, developer tooling, docs/support readers, `pay`, `zkp2p-mobile` embedded RN SDK via `@zkp2p/sdk`, external SDK consumers.                                        |
| `pay`                                                                                                                                                    | Merchant checkout/API surfaces using curator, attestation-service, and `@zkp2p/sdk`.                                                                                | `@zkp2p/sdk`, curator APIs, attestation-service verification shape, contracts.                                                                       | Merchants, checkout users, support workflows.                                                                                                                                         |
| `zkp2p-mobile`                                                                                                                                           | Peer mobile app plus active `packages/zkp2p-react-native-sdk` workspace for mobile proof capture, attestation helpers, and SDK wrapping.                            | Embedded RN SDK package, `@zkp2p/sdk`, `@zkp2p/zkp2p-attestation`, contracts, curator `/providers/mobile` and APIs, attestation-service URL/routing. | App releases, mobile users, published mobile SDK package when released from this monorepo.                                                                                            |
| `notification-server`                                                                                                                                    | Push notification service consuming indexer and Curator webhooks, indexer GraphQL quote data, and contract metadata; owns notification preferences and delivery APIs. | Indexer webhook payloads/schema and GraphQL, Curator notification events, `@zkp2p/contracts-v2`.                                                      | `zkp2p-mobile`, web notification consumers, and notification/support workflows.                                                                                                      |
| `zkp2p-indexer-proxy`                                                                                                                                    | Express GraphQL proxy for the Envio indexer with auth, quotas, fixtures, and x402 paid overflow.                                                                    | Indexer GraphQL URL, schema, root fields, error shape, fixtures, payment method fixture metadata.                                                    | Public/private indexer API consumers, dashboards, miniapps, CLIs, and external integrators.                                                                                           |
| `zkp2p-support-bot`                                                                                                                                      | Slack support and ops bot with read tools for Pay DB, Curator DB, indexer GraphQL, SDK viewer, PostHog, logs, and Notion KB.                                        | `@zkp2p/sdk`, indexer GraphQL queries, Curator/Pay DB schemas, Curator API/config, attestation response shape, support runbooks.                     | Support agents, incident/debug workflows, Slack commands, automated triage/evals.                                                                                                     |
| `zkp2p-clients/clients/developer`                                                                                                                        | Developer integration workbench for extension-backed buyer TEE, seller credentials, attestations, and fulfill-intent calldata.                                      | Extension message contracts, attestation responses, deployed contract interfaces, and integration behavior.                                          | Integrators and internal developers. Update in the same clients PR when affected.                                                                                                     |
| `zkp2p-clients/clients/support`                                                                                                                          | User-support/help center workspace and support-bot knowledge-base export.                                                                                           | User-visible product behavior, fees, rails, app/platform availability, screenshots/copy, error/remediation semantics.                                | Customer support articles and troubleshooting flows. Update in the same clients PR when affected.                                                                                     |
| `zkp2p-clients/clients/docs`                                                                                                                             | Public developer/protocol docs workspace.                                                                                                                           | SDK, contracts, attestation, provider, Pay/offramp, and mobile SDK behavior.                                                                         | External developers, integrators, agent/LLM docs. Update in the same clients PR when affected.                                                                                        |
| `peer-cash`                                                                                                                                              | Public-facing cash-out SDK/facade over `@zkp2p/sdk`.                                                                                                                | `@zkp2p/sdk`, curator payee registration, indexer deposit/intent aggregates, identity-attestation requirements, payment methods.                     | Cash-out integrators and React/Node SDK users.                                                                                                                                        |
| `peer-cli`                                                                                                                                               | CLI/MCP surface over `@zkp2p/sdk`, ProtocolViewer, indexer reads, curator payee registration, and proof/attestation fulfillment commands.                           | `@zkp2p/sdk`, indexer schema/root fields, curator registration behavior, attestation fulfillment shape, contract/payment method catalogs.            | Internal and external CLI users, docs, MCP tools.                                                                                                                                     |
| `PeerHQ-Admin`                                                                                                                                           | Private control-plane dashboard that mirrors Curator Prisma schema and reads indexer payout/tier state.                                                             | Curator DB schema/migrations, Curator runtime config semantics, indexer GraphQL payout/tier queries.                                                 | Ops/admin users; sometimes paired Curator PRs are required first.                                                                                                                     |
| `protocol-dashboard`, `SAR-dashboard`, `arm-dashboard`                                                                                                   | Active private operational dashboards.                                                                                                                              | Curator APIs/DB mirrors, indexer GraphQL fields, attestation/relayer semantics, contract addresses, env names.                                       | Protocol, SAR, and ARM/feed operators.                                                                                                                                                |
| `zkp2p-relayer`                                                                                                                                          | Shared OpenZeppelin Relayer configuration for Pay and Curator transaction submission.                                                                               | Contract addresses/whitelists, signer/relayer IDs, chain env, Pay/Curator transaction flow.                                                          | Pay signal/fulfill relays and Curator guardian operations.                                                                                                                            |

## Trigger Matrix

Treat these as downstream-impact triggers:

- Provider template, provider manifest, payment app parser, header/cookie,
  mobile capture, or metadata changes: inspect `curator/src/api/providers/**`,
  `zkp2p-clients` extension/web capture code, `zkp2p-mobile/packages/zkp2p-react-native-sdk`,
  mobile app payment platform config, `zkp2p-skills` provider-authoring
  references, and Pay checkout support when platform availability or
  merchant-visible rails change.
- Attestation route, payment query or resolution mode, action type, platform
  key, response shape, error code, signer, typed-data, nullifier, release
  amount, metadata, or package export changes: inspect `curator`,
  `zkp2p-clients` SDK/extension/web, `pay`, and `zkp2p-mobile` embedded RN
  SDK/app. Also inspect `zkp2p-support-bot` and any active admin tool when
  attestation responses, proof resubmission, payment matching, or support/debug
  tooling can observe the changed shape.
- Contract package, deployment address, ABI, event, payment method, verifier,
  hook or policy, fee, or oracle changes: inspect `zkp2p-indexer`, attestation-service
  contract resolution, curator contract usage, SDK/core, pay, mobile embedded
  SDK/app, `peer-cash`, `peer-cli`, `zkp2p-relayer` when relayer whitelists or
  signer flows are affected, and `notification-server` when events, webhooks,
  or address matching are affected.
- Indexer entity, GraphQL schema, enum, webhook event, field naming, or
  published `@zkp2p/indexer-schema` changes: inspect curator typed consumers,
  clients SDK/core/indexer queries, pay/admin analytics, `notification-server`,
  `zkp2p-indexer-proxy` fixtures/query assumptions, `zkp2p-support-bot`,
  `peer-cash`, `peer-cli`, active miniapps, PeerHQ/admin
  dashboards, and other dashboards that read those fields.
- Curator API request/response/status/auth/quote/orderbook/tier/signing/verify/
  provider, deployment-guard, or notification webhook changes:
  inspect `zkp2p-clients`, `pay`, `zkp2p-mobile`, `peer-cash`, `peer-cli`,
  active miniapps, PeerHQ/admin dashboards, `notification-server`,
  `zkp2p-support-bot`, `clients/support`, and `clients/docs`
  if public or support-visible API behavior changes.
- Indexer or Curator notification event, payload, HMAC contract, preference
  field, delivery API, deep link, or alert semantics changes: inspect
  `notification-server`, the producing owner, `zkp2p-mobile`, web consumers,
  and affected support or ops tooling.
- SDK exports, package versions, or runtime URL/routing defaults: inspect
  `pay`, `zkp2p-mobile`, `peer-cash`, `peer-cli`, `zkp2p-support-bot`,
  extension/web callers, external SDK docs, and mobile's embedded RN SDK if the
  mobile runtime wraps or re-exports the changed surface.
- Curator Prisma schema, control-plane table, platform/rail toggle, fee,
  tier, API key, referral, blocklist, or global-config changes: inspect
  `PeerHQ-Admin` first, then `clients/support`, `zkp2p-support-bot`, dashboards, `pay`,
  `zkp2p-mobile`, and `zkp2p-clients` when user-visible behavior changes.
- Support-visible error text, remediation, platform availability, screenshots,
  fee/currency copy, SLA expectations, or troubleshooting flow changes:
  inspect `clients/support`, `clients/docs`, `zkp2p-support-bot` prompts/runbooks/evals,
  `pay` support surfaces, and mobile/web copy.
- Operational dashboard, proxy, CLI, miniapp, or support tool changes:
  identify the exact upstream boundary they consume before planning PRs. For
  example, `zkp2p-indexer-proxy` is affected by GraphQL schema/transport and
  fixture assumptions; `peer-cash`/`peer-cli` are affected by SDK/indexer/curator
  API changes; dashboards are affected by Curator DB/API and indexer fields.
- Never route an impact investigation through deprecated `zkp2p/protocol`.
  Resolve the owning standalone repositories and inspect their current default
  branches directly.

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
- Environment/deployment gates:
- Validation run:
- Open questions:
```

## PR Target Rules

- Skip `zkp2p-contracts` PRs by default because it is public and often handled
  separately. Include it only when the user explicitly asks.
- Do not create PRs for archived/deprecated `providers`, standalone
  `zkp2p-react-native-sdk`, `docs`, `support`, `signal-dispatcher`,
  `zkp2p-miniapps-monorepo`, `earnmo`, `orderbook-dashboard`,
  `internal-dashboard`, or `zkp2p-dispute-resolution-dashboard`. Route active
  work to its current standalone or in-repository owner.
- Do not create PRs for deprecated `zkp2p/protocol`.
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
- Create PRs for `PeerHQ-Admin` when Curator Prisma models, runtime config,
  platform/tier/fee/API-key/referral tables, or indexer payout/tier queries
  change. Pair the PR with the Curator PR when migrations or source-of-truth
  behavior change.
- Create PRs for active dashboards (`protocol-dashboard`, `SAR-dashboard`, and
  `arm-dashboard`) only when their concrete Curator, indexer, attestation,
  relayer, or contract inputs change.
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
- Prefer sibling checkouts under `/home/ubuntu/zkp2p/<repo>`. If the working
  tree is dirty or on an unrelated branch, use a clean worktree from `origin/main`.
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

- `attestation-service`: `yarn lint`, `yarn test`, and platform-specific
  provider hash, buyer TEE, seller credential, or transformer tests.
- `zkp2p-indexer`: `pnpm build`, `pnpm typecheck`, `pnpm check:schema-breaking`,
  and `pnpm schema-package:build` when schema changes.
- `curator`: `yarn lint`, focused `yarn test ...`, provider-router tests,
  quote/verify tests, V3 router/deployment-guard tests, and API smoke tests when
  route behavior changes.
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
- `PeerHQ-Admin`: `npm run typecheck`, `npm run lint`, `npm run build`, and
  `prisma generate` when the mirrored Curator schema changes.
- Dashboards: run their package-specific `build`/`lint`; for Next dashboards
  use `npm run build`, for Vite dashboards use `npm run build`. Add a manual
  smoke check against staging when env-backed data shapes change.
- `zkp2p-relayer`: config diff review, whitelist/address review, and dry-run
  or staging relayer smoke only with explicit approval.

When validation cannot be run locally, state why in the PR body and list the
smallest checks reviewers or CI should run.
