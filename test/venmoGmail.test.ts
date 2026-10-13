import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256, stringToBytes, type Hash } from 'viem';

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
    openXMoneyConnect: mocks.open,
  };
});

import { Zkp2pClient } from '@zkp2p/sdk';
import {
  createCashClient,
  preparedXMoneyConnectFromJson,
  preparedXMoneyConnectToJson,
  xMoneyConnectResultFromJson,
  xMoneyConnectResultToJson,
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

  it('shares branding between prepared URLs and the synchronous popup', async () => {
    const appearance = { logoUrl: 'https://partner.example/logo.png', buttonColor: '#6246EA' };
    const popup = { width: 500, height: 620 };
    const cash = createCashClient({ environment: 'production', venmoGmail: { appearance, popup } });
    const link = await cash.prepareVenmoGmailConnect('alice');
    expect(new URL(link.url).searchParams.get('appearance')).toBe(JSON.stringify(appearance));
    const result = cash.openVenmoGmailConnect(link.payeeDetails);
    expect(mocks.open).toHaveBeenCalledWith({
      payeeDetails,
      peerOrigin: 'https://app.peer.xyz',
      appearance,
      popup,
    });
    await expect(result).resolves.toEqual({ payeeDetails });
  });

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

  it.each([
    'partner-app://venmo-linked?session=one%2Ftwo&label=hello%20world#receipt',
    'https://partner.example/venmo-linked?session=one%2Ftwo',
    '',
  ])('prepares a native return URL without changing popup behavior: %s', async (returnUrl) => {
    const cash = createCashClient({ environment: 'staging' });
    const link = await cash.prepareVenmoGmailConnect('alice', { returnUrl });
    const query = returnUrl ? `?${new URLSearchParams({ returnUrl })}` : '';
    expect(link).toEqual({
      payeeDetails,
      url: `https://ramp-staging.peer.xyz/connect/venmo${query}#${payeeDetails}`,
    });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.getSellerCredentialStatus).not.toHaveBeenCalled();
    expect(
      preparedVenmoGmailConnectFromJson(
        JSON.parse(JSON.stringify(preparedVenmoGmailConnectToJson(link))),
      ),
    ).toEqual(link);
    await cash.openVenmoGmailConnect(link.payeeDetails);
    expect(mocks.open).toHaveBeenCalledWith({
      payeeDetails,
      peerOrigin: 'https://ramp-staging.peer.xyz',
    });
  });

  it('retains branding with a per-link app callback', async () => {
    const appearance = { buttonColor: '#6246EA' };
    const cash = createCashClient({ environment: 'production', venmoGmail: { appearance } });
    const link = await cash.prepareVenmoGmailConnect('alice', {
      returnUrl: 'partner-app://venmo-linked',
    });
    const url = new URL(link.url);
    expect(url.searchParams.get('returnUrl')).toBe('partner-app://venmo-linked');
    expect(url.searchParams.get('appearance')).toBe(JSON.stringify(appearance));
    const withoutCallback = await cash.prepareVenmoGmailConnect('alice');
    expect(new URL(withoutCallback.url).searchParams.has('returnUrl')).toBe(false);
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
    ['active', 'microsoft_oauth', true],
    ['active', 'icloud_mail', true],
    ['active', 'session_cookie', false],
    ['inactive', 'google_oauth', false],
    ['inactive', 'microsoft_oauth', false],
    ['inactive', 'icloud_mail', false],
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
    'VENMO_MICROSOFT_OAUTH_RECEIPT_NOT_FOUND',
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

describe('X Money receipt linking', () => {
  it.each(['production', 'preproduction', 'staging'] as const)(
    'registers and opens the normalized account in %s',
    async (environment) => {
      const hash = keccak256(stringToBytes('alice'));
      mocks.registerPayeeDetails.mockResolvedValue({ hashedOnchainIds: [hash] });
      const cash = createCashClient({ environment });
      const link = await cash.prepareXMoneyConnect(' @Alice ', { returnUrl: 'partner://linked' });
      expect(mocks.registerPayeeDetails).toHaveBeenCalledWith({
        processorNames: ['xmoney'],
        payeeData: [{ offchainId: 'alice' }],
      });
      const url = new URL(link.url);
      expect(url.pathname).toBe('/connect/xmoney');
      expect(url.searchParams.get('returnUrl')).toBe('partner://linked');
      expect(Object.fromEntries(new URLSearchParams(url.hash.slice(1)))).toEqual({
        payeeDetails: hash,
        payeeUsername: 'alice',
      });
      const result = cash.openXMoneyConnect(link);
      expect(mocks.open).toHaveBeenCalledWith({
        payeeDetails: hash,
        payeeUsername: 'alice',
        peerOrigin: url.origin,
      });
      await result;
      expect(preparedXMoneyConnectFromJson(preparedXMoneyConnectToJson(link))).toEqual(link);
      expect(
        xMoneyConnectResultFromJson(xMoneyConnectResultToJson({ payeeDetails: hash })),
      ).toEqual({ payeeDetails: hash });
    },
  );
  it.each(['google_oauth', 'microsoft_oauth', 'icloud_mail', 'session_cookie'])(
    'checks active mailbox status for %s',
    async (credentialType) => {
      mocks.getSellerCredentialStatus.mockResolvedValue({
        responseObject: { status: 'active', credentialType },
      });
      const cash = createCashClient({ environment: 'production' });
      await expect(cash.isXMoneyConnected(payeeDetails)).resolves.toBe(
        credentialType !== 'session_cookie',
      );
      expect(mocks.getSellerCredentialStatus).toHaveBeenCalledWith({
        processorName: 'xmoney',
        payeeDetails,
      });
    },
  );
  it('preserves status errors and rejects inconsistent registration identity', async () => {
    const cash = createCashClient({ environment: 'production' });
    const error = new Error('Unavailable');
    mocks.getSellerCredentialStatus.mockRejectedValue(error);
    await expect(cash.isXMoneyConnected(payeeDetails)).rejects.toBe(error);
    await expect(cash.prepareXMoneyConnect('alice')).rejects.toThrow('registered payee hash');
  });
});
