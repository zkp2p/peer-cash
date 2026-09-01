# MPP merchant revenue to Peer Cash

This example accepts Base USDC for a paid MPP resource, counts successful
settlements, and prepares an unsigned Peer Cash plan once confirmed revenue
reaches a threshold.

MPP owns the incoming machine payment. Peer Cash starts a separate seller-side
operation after settlement. It is not an MPP payment method and does not change
the payer flow.

The public MPP route and the cash-out planner use separate listeners. The
planner binds to `127.0.0.1` and never accepts private keys, signs, or
broadcasts. The merchant wallet that receives MPP revenue keeps custody and
decides whether to submit the returned transactions.

This example moved here from [wevm/mppx#798](https://github.com/wevm/mppx/pull/798)
after the MPP maintainers asked vendor-specific examples to live in the
vendor's own repository.

For the production state and custody checklist around this example, see the
[partner integration patterns](../../docs/partner-integrations.md).

## Setup

From a clone of `zkp2p/peer-cash`:

```sh
bun install

export MPPX_RECIPIENT=0xMerchantWallet
export X402_FACILITATOR_URL=https://your-facilitator.example
export MPP_SECRET_KEY=replace-with-at-least-32-random-characters
export PEER_CASH_PLATFORM=revolut
export PEER_CASH_CURRENCY=USD
export PEER_CASH_PAYEE=your-handle
export PEER_CASH_THRESHOLD_USDC=10

bun examples/mpp-merchant-cashout/server.ts
```

Use a facilitator that supports Base mainnet USDC. The recipient must be the
merchant-controlled Base wallet that will sign any Peer Cash transactions.

## Payment and cash-out flow

Pay the MPP resource with an EVM-capable client:

```sh
MPPX_PRIVATE_KEY=0x... bunx mppx http://localhost:5173/api/report
```

Inspect confirmed, unreserved revenue on the local admin listener:

```sh
curl http://127.0.0.1:5174/status
```

After the threshold is reached, prepare a cash-out for all available revenue:

```sh
curl -X POST http://127.0.0.1:5174/cashout \
  -H 'content-type: application/json' \
  -d '{}'
```

Pass `{"amountUsdc":"5.25"}` to prepare a smaller amount. The response contains
unsigned transactions and same-index step descriptions. Review them, then sign
and submit them with the recipient wallet.

The example deduplicates successful MPP receipts and reserves planned amounts
in memory so a second request cannot prepare the same revenue again. A
production service must persist settlement, reservation, transaction, and
deposit state before exposing an equivalent operator endpoint.

The minimal planner fails closed when a platform requires the restricted-rail
access-policy follow-up. A production host can support those platforms by
waiting for the deposit receipt, calling `finalizePreparedCashout`, then calling
`prepareAccessPolicy` once per `accessPolicyPaymentMethods` entry and submitting
each method-scoped transaction.
