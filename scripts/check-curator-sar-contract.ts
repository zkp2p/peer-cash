/**
 * Curator SAR connection contract check - READ-ONLY, no links are minted.
 *
 * Compares Peer Cash's App Clip connection rules with a live Curator's
 * OpenAPI document (`/docs/swagger.json`): the checkout body fields, required
 * fields, PayPal identity actions, length limits and state pattern per
 * platform. OpenAPI omits the patterns Curator applies after normalizing a
 * handle, so pass a Curator checkout to compare `sarConnectionAccount.ts` too.
 *
 * Run: bun scripts/check-curator-sar-contract.ts [curatorUrl] [--curator-source <curator repo>]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SAR_CONNECT_CASHTAG_PATTERN,
  SAR_CONNECT_PAYPAL_USERNAME_PATTERN,
  SAR_CONNECT_STATE_PATTERN,
} from '../src/codecs/schemas';

type JsonSchema = {
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: string[];
  pattern?: string;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  oneOf?: JsonSchema[];
};

const args = process.argv.slice(2);
const sourceFlag = args.indexOf('--curator-source');
const curatorSource = sourceFlag >= 0 ? args[sourceFlag + 1] : undefined;
const curatorUrl = args.find(
  (arg, index) => !arg.startsWith('--') && (sourceFlag < 0 || index !== sourceFlag + 1),
);
const origin = new URL(curatorUrl ?? 'https://api-preprod.zkp2p.xyz').origin;

const failures: string[] = [];
function expectEqual(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  ok: ${label}`);
  else failures.push(`${label}: Curator ${a}, Peer Cash ${e}`);
}

// What Peer Cash sends to `POST /v2/sar/connections/checkout`.
const EXPECTED: Record<'cashapp' | 'paypal', { properties: string[]; required: string[] }> = {
  cashapp: {
    properties: ['currencies', 'payeeHandle', 'platform', 'returnUrl', 'state'],
    required: ['currencies', 'payeeHandle', 'platform', 'returnUrl', 'state'],
  },
  paypal: {
    properties: [
      'currencies',
      'identityActionType',
      'payeeHandle',
      'paypalEmail',
      'platform',
      'returnUrl',
      'state',
    ],
    required: ['currencies', 'payeeHandle', 'paypalEmail', 'platform', 'returnUrl', 'state'],
  },
};

const response = await fetch(`${origin}/docs/swagger.json`, {
  headers: { Accept: 'application/json' },
});
if (!response.ok) throw new Error(`${origin}/docs/swagger.json returned HTTP ${response.status}`);
const document = (await response.json()) as {
  paths: Record<
    string,
    Record<string, { requestBody?: { content: Record<string, { schema: JsonSchema }> } }>
  >;
};
const checkout =
  document.paths['/v2/sar/connections/checkout']?.post?.requestBody?.content['application/json']
    ?.schema;
if (!checkout?.oneOf)
  throw new Error('Curator no longer documents POST /v2/sar/connections/checkout');

console.log(`Curator ${origin}`);
for (const platform of ['cashapp', 'paypal'] as const) {
  const variant = checkout.oneOf.find((item) => item.properties?.platform?.enum?.[0] === platform);
  if (!variant?.properties) {
    failures.push(`${platform}: checkout variant missing`);
    continue;
  }
  const properties = variant.properties;
  expectEqual(`${platform} fields`, Object.keys(properties).sort(), EXPECTED[platform].properties);
  expectEqual(
    `${platform} required`,
    [...(variant.required ?? [])].sort(),
    EXPECTED[platform].required,
  );
  expectEqual(
    `${platform} state pattern`,
    properties.state?.pattern,
    SAR_CONNECT_STATE_PATTERN.source,
  );
  expectEqual(`${platform} payeeHandle max`, properties.payeeHandle?.maxLength, 128);
  expectEqual(`${platform} returnUrl max`, properties.returnUrl?.maxLength, 2048);
  expectEqual(
    `${platform} currencies bounds`,
    [properties.currencies?.minItems, properties.currencies?.maxItems],
    [1, 20],
  );
  if (platform === 'paypal') {
    expectEqual('paypal email max', properties.paypalEmail?.maxLength, 254);
    expectEqual('paypal identity actions', properties.identityActionType?.enum, [
      'register_paypal',
      'register_business_paypal',
    ]);
  }
}

if (curatorSource) {
  const source = readFileSync(
    join(curatorSource, 'src/api/v2/sarConnection/sarConnectionAccount.ts'),
    'utf8',
  );
  const patterns = [...source.matchAll(/\.regex\(\/(.+?)\/[a-z]*\)/g)].map((match) => match[1]);
  expectEqual(
    'Cash App cashtag pattern',
    patterns.includes(SAR_CONNECT_CASHTAG_PATTERN.source),
    true,
  );
  expectEqual(
    'PayPal username pattern',
    patterns.includes(SAR_CONNECT_PAYPAL_USERNAME_PATTERN.source),
    true,
  );
  expectEqual(
    'handle normalization',
    source.includes('.replace(platform === "cashapp" ? /^\\$/ : /^@/, "")'),
    true,
  );
} else {
  console.log('  skip: handle patterns (pass --curator-source <curator repo>)');
}

if (failures.length > 0) {
  console.error(`\nFAIL: Peer Cash and Curator SAR rules differ\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nPeer Cash SAR connection rules match Curator.');
