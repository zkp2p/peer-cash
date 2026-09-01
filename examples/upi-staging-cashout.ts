import { createCashClient, usdc } from '@zkp2p/cash';
import type { WalletClient } from 'viem';

export async function cashOutToUpi(signer: WalletClient, upiId: string) {
  const cash = createCashClient({
    environment: 'staging',
    features: { upi: true },
  });

  const upi = cash.capabilities().platforms.find(({ platform }) => platform === 'upi');
  if (!upi?.currencies.includes('INR')) {
    throw new Error('UPI is not enabled in this staging SDK build.');
  }

  return cash.cashout(
    {
      amount: usdc(25),
      receive: { platform: 'upi', currency: 'INR', payee: upiId },
    },
    { signer },
  );
}
