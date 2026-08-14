import { describe, expect, it } from 'vitest';

import { usdc } from '@zkp2p/cash';

import { createApp } from './app.js';

describe('MPP revenue cash-out planner', () => {
  it('prepares one unsigned plan from confirmed MPP revenue', async () => {
    const amounts: bigint[] = [];
    const { adminApp, revenue } = createApp({
      cash: {
        async prepare(input) {
          amounts.push(input.amount);
          return {
            accessPolicyRequired: false,
            register: { hashedOnchainIds: [] },
            steps: [],
            txs: [],
          };
        },
      },
      cashout: { currency: 'USD', payee: 'merchant', platform: 'revolut' },
      facilitator: 'https://facilitator.example',
      recipient: '0x0000000000000000000000000000000000000001',
      secretKey: 'test-secret-key-test-secret-key-32',
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
      cash: {
        async prepare() {
          return {
            accessPolicyRequired: true,
            register: { hashedOnchainIds: [] },
            steps: [],
            txs: [],
          };
        },
      },
      cashout: { currency: 'USD', payee: 'merchant', platform: 'venmo' },
      facilitator: 'https://facilitator.example',
      recipient: '0x0000000000000000000000000000000000000001',
      secretKey: 'test-secret-key-test-secret-key-32',
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
});
