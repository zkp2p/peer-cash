import { describe, expect, it } from 'vitest';
import {
  cashToolManifest,
  cashTools,
  type BuiltInCashToolName,
  type CashToolDefinition,
  type CashToolName,
} from '../src/tools';
import packageJson from '../package.json';

describe('tools manifest', () => {
  it('keeps the extensible 0.1.x tool types while exposing built-in literals', () => {
    const customName: CashToolName = 'merchant_custom_tool';
    const builtInName: BuiltInCashToolName = 'cash_order';
    const mutableRegistry: CashToolDefinition[] = cashTools;

    // @ts-expect-error Unknown names are not part of the package's built-in set.
    const invalidBuiltInName: BuiltInCashToolName = 'cash_unknown';

    expect(customName).toBe('merchant_custom_tool');
    expect(builtInName).toBe('cash_order');
    expect(invalidBuiltInName).toBe('cash_unknown');
    expect(mutableRegistry).toBe(cashTools);
  });

  it('covers the verbs', () => {
    expect(cashTools.map((t) => t.name)).toEqual([
      'cash_capabilities',
      'cash_source_quote',
      'cash_estimate',
      'cash_fill_stats',
      'cash_cashout',
      'cash_order',
      'cash_orders',
      'cash_buyer',
      'cash_source_status',
      'cash_withdraw',
      'cash_topup',
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
    for (const name of ['cash_cashout', 'cash_withdraw', 'cash_topup']) {
      const tool = cashTools.find((t) => t.name === name);
      expect(tool?.description).toMatch(/UNSIGNED/);
    }
    const cashout = cashTools.find((tool) => tool.name === 'cash_cashout');
    expect(cashout?.inputSchema.properties).not.toHaveProperty('source');
  });

  it('is JSON-serializable as-is', () => {
    expect(() => JSON.stringify(cashToolManifest)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(cashToolManifest));
    expect(parsed.tools).toHaveLength(11);
    expect(parsed.name).toBe('@zkp2p/cash');
    expect(parsed.version).toBe(packageJson.version);
  });
});
