import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData } from 'viem';
import { Zkp2pClient as RuntimeZkp2pClient } from '@zkp2p/sdk';
import {
  buildIntentAmountRange,
  buildMarketRateCurrencyOverride,
  isMarketRateSupported,
  prepareCashDepositParams,
} from '../src/engine/marketRate';
import { BASE_USDC_ADDRESS, ORACLE_MIN_CONVERSION_RATE_SENTINEL } from '../src/engine/constants';
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
    expect(params).not.toHaveProperty('intentGuardian');
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

  it.each([
    ['staging', '0x3355bb8CEFA54509d244384CFA7f2A71fdb1FDD6'],
    ['production', '0x83671606454fA72ba1e2831E18C5090D25629414'],
  ] as const)('encodes the %s guardian from the contracts bundle', async (runtimeEnv, guardian) => {
    const client = new RuntimeZkp2pClient({
      walletClient: {
        chain: {
          id: 8453,
          rpcUrls: { default: { http: ['https://base-rpc.invalid'] } },
        },
        account: { address: '0x1111111111111111111111111111111111111111' },
      } as never,
      chainId: 8453,
      runtimeEnv,
    });
    vi.spyOn(client, 'registerPayeeDetails').mockResolvedValue({
      depositDetails: [{ processorName: 'venmo', offchainId: '@a' }],
      hashedOnchainIds: [`0x${'22'.repeat(32)}`],
    });

    const params = await prepareCashDepositParams(client, {
      amount: 5_000_000n,
      payouts: [{ processorName: 'venmo', currency: 'USD', payeeData: { offchainId: '@a' } }],
    });
    const { prepared } = await client.prepareCreateDeposit(params);
    const decoded = decodeFunctionData({ abi: client.escrowAbi, data: prepared.data });

    expect(decoded.args?.[0]).toMatchObject({ intentGuardian: guardian });
  });

  it('builds one payment method with multiple zero-spread currencies', async () => {
    const client = mockClient();
    const params = await prepareCashDepositParams(client, {
      amount: 5_000_000n,
      payouts: [
        {
          processorName: 'revolut',
          currencies: ['EUR', 'GBP', 'USD'],
          payeeData: { offchainId: 'revtag' },
        },
      ],
    });

    expect(params.processorNames).toEqual(['revolut']);
    expect(params.conversionRates[0]?.map(({ currency }) => currency)).toEqual([
      'EUR',
      'GBP',
      'USD',
    ]);
    expect(params.currenciesOverride?.[0]).toHaveLength(3);
    expect(
      params.currenciesOverride?.[0]?.map((currency) => currency.oracleRateConfig?.spreadBps),
    ).toEqual([0, 0, 0]);
    expect(client.registerPayeeDetails).toHaveBeenCalledWith({
      processorNames: ['revolut'],
      payeeData: [{ offchainId: 'revtag' }],
    });
  });

  it('rejects duplicate multi-currency payouts before registration', async () => {
    const client = mockClient();
    await expect(
      prepareCashDepositParams(client, {
        amount: 5_000_000n,
        payouts: [
          {
            processorName: 'revolut',
            currencies: ['EUR', 'EUR'],
            payeeData: { offchainId: 'revtag' },
          },
        ],
      }),
    ).rejects.toThrow(/unique/);
    expect(client.registerPayeeDetails).not.toHaveBeenCalled();
  });

  it('rejects ambiguous singular and multi-currency payouts before registration', async () => {
    const client = mockClient();
    await expect(
      prepareCashDepositParams(client, {
        amount: 5_000_000n,
        payouts: [
          {
            processorName: 'revolut',
            currency: 'EUR',
            currencies: ['GBP'],
            payeeData: { offchainId: 'revtag' },
          } as never,
        ],
      }),
    ).rejects.toThrow(/exactly one/);
    expect(client.registerPayeeDetails).not.toHaveBeenCalled();
  });

  it('rejects currencies unsupported by the payment method before registration', async () => {
    const client = mockClient();
    await expect(
      prepareCashDepositParams(client, {
        amount: 5_000_000n,
        payouts: [
          {
            processorName: 'cashapp',
            currencies: ['USD', 'EUR'],
            payeeData: { offchainId: 'cashtag' },
          },
        ],
      }),
    ).rejects.toThrow(/cashapp does not support EUR/);
    expect(client.registerPayeeDetails).not.toHaveBeenCalled();
  });

  it("uses the SDK resolver's case-insensitive processor names for catalog validation", async () => {
    const client = mockClient();
    await expect(
      prepareCashDepositParams(client, {
        amount: 5_000_000n,
        payouts: [
          {
            processorName: 'VENMO',
            currency: 'USD',
            payeeData: { offchainId: 'venmo-user' },
          },
        ],
      }),
    ).resolves.toMatchObject({ processorNames: ['VENMO'] });
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
