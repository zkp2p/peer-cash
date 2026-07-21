import type { CuratorPayeeDataInput } from '../sdk-types';

export type CashPayeeInput = string | CuratorPayeeDataInput;

function normalizePaypalHandle(value: string): string {
  const withoutProtocol = value.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  if (/^paypal\.me(?:[?#].*)?$/i.test(withoutProtocol)) return '';
  const withoutDomain = withoutProtocol.replace(/^paypal\.me\//i, '');
  const [pathWithoutQuery = ''] = withoutDomain.split(/[?#]/, 1);
  const [username = ''] = pathWithoutQuery.replace(/^\/+/, '').split('/', 1);
  return username.replace(/^@+/, '').trim().toLowerCase();
}

/** Convert user-entered handles into the curator form for a payment platform. */
export function normalizeCashPayee(platform: string, payee: CashPayeeInput): CuratorPayeeDataInput {
  if (typeof payee !== 'string') return payee;

  const trimmed = payee.trim();
  switch (platform) {
    case 'chime':
      return { offchainId: trimmed.toLowerCase() };
    case 'n26':
      return { offchainId: trimmed.replace(/\s/g, '') };
    case 'paypal':
      return { offchainId: normalizePaypalHandle(trimmed) };
    default:
      return { offchainId: trimmed };
  }
}
