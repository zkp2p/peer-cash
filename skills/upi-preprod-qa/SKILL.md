---
name: upi-preprod-qa
description: Verify the Cash SDK Amazon Pay UPI corridor on preproduction, including catalog gates, a small maker deposit, indexing, and cleanup.
---

# UPI preproduction QA

Use the exact published Cash candidate and record its SDK/contracts versions.
Require `createCashClient({ environment: 'preproduction', features: { upi: true } })`
to advertise UPI/INR. Without the flag, and in production even with the flag,
UPI must be absent and unsigned preparation must reject before registration or rate reads.
The canonical contracts catalog must contain the live UPI method and INR currency;
never invent a catalog entry when the package or registry omits one.

From a clean consumer of the candidate, run this catalog check before creating
any transaction:

```ts
import { createCashClient } from '@zkp2p/cash';

for (const environment of ['staging', 'preproduction', 'production'] as const) {
  for (const upi of [false, true]) {
    const client = createCashClient({ environment, features: { upi } });
    const method = client.capabilities().platforms.find((item) => item.platform === 'upi');
    const expected = upi && environment !== 'production';
    if (Boolean(method?.currencies.includes('INR')) !== expected) {
      throw new Error(`Unexpected UPI catalog for ${environment}, flag=${upi}`);
    }
  }
}
```

Use an explicitly authorized low-value wallet and verified recipient UPI ID.
Keep the identity and operation ledger in ignored private storage, outside this skill.
`cashout` accepts any valid VPA; no seller bank login or identity attestation is required.
Verify INR pricing is a fresh Polygon Chainlink snapshot fixed at deposit creation.
The official [INR/USD feed](https://data.chain.link/feeds/polygon/mainnet/inr-usd)
is proxy `0xDA0F8Df6F5dB15b346f4B8D1156722027E194E60` on chain 137;
it is not registered in Ethereum's Feed Registry. Before funding, call
`cash.estimate({ amount: 5_000_000n, platform: 'upi', currency: 'INR' }, { includeEta: false })`
against the live default or explicitly configured Polygon RPC. Confirm a positive
rate, fresh `oracleUpdatedAt`, and `binding: 'deposit-creation'`. Do not accept
mocked-rate unit tests as proof of a functioning live corridor. The reader must
reject the wrong chain, invalid/incomplete rounds, future timestamps and data
older than 86,400 seconds. Forex market-hour gaps must fail closed; do not
substitute a static price or relax freshness to make QA pass.

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
sole client flow: no HDFC/Gmail selector or fallback copy. Pay with standard UPI
to a person, then verify from the same Amazon account. Exclude UPI Lite, merchant
payments and incoming transactions. Keep session evidence encrypted. A real
intent requires the exact payment identity, allowed payment-time window, and an
unused payment nullifier. Report maker deposit, buyer signal, evidence proof,
and settlement as separate checkpoints. Backend HDFC support is retained until
a separately authorized retirement; do not remove its server routes here.

After buyer intents are cancelled or otherwise terminal, call the supported
`withdraw` path and verify the receipt and returned order state. If a transaction
has an unknown result, inspect its receipt and existing deposit before retrying.
Stop further spending on an unexplained balance or identity mismatch.

Run `bun run ci` for SDK changes. Keep private VPA, cookies, raw receipts, keys, and request
bodies out of committed evidence; publish only redacted checkpoint results.

## Live order reconstruction regression

After the exact UPI fixture is indexed, require both `cash.order(depositId)` and `cash.orders(owner)` to return it. Fixed UPI/INR creation-rate deposits must have positive fixed-rate evidence and the indexed `peer-cash` attribution marker. Do not classify unrelated Advanced Sell deposits as Cash orders. A quoteable indexer row alone is insufficient: run order lookup, partial-fill observation and withdrawal checks too. Keep the method/currency pair explicit; UPI/CNY must be rejected.

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
