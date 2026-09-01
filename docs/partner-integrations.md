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
deposit. For Venmo or PayPal, `cashout()` also confirms the method-scoped access
policy before returning.

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
  accessPolicyPaymentMethods: prepared.accessPolicyPaymentMethods,
});
```

Submit each transaction in order and wait for its receipt. After
`createDeposit` confirms, call `finalizePreparedCashout(receipt)` and persist
the returned `depositId`. If `accessPolicyPaymentMethods` is non-empty, call
`prepareAccessPolicy(depositId, paymentMethod)` once for each returned method
and confirm those transactions with the depositor wallet.

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
4. Submit the plan in order, finalize the confirmed deposit receipt, and attach
   any returned access policies.
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
- Required payment-method access policies and their transaction hashes

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
