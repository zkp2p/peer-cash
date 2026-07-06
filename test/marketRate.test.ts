import { describe, expect, it, vi } from 'vitest';
import {
  buildIntentAmountRange,
  buildMarketRateCurrencyOverride,
  isMarketRateSupported,
  prepareCashDepositParams,
} from '../src/engine/marketRate';
import {
  BASE_USDC_ADDRESS,
  ORACLE_MIN_CONVERSION_RATE_SENTINEL,
} from '../src/engine/constants';
import type { Zkp2pClient } from '../src/sdk-types';

describe('isMarketRateSupported', () => {
  it('supports USD (zero-address passthrough feed)', () => {
    expect(isMarketRateSupported('USD')).toBe(true);
  });

  it('supports EUR (live Chainlink feed)', () => {
    expect(isMarketRateSupported('EUR')).toBe(true);
  });
});

describe('buildMarketRateCurrencyOverride', () => {
  it('builds a 0-spread oracle tuple with the sentinel min rate', () => {
    const tuple = buildMarketRateCurrencyOverride('USD');
    expect(tuple).not.toBeNull();
    expect(tuple?.minConversionRate).toBe(ORACLE_MIN_CONVERSION_RATE_SENTINEL);
    const cfg = (tuple as { oracleRateConfig?: { spreadBps: number } }).oracleRateConfig;
    expect(cfg?.spreadBps).toBe(0);
  });
});

describe('buildIntentAmountRange', () => {
  it('floors min at 1 USDC for normal amounts', () => {
    expect(buildIntentAmountRange(50_000_000n)).toEqual({ min: 1_000_000n, max: 50_000_000n });
  });

  it('collapses to min == max for sub-floor deposits', () => {
    expect(buildIntentAmountRange(500_000n)).toEqual({ min: 500_000n, max: 500_000n });
  });

  it('rejects non-positive amounts', () => {
    expect(() => buildIntentAmountRange(0n)).toThrow(/positive/);
  });
});

describe('prepareCashDepositParams', () => {
  function mockClient(): Zkp2pClient {
    return {
      chainId: 8453,
      runtimeEnv: 'staging',
      registerPayeeDetails: vi.fn(async () => ({
        depositDetails: [{}],
        hashedOnchainIds: ['0xpayeehash'],
      })),
    } as unknown as Zkp2pClient;
  }

  it('assembles override-mode params with spreadBps 0 and registered payee hash', async () => {
    const client = mockClient();
    const params = await prepareCashDepositParams(client, {
      amount: 5_000_000n,
      payouts: [{ processorName: 'venmo', currency: 'USD', payeeData: { offchainId: '@a' } }],
    });

    expect(params.token).toBe(BASE_USDC_ADDRESS);
    expect(params.amount).toBe(5_000_000n);
    expect(params.intentAmountRange).toEqual({ min: 1_000_000n, max: 5_000_000n });
    expect(params.processorNames).toEqual(['venmo']);
    expect(params.retainOnEmpty).toBe(false);

    expect(params.paymentMethodsOverride).toHaveLength(1);
    expect(params.paymentMethodDataOverride?.[0]).toMatchObject({
      payeeDetails: '0xpayeehash',
      data: '0x',
    });
    const currency = params.currenciesOverride?.[0]?.[0] as {
      minConversionRate: bigint;
      oracleRateConfig?: { spreadBps: number };
    };
    expect(currency.minConversionRate).toBe(ORACLE_MIN_CONVERSION_RATE_SENTINEL);
    expect(currency.oracleRateConfig?.spreadBps).toBe(0);
    expect(client.registerPayeeDetails).toHaveBeenCalledOnce();
  });

  it('rejects before any network call when a currency has no oracle feed', async () => {
    const client = mockClient();
    await expect(
      prepareCashDepositParams(client, {
        amount: 5_000_000n,
        payouts: [
          {
            processorName: 'venmo',
            currency: 'XYZ' as never,
            payeeData: { offchainId: '@a' },
          },
        ],
      }),
    ).rejects.toThrow(/oracle/);
    expect(client.registerPayeeDetails).not.toHaveBeenCalled();
  });

  it('rejects empty payouts', async () => {
    await expect(
      prepareCashDepositParams(mockClient(), { amount: 5_000_000n, payouts: [] }),
    ).rejects.toThrow(/payout/i);
  });

  it('rejects when payee registration returns a mismatched hash count', async () => {
    const client = mockClient();
    (client.registerPayeeDetails as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      depositDetails: [],
      hashedOnchainIds: [],
    });
    await expect(
      prepareCashDepositParams(client, {
        amount: 5_000_000n,
        payouts: [{ processorName: 'venmo', currency: 'USD', payeeData: { offchainId: '@a' } }],
      }),
    ).rejects.toThrow(/unexpected number/);
  });
});
