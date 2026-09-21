import {
  createCashClient,
  VenmoGmailConnectError,
  type PreparedVenmoGmailConnect,
} from '@zkp2p/cash';

const cash = createCashClient({
  environment: 'production',
  // Optional: omit venmoGmail for Peer branding and the default popup size.
  venmoGmail: {
    appearance: { buttonColor: '#6246EA', buttonTextColor: '#FFFFFF' },
    popup: { width: 500, height: 620 },
  },
});

/** Optional onboarding: call with the selected handle before enabling the link button. */
export async function prepareVenmoLink(handle: string) {
  return cash.prepareVenmoGmailConnect(handle);
}

/** Bind this to a click. Keep registration/other awaits outside the handler. */
export function linkVenmo(link: PreparedVenmoGmailConnect) {
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
  return cash.isVenmoGmailConnected(link.payeeDetails);
}

// cash.cashout(...) remains a separate action and does not require these helpers.
// No Gmail address is taken here: receipt verification belongs to the hosted flow.
