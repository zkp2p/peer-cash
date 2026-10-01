---
name: upi-preprod-qa
description: Verify the Cash SDK Amazon Pay UPI corridor on preproduction, including catalog gates, a small maker deposit, indexing, and cleanup.
---

# UPI preproduction QA

Use the exact published Cash candidate and record its SDK/contracts versions.
Require `createCashClient({ environment: 'preproduction' })` to advertise UPI/INR.
UPI is available without feature flags in every environment.
The canonical contracts catalog must contain the live UPI method and INR currency;
never invent a catalog entry when the package or registry omits one.

From a clean consumer of the candidate, run this catalog check before creating
any transaction:

```ts
import { createCashClient } from '@zkp2p/cash';

for (const environment of ['staging', 'preproduction', 'production'] as const) {
  const client = createCashClient({ environment });
  const method = client.capabilities().platforms.find((item) => item.platform === 'upi');
  if (!method?.currencies.includes('INR')) {
    throw new Error(`Missing UPI catalog for ${environment}`);
  }
}
```

Use an explicitly authorized low-value wallet and verified recipient UPI ID.
Keep the identity and operation ledger in ignored private storage, outside this skill.
`cashout` accepts any valid VPA; no seller bank login or identity attestation is required.
Verify INR pricing uses the ZKP2P-operated Base INR/USD oracle from the SDK
catalog, inverted through the Chainlink adapter with zero spread. Before funding, call
`cash.estimate({ amount: 5_000_000n, platform: 'upi', currency: 'INR' }, { includeEta: false })`
against the live default or explicitly configured Base RPC. Confirm a positive
rate, fresh `oracleUpdatedAt`, and `binding: 'intent-signal'`. Do not accept
mocked-rate unit tests as proof of a functioning live corridor. Stop before funding
if the read fails or is stale. The on-chain adapter enforces the SDK config's
`maxStaleness` at signal; do not substitute a static price to make QA pass.

With bounded task authorization, create one small Base-USDC deposit, recording
transaction hash and deposit ID before any retry. Confirm the receipt, then
`order`/`orders` and the matching preproduction indexer's MethodCurrency and
QuoteCandidate. Check exact UPI/INR hashes, payee hash, amounts, and rate. Share
this one fixture with authorized buyer QA instead of funding duplicate deposits.
Keep quotes within the maker minimum and available liquidity.

Use `examples/upi-staging-cashout.ts` with its explicit `preproduction`
environment argument as the maker API example. Use the supported Cash client
methods for signing and finalization; never copy an old escrow address or
transaction payload. For GraphQL, filter `MethodCurrency` and `QuoteCandidate`
by the recorded `depositId`, `paymentMethodHash`, and `currencyCode`. Require
exactly one matching tuple, Base USDC, a positive matching conversion rate,
`isActive: true`, `hasMinLiquidity: true`, and enough available liquidity.
Inspect `disputeProtectionRequiresStake` before buyer QA so stake admission is
not mistaken for a payment-proof failure.

Buyer QA belongs to the client and attestation repositories. Amazon Pay is the
sole buyer proof flow. Pay with standard UPI
to a person, then verify from the same Amazon account. Exclude UPI Lite, merchant
payments and incoming transactions. Keep session evidence encrypted. A real
intent requires the exact payment identity, allowed payment-time window, and an
unused payment nullifier. Report maker deposit, buyer signal, evidence proof,
and settlement as separate checkpoints.

After buyer intents are cancelled or otherwise terminal, call the supported
`withdraw` path and verify the receipt and returned order state. If a transaction
has an unknown result, inspect its receipt and existing deposit before retrying.
Stop further spending on an unexplained balance or identity mismatch.

Run `bun run ci` for SDK changes. Keep private VPA, cookies, raw receipts, keys, and request
bodies out of committed evidence; publish only redacted checkpoint results.

## Live order reconstruction regression

After the exact UPI fixture is indexed, require both `cash.order(depositId)` and `cash.orders(owner)` to return it. New UPI/INR deposits must have zero-spread oracle pricing evidence. Historical fixed-rate UPI/INR deposits still require positive fixed-rate evidence and the indexed `peer-cash` attribution marker for recovery. Do not classify unrelated Advanced Sell deposits as Cash orders. A quoteable indexer row alone is insufficient: run order lookup, partial-fill observation and withdrawal checks too. Keep the method/currency pair explicit; UPI/CNY must be rejected.

## Small-fixture visibility and dust reconciliation

The web orderbook hides deposits below USD 5 by default. Enable its low-liquidity
filter before diagnosing an active small fixture as missing. Selector liquidity
can include a deposit that the orderbook display hides. A verified read-only
Express `getQuote` accepted INR 10 against a 1 USDC fixture; quoteability still
depends on the current maker minimum, available liquidity and rate. This does
not authorize a payment or another fixture, and a quote is not a settlement.

The verified contract dust threshold is 0.1 USDC. A remaining amount below that
threshold may be collected as protocol dust rather than refunded to the maker.
Reconcile `DustCollected` events and actual token transfers with the successful
receipt, buyer proceeds, fees and maker balance. Do not interpret Cash
`returnedAmount` alone as a maker refund. Confirm the deployed threshold again
if the contract version changes, and retain exact amounts in private receipts.
