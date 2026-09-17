// UPI pricing reads Polygon mainnet; configure upiCreationRateRpcUrl for a dedicated provider.
import { createCashClient, usdc } from '@zkp2p/cash';
import type { WalletClient } from 'viem';

export async function cashOutToUpi(
  signer: WalletClient,
  upiId: string,
  environment: 'staging' | 'preproduction' = 'staging',
) {
  const cash = createCashClient({
    environment,
    features: { upi: true },
  });

  const upi = cash.capabilities().platforms.find(({ platform }) => platform === 'upi');
  if (!upi?.currencies.includes('INR')) {
    throw new Error('UPI is not enabled in this environment.');
  }

  return cash.cashout(
    {
      amount: usdc(25),
      receive: { platform: 'upi', currency: 'INR', payee: upiId },
    },
    { signer },
  );
}
