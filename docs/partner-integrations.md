# Partner integration patterns

Peer Cash starts after an application controls funds that should be converted
to fiat. How those funds arrived does not change the cash-out contract: the
application remains the maker, Base USDC becomes a Peer deposit, and a buyer
pays the maker offchain.

Keep revenue collection and cash-out as separate state machines. An MPP,
x402, subscription, checkout, or agent settlement proves that the merchant was
paid. It does not create a Peer Cash order and must not authorize one by
itself.

## Pick the custody boundary

### The application signs

Use `cashout()` when the application holds a viem `WalletClient` and its policy
allows immediate submission:

```ts
const result = await cash.cashout(
  {
    amount: settledBaseUsdc,
    receive: { platform: 'revolut', currency: 'USD', payee: 'merchant-handle' },
  },
  { signer: merchantWallet },
);

persist({ depositId: result.depositId });
```

The signer must be the wallet that owns the Base USDC and will own the Peer
deposit. `cashout()` returns after the deposit confirms; it never configures
a whitelist or group.

### Signing stays in a custody or approval system

Use `prepare()` when a policy engine, AA bundler, custody service, or human
approval step owns signing:

```ts
const prepared = await cash.prepare({
  amount: settledBaseUsdc,
  receive,
});

persist({
  reservationId,
  steps: prepared.steps,
  txs: prepared.txs,
});
```

Submit each transaction in order and wait for its receipt. After
`createDeposit` confirms, call `finalizePreparedCashout(receipt)` and persist
the returned `depositId`. No policy follow-up is required.

### An agent host prepares transactions

Use the canonical Peer MCP server from
[`zkp2p/peer-cli`](https://github.com/zkp2p/peer-cli) with its local cash
profile:

```sh
npx -y peer-protocol-cli@0.3.0 mcp --profile cash
```

The cash profile exposes reads and unsigned preparation tools. It never accepts
a private key, signs, or broadcasts. The hosted `mcp.peer.xyz` endpoint is
read-only; authority-bearing cash tools remain local over stdio.

## MPP merchant revenue

The runnable
[`mpp-merchant-cashout`](../examples/mpp-merchant-cashout) example accepts Base
USDC for an MPP resource, deduplicates successful settlement receipts, reserves
confirmed revenue, and returns an unsigned Peer Cash plan from a localhost-only
operator endpoint.

The production shape is:

1. Record the successful MPP receipt once.
2. Reserve a specific amount of confirmed, unreserved revenue before preparing
   the cash-out.
3. Persist the reservation and prepared transaction plan before returning it
   to the signer.
4. Submit the plan in order and finalize the confirmed deposit receipt.
5. Persist the `depositId` and drive the order from `nextActions`.
6. Release or reconcile the reservation only from confirmed transaction and
   protocol state.

For an MCP provider charging per tool call, the external
[`mpp-mcp-gateway` Peer Cash example](https://github.com/aspiring-100x/mpp-mcp-gateway/tree/main/examples/paid-peer-cash-mcp)
shows the same two-stage boundary: MPP settles pathUSD revenue to the operator,
then an operator-controlled Relay route converts a chosen amount to Base USDC
before Peer Cash prepares the fiat cash-out.

## Source assets are a separate route

If revenue is not already Base USDC, discover support live instead of
hardcoding a chain or token. Quote and execute Relay with the source wallet,
wait for the Base result, and only then call the Base-USDC `prepare()` path.

Persist the Relay request ID and every origin and destination transaction. If
the route completes but cash-out creation fails, retry Base-only with the
recovery amount. Never execute the source route twice. NEAR Intents sources use
the external-deposit flow: persist the signed quote and deposit address before
one origin send, then wait for `SUCCESS` and reconcile the Base destination.

## State a production integration must persist

- Settlement reference and settled amount
- Reservation ID, amount, owner, and status
- Source quote, request ID, deadline, and transaction evidence when routing
- Prepared `steps[]` and `txs[]`
- Submitted transaction hashes and receipts
- `depositId` and depositor wallet

Do not infer completion from a wallet balance or an HTTP timeout. A missing
transaction hash or unknown receipt may still mean a transaction was
broadcast. Follow the typed recovery action and inspect chain and order state
before any resubmission.

## Launch checklist

- Bind each settlement, reservation, and order to the same merchant identity.
- Keep private keys out of public handlers and MCP servers.
- Put the preparation endpoint behind operator authentication; localhost alone
  is only suitable for the example.
- Reject cash-out amounts above confirmed, unreserved revenue.
- Serialize work per wallet when a source route needs more than one
  transaction; local Relay signers need viem's nonce manager.
- Use `capabilities()` immediately before selecting payout rails and source
  assets.
- Test a small staging cash-out through `awaiting-buyer`, `withdraw()`, and
  `returned` before enabling production funds.

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
