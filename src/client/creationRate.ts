import type { Address, PublicClient } from 'viem';

const CHAINLINK_FEED_REGISTRY = '0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf';
const CNY_DENOMINATION = '0x000000000000000000000000000000000000009c';
const INR_DENOMINATION = '0x0000000000000000000000000000000000000164';
const USD_DENOMINATION = '0x0000000000000000000000000000000000000348';

const FEED_REGISTRY_ABI = [
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'base', type: 'address' },
      { name: 'quote', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    name: 'latestRoundData',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'base', type: 'address' },
      { name: 'quote', type: 'address' },
    ],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const;

export const CREATION_RATE_MAX_STALENESS_SECONDS = 86_400;

export interface CreationRateSnapshot {
  /** Fiat units per USDC, scaled by 1e18 for EscrowV2. */
  rate1e18: bigint;
  /** Human-readable fiat units per USDC. */
  rate: number;
  /** Unix timestamp of the source observation. */
  updatedAt: number;
}

export type CreationRateReader = (
  platform: string,
  currency: string,
) => Promise<CreationRateSnapshot>;

/** Cash corridors whose fresh market rate is fixed when the deposit is created. */
export function isCreationRateCorridor(platform: string, currency: string): boolean {
  const normalizedPlatform = platform.toLowerCase();
  const normalizedCurrency = currency.toUpperCase();
  return (
    (normalizedPlatform === 'alipay' && normalizedCurrency === 'CNY') ||
    (normalizedPlatform === 'upi' && normalizedCurrency === 'INR')
  );
}

function getCreationRateDenomination(platform: string, currency: string): Address {
  if (platform.toLowerCase() === 'alipay' && currency.toUpperCase() === 'CNY') {
    return CNY_DENOMINATION as Address;
  }
  if (platform.toLowerCase() === 'upi' && currency.toUpperCase() === 'INR') {
    return INR_DENOMINATION as Address;
  }
  throw new Error(`No creation-time rate source for ${platform}/${currency}`);
}

function divideRoundUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Read CNY/USD from Chainlink's canonical Ethereum Feed Registry and convert it
 * to CNY per USDC. The returned integer is rounded up so the on-chain maker
 * floor is never weaker than the observed market rate.
 */
export async function readCashCreationRate(
  publicClient: PublicClient,
  platform: string,
  currency: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<CreationRateSnapshot> {
  const args = [
    getCreationRateDenomination(platform, currency),
    USD_DENOMINATION as Address,
  ] as const;
  const [decimals, round] = await Promise.all([
    publicClient.readContract({
      address: CHAINLINK_FEED_REGISTRY,
      abi: FEED_REGISTRY_ABI,
      functionName: 'decimals',
      args,
    }),
    publicClient.readContract({
      address: CHAINLINK_FEED_REGISTRY,
      abi: FEED_REGISTRY_ABI,
      functionName: 'latestRoundData',
      args,
    }),
  ]);

  const [roundId, answer, , updatedAtRaw, answeredInRound] = round;
  if (answer <= 0n || updatedAtRaw <= 0n || answeredInRound < roundId) {
    throw new Error('Chainlink CNY/USD returned an invalid round');
  }

  const updatedAt = Number(updatedAtRaw);
  if (!Number.isSafeInteger(updatedAt) || updatedAt > nowSeconds) {
    throw new Error('Chainlink CNY/USD returned an invalid timestamp');
  }
  if (nowSeconds - updatedAt > CREATION_RATE_MAX_STALENESS_SECONDS) {
    throw new Error('Chainlink CNY/USD rate is stale');
  }

  // The feed is USD per CNY. Invert it into CNY per USD/USDC at 1e18 precision.
  const rate1e18 = divideRoundUp(10n ** (BigInt(decimals) + 18n), answer);
  const rate = Number(rate1e18) / 1e18;
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('Chainlink CNY/USD produced an invalid creation rate');
  }

  return { rate1e18, rate, updatedAt };
}

/** Backward-compatible Alipay/CNY reader. */
export async function readAlipayCnyCreationRate(
  publicClient: PublicClient,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<CreationRateSnapshot> {
  return readCashCreationRate(publicClient, 'alipay', 'CNY', nowSeconds);
}
