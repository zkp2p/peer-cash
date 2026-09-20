import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hash } from 'viem';

const mocks = vi.hoisted(() => ({
  registerPayeeDetails: vi.fn(),
  getSellerCredentialStatus: vi.fn(),
  open: vi.fn(),
}));
vi.mock('@zkp2p/sdk', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@zkp2p/sdk')>();
  return {
    ...actual,
    Zkp2pClient: vi.fn(function () {
      return mocks;
    }),
    openVenmoGmailConnect: mocks.open,
  };
});

import { Zkp2pClient } from '@zkp2p/sdk';
import {
  createCashClient,
  VenmoGmailConnectError,
  preparedVenmoGmailConnectFromJson,
  preparedVenmoGmailConnectToJson,
  venmoGmailConnectResultFromJson,
  venmoGmailConnectResultToJson,
} from '../src';

const payeeDetails: Hash = `0x${'ab'.repeat(32)}`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.registerPayeeDetails.mockResolvedValue({ hashedOnchainIds: [payeeDetails] });
  mocks.open.mockResolvedValue({ payeeDetails });
});

describe('optional Venmo receipt linking', () => {
  it.each([
    ['production', 'https://app.peer.xyz', undefined],
    ['preproduction', 'https://ramp-preprod.peer.xyz', 'https://api-preprod.zkp2p.xyz'],
    ['staging', 'https://ramp-staging.peer.xyz', 'https://api-staging.zkp2p.xyz'],
  ] as const)(
    'uses the %s environment for registration and the hosted link',
    async (environment, origin, baseApiUrl) => {
      const cash = createCashClient({ environment });
      expect(mocks.registerPayeeDetails).not.toHaveBeenCalled();
      expect(mocks.getSellerCredentialStatus).not.toHaveBeenCalled();
      expect(mocks.open).not.toHaveBeenCalled();
      const link = await cash.prepareVenmoGmailConnect(' @alice ');
      expect(link).toEqual({ payeeDetails, url: `${origin}/connect/venmo#${payeeDetails}` });
      expect(mocks.registerPayeeDetails).toHaveBeenCalledWith({
        processorNames: ['venmo'],
        payeeData: [{ offchainId: 'alice' }],
      });
      expect(vi.mocked(Zkp2pClient).mock.calls[0]?.[0].baseApiUrl).toBe(baseApiUrl);
      expect(mocks.open).not.toHaveBeenCalled();
      const result = cash.openVenmoGmailConnect(link.payeeDetails);
      // No await before opening: preserves a mobile browser's user activation.
      expect(mocks.open).toHaveBeenCalledWith({ payeeDetails, peerOrigin: origin });
      await expect(result).resolves.toEqual({ payeeDetails });
    },
  );

  it('retains explicit service overrides', async () => {
    const cash = createCashClient({
      environment: 'staging',
      curatorUrl: 'https://curator.example',
      peerOrigin: 'http://localhost:3010',
    });
    const link = await cash.prepareVenmoGmailConnect('alice');
    expect(link.url).toBe(`http://localhost:3010/connect/venmo#${payeeDetails}`);
    expect(vi.mocked(Zkp2pClient).mock.calls[0]?.[0].baseApiUrl).toBe('https://curator.example');
    await cash.openVenmoGmailConnect(link.payeeDetails);
    expect(mocks.open).toHaveBeenCalledWith({ payeeDetails, peerOrigin: 'http://localhost:3010' });
  });

  it('does not produce a link when registration fails', async () => {
    const error = new Error('Venmo account not found');
    mocks.registerPayeeDetails.mockRejectedValueOnce(error);
    await expect(
      createCashClient({ environment: 'production' }).prepareVenmoGmailConnect('missing'),
    ).rejects.toBe(error);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it.each([
    ['active', 'google_oauth', true],
    ['active', 'session_cookie', false],
    ['inactive', 'google_oauth', false],
    ['missing', null, false],
  ])('reports %s / %s as connected=%s', async (status, credentialType, expected) => {
    mocks.getSellerCredentialStatus.mockResolvedValueOnce({
      responseObject: { status, credentialType },
    });
    const cash = createCashClient({ environment: 'production' });
    await expect(cash.isVenmoGmailConnected(payeeDetails)).resolves.toBe(expected);
    expect(mocks.getSellerCredentialStatus).toHaveBeenCalledWith({
      processorName: 'venmo',
      payeeDetails,
    });
  });

  it('preserves status lookup errors instead of reporting unlinked', async () => {
    const error = new Error('Service unavailable');
    mocks.getSellerCredentialStatus.mockRejectedValueOnce(error);
    await expect(
      createCashClient({ environment: 'production' }).isVenmoGmailConnected(payeeDetails),
    ).rejects.toBe(error);
  });

  it.each([
    'popup_blocked',
    'connection_closed',
    'connection_timeout',
    'venmo_google_oauth_receipt_not_found',
  ])('preserves the hosted %s error code', async (code) => {
    const error = new VenmoGmailConnectError(code, 'Linking did not complete');
    mocks.open.mockRejectedValueOnce(error);
    await expect(
      createCashClient({ environment: 'production' }).openVenmoGmailConnect(payeeDetails),
    ).rejects.toBe(error);
  });

  it('round-trips prepared links and verified results across JSON', () => {
    const link = { payeeDetails, url: `https://app.peer.xyz/connect/venmo#${payeeDetails}` };
    expect(
      preparedVenmoGmailConnectFromJson(
        JSON.parse(JSON.stringify(preparedVenmoGmailConnectToJson(link))),
      ),
    ).toEqual(link);
    expect(
      venmoGmailConnectResultFromJson(
        JSON.parse(JSON.stringify(venmoGmailConnectResultToJson({ payeeDetails }))),
      ),
    ).toEqual({ payeeDetails });
    expect(() => preparedVenmoGmailConnectFromJson({ ...link, payeeDetails: 'alice' })).toThrow();
    expect(() => venmoGmailConnectResultFromJson({ payeeDetails: '0xabc' })).toThrow();
  });
});
