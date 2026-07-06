import { describe, expect, it } from 'vitest';
import { cashToolManifest, cashTools } from '../src/tools';

describe('tools manifest', () => {
  it('covers the six verbs', () => {
    expect(cashTools.map((t) => t.name)).toEqual([
      'cash_capabilities',
      'cash_estimate',
      'cash_cashout',
      'cash_order',
      'cash_orders',
      'cash_withdraw',
    ]);
  });

  it('every tool has a JSON-schema object input', () => {
    for (const tool of cashTools) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      expect(tool.inputSchema['additionalProperties']).toBe(false);
    }
  });

  it('mutating tools default to the prepare path (unsigned txs, host-side signing)', () => {
    for (const name of ['cash_cashout', 'cash_withdraw']) {
      const tool = cashTools.find((t) => t.name === name);
      expect(tool?.description).toMatch(/UNSIGNED/);
    }
  });

  it('is JSON-serializable as-is', () => {
    expect(() => JSON.stringify(cashToolManifest)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(cashToolManifest));
    expect(parsed.tools).toHaveLength(6);
    expect(parsed.name).toBe('@zkp2p/cash');
  });
});
