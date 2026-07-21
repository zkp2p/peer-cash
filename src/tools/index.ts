/**
 * `@zkp2p/cash/tools` - JSON-schema tool definitions of the verbs, so
 * agent hosts (peer-cli, zkp2p-mcp, any MCP server or tool-use loop) adopt
 * Peer Cash without re-deriving schemas.
 *
 * Design rules:
 * - Mutating verbs default to the **prepare path**: the tool returns unsigned
 *   transactions plus readable step labels; signing stays host-side, where key
 *   custody and policy live.
 * - Every input/output is plain JSON (bigints as decimal strings) - see the
 *   codecs exported from the package root for lossless (de)serialization.
 * - `watch` is intentionally not a tool: agents poll `cash_order` between
 *   other work instead of holding a streaming connection open.
 */

import packageJson from '../../package.json';

export interface CashToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (draft-07 compatible) for the tool input. */
  inputSchema: Record<string, unknown>;
}

const bigintString = {
  type: 'string',
  pattern: '^0*[1-9][0-9]*$',
  description:
    'Base units as a decimal string. For the default path this is USDC 6 decimals; with source it is source-token base units.',
} as const;

const depositId = {
  type: 'string',
  pattern: '^0x[0-9a-fA-F]{40}_[0-9]+$',
  description: 'Composite deposit id (escrow_onchainId) returned by cash_cashout - the resume key',
} as const;

const address = {
  type: 'string',
  pattern: '^0x[0-9a-fA-F]{40}$',
} as const;

const chainId = {
  type: 'integer',
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
} as const;

const builtInCashTools = [
  {
    name: 'cash_capabilities',
    description:
      'Discover what Peer Cash can do: payout platforms, oracle-priced currencies per platform, Base USDC destination, default Base USDC source, payee handle hints, and amount bounds. Set includeRelaySources=true to fetch live Relay-supported EVM source chains/tokens through the Relay SDK.',
    inputSchema: {
      type: 'object',
      properties: {
        includeRelaySources: {
          type: 'boolean',
          description: 'Fetch live Relay SDK EVM source chain/token metadata.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'cash_source_quote',
    description:
      'Quote any Relay-supported EVM source asset into Base USDC through @relayprotocol/relay-sdk. A custody-capable host must submit the returned route, poll cash_source_status to success, then call Base-USDC cash_cashout with the guaranteed output amount. Never submit the route twice.',
    inputSchema: {
      type: 'object',
      properties: {
        user: { ...address, description: 'Source wallet submitting the Relay transaction.' },
        amount: bigintString,
        source: {
          type: 'object',
          properties: {
            chainId: { ...chainId, description: 'Relay-supported EVM source chain id.' },
            currency: { ...address, description: 'Source token/native address.' },
          },
          required: ['chainId', 'currency'],
          additionalProperties: false,
        },
        recipient: {
          ...address,
          description: 'Base recipient for Relay-delivered USDC. Defaults to user.',
        },
        tradeType: {
          type: 'string',
          enum: ['EXACT_INPUT', 'EXACT_OUTPUT', 'EXPECTED_OUTPUT'],
          description: 'Relay quote trade type. Defaults to EXACT_INPUT.',
        },
      },
      required: ['user', 'amount', 'source'],
      additionalProperties: false,
    },
  },
  {
    name: 'cash_estimate',
    description:
      'Estimate fiat received at the live oracle market rate and include a simple recent-fill ETA. Without source, amount is Base USDC. With source, the SDK first quotes source->Base USDC through Relay SDK, then estimates the cashout.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: bigintString,
        currency: {
          type: 'string',
          description: 'Fiat currency code from cash_capabilities, e.g. "USD"',
        },
        platform: {
          type: 'string',
          description: 'Optional payout platform for platform-specific ETA sampling.',
        },
        source: {
          type: 'object',
          description: 'Optional Relay EVM source asset. Omit for the Base USDC default path.',
          properties: {
            chainId: { ...chainId, description: 'Relay-supported EVM source chain id.' },
            currency: { ...address, description: 'Source token/native address.' },
            user: {
              ...address,
              description: 'Source wallet submitting the Relay transaction.',
            },
            recipient: {
              ...address,
              description: 'Base recipient for Relay-delivered USDC. Defaults to user.',
            },
            tradeType: {
              type: 'string',
              enum: ['EXACT_INPUT', 'EXACT_OUTPUT', 'EXPECTED_OUTPUT'],
            },
          },
          required: ['chainId', 'currency', 'user'],
          additionalProperties: false,
        },
      },
      required: ['amount', 'currency'],
      additionalProperties: false,
    },
  },
  {
    name: 'cash_fill_stats',
    description:
      'Read raw 30-day demand and first-fill speed evidence for every observed platform:currency pair. Consumers should apply their own threshold and fail open to cash_capabilities when stats are unavailable or filtering would empty the catalog.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'cash_cashout',
    description:
      'Start a Base-USDC cash-out using the custody-separated prepare path. Returns UNSIGNED transactions plus same-index steps [approve, createDeposit]; signing and ordered submission stay host-side. For another source asset, complete cash_source_quote and cash_source_status first, then pass the guaranteed Base USDC output amount here.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: bigintString,
        receive: {
          type: 'object',
          description: 'Where the fiat should arrive',
          properties: {
            platform: {
              type: 'string',
              description: 'Platform id from cash_capabilities, e.g. "venmo"',
            },
            currency: { type: 'string', description: 'Fiat currency code, e.g. "USD"' },
            payee: {
              description: 'Raw payee handle or structured curator payee data',
              oneOf: [
                {
                  type: 'string',
                  description:
                    'User-entered handle, e.g. "@andrew" for Venmo; Peer Cash normalizes it for the selected platform',
                },
                {
                  type: 'object',
                  properties: {
                    offchainId: {
                      type: 'string',
                      description: 'Already-normalized handle for the platform',
                    },
                  },
                  required: ['offchainId'],
                  additionalProperties: true,
                },
              ],
            },
          },
          required: ['platform', 'currency', 'payee'],
          additionalProperties: false,
        },
      },
      required: ['amount', 'receive'],
      additionalProperties: false,
    },
  },
  {
    name: 'cash_order',
    description:
      'Observe one cash-out order by depositId - fully resumable, no session state. Returns state (awaiting-buyer | matched | delivering | delivered | returned), amounts, fills, and nextActions (wait | withdraw). Errors are typed with retryable + remediation; ORDER_NOT_FOUND right after cashout means indexer lag - retry in a few seconds.',
    inputSchema: {
      type: 'object',
      properties: { depositId },
      required: ['depositId'],
      additionalProperties: false,
    },
  },
  {
    name: 'cash_orders',
    description:
      'List all cash-out orders for a wallet address (the chain is the database - a cash order IS a deposit, keyed by depositor). Use inFlight=true for only the orders still needing attention.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { ...address, description: 'The maker wallet address (0x...)' },
        inFlight: {
          type: 'boolean',
          description: 'Only awaiting-buyer / matched / delivering orders',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 1_000,
          description: 'Max deposits to scan (default 100)',
        },
      },
      required: ['owner'],
      additionalProperties: false,
    },
  },
  {
    name: 'cash_buyer',
    description:
      'Look up a buyer\'s protocol track record from their full intent history: lifetime intents, fulfilled vs pruned counts, success rate (bps), first/last seen. Use during the matched state to answer "who just committed to my order?".',
    inputSchema: {
      type: 'object',
      properties: {
        address: { ...address, description: 'The buyer (taker) wallet address (0x...)' },
      },
      required: ['address'],
      additionalProperties: false,
    },
  },
  {
    name: 'cash_source_status',
    description:
      'Read Relay request status through the Relay SDK request utility using the requestId returned from cash_source_quote or Relay execution progress.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Relay request id.' },
      },
      required: ['requestId'],
      additionalProperties: false,
    },
  },
  {
    name: 'cash_withdraw',
    description:
      'Unwind a cash-out: returns UNSIGNED transaction(s) plus same-index steps (prepare path - signing stays host-side). With amount: partial withdrawal of the unlocked balance (a live buyer intent does not block it). Without amount: closes the order fully, state-aware - when the only live intents have expired it includes a pruneExpiredIntents transaction first; while a live buyer intent locks funds it fails with ACTIVE_INTENT_BLOCKS_WITHDRAWAL (retryable - wait for expiry).',
    inputSchema: {
      type: 'object',
      properties: {
        depositId,
        amount: {
          ...bigintString,
          description:
            'Optional partial amount (USDC base units, decimal string). Omit to close the order fully.',
        },
      },
      required: ['depositId'],
      additionalProperties: false,
    },
  },
  {
    name: 'cash_topup',
    description:
      'Add USDC to a live cash-out order (same payee, same market rate). Returns UNSIGNED transactions plus same-index steps [approve, addFunds] for the host to sign and submit in order. Fails with ORDER_NOT_ACTIVE if the order is already delivered or returned.',
    inputSchema: {
      type: 'object',
      properties: { depositId, amount: bigintString },
      required: ['depositId', 'amount'],
      additionalProperties: false,
    },
  },
] as const satisfies readonly CashToolDefinition[];

/** Literal names shipped by this package. Use this for exhaustive built-in dispatch. */
export type BuiltInCashToolName = (typeof builtInCashTools)[number]['name'];

/**
 * Mutable tool registry for hosts that append their own definitions.
 *
 * This was part of the 0.1.x public contract: keep the element name open as a
 * string rather than narrowing consumers to only the built-in verbs.
 */
export const cashTools: CashToolDefinition[] = [...builtInCashTools];

/** Manifest wrapper with versioning for host registries. */
export const cashToolManifest = {
  name: '@zkp2p/cash',
  version: packageJson.version,
  description:
    'Peer Cash - offramp-only: route any Relay-supported EVM source asset to Base USDC, then cash out to fiat at the live oracle market rate (0% spread). Mutating protocol tools return unsigned transactions plus step labels with ERC-8021 peer-cash attribution.',
  tools: cashTools,
} as const;

/** Tool names accepted by an extensible host registry, including custom tools. */
export type CashToolName = string;
