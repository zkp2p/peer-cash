import { createCashClient, XMoneyConnectError, type PreparedXMoneyConnect } from '../src';

const cash = createCashClient({ environment: 'preproduction' });

export function prepareXMoneyLink(username: string, returnUrl?: string) {
  return cash.prepareXMoneyConnect(username, returnUrl ? { returnUrl } : undefined);
}

// Call directly from a click handler to preserve browser user activation.
export function linkXMoney(link: PreparedXMoneyConnect) {
  return cash.openXMoneyConnect(link).catch((error: unknown) => {
    if (error instanceof XMoneyConnectError) console.error(error.code, error.message);
    throw error;
  });
}

export function checkXMoneyLink(link: PreparedXMoneyConnect) {
  return cash.isXMoneyConnected(link.payeeDetails);
}
