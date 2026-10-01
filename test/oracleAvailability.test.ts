import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSpreadOracleConfig } from '@zkp2p/sdk';
import type * as Sdk from '@zkp2p/sdk';
import { buildCapabilities } from '../src/client/capabilities';
import {
  isCashCorridorSupported,
  isMarketRateSupported,
  prepareCashDepositParams,
} from '../src/engine/marketRate';
import type { Zkp2pClient } from '../src/sdk-types';

vi.mock('@zkp2p/sdk', async (importOriginal) => {
  const sdk = await importOriginal<typeof Sdk>();
  return { ...sdk, getSpreadOracleConfig: vi.fn(sdk.getSpreadOracleConfig) };
});

afterEach(() => vi.mocked(getSpreadOracleConfig).mockReset());

describe('oracle-driven corridor availability', () => {
  it.each([
    ['upi', 'INR'],
    ['alipay', 'CNY'],
  ] as const)(
    '%s/%s requires an SDK oracle config for discovery and preparation',
    async (platform, currency) => {
      expect(isMarketRateSupported(currency)).toBe(true);
      expect(isCashCorridorSupported(platform, currency)).toBe(true);
      const realResolver = vi.mocked(getSpreadOracleConfig).getMockImplementation()!;
      vi.mocked(getSpreadOracleConfig).mockImplementation((code, adapters) =>
        code === currency ? null : realResolver(code, adapters),
      );
      expect(isMarketRateSupported(currency)).toBe(false);
      expect(isCashCorridorSupported(platform, currency)).toBe(false);
      for (const environment of ['staging', 'production', 'preproduction'] as const) {
        expect(
          buildCapabilities(environment).platforms.find((entry) => entry.platform === platform)
            ?.currencies ?? [],
        ).not.toContain(currency);
      }
      expect(isMarketRateSupported('EUR')).toBe(true);
      const registerPayeeDetails = vi.fn();
      const client = {
        chainId: 8453,
        runtimeEnv: 'staging',
        registerPayeeDetails,
      } as unknown as Zkp2pClient;
      await expect(
        prepareCashDepositParams(client, {
          amount: 1_000_000n,
          payouts: [{ processorName: platform, currency, payeeData: { offchainId: 'seller' } }],
        }),
      ).rejects.toThrow(/no live oracle/);
      expect(registerPayeeDetails).not.toHaveBeenCalled();
    },
  );
});
