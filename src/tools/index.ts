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

const receiveLeg = {
  type: 'object',
  description: 'One payout leg: platform + currency choice + payee',
  properties: {
    platform: {
      type: 'string',
      description: 'Platform id from cash_capabilities, e.g. "venmo"',
    },
    currency: { type: 'string', description: 'Fiat currency code, e.g. "USD"' },
    currencies: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string' },
      description: 'Fiat currency choices for one payment method, e.g. ["EUR", "GBP"]',
    },
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
  required: ['platform', 'payee'],
  oneOf: [{ required: ['currency'] }, { required: ['currencies'] }],
  additionalProperties: false,
} as const;

const builtInCashTools = [
  {
    name: 'cash_capabilities',
    description:
      'Discover what Peer Cash can do: payout platforms, currencies and rate-binding semantics per platform, Base USDC destination, default Base USDC source, payee handle hints, and amount bounds. Opt into live Relay EVM or NEAR Intents source discovery.',
    inputSchema: {
      type: 'object',
      properties: {
        includeRelaySources: {
          type: 'boolean',
          description: 'Fetch live Relay SDK EVM source chain/token metadata.',
        },
        includeNearIntentsSources: {
          type: 'boolean',
          description: 'Fetch live NEAR Intents 1Click source asset metadata.',
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
    name: 'cash_near_intents_quote',
    description:
      'Quote a NEAR Intents 1Click external-deposit route into canonical Base USDC. Persist the returned depositAddress, optional depositMemo, signed quote, and deadline before sending source funds. The host must fund that origin-chain address itself; this tool never signs or broadcasts the source transfer.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceAsset: {
          type: 'string',
          description: 'NEAR Intents asset id from cash_capabilities, e.g. nep141:zec.omft.near.',
        },
        amount: {
          ...bigintString,
          description:
            'Base units: source units for EXACT_INPUT or canonical Base USDC units for EXACT_OUTPUT.',
        },
        recipient: {
          ...address,
          description: 'Base address that will receive canonical USDC.',
        },
        refundTo: {
          type: 'string',
          description: 'Refund address on the source chain.',
        },
        tradeType: {
          type: 'string',
          enum: ['EXACT_INPUT', 'EXACT_OUTPUT'],
        },
        deadline: {
          type: 'string',
          format: 'date-time',
          description: 'Quote deadline as an ISO timestamp.',
        },
        slippageTolerance: {
          type: 'integer',
          minimum: 0,
          maximum: 10_000,
          description: 'Basis points; defaults to 100 (1%).',
        },
        dry: {
          type: 'boolean',
          description: 'Simulation only. A dry quote has no deposit address.',
        },
      },
      required: ['sourceAsset', 'amount', 'recipient', 'refundTo', 'tradeType', 'deadline'],
      additionalProperties: false,
    },
  },
  {
    name: 'cash_near_intents_submit',
    description:
      'Optionally notify NEAR Intents of an already-broadcast origin transaction so deposit detection starts sooner. Retrying this notification is safe; never resend source funds because notification failed.',
    inputSchema: {
      type: 'object',
      properties: {
        depositAddress: { type: 'string', description: 'Deposit address from the signed quote.' },
        depositMemo: { type: 'string', description: 'Optional memo from the signed quote.' },
        txHash: { type: 'string', description: 'Already-broadcast origin-chain transaction hash.' },
      },
      required: ['depositAddress', 'txHash'],
      additionalProperties: false,
    },
  },
  {
    name: 'cash_near_intents_status',
    description:
      'Track a NEAR Intents route by the exact depositAddress and optional depositMemo returned by its signed quote. Persist transaction evidence and wait for SUCCESS before creating the Base-USDC cash-out; never reuse an expired route.',
    inputSchema: {
      type: 'object',
      properties: {
        depositAddress: { type: 'string', description: 'Deposit address from the signed quote.' },
        depositMemo: { type: 'string', description: 'Optional memo from the signed quote.' },
        expectedQuote: {
          type: 'object',
          description:
            'Exact serialized result from cash_near_intents_quote; used to reject status for a different route identity.',
          additionalProperties: true,
        },
      },
      required: ['depositAddress', 'expectedQuote'],
      additionalProperties: false,
    },
  },
  {
    name: 'cash_estimate',
    description:
      'Estimate fiat received at the corridor market rate, including whether it binds at intent signal or deposit creation, plus a simple recent-fill ETA. Without source, amount is Base USDC. With source, the SDK first quotes source->Base USDC through Relay SDK, then estimates the cashout.',
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
      'Start a Base-USDC cash-out using the custody-separated prepare path. Returns UNSIGNED transactions plus same-index steps [approve, createDeposit]; signing and ordered submission stay host-side. If any payout leg is Venmo or PayPal, accessPolicyPaymentMethods lists every method-scoped Peer Pay policy required after createDeposit confirms. Cash App is non-chargebackable, stays public, and does not require stake. The host adapter must call CashClient.finalizePreparedCashout(receipt), then prepare and confirm CashClient.prepareAccessPolicy(depositId, paymentMethod) for each listed method with the depositor. These receipt/signing methods are not separate built-in tools. For another source asset, complete cash_source_quote and cash_source_status first, then pass the guaranteed Base USDC output amount here.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: bigintString,
        receive: {
          description:
            'Where the fiat should arrive: one payout leg, or an array of legs to offer several platforms (each platform at most once; consult cash_capabilities for each corridor binding point)',
          oneOf: [
            receiveLeg,
            {
              type: 'array',
              minItems: 1,
              items: receiveLeg,
              description: 'Multiple payout legs across different platforms',
            },
          ],
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
    'Peer Cash - offramp-only: route Relay EVM or NEAR Intents external-deposit source assets to Base USDC, then cash out to fiat at a zero-spread Chainlink market rate. Mutating protocol tools return unsigned transactions plus step labels with ERC-8021 peer-cash attribution.',
  tools: cashTools,
} as const;

/** Tool names accepted by an extensible host registry, including custom tools. */
export type CashToolName = string;
