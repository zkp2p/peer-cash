# Carpe Diem provider revenue to Peer Cash

This example turns a Carpe Diem provider's withdrawn DIEM revenue into a Peer
Cash order. It is the provider-side continuation of Carpe Diem's existing
[`withdrawDiem`](https://carpe-diem.xyz/docs#6-3-earning-withdrawing) flow:

1. The provider withdraws accrued DIEM from Carpe Diem and waits for that Base
   transaction to confirm.
2. Peer Cash obtains a fresh Relay quote for canonical DIEM on Base, swaps the
   exact DIEM input to Base USDC, then deposits Relay's guaranteed minimum USDC
   output into the cash-out order.
3. The provider receives fiat through the selected Peer payout platform using
   the binding semantics advertised by `capabilities()`.

Carpe Diem remains authoritative for earned revenue and its withdrawal. Do not
start Peer Cash from an off-chain earnings figure or an unconfirmed withdrawal.

## Wire it into the provider dashboard

Install `@zkp2p/cash` and call the adapter after the connected wallet's
`withdrawDiem` receipt succeeds:

```ts
import { parseUnits } from 'viem';
import { createCarpeDiemProviderCashout } from './cashout';

const providerCashout = createCarpeDiemProviderCashout(peerReferralCode);
const amountDiem = parseUnits(form.amountDiem, 18);

// Preview only. Relay and the fiat oracle are refreshed at submission time,
// so render this as an estimate rather than a promised rate.
const estimate = await providerCashout.estimate({
  amountDiem,
  currency: 'USD',
  owner: walletClient.account.address,
});

const result = await providerCashout.cashout({
  amountDiem,
  receive: {
    platform: 'revolut',
    currency: 'USD',
    payee: { offchainId: form.revolutHandle },
  },
  signer: walletClient,
});

persistProviderCashout({
  carpeDiemWithdrawalTxHash,
  depositId: result.depositId,
  relayRequestId: result.source?.requestId,
  relayTransactions: result.source?.transactions,
});
```

Use the six-character Peer referral code assigned to the integration owner;
the adapter also adds the analytics-only `carpe-diem` attribution marker. Keep
the code in public app configuration—it is an identifier, not a secret.

Relay's curated Base token metadata was not exhaustive during validation: DIEM
was absent even though Relay returned an executable DIEM-to-USDC quote. Do not
disable the button merely because DIEM is absent from `sourceCapabilities()`.
The `estimate()` call is the live availability check: show the typed
`SOURCE_QUOTE_FAILED` remediation when Relay cannot quote the route. Never
cache that success as permanent support or repeat a route whose transaction
outcome is uncertain.

The same Base browser wallet signs the DIEM route and the Peer Cash deposit. A
live quote can include separate approval and swap transactions, so the UI must
support multiple wallet prompts. After `cashout()` returns, drive the lifecycle
from `order(depositId)` / `watch(depositId)` and unwind only with
`withdraw(depositId)`.

The canonical token address comes from
[Venice's DIEM launch documentation](https://venice.ai/blog/introducing-diem-as-tokenized-intelligence-the-next-evolution-of-vvv).
