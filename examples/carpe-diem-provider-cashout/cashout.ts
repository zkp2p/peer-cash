import { createCashClient } from '@zkp2p/cash';
import type { CashEstimate, CashoutInput, CashoutResult, CurrencyType } from '@zkp2p/cash';
import type { Address, WalletClient } from 'viem';
import { base } from 'viem/chains';

/** Venice's canonical DIEM token on Base, paid to Carpe Diem providers. */
export const DIEM_ADDRESS: Address = '0xf4d97f2da56e8c3098f3a8d538db630a2606a024';

const DIEM_SOURCE = {
  chainId: base.id,
  currency: DIEM_ADDRESS,
  tradeType: 'EXACT_INPUT',
} as const;

export function createCarpeDiemProviderCashout(referralCode: string) {
  const cash = createCashClient({
    environment: 'production',
    referralCode,
    referrer: 'carpe-diem',
  });

  return {
    /**
     * Preview the live DIEM -> Base USDC route and fiat oracle estimate.
     * This is not a locked rate; both the route and oracle price are refreshed
     * when the provider submits the cash-out.
     */
    estimate(input: {
      amountDiem: bigint;
      currency: CurrencyType;
      owner: Address;
    }): Promise<CashEstimate> {
      return cash.estimate(
        {
          amount: input.amountDiem,
          currency: input.currency,
          source: {
            ...DIEM_SOURCE,
            user: input.owner,
          },
        },
        { includeEta: false },
      );
    },

    /**
     * Cash out DIEM that Carpe Diem has already withdrawn to the provider's
     * connected Base wallet. Persist the returned depositId immediately.
     */
    cashout(input: {
      amountDiem: bigint;
      receive: CashoutInput['receive'];
      signer: WalletClient;
    }): Promise<CashoutResult> {
      return cash.cashout(
        {
          amount: input.amountDiem,
          source: DIEM_SOURCE,
          receive: input.receive,
        },
        { signer: input.signer },
      );
    },
  };
}
