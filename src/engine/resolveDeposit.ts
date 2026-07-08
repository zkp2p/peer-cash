/**
 * Peer Cash - resolve the composite deposit id from a `createDeposit` receipt.
 *
 * `createDeposit` returns only a tx hash; the on-chain `depositId` is assigned by
 * the contract and emitted in `DepositReceived` (indexed). We decode it from the
 * receipt logs using the real escrow ABI so the order can be keyed on the
 * composite id (`escrow_onchainId`) the indexer uses.
 */
import { parseEventLogs, type Abi, type Log } from 'viem';
import { createCompositeDepositId } from '@zkp2p/sdk';

export interface ResolvedCashDeposit {
  onchainDepositId: bigint;
  escrowAddress: string;
  compositeId: string;
}

export function resolveCashDepositId(params: {
  logs: Log[];
  abi: Abi;
}): ResolvedCashDeposit | null {
  let events: Array<{ address: string; args: Record<string, unknown> }>;
  try {
    events = parseEventLogs({
      abi: params.abi,
      eventName: 'DepositReceived',
      logs: params.logs,
    }) as unknown as Array<{ address: string; args: Record<string, unknown> }>;
  } catch {
    return null;
  }

  const event = events[0];
  if (!event) return null;

  const rawId = event.args.depositId;
  if (rawId === undefined || rawId === null) return null;
  const onchainDepositId = BigInt(rawId as string | number | bigint);
  // Normalize to the indexer's canonical lowercase form so the escrow address,
  // the composite id, and every subsequent indexer query agree exactly.
  const escrowAddress = event.address.toLowerCase();

  return {
    onchainDepositId,
    escrowAddress,
    compositeId: createCompositeDepositId(escrowAddress, onchainDepositId),
  };
}

/** Split a composite deposit id (`escrow_onchainId`) back into its parts. */
export function parseCompositeDepositId(compositeId: string): {
  escrowAddress: string;
  onchainDepositId: bigint;
} {
  const idx = compositeId.lastIndexOf('_');
  if (idx === -1) {
    // No escrow prefix - treat the whole string as the on-chain id.
    return { escrowAddress: '', onchainDepositId: BigInt(compositeId) };
  }
  const escrowAddress = compositeId.slice(0, idx);
  const onchainDepositId = BigInt(compositeId.slice(idx + 1) || '0');
  return { escrowAddress, onchainDepositId };
}
