import { describe, expect, it } from 'vitest';
import { decodeFunctionData, parseAbi } from 'viem';
import { getPaymentMethodsCatalog } from '@zkp2p/sdk';
import { createCashClient } from '../src/client/createCashClient';
import { CASH_ACCESS_GROUP_IDS } from '../src/engine/constants';

const ESCROW = '0x1111111111111111111111111111111111111111';
const CONFIGURE_DEPOSIT_ABI = parseAbi([
  'function configureDeposit(address _escrow, uint256 _depositId, bytes32 _paymentMethod, bool _enabled, bytes32[] _groupIds, address[] _takers)',
]);

// OrchestratorV4 reads only WhitelistPolicyV4; OrchestratorV3 reads only WhitelistPolicy.
// Base staging has O4. Base production keeps O3 until the contracts package records Base O4.
describe('prepareAccessPolicy() whitelist target', () => {
  it.each([
    ['staging', '0xd8e22BDfDBD6969d1641E7495294A94aF4893952'],
    ['production', '0x389Cd9bA91FfFcd83d267B241E975541892759Ce'],
    ['preproduction', '0x389Cd9bA91FfFcd83d267B241E975541892759Ce'],
  ] as const)('%s writes the Peer Pay group to %s', (environment, whitelist) => {
    const venmo = getPaymentMethodsCatalog(8453, environment)['venmo']!.paymentMethodHash;

    const prepared = createCashClient({ environment }).prepareAccessPolicy(`${ESCROW}_5`, venmo);

    expect(prepared.to).toBe(whitelist);
    expect(prepared.chainId).toBe(8453);
    const { functionName, args } = decodeFunctionData({
      abi: CONFIGURE_DEPOSIT_ABI,
      data: prepared.data,
    });
    expect(functionName).toBe('configureDeposit');
    expect(args).toEqual([ESCROW, 5n, venmo, true, CASH_ACCESS_GROUP_IDS[environment], []]);
  });
});
