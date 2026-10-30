import {
  createCashClient,
  detectSarConnectDevice,
  preparedSarConnectFromJson,
  preparedSarConnectToJson,
  sarConnectUrlFor,
  SarConnectError,
  type PreparedSarConnect,
} from '../src';

const cash = createCashClient({ environment: 'preproduction' });
// Your page. Its origin must be on Curator's SAR_CONNECT_RETURN_ORIGINS for this environment.
const returnUrl = 'https://checkout.example.com/connected';

export async function startCashAppConnect(cashtag: string): Promise<string> {
  const link = await cash.prepareSarConnect({
    platform: 'cashapp',
    payeeHandle: cashtag,
    returnUrl,
  });
  sessionStorage.setItem('peer-sar-link', JSON.stringify(preparedSarConnectToJson(link)));
  return sarConnectUrlFor(link, detectSarConnectDevice());
}

export function startPayPalConnect(username: string, paypalEmail: string, business = false) {
  return cash.prepareSarConnect({
    platform: 'paypal',
    payeeHandle: username,
    paypalEmail,
    ...(business ? { identityActionType: 'register_business_paypal' as const } : {}),
    returnUrl,
  });
}

// On the return page, or while the seller is on their phone.
export async function finishConnect(): Promise<string> {
  const saved = sessionStorage.getItem('peer-sar-link');
  if (!saved) return 'no link';
  const link: PreparedSarConnect = preparedSarConnectFromJson(JSON.parse(saved));
  try {
    const result = await cash.waitForSarConnect(link);
    if (result.status === 'connected') sessionStorage.removeItem('peer-sar-link');
    return result.status;
  } catch (error) {
    if (error instanceof SarConnectError && error.retryable) return 'check again';
    throw error;
  }
}
