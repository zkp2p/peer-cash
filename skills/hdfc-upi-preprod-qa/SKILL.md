---
name: hdfc-upi-preprod-qa
description: Verify the Cash SDK HDFC email UPI corridor on preproduction, including catalog gates, a small maker deposit, indexing, and cleanup.
---

# HDFC UPI preproduction QA

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

Buyer QA belongs to the client and attestation repositories: HDFC debit email
selected through Gmail, encrypted raw evidence, no WhatsApp route. Historical
email checks against synthetic intents do not demonstrate settlement. A real
intent requires the exact payment identity, allowed payment-time window, and an
unused payment nullifier. Report maker deposit, buyer signal, evidence proof,
and settlement as separate checkpoints.

After buyer intents are cancelled or otherwise terminal, call the supported
`withdraw` path and verify the receipt and returned order state. If a transaction
has an unknown result, inspect its receipt and existing deposit before retrying.
Stop further spending on an unexplained balance or identity mismatch.

Run `bun run ci` for SDK changes. Keep private VPA, raw email, keys, and request
bodies out of committed evidence; publish only redacted checkpoint results.

## Live order reconstruction regression

After the exact UPI fixture is indexed, require both `cash.order(depositId)` and `cash.orders(owner)` to return it. Fixed UPI/INR creation-rate deposits must have positive fixed-rate evidence and the indexed `peer-cash` attribution marker. Do not classify unrelated Advanced Sell deposits as Cash orders. A quoteable indexer row alone is insufficient: run order lookup, partial-fill observation and withdrawal checks too. Keep the method/currency pair explicit; UPI/CNY must be rejected.

Historical HDFC emails may be accepted within the deployed 14-day lookback. Bind any generated proof to the exact real intent, check the unused nullifier, and expect proportional release when the old payment is smaller than the requested fiat amount. Synthetic proof success is separate from chain settlement. Never alter the evidence or relax the window to force a match.
