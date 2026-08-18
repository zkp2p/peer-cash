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
      'cash_near_intents_quote',
      'cash_near_intents_submit',
      'cash_near_intents_status',
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

  function receiveVariants(): { leg: Record<string, unknown>; array: Record<string, unknown> } {
    const cashout = cashTools.find((tool) => tool.name === 'cash_cashout');
    const receive = (cashout?.inputSchema as { properties: { receive: Record<string, unknown> } })
      .properties.receive;
    const [leg, array] = receive['oneOf'] as [Record<string, unknown>, Record<string, unknown>];
    return { leg, array };
  }

  it('lets tool hosts pass a raw payee handle', () => {
    const { leg } = receiveVariants();
    const properties = leg['properties'] as {
      payee?: { oneOf?: Array<{ type?: string }> };
    };

    expect(properties.payee?.oneOf?.map((shape) => shape.type)).toEqual(['string', 'object']);
  });

  it('offers mutually exclusive single and multi-currency cashout inputs', () => {
    const { leg } = receiveVariants();
    const properties = leg['properties'] as Record<string, Record<string, unknown>>;

    expect(properties['currencies']).toMatchObject({
      type: 'array',
      minItems: 1,
      uniqueItems: true,
    });
    expect(leg['oneOf']).toEqual([{ required: ['currency'] }, { required: ['currencies'] }]);
  });

  it('accepts one payout leg or an array of legs across platforms', () => {
    const { leg, array } = receiveVariants();

    expect(leg).toMatchObject({ type: 'object' });
    expect(array).toMatchObject({ type: 'array', minItems: 1 });
    expect(array['items']).toBe(leg);
  });

  it('is JSON-serializable as-is', () => {
    expect(() => JSON.stringify(cashToolManifest)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(cashToolManifest));
    expect(parsed.tools).toHaveLength(14);
    expect(parsed.name).toBe('@zkp2p/cash');
    expect(parsed.version).toBe(packageJson.version);
  });
});
