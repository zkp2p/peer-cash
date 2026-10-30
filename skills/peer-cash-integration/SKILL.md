---
name: peer-cash-integration
description: Integrate Peer Cash (@zkp2p/cash) into any codebase - React app, Node service, or agent runtime. Covers the maker-inversion mental model, corridor pricing and binding, the verbs, indexer-native order tracking, the failure playbook, and the maker-side staging verification that proves the integration works. Use when adding crypto-to-fiat cash-out to a product or wiring the cash tools into an agent host.
---

# Peer Cash integration

Onboard this codebase to `@zkp2p/cash`: an offramp-only SDK that routes Relay
EVM assets or NEAR Intents 1Click external deposits into Base USDC, then cashes
out Base USDC to fiat at a zero-spread Chainlink market rate, with
protocol-held funds and no custodial off-ramp provider.

## 1. Mental model (read before writing code)

- **Maker inversion.** The cashing-out user is the _maker_: their USDC becomes
  a protocol-held deposit. A buyer (taker) pays them fiat and proves it
  with TEE-TLS; the protocol releases the USDC. The protocol runs in its normal
  direction - Peer Cash is a lens on it, not a fork of it.
- **Source routing.** Destination is always canonical Base USDC. Same-chain
  Base USDC remains the default/minimal path. Other source chains/tokens come
  from `@relayprotocol/relay-sdk` metadata and quote execution, filtered to
  EVM chains this viem SDK can sign. Non-Base source chains require
  `sourceSigner`. Use `EXACT_INPUT` for high-level cash-out flows: `amount` is
  source-token base units, while `source.amount` is Relay's guaranteed minimum
  Base USDC output and the exact order deposit amount, not actual route output.
- **NEAR Intents routing.** Non-EVM origins use an external-deposit boundary:
  discover live 1Click assets, persist the signed quote/address/memo/deadline,
  send once with the origin wallet, optionally register that existing hash,
  poll status to `SUCCESS`, reconcile Base evidence, then cash out Base-only.
  Browser integrations use a same-origin proxy so the 1Click JWT stays server-side.
- **Pricing has an explicit binding point.** Every corridor carries
  `oracleRateConfig { spreadBps: 0 }`; the binding rate is the Base oracle rate
  when a buyer signals, including Alipay/CNY and UPI/INR. Read
  `estimate().binding` and `capabilities().platforms[].pricing`.
- **Custody story.** Funds are held by the protocol contract only. An unmatched
  deposit is withdrawable by the maker at any time. The SDK never holds keys.
- **Cash-outs never configure a whitelist or group**, including Venmo and
  PayPal. Signed `cashout()` returns after deposit confirmation. Prepared hosts
  finalize the confirmed receipt and persist `depositId`; any EOA works.
  Venmo and PayPal retain the protocol's default dispute protection without a
  group-based staking exemption. Cash App is non-chargebackable and does not
  require dispute-protection stake.
- **Honest ETA.** Use `estimate().eta`: `{ seconds, label }` backed by rolling
  30-day indexer data from zero-spread (`spreadBps: 0`) market-rate deposits in
  the same payout corridor, measured from deposit creation to first fill. Do
  not use signal-to-fulfillment latency and never render it as a guarantee.

## 2. Decision tree - entry point by runtime

| Runtime                   | Entry                                                            | Signer pattern                                                                      |
| ------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| React app                 | `@zkp2p/cash/react` hooks + one `createCashClient` in a provider | wagmi/viem `WalletClient` from the connected wallet                                 |
| Node service              | `createCashClient` + `cashout()`/`withdraw()`                    | `createWalletClient({ account: privateKeyToAccount(...), chain: base, transport })` |
| Agent host / policy layer | Base-USDC `prepare*()` -> unsigned `txs[]` + `steps[]`           | Host signs; Relay tools do not execute, and NEAR tools never send origin funds      |

## 3. Recipes - the verbs

Authoritative signatures live in the package's typedoc and `AGENTS.md` - do
not copy types from here; import them.

```ts
import { createCashClient, usdc } from '@zkp2p/cash';

// env: 'production' | 'preproduction' | 'staging'. Preproduction and staging
// select api-preprod.zkp2p.xyz and api-staging.zkp2p.xyz curators by default.
const cash = createCashClient({ environment: 'staging' });

const caps = cash.capabilities(); // 0 discover (sync)
const relayCaps = await cash.capabilities({ includeRelaySources: true }); // 0b source discovery
const nearCaps = await cash.capabilities({ includeNearIntentsSources: true }); // 0c 1Click assets
const est = await cash.estimate({ amount: usdc(100), currency: 'USD' }); // 1 estimate + ETA
const res = await cash.cashout(
  {
    // 2 execute
    amount: usdc(100),
    // or an array of legs to offer several platforms on one order:
    // receive: [{ platform: 'venmo', ... }, { platform: 'revolut', ... }]
    receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@handle' } },
  },
  { signer },
);
const { txs, steps } = await cash.prepare({/* same input */}); // 2b unsigned plan
// Submit txs in order. After createDeposit confirms:
const prepared = cash.finalizePreparedCashout(createDepositReceipt);
persist({ depositId: prepared.depositId });
const order = await cash.order(res.depositId); // 3 observe
const mine = await cash.orders(ownerAddress, { inFlight: true }); // 4 list
for await (const o of cash.watch(res.depositId)) {
  // 5 watch
  if (!o.isInFlight) break;
}
await cash.withdraw(res.depositId, { signer }); // 6 unwind (amount: for partial)
await cash.topUp(res.depositId, usdc(50), { signer }); // 7 top up a live order
```

Signer-backed exact-input source path:

```ts
const routed = await cash.cashout(
  {
    amount: sourceAmount,
    source: {
      chainId: sourceChainId,
      currency: sourceToken,
      tradeType: 'EXACT_INPUT',
    },
    receive,
  },
  { signer, sourceSigner },
);

persist({
  depositId: routed.depositId,
  guaranteedBaseUsdc: routed.source?.amount,
  requestId: routed.source?.requestId,
  transactions: routed.source?.transactions,
});
```

External-deposit NEAR Intents source path:

```ts
const quote = await cash.quoteNearIntentsSource({
  sourceAsset: nearAssetId,
  amount: usdc(1),
  recipient: signer.account.address,
  refundTo: originRefundAddress,
  tradeType: 'EXACT_OUTPUT',
  deadline: new Date(Date.now() + 3 * 60_000).toISOString(),
});
persist(quote);
const txHash = await originWallet.send(quote.depositAddress!, quote.inputAmount);
await cash.submitNearIntentsDeposit({
  depositAddress: quote.depositAddress!,
  ...(quote.depositMemo ? { depositMemo: quote.depositMemo } : {}),
  txHash,
});
const route = await cash.nearIntentsStatus({
  depositAddress: quote.depositAddress!,
  ...(quote.depositMemo ? { depositMemo: quote.depositMemo } : {}),
  expectedQuote: quote,
});
// Reconcile Base delivery after SUCCESS, then use a Base-only prepare/cashout.
```

Base-USDC cashout, withdraw, and top-up also have unsigned `prepare*`
counterparts. `prepare()` rejects `source`. Source-routed cashout runs Relay
first; use signed `cashout({ source }, { signer, sourceSigner })`, or execute
and confirm Relay in the host before preparing a Base-USDC cashout.
`cash_source_quote` and `cash_source_status` are quote/read tools, not a
host-side execution path. The built-in tool manifest also does not expose
receipt finalization as a separate tool; the host adapter calls
`CashClient.finalizePreparedCashout(receipt)` after its signer confirms
`createDeposit`.
Every protocol transaction carries ERC-8021 attribution. To receive the
deposit-level integration share, copy the six-character code from your Peer
mobile or web referral screen and configure it directly:

```ts
const cash = createCashClient({
  environment: 'production',
  referralCode: 'ABC123',
});
```

The SDK emits `peer-cash`, then `peer-ref-ABC123`, then any analytics-only
`createCashClient({ referrer })` codes. No API key or referral-enrollment
transaction is required. Curator pays the eligible code owner 50 bps (capped
by the Peer service-fee budget) instead of applying the maker L1/L2 ladder for
that deposit. Use one referral code per deposit. Renaming the displayed code
later does not change the owner of an already-attributed open deposit.

Wise and PayPal require an identity attestation for a new payee registration.
The SDK accepts the structured attestation but does not mint it; first-party
Peer web obtains it through the Peer TEE browser extension. Do not disable these
platforms outright: a previously registered handle can be reused with bare
payee data. Handle `PAYEE_VERIFICATION_REQUIRED` when registration is still
needed.

UPI is available on production, preproduction, and staging clients without feature flags. Accept any locally valid
UPI ID from any bank; do not add a seller bank-login, extension, identity
attestation, or pre-registration step. Buyers pay and verify through Amazon Pay using standard UPI; UPI Lite and
merchant payments are unsupported.

X Money accepts `receive: { platform: 'xmoney', currency: 'USD', payee: '@YourHandle' }`.
Raw handles normalize to the bare lowercase username. Structured payee data must
already use `offchainId: 'yourhandle'`. Confirm that the receiving account has
X Money enabled: registration verifies X account existence, but not X Money enrollment.
No identity attestation is required.

## 4. Order management - indexer-native

- A cash order IS a deposit; the chain is the database. No storage layer.
- Bind orders to your users with one column in _your_ system:
  `userId → depositId`, populated from `cashout()`'s return value.
- `order(depositId)` cold-hydrates from the id alone - resumable across
  processes, devices, and crashes.
- Serialize across boundaries with the exported codecs
  (`orderToJson`/`orderFromJson`) - they handle bigints and re-attach
  `explain()`.

## 5. Failure playbook

Every error is a `CashError` with `code`, `retryable`, `remediation`. The
full table lives in `AGENTS.md` and `docs/lifecycle-and-recovery.md` - quote
those, don't re-derive. The recovery boundaries that matter most in practice:

- `ORDER_NOT_FOUND` seconds after `cashout()` = indexer lag. The receipt is
  the truth; retry. `watch()` and the React hooks absorb it.
- `ACTIVE_INTENT_BLOCKS_WITHDRAWAL` = a buyer may still deliver. Retry
  `withdraw()` after their intent expires; it prunes automatically.
- `SOURCE_ROUTE_COMPLETED_CASHOUT_FAILED` = Relay completed but the Base
  cashout did not. Never repeat Relay; retry Base-only with
  `BigInt(error.recovery.amount)`.
- `SOURCE_CASHOUT_SUBMISSION_UNKNOWN` = Relay completed but Base submission
  returned no hash. Inspect Base wallet activity and
  `orders(error.recovery.depositor)` before any retry.
- `SOURCE_CASHOUT_STATUS_UNKNOWN` = Relay completed and a Base transaction was
  submitted, but its receipt is unknown. Inspect
  `error.recovery.depositTxHash`; do not route or submit again until it is
  known.
- `SOURCE_DEPOSIT_SUBMISSION_FAILED` = the NEAR Intents origin transaction may
  already be final. Retry only the notification with the same address/hash;
  never resend source funds.
- `TRANSACTION_STATUS_UNKNOWN` = a Base transaction may already have
  succeeded. Inspect `error.recovery.transactionHash` before resubmitting.
- `TRANSACTION_SUBMISSION_UNKNOWN` = a Base mutation returned no hash but may
  have broadcast. Follow `error.recovery`, inspect Base wallet/protocol state,
  and do not retry until absence is proven.
- `INDEXER_UNAVAILABLE` / `ORACLE_READ_FAILED` = retry the read only. Do not
  repeat the transaction that produced the id or balance being inspected.
- `SIGNER_CHAIN_MISMATCH` = switch to the required chain and obtain a fresh
  Relay quote before retrying.
- `SIGNER_CHAIN_UNAVAILABLE` = reconnect the wallet and verify its live chain
  before any quote or mutation.
- Buyer never pays → nothing to do: the intent expires, `nextActions` gains
  `'withdraw'`, one `withdraw()` call returns the funds (prune + withdraw).

## 6. Verification checklist (mandatory before calling the integration done)

Run against `environment: 'staging'` with a small funded wallet.
**Maker-side only - never wait on a buyer.**

Prove both routes without waiting for a buyer:

1. Create a real 1–2 USDC Base-USDC deposit; retain `depositId` and the Base tx.
2. Retry through indexer lag until `order(depositId)` is `awaiting-buyer`, and
   assert `orders(owner)` contains it.
3. Withdraw it; assert `returned` and the Base USDC balance is restored minus
   gas.
4. Select a live supported source from capabilities and create a real
   exact-input route whose guaranteed Base USDC output is at least 1 USDC.
   Retain Relay `requestId`, origin/destination transaction hashes, Base tx,
   and `depositId`.
5. Assert the routed order becomes `awaiting-buyer` and appears in
   `orders(owner)`, then withdraw and confirm `returned` plus restored balance.

If withdrawal fails with funds stuck: stop, do not retry blindly, escalate to
a human with the `depositId` and tx hashes.

## UPI oracle checks

UPI/INR and Alipay/CNY use ZKP2P-operated AggregatorV3-compatible feeds on Base,
through the SDK's Chainlink oracle adapter with `invert: true` and zero spread.
The SDK feed catalog supplies the addresses and determines oracle availability;
Cash adds no currency exceptions. Estimates read through the normal Base
`transport` / `rpcUrl`; deposits float until each buyer signals an intent.
UPI is available in production, preproduction, and staging without a feature flag.

Before a funded UPI QA run, call
`cash.estimate({ amount: 1000000n, platform: 'upi', currency: 'INR' }, { includeEta: false })`
using the intended live Base RPC. Require a positive finite rate,
`binding: 'intent-signal'`, and `oracleUpdatedAt` no more than 86400 seconds
old and not in the future. Record the observation time and selected chain,
then stop before funding if the read fails. Unit-test fixtures prove routing,
not live availability. Use the pinned SDK oracle feed catalog for the feed address.

## Optional Cash App and PayPal account connection

This is the connection Peer Payouts uses. The seller connects a Cash App or
PayPal account in the Peer App Clip on iPhone, or in the installed Peer app on
Android. Curator verifies the account and stores the seller credential. A
connection never moves funds or starts a cash-out, and `cashout()` never
requires one.

```ts
const link = await cash.prepareSarConnect({
  platform: 'cashapp', // or 'paypal' with paypalEmail (and optional identityActionType)
  payeeHandle: '$alice',
  returnUrl: 'https://checkout.example.com/connected',
});
// Persist the link (preparedSarConnectToJson), then show it:
const href = sarConnectUrlFor(link, detectSarConnectDevice());
const result = await cash.waitForSarConnect(link); // connected | cancelled | expired
```

- `prepareSarConnect(input)` calls Curator's wallet-free
  `POST /v2/sar/connections/checkout`. Pass
  `{ privyAccessToken, callerAddress }` as the second argument for the
  wallet-owned `POST /v2/sar/connections`, which associates the connection with
  that seller's Peer maker profile.
- `link.url` is the App Clip URL exactly as Curator returned it. Use it in
  iPhone Safari and in desktop QR codes. `link.appUrl` carries the same request
  on `/connect`, which opens the installed Peer app on Android and in other iOS
  browsers. `sarConnectUrlFor(link, detectSarConnectDevice())` picks between
  them.
- `getSarConnectStatus(link)` reads the session with the request id as a
  Bearer token. It returns `expired` on 401/410 and throws
  `SarConnectError('mismatch')` when the session's state, environment, account
  or return URL differ from the link. `waitForSarConnect(link)` polls every 3s
  and returns `connected` only after `isSarConnected(account)` confirms the
  credential with Curator's account status. `cancelSarConnect(link)` cancels a
  pending link but never undoes a submitted credential.
- Cash App takes a cashtag: one leading `$` and surrounding spaces are removed,
  it is lowercased, and it must be 1-20 letters or digits. Cash App is USD
  only. PayPal takes the PayPal username (one leading `@` removed, then
  lowercase letters, digits, `.`, `_` or `-`) and requires `paypalEmail`. Set
  `identityActionType: 'register_business_paypal'` for a Business account;
  Personal is the default. These rules mirror Curator's
  `sarConnectionAccount.ts`; `bun run check:curator-sar` compares them with a
  live Curator.
- Each integrator's `returnUrl` origin must be on the Curator environment's
  `SAR_CONNECT_RETURN_ORIGINS` and CORS lists. Otherwise create fails with
  `SarConnectError('invalid_return_url')`. Ask Peer to approve each origin per
  environment.
- `requestId` is a 15-minute capability. Keep it out of logs and analytics.
  Treat `sarState` and `sarStatus` on the callback as hints, and re-read status.
  Prepared links and results have `preparedSarConnectToJson/FromJson` and
  `sarConnectResultToJson/FromJson` codecs. See `examples/sar-connect.ts`.

## Optional X Money receipt linking

`prepareXMoneyConnect(handle, { returnUrl }?)` registers an X username and returns
`{ payeeDetails, payeeUsername, url }`. From a separate click, call
`openXMoneyConnect(link)`. Native apps open `link.url` themselves. Re-check
`isXMoneyConnected(link.payeeDetails)` on return or dismissal; only an active
Gmail, Outlook or iCloud Mail credential counts as linked. Status errors reject.

The hosted `/connect/xmoney` page must be deployed before enabling the flow.
Enable X Money email notifications and receive a payment before connecting.
The signed receipt must match the registered X account. Account identity stays
in the URL fragment; partners never receive mailbox tokens or passwords.
`XMoneyConnectError.code` preserves hosted errors. Configure branding through
`createCashClient({ environment, xmoney: { appearance, popup } })`.
Re-prepare when the username changes. Cash-out does not require linking.
Prepared links and results have `preparedXMoneyConnectToJson/FromJson` and
`xMoneyConnectResultToJson/FromJson` codecs.

## Optional Venmo receipt linking

Offer this separately; `cashout()` and `prepare()` never require or invoke it.
Run `cash.prepareVenmoGmailConnect(handle)` when the user selects Venmo, then
call `cash.openVenmoGmailConnect(link.payeeDetails)` directly from a separate
button click. Re-prepare when the selected handle changes. Use
`cash.isVenmoGmailConnected(link.payeeDetails)` after returning from a mobile
tab or an ambiguous closure; service errors reject, and any active Gmail,
Outlook or iCloud Mail credential counts as connected (`@zkp2p/sdk` 0.14.7
`isMailboxSellerCredentialType`). Persist the hash with its environment and user.

For native apps, use `prepareVenmoGmailConnect(handle, { returnUrl })` and
open `link.url` with Expo's `openAuthSessionAsync(link.url, returnUrl)`.
Register the scheme in your app binary; no registration with Peer is needed.
Peer appends no data to the callback. Omitted/empty callbacks attempt closure;
tabs that block it keep the success page. Always re-check status on return.

The hosted flow offers Gmail, including Google-hosted custom domains, personal
Outlook, and iCloud Mail, then verifies actual Venmo receipts.
`VenmoGmailConnectError` is separate from `CashError`; no emails, mailbox
tokens or app-specific passwords reach the partner. Configure `venmoGmail: { appearance, popup }`
for branding and desktop dimensions; omission keeps Peer defaults.
See the README for error codes, native callbacks, package-free URLs, and
customization, plus `examples/venmo-link.ts`.
