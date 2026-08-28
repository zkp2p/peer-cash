import { describe, expect, it } from 'vitest';

import { createApp } from '../examples/mpp-merchant-cashout/app';
import { RevenueTracker } from '../examples/mpp-merchant-cashout/revenue';
import { usdc } from '../src';

const appOptions = {
  cashout: { currency: 'USD' as const, payee: 'merchant', platform: 'revolut' },
  facilitator: 'https://facilitator.example',
  recipient: '0x0000000000000000000000000000000000000001' as const,
  secretKey: 'test-secret-key-test-secret-key-32',
};

describe('MPP merchant cash-out example', () => {
  it('deduplicates settlements and reserves only confirmed revenue', () => {
    const revenue = new RevenueTracker(usdc('5'));

    expect(revenue.record('0xabc', usdc('7'))).toBe(true);
    expect(revenue.record('0xabc', usdc('7'))).toBe(false);
    revenue.reserve(usdc('5'));

    expect(revenue.snapshot()).toEqual({
      available: usdc('2'),
      ready: false,
      reserved: usdc('5'),
      settled: usdc('7'),
      threshold: usdc('5'),
    });
    expect(() => revenue.reserve(usdc('3'))).toThrow(/exceeds unreserved settlements/);

    revenue.release(usdc('5'));
    expect(revenue.snapshot().available).toBe(usdc('7'));
  });

  it('prepares one unsigned plan from confirmed MPP revenue', async () => {
    const amounts: bigint[] = [];
    const { adminApp, revenue } = createApp({
      ...appOptions,
      cash: {
        async prepare(input) {
          amounts.push(input.amount);
          return {
            accessPolicyRequired: false,
            accessPolicyPaymentMethods: [],
            register: { hashedOnchainIds: [] },
            steps: [],
            txs: [],
          };
        },
      },
    });
    revenue.record('0xsettlement', usdc('10'));

    const response = await adminApp.request('http://localhost/cashout', {
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(amounts).toEqual([usdc('10')]);
    expect((await response.json()).revenue.availableUsdc).toBe('0');

    const duplicate = await adminApp.request('http://localhost/cashout', {
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(duplicate.status).toBe(409);
  });

  it('releases revenue when a payout needs an unsupported follow-up', async () => {
    const { adminApp, revenue } = createApp({
      ...appOptions,
      cashout: { ...appOptions.cashout, platform: 'venmo' },
      cash: {
        async prepare() {
          return {
            accessPolicyRequired: true,
            accessPolicyPaymentMethods: [`0x${'01'.repeat(32)}`],
            register: { hashedOnchainIds: [] },
            steps: [],
            txs: [],
          };
        },
      },
    });
    revenue.record('0xsettlement', usdc('10'));

    const response = await adminApp.request('http://localhost/cashout', {
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(400);
    expect(revenue.snapshot().available).toBe(usdc('10'));
  });

  it('returns an MPP payment challenge for the protected resource', async () => {
    const { publicApp } = createApp({
      ...appOptions,
      cash: { prepare: async () => Promise.reject(new Error('not called')) },
    });

    const response = await publicApp.request('http://localhost/api/report');

    expect(response.status).toBe(402);
    expect(response.headers.get('payment-required')).toBeTruthy();
  });
});
