/**
 * Name-mapping shim over the published `@zkp2p/sdk` (^0.8).
 *
 * The reference implementation imported these from internal SDK paths; the
 * published package exports them under indexer-prefixed names, and one type
 * (`CuratorPayeeDataInput`) is not exported at all — it is recovered here from
 * the `registerPayeeDetails` method signature. Everything else in this package
 * imports SDK types from this module so the mapping lives in exactly one place.
 */
import type { Zkp2pClient, IndexerIntentStatus, IndexerIntent, IndexerDeposit } from '@zkp2p/sdk';

export type IntentStatus = IndexerIntentStatus;
export type IntentEntity = IndexerIntent;
export type DepositEntity = IndexerDeposit;

export type CuratorPayeeDataInput = NonNullable<
  Parameters<Zkp2pClient['registerPayeeDetails']>[0]['payeeData']
>[number];

export type CreateDepositParamsArg = Parameters<Zkp2pClient['createDeposit']>[0];

export type {
  Zkp2pClient,
  CurrencyType,
  OracleAdapterOverrides,
  OnchainCurrency,
  DepositVerifierData,
  IndexerDepositWithRelations,
  PreparedTransaction,
  RuntimeEnv,
} from '@zkp2p/sdk';
