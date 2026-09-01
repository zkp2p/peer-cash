import { IndexerClient, defaultIndexerEndpoint } from '@zkp2p/sdk';
import type { RuntimeEnv } from '../sdk-types';

const ATTRIBUTED_DEPOSITS_QUERY = /* GraphQL */ `
  query PeerCashAttributedDeposits($ids: [String!]) {
    Deposit(where: { id: { _in: $ids }, attributionSource: { _eq: "peer-cash" } }) {
      id
    }
  }
`;

const INDEXER_ENVIRONMENT: Record<RuntimeEnv, 'PRODUCTION' | 'PREPRODUCTION' | 'STAGING'> = {
  production: 'PRODUCTION',
  preproduction: 'PREPRODUCTION',
  staging: 'STAGING',
};

export interface CashAttributionReaderOptions {
  environment: RuntimeEnv;
  indexerUrl?: string;
  indexerApiKey?: string;
}

interface AttributionQueryClient {
  query(request: { query: string; variables: Record<string, unknown> }): Promise<unknown>;
}

/** Resolve the canonical lowercase ids attributed to Peer Cash. */
export async function readCashAttributedDepositIds(
  client: AttributionQueryClient,
  depositIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(depositIds.map((id) => id.toLowerCase()))];
  if (ids.length === 0) return new Set();

  const result = (await client.query({
    query: ATTRIBUTED_DEPOSITS_QUERY,
    variables: { ids },
  })) as { Deposit?: Array<{ id: string }> };
  return new Set(
    (result.Deposit ?? []).map((deposit) => deposit.id.toLowerCase()).filter((id) => id.length > 0),
  );
}

/** Read deposit ids whose create transaction carries the canonical Cash marker. */
export function createCashAttributionReader(options: CashAttributionReaderOptions) {
  const endpoint =
    options.indexerUrl ?? defaultIndexerEndpoint(INDEXER_ENVIRONMENT[options.environment]);
  const client = new IndexerClient(endpoint, {
    ...(options.indexerApiKey ? { apiKey: options.indexerApiKey } : {}),
  });

  return (depositIds: readonly string[]): Promise<Set<string>> =>
    readCashAttributedDepositIds(client, depositIds);
}
