import {
  createCashClient,
  VenmoGmailConnectError,
  type PreparedVenmoGmailConnect,
} from '@zkp2p/cash';

/** Optional onboarding: call with the selected handle before enabling the link button. */
export async function prepareVenmoLink(handle: string) {
  const cash = createCashClient({ environment: 'production' });
  return cash.prepareVenmoGmailConnect(handle);
}

/** Bind this to a click. Keep registration/other awaits outside the handler. */
export function linkVenmo(link: PreparedVenmoGmailConnect) {
  const cash = createCashClient({ environment: 'production' });
  return cash.openVenmoGmailConnect(link.payeeDetails).catch((error: unknown) => {
    if (error instanceof VenmoGmailConnectError) {
      // Render error.message. For an ambiguous closure/timeout, offer a status refresh.
      // Missing receipts: let the user choose the inbox that receives their receipts.
      console.error(error.code, error.message);
    }
    throw error;
  });
}

/** Also call when returning from a mobile tab or redirect opened with link.url. */
export function checkVenmoLink(link: PreparedVenmoGmailConnect) {
  const cash = createCashClient({ environment: 'production' });
  return cash.isVenmoGmailConnected(link.payeeDetails);
}

// cash.cashout(...) remains a separate action and does not require these helpers.
// No Gmail address is taken here: receipt verification belongs to the hosted flow.
