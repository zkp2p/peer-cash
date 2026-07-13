import type { WalletClient } from 'viem';
import { errors } from './errors';

/** Verify signer chain without pulling the Relay adapter into Base-only flows. */
export async function assertWalletChainId(
  wallet: WalletClient,
  expectedChainId: number,
  operation: string,
): Promise<void> {
  let actualChainId: number;
  try {
    actualChainId = await wallet.getChainId();
  } catch (err) {
    throw errors.signerChainUnavailable(operation, expectedChainId, err);
  }
  if (actualChainId !== expectedChainId) {
    throw errors.signerChainMismatch(operation, expectedChainId, actualChainId);
  }
}
