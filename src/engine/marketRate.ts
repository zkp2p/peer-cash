/**
 * Peer Cash - market-rate (0% spread) deposit construction.
 *
 * The user sells at the prevailing live Chainlink oracle rate with `spreadBps: 0`.
 * This requires EscrowV2 "override mode" (the only `createDeposit` path that can
 * attach an `oracleRateConfig`), so we build the three override arrays ourselves
 * - exactly mirroring the SDK's auto-mode (`data: '0x'`, gating service, payee
 * hash) but injecting the oracle config.
 */
import type { Address } from 'viem';
import {
  currencyInfo,
  getSpreadOracleConfig,
  getPaymentMethodsCatalog,
  getGatingServiceAddress,
  resolvePaymentMethodHashFromCatalog,
} from '@zkp2p/sdk';
import type {
  Zkp2pClient,
  CurrencyType,
  OracleAdapterOverrides,
  OnchainCurrency,
  DepositVerifierData,
  CreateDepositParamsArg,
} from '../sdk-types';
import {
  BASE_USDC_ADDRESS,
  CASH_RETAIN_ON_EMPTY,
  MARKET_SPREAD_BPS,
  ORACLE_MIN_CONVERSION_RATE_SENTINEL,
} from './constants';
import type { CashDepositInput, CashPayout } from './types';

function payoutCurrencies(payout: CashPayout): readonly CurrencyType[] {
  if ((payout.currency === undefined) === (payout.currencies === undefined)) {
    throw new Error('Pass exactly one of payout currency or currencies');
  }
  return payout.currencies ?? [payout.currency];
}

/**
 * Whether a currency can be priced at the live market rate. Only currencies with
 * a Chainlink feed (`supportsSpreadOracle`) get oracle pricing; others would fall
 * back to a fixed rate, which Peer Cash does not offer.
 */
export function isMarketRateSupported(
  currency: CurrencyType,
  adapters?: OracleAdapterOverrides,
): boolean {
  return getSpreadOracleConfig(currency, adapters) != null;
}

/**
 * Build a single oracle-backed currency tuple priced at market (0% spread).
 * Returns `null` for currencies without a Chainlink feed.
 */
export function buildMarketRateCurrencyOverride(
  currency: CurrencyType,
  adapters?: OracleAdapterOverrides,
): OnchainCurrency | null {
  const code = currencyInfo[currency]?.currencyCodeHash as `0x${string}` | undefined;
  const oracle = getSpreadOracleConfig(currency, adapters);
  if (!code || !oracle) return null;

  return {
    code,
    minConversionRate: ORACLE_MIN_CONVERSION_RATE_SENTINEL,
    oracleRateConfig: {
      adapter: oracle.adapter,
      adapterConfig: oracle.adapterConfig,
      spreadBps: MARKET_SPREAD_BPS,
      maxStaleness: oracle.maxStaleness,
    },
  } as OnchainCurrency;
}

/**
 * Default per-order range. Allows partial fills down to a small floor while
 * letting a single buyer take the whole deposit. Never forces `min == max`
 * unless the deposit itself is below the floor (which would otherwise starve
 * matching). Contract invariants: `min != 0`, `min <= max`, `amount >= min`.
 */
const DEFAULT_MIN_ORDER_FLOOR = 1_000_000n; // 1 USDC

export function buildIntentAmountRange(amount: bigint): { min: bigint; max: bigint } {
  if (amount <= 0n) throw new Error('Cash-out amount must be positive');
  const min = amount < DEFAULT_MIN_ORDER_FLOOR ? amount : DEFAULT_MIN_ORDER_FLOOR;
  return { min, max: amount };
}

/**
 * Prepare the full `createDeposit` params for a market-rate cash-out.
 *
 * Registers payee details with the curator (no auth), resolves payment-method
 * hashes + the gating service from the catalog, and assembles the override
 * arrays with `spreadBps: 0` oracle configs. Throws if any payout currency lacks
 * a live oracle feed (Peer Cash is market-rate only).
 */
export async function prepareCashDepositParams(
  client: Zkp2pClient,
  input: CashDepositInput,
  adapters?: OracleAdapterOverrides,
): Promise<CreateDepositParamsArg> {
  const { payouts } = input;
  if (!payouts.length) throw new Error('At least one payout is required');

  const chainId = client.chainId;
  const runtimeEnv = client.runtimeEnv;
  const catalog = getPaymentMethodsCatalog(chainId, runtimeEnv);
  const intentGatingService = getGatingServiceAddress(chainId, runtimeEnv) as Address;
  const processorNames = payouts.map((p) => p.processorName);
  const paymentMethodsOverride = processorNames.map((name) =>
    resolvePaymentMethodHashFromCatalog(name, catalog),
  );

  // Validate every platform/currency pair is supported and oracle-priceable before any network call.
  for (const payout of payouts) {
    const currencies = payoutCurrencies(payout);
    if (currencies.length === 0 || new Set(currencies).size !== currencies.length) {
      throw new Error('Payout currencies must be non-empty and unique');
    }
    const supportedCurrencyHashes = new Set(
      (catalog[payout.processorName.toLowerCase()]?.currencies ?? []).map((hash) =>
        hash.toLowerCase(),
      ),
    );
    for (const currency of currencies) {
      if (!isMarketRateSupported(currency, adapters)) {
        throw new Error(
          `${currency} has no live market-rate oracle feed; Peer Cash supports market-rate currencies only.`,
        );
      }
      const currencyHash = currencyInfo[currency]?.currencyCodeHash;
      if (!currencyHash || !supportedCurrencyHashes.has(currencyHash.toLowerCase())) {
        throw new Error(`${payout.processorName} does not support ${currency}`);
      }
    }
  }

  // Register payee details with the curator to obtain on-chain payee hashes.
  const { hashedOnchainIds } = await client.registerPayeeDetails({
    processorNames,
    payeeData: payouts.map((p) => p.payeeData),
  });
  if (hashedOnchainIds.length !== payouts.length) {
    throw new Error('Payee registration returned an unexpected number of hashes');
  }

  const paymentMethodDataOverride: DepositVerifierData[] = hashedOnchainIds.map((hid) => ({
    intentGatingService,
    payeeDetails: hid,
    data: '0x',
  }));

  const currenciesOverride: OnchainCurrency[][] = payouts.map((payout) =>
    payoutCurrencies(payout).map((currency) => {
      const tuple = buildMarketRateCurrencyOverride(currency, adapters);
      if (!tuple) throw new Error(`Failed to build market-rate config for ${currency}`);
      return tuple;
    }),
  );

  // `conversionRates` is required for the length/shape check but is unused in
  // override mode - the on-chain tuple comes from `currenciesOverride`.
  const conversionRates = payouts.map((payout) =>
    payoutCurrencies(payout).map((currency) => ({
      currency,
      conversionRate: ORACLE_MIN_CONVERSION_RATE_SENTINEL.toString(),
    })),
  );

  const intentAmountRange = input.intentAmountRange ?? buildIntentAmountRange(input.amount);

  return {
    token: (input.token ?? BASE_USDC_ADDRESS) as Address,
    amount: input.amount,
    intentAmountRange,
    processorNames,
    conversionRates,
    paymentMethodsOverride,
    paymentMethodDataOverride,
    currenciesOverride,
    retainOnEmpty: CASH_RETAIN_ON_EMPTY,
  } as CreateDepositParamsArg;
}
