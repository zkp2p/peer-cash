/**
 * `@zkp2p/cash/tools` — JSON-schema tool definitions of the verbs, so
 * agent hosts (peer-cli, zkp2p-mcp, any MCP server or tool-use loop) adopt
 * Peer Cash without re-deriving schemas.
 *
 * Design rules:
 * - Mutating verbs default to the **prepare path**: the tool returns unsigned
 *   transactions; signing stays host-side, where key custody and policy live.
 * - Every input/output is plain JSON (bigints as decimal strings) — see the
 *   codecs exported from the package root for lossless (de)serialization.
 * - `watch` is intentionally not a tool: agents poll `cash_order` between
 *   other work instead of holding a streaming connection open.
 */

export interface CashToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (draft-07 compatible) for the tool input. */
  inputSchema: Record<string, unknown>;
}

const bigintString = {
  type: 'string',
  pattern: '^[0-9]+$',
  description: 'USDC base units (6 decimals) as a decimal string, e.g. "1000000000" for 1000 USDC',
} as const;

const depositId = {
  type: 'string',
  description: 'Composite deposit id (escrow_onchainId) returned by cash_cashout — the resume key',
} as const;

export const cashTools: CashToolDefinition[] = [
  {
    name: 'cash_capabilities',
    description:
      'Discover what Peer Cash can do: payout platforms, oracle-priced currencies per platform, payee handle format hints, and amount bounds. Static and instant — call this first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'cash_estimate',
    description:
      'Estimate fiat received for a USDC amount at the live oracle market rate. No payee, no side effects, no expiry — the binding rate resolves at the oracle when a buyer fills, so this is always "approximately", never a committed quote.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: bigintString,
        currency: {
          type: 'string',
          description: 'Fiat currency code from cash_capabilities, e.g. "USD"',
        },
      },
      required: ['amount', 'currency'],
      additionalProperties: false,
    },
  },
  {
    name: 'cash_cashout',
    description:
      'Start a cash-out: registers the payee with the curator and returns UNSIGNED transactions [approve, createDeposit] for the host to sign and submit (prepare path — signing stays host-side). After submission, parse the depositId from the DepositReceived event or find it via cash_orders, then track with cash_order.',
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
              type: 'object',
              description: 'Payee handle for the platform',
              properties: {
                offchainId: {
                  type: 'string',
                  description:
                    'The handle, e.g. "@andrew" for Venmo — see payeeHint in cash_capabilities',
                },
              },
              required: ['offchainId'],
              additionalProperties: true,
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
      'Observe one cash-out order by depositId — fully resumable, no session state. Returns state (awaiting-buyer | matched | delivering | delivered | returned), amounts, fills, and nextActions (wait | withdraw). Errors are typed with retryable + remediation; ORDER_NOT_FOUND right after cashout means indexer lag — retry in a few seconds.',
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
      'List all cash-out orders for a wallet address (the chain is the database — a cash order IS a deposit, keyed by depositor). Use inFlight=true for only the orders still needing attention.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The maker wallet address (0x…)' },
        inFlight: {
          type: 'boolean',
          description: 'Only awaiting-buyer / matched / delivering orders',
        },
        limit: { type: 'number', description: 'Max deposits to scan (default 100)' },
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
        address: { type: 'string', description: 'The buyer (taker) wallet address (0x…)' },
      },
      required: ['address'],
      additionalProperties: false,
    },
  },
  {
    name: 'cash_withdraw',
    description:
      'Unwind a cash-out: returns UNSIGNED transaction(s) (prepare path — signing stays host-side). With amount: partial withdrawal of the unlocked balance (a live buyer intent does not block it). Without amount: closes the order fully, state-aware — when the only live intents have expired it includes a pruneExpiredIntents transaction first; while a live buyer intent locks funds it fails with ACTIVE_INTENT_BLOCKS_WITHDRAWAL (retryable — wait for expiry).',
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
      'Add USDC to a live cash-out order (same payee, same market rate). Returns UNSIGNED transactions [approve, addFunds] for the host to sign and submit in order. Fails with ORDER_NOT_ACTIVE if the order is already delivered or returned.',
    inputSchema: {
      type: 'object',
      properties: { depositId, amount: bigintString },
      required: ['depositId', 'amount'],
      additionalProperties: false,
    },
  },
];

/** Manifest wrapper with versioning for host registries. */
export const cashToolManifest = {
  name: '@zkp2p/cash',
  version: '0.1.0',
  description:
    'Peer Cash — offramp-only: cash out Base USDC to fiat at the live oracle market rate (0% spread). Seven verbs; mutating tools return unsigned transactions with ERC-8021 peer-cash attribution.',
  tools: cashTools,
} as const;

export type CashToolName = (typeof cashTools)[number]['name'];
