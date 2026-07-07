---
name: peer-cash-integration
description: Integrate Peer Cash (@zkp2p/cash) into any codebase — React app, Node service, or agent runtime. Covers the maker-inversion mental model, oracle-at-fill pricing, the verbs, indexer-native order tracking, the failure playbook, and the maker-side staging verification that proves the integration works. Use when adding crypto-to-fiat cash-out to a product or wiring the cash tools into an agent host.
---

# Peer Cash integration

Onboard this codebase to `@zkp2p/cash`: an offramp-only SDK that cashes out
Base USDC to fiat at the live Chainlink market rate (0% spread),
non-custodially, over the ZKP2P protocol.

## 1. Mental model (read before writing code)

- **Maker inversion.** The cashing-out user is the _maker_: their USDC goes
  into escrow as a deposit. A buyer (taker) pays them fiat and proves it
  (TEE-TLS); escrow releases the USDC. The protocol runs in its normal
  direction — Peer Cash is a lens on it, not a fork of it.
- **Oracle-at-fill pricing. There is no quote.** The deposit carries
  `oracleRateConfig { spreadBps: 0 }`; the binding rate is whatever the
  Chainlink feed says when a buyer fills. `estimate()` is deliberately named
  — anything in your UI or agent output implying a locked rate is a bug.
- **Custody story.** Funds are held by the escrow contract only. An unmatched
  deposit is withdrawable by the maker at any time. The SDK never holds keys.
- **Honest ETA.** Buyer arrival time is unknowable. Use `order.explain()`;
  never render a countdown.

## 2. Decision tree — entry point by runtime

| Runtime                   | Entry                                                            | Signer pattern                                                                      |
| ------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| React app                 | `@zkp2p/cash/react` hooks + one `createCashClient` in a provider | wagmi/viem `WalletClient` from the connected wallet                                 |
| Node service              | `createCashClient` + `cashout()`/`withdraw()`                    | `createWalletClient({ account: privateKeyToAccount(...), chain: base, transport })` |
| Agent host / policy layer | `prepare()` / `prepareWithdraw()` → unsigned `txs[]`             | Host signs; see `@zkp2p/cash/tools` for the JSON-schema tool manifest               |

## 3. Recipes — the verbs

Authoritative signatures live in the package's typedoc and `AGENTS.md` — do
not copy types from here; import them.

```ts
import { createCashClient, usdc } from '@zkp2p/cash';

// env: 'production' | 'preproduction' | 'staging'
const cash = createCashClient({ environment: 'staging' });

const caps = cash.capabilities(); // 0 discover (sync)
const est = await cash.estimate({ amount: usdc(100), currency: 'USD' }); // 1 estimate
const res = await cash.cashout(
  {
    // 2 execute
    amount: usdc(100),
    receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@handle' } },
  },
  { signer },
);
const { txs } = await cash.prepare({/* same input */}); // 2b unsigned
const order = await cash.order(res.depositId); // 3 observe
const mine = await cash.orders(ownerAddress, { inFlight: true }); // 4 list
for await (const o of cash.watch(res.depositId)) {
  // 5 watch
  if (!o.isInFlight) break;
}
await cash.withdraw(res.depositId, { signer }); // 6 unwind (amount: for partial)
await cash.topUp(res.depositId, usdc(50), { signer }); // 7 top up a live order
```

Every mutating verb also has an unsigned `prepare*` counterpart, and every
transaction carries ERC-8021 attribution (`peer-cash` + your
`createCashClient({ referrer })` codes).

## 4. Order management — indexer-native

- A cash order IS a deposit; the chain is the database. No storage layer.
- Bind orders to your users with one column in _your_ system:
  `userId → depositId`, populated from `cashout()`'s return value.
- `order(depositId)` cold-hydrates from the id alone — resumable across
  processes, devices, and crashes.
- Serialize across boundaries with the exported codecs
  (`orderToJson`/`orderFromJson`) — they handle bigints and re-attach
  `explain()`.

## 5. Failure playbook

Every error is a `CashError` with `code`, `retryable`, `remediation`. The
full table lives in `AGENTS.md` and `docs/lifecycle-and-recovery.md` — quote
those, don't re-derive. The three that matter most in practice:

- `ORDER_NOT_FOUND` seconds after `cashout()` = indexer lag. The receipt is
  the truth; retry. `watch()` and the React hooks absorb it.
- `ACTIVE_INTENT_BLOCKS_WITHDRAWAL` = a buyer may still deliver. Retry
  `withdraw()` after their intent expires; it prunes automatically.
- Buyer never pays → nothing to do: the intent expires, `nextActions` gains
  `'withdraw'`, one `withdraw()` call returns the funds (prune + withdraw).

## 6. Verification checklist (mandatory before calling the integration done)

Run against `environment: 'staging'` with a small funded wallet.
**Maker-side only — never wait on a buyer.**

1. Create a real 1–2 USDC deposit via `cashout()`; capture `depositId`.
2. Assert `order(depositId).state === 'awaiting-buyer'` (retry through
   indexer lag for up to ~60s).
3. Assert `orders(owner)` contains the deposit.
4. `withdraw(depositId, { signer })` succeeds.
5. Assert `order(depositId).state === 'returned'` and the wallet balance is
   restored minus gas.

If withdrawal fails with funds stuck: stop, do not retry blindly, escalate to
a human with the `depositId` and tx hashes.
