# Peer Cash (`@zkp2p/cash`) - Product Requirements & Build Report

**Status:** Built, verified against staging and live production data, ready for private review. Awaiting the go for public flip + npm publish.
**Owner:** Andrew
**Package:** `@zkp2p/cash` - standalone repo `zkp2p/peer-cash`
**Depends on:** published `@zkp2p/sdk@^0.8.0` (facade, not fork)

---

## 1. Summary

Peer Cash is a productized crypto-to-fiat **offramp**: one npm package that turns a user's Base USDC into fiat on Venmo, Revolut, Wise, Zelle, Cash App and more, with protocol-held funds, no custodial off-ramp provider, and the live Chainlink market rate with zero spread. It is a thin, opinionated facade over `@zkp2p/sdk`: a small, honest surface (eight verbs) that a React app, a Node service, and an AI agent consume identically.

The protocol did not change. Peer Cash is a **framing plus an SDK that enforces the framing**: the cashing-out user becomes a standard maker; a standard taker pays them fiat and proves it via TEE-TLS; the protocol releases funds. No new contracts, no proof inversion, no curator changes.

## Who it's for

Directionally, this is infrastructure for **app integrators who need to offboard their users to fiat without standing up a centralized off-ramp**. The target consumers are:

- **Wallets** that want an in-app "cash out to my bank / payment app" button without integrating a MoonPay/Ramp/Transak-style custodial provider, its hosted identity funnel, and its per-transaction economics.
- **Crypto apps and consumer products** that hold user USDC and want a native exit to fiat as a feature, not a redirect to a third party.
- **DeFi protocols and onchain products** that need a programmatic withdrawal-to-fiat path without a custodial off-ramp provider, including agent- and policy-driven flows where no human clicks a widget.
- **AI agents** holding USDC that need to cash out through typed tools with host-side signing.

The wedge against centralized off-ramps (MoonPay, Ramp, Transak, Coinbase off-ramp) is structural, not just pricing: **protocol-held funds** instead of provider custody, **no separate Peer identity flow** for the integrator to embed, **market rate at zero spread** instead of a marked-up quote, and an **API/agent-native surface** rather than a hosted iframe widget. The integrator ships a few function calls; their users never leave the app or hand custody to a middleman.

## 2. Problem

- **Offramping is the underserved half.** Onramps are everywhere; "get my USDC into my Venmo" without a hosted identity funnel or custodial provider is rare. The protocol already supports it; nothing packaged it.
- **The full SDK is too much surface for this job.** `@zkp2p/sdk` exposes ~40+ methods, rate/spread/vault/DRM controls, both sides of the book. A developer who just wants "USDC in, fiat out" should not have to learn deposits, intents, verifiers, gating services, and oracle configs.
- **Agents are a first-class customer with no first-class surface.** An AI agent holding USDC should be able to cash out through typed tools with host-side signing — no UI, no human. Nothing existed for that.
- **Trust needs to be verifiable, not asserted.** Code that constructs the transactions moving a user's USDC into protocol-held funds, shipped from a private repo, is a black box. A standalone public repo makes the custody claim auditable.

## 3. Goals / Non-goals

**Goals**

- Offramp-only, maker-side, Base USDC → fiat, in the smallest honest API that covers the whole lifecycle.
- Every operation available as pure serializable data; every mutating verb has an unsigned `prepare` path.
- Indexer-native order tracking — no storage layer; an order IS a deposit, resumable from its id alone.
- Money-safe by construction: never misreport an amount, never report a reverted transaction as success, never leak a raw error.
- Agent-ready: JSON-schema tool manifest, `AGENTS.md`, a colocated integration skill, ERC-8021 attribution.

**Non-goals (the API physically cannot express these)**

- Rate / spread configuration — `spreadBps: 0` is a constant, not a parameter.
- Onramp vocabulary, buyer-side operations, dispute machinery, SAR, vaults/DRM, corridor gating.
- Any-chain in v1 (Base USDC in only; any-chain is the first fast-follow).
- Multi-payout legs in v1 (single `receive` leg; `Leg | Leg[]` is a later additive change).

## 4. Product model

- **Maker inversion.** The user deposits USDC into the protocol priced at the live Chainlink oracle, zero spread. By construction this is the best offer on the book, which is the fill incentive. A buyer signals an intent, pays fiat offchain, proves it, and the protocol releases the USDC to them.
- **Oracle-at-fill pricing. There is no quote.** The binding rate resolves at the oracle when a buyer fills. The API says `estimate()`, never `quote()`. Anything implying a locked price is a bug.
- **Honest ETA.** Buyer arrival time is unknowable; `order.explain()` states only what the chain shows. No countdowns.
- **The chain is the database.** Orders derive from the indexer by `depositId`. Integrators store one column: `userId → depositId`.

## 5. API surface — eight verbs

| Verb                                       | What it does                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `capabilities()`                           | Sync discovery: platforms × oracle-priced currencies × payee hints × amount bounds × per-platform verification flags |
| `estimate({ amount, currency })`           | Live oracle rate, idempotent, no side effects; carries oracle freshness + a `stale` flag                             |
| `cashout(input, { signer })`               | Registers the payee, ensures allowance, creates the deposit, returns the resumable `depositId`                       |
| `prepare(input)`                           | Same as cashout but returns unsigned `txs[]` `[approve, createDeposit]` — agent wallets, AA, server keys             |
| `order(depositId)` / `orders(owner)`       | Cold-hydrate one order from its id; list a wallet's orders (indexer-native)                                          |
| `buyer(address)`                           | A buyer's protocol track record (fulfilled/pruned counts, success rate) — "who just matched my order?"               |
| `watch(depositId)`                         | Async iterator; yields on state change until terminal state, abort, or timeout                                       |
| `withdraw(depositId, { signer, amount? })` | The ONE unwind verb — partial with `amount`, full close without (prunes expired intents first)                       |
| `topUp(depositId, amount, { signer })`     | Add USDC to a live order — same payee, same market rate                                                              |

`prepareWithdraw` and `prepareTopUp` mirror the mutating verbs for host-side signing. Every transaction — including approves — carries ERC-8021 attribution (`peer-cash`, then integrator `referrer` codes, then the Base builder code).

## 6. Architecture

A standalone repo can't use `workspace:*`, so `@zkp2p/cash` depends on the **published** `@zkp2p/sdk@^0.8`. "Minimal" is judged at the API surface, not the dependency tree — the facade keeps the outward surface tiny while reusing battle-tested internals.

- **`src/engine/`** — pure, deterministic, no I/O: order-state derivation, market-rate deposit-param construction (`spreadBps: 0`), receipt parsing, hash decoding, buyer-profile and payout-leg reconstruction, fiat math. Ported from the reviewed reference implementation; fully unit-tested with golden files.
- **`src/client/`** — `createCashClient` facade over a read-only `Zkp2pClient`, the eight verbs, typed errors, allowance settlement, transaction confirmation.
- **`src/codecs/`** — zod schemas + lossless JSON round-trips for every wire type (bigints as decimal strings; `order.explain()` re-attached on parse).
- **`src/tools/`** — JSON-schema manifest of the verbs for agent hosts; mutating tools default to the prepare path.
- **`src/react/`** — optional hooks (`useEstimate`, `useCashout`, `useOrder`, `useOrders`); React is an optional peer dep, never pulled in by the root entry.

**Export audit result:** every runtime symbol the engine needs is publicly exported by `@zkp2p/sdk@0.8.0`. Three types carry indexer-prefixed names and one (`CuratorPayeeDataInput`) is recovered by type extraction — all mapped in one file (`sdk-types.ts`). No SDK patch was required; the package depends on the published `^0.8.0` directly.

## 7. Data & enrichment — decoded, receipt-grade

The order surface serves synthesized, decoded data, not raw indexer projections:

- **Order state is derived, not stored.** The indexer's Deposit entity has no amount field; `totalAmount` is reconstructed from four aggregates (`remaining + outstanding + taken + withdrawn` — the identity the schema itself documents), and the five product states (`awaiting-buyer → matched → delivering → delivered / returned`) from those aggregates plus intent statuses.
- **Fills are receipts.** Each decodes: currency (from the bytes32 hash), the oracle rate locked at signal and `fiatOwed` (ceil-to-cent, matching the first-party clients' math), then post-proof `fiatPaid` (verified, cents convention), `paidCurrency`, `paymentId` (platform reference), `releasedAmount`, and `fillLatencySeconds`.
- **Payout legs reconstructed** on `order()` from the relations the same query returns: decoded platform + currency, payee hash, and a **pricing proof** (`spreadBps: 0`, `kind: oracle_chainlink`, `marketRate: true`) — the zero-spread claim is a queryable fact.
- **Everything decoded to human units:** platform ids and currency codes, plain-number rates. Raw hashes stay available alongside for anything unknown.
- **Expiry is belt-and-braces:** honors the indexer's reconciler `isExpired` flag OR the local clock, whichever fires first (the reconciler runs on a ~10-minute cadence and is live-only).

## 8. Agent surface

- **prepare/execute split** — unsigned `txs[]` for any signer; policy layers inspect calldata pre-signature.
- **`@zkp2p/cash/tools`** — JSON-schema tool definitions of the verbs; mutating tools default to the prepare path so signing stays host-side.
- **Typed errors** — every failure carries `code`, `retryable`, `remediation`; `nextActions` drive the lifecycle without heuristics.
- **`AGENTS.md`** in the repo and tarball; **`peer-cash-integration` skill** colocated and versioned with the code (drift is structurally impossible).

## 9. Reliability & correctness

The unforgivable class is misreporting money. The build is hardened against it and was reviewed adversarially and against all three upstreams (indexer, curator, `@zkp2p/sdk`).

- **No false success.** Every mutating verb (`cashout`, `topUp`, `withdraw` full and partial, prune) waits for its receipt and throws `TRANSACTION_FAILED` on revert. A reverted withdrawal can never return a success result.
- **No raw errors.** Every SDK/RPC error from a mutating call maps to a typed `CashError` (`ESCROW_PAUSED`, `ALLOWANCE_NOT_VISIBLE`, or a wrapped `TRANSACTION_FAILED`).
- **Honest `nextActions`.** List rows (which omit intent detail) never offer a withdraw that would revert; a live outstanding amount is treated conservatively as locked.
- **Allowance durability.** Approvals wait for the receipt and poll until the allowance is visible on the read path (guarding against load-balanced RPC replicas), then throw a retryable error rather than submitting a doomed deposit.
- **Verified-platform gate.** Wise/PayPal require a signed identity attestation the SDK can't mint; `capabilities()` flags them (`requiresIdentityAttestation`) and a bare-handle cashout fails fast with `PAYEE_VERIFICATION_REQUIRED` before any transaction.
- **Deterministic id normalization.** Escrow addresses are lowercased to the indexer's canonical form so the composite id and every subsequent query agree.

## 10. Verification

- **Unit / integration:** 114 tests, all green. Typecheck (strict), lint, prettier, and dual ESM+CJS+d.ts build all pass (`bun run ci`).
- **Staging, maker-side only, zero buyer dependency** (`scripts/verify-staging.ts`): create a real deposit → assert `awaiting-buyer` with decoded payout leg (`zelle/USD, spreadBps=0, marketRate=true`) and on-chain `peer-cash` attribution → topUp → partial withdraw (order stays live) → full withdraw → assert `returned`, balance restored to the cent. Run six times across the build; every run clean, zero funds left locked.
- **Live production, read-only, no keys** (`scripts/verify-prod-read.ts`): 86/86 payout legs across 25 live deposits decoded; 20/20 real fulfilled receipts agree with the locked-rate math (the cents convention proven against ground truth); a real buyer profiled; a live 7000-USDC / 16-fill order derived and codec round-tripped losslessly.

## 11. Scope cuts & roadmap

- **Any-chain** (Relay bridge → Base USDC) — first fast-follow; two stages, gated on testnet verification of the one-step `depositTo` path.
- **Multi-payout** (`receive: Leg | Leg[]`) — additive, raises fill probability.
- **Wise/PayPal in-SDK registration** — currently requires the app/extension attestation; an SDK path would need the attestation flow.
- **`@zkp2p/sdk` open-sourcing** — the honest gap in the trust story; the facade is auditable, the dependency still ships from private source.

## 12. Rollout

Repo is **private** on the `zkp2p` org; it flips **public** as the final step together with the `0.1.0` npm publish, on explicit go. The developer-conversion landing page (`/cash` on peer.xyz) is open as its own **draft PR on `zkp2p-clients` (#1103)**, brand-native and claims-reviewed, held in draft until the publish lands so its npm and GitHub CTA links resolve.

## 13. Acceptance criteria — all met

- [x] Eight-verb offramp API; every mutating verb has an unsigned prepare path.
- [x] Facade over published `@zkp2p/sdk@^0.8`; no SDK fork; export audit clean.
- [x] Indexer-native, resumable-from-id order tracking; no storage layer.
- [x] Decoded, receipt-grade order data with a queryable zero-spread pricing proof.
- [x] Agent surface: `/tools` manifest, `AGENTS.md`, integration skill, ERC-8021 attribution.
- [x] Money-safe: receipt-checked mutations, typed error contract, honest `nextActions`.
- [x] Verified against staging (maker-side) and live production (read-only).
- [x] Docs complete, accurate, slop-free; CI green.
