/**
 * Example: wiring the cash verbs into an agent tool-use loop.
 *
 * The host owns signing: mutating tools return UNSIGNED transactions the host
 * submits with its own key management. Everything crossing the tool boundary
 * is JSON - the codecs make that lossless.
 *
 * Run: bun examples/agent-tool-use.ts   (read-only tools run against staging)
 */
import { createCashClient, usdc, isCashError } from '@zkp2p/cash';
import {
  buyerProfileToJson,
  capabilitiesToJson,
  estimateToJson,
  orderToJson,
  prepareResultToJson,
  preparedTxToJson,
} from '@zkp2p/cash';
import { cashToolManifest } from '@zkp2p/cash/tools';
import type { PreparedTransaction, RelayQuote, RelayStatus } from '@zkp2p/cash';

const cash = createCashClient({ environment: 'staging' });

function txToJson(tx: PreparedTransaction) {
  return { ...tx, value: tx.value.toString() };
}

function relayQuoteToJson(quote: RelayQuote) {
  return {
    ...quote,
    inputAmount: quote.inputAmount.toString(),
    outputAmount: quote.outputAmount.toString(),
    txs: quote.txs.map(txToJson),
    raw: quote.raw,
  };
}

function relayStatusToJson(status: RelayStatus) {
  return { ...status };
}

/** The host's tool executor: tool name + JSON args in, JSON result out. */
async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'cash_capabilities':
        return capabilitiesToJson(
          args.includeRelaySources
            ? await cash.capabilities({ includeRelaySources: true })
            : cash.capabilities(),
        );
      case 'cash_source_quote':
        return relayQuoteToJson(
          await cash.quoteSource({
            user: args.user as string,
            amount: BigInt(args.amount as string),
            source: args.source as never,
            ...(args.recipient ? { recipient: args.recipient as string } : {}),
            ...(args.tradeType ? { tradeType: args.tradeType as never } : {}),
          }),
        );
      case 'cash_estimate':
        return estimateToJson(
          await cash.estimate({
            amount: BigInt(args.amount as string),
            currency: args.currency as never,
            ...(args.platform ? { platform: args.platform as string } : {}),
            ...(args.source ? { source: args.source as never } : {}),
          }),
        );
      case 'cash_cashout': {
        // Prepare path: return unsigned txs for Base USDC. Source-routed
        // cashout needs Relay execution first, so prepare() returns a typed
        // SOURCE_ROUTE_UNSUPPORTED_IN_PREPARE error for source inputs.
        const input = {
          amount: BigInt(args.amount as string),
          ...(args.source ? { source: args.source as never } : {}),
          receive: args.receive as never,
        };
        return prepareResultToJson(await cash.prepare(input));
      }
      case 'cash_order':
        return orderToJson(await cash.order(args.depositId as string));
      case 'cash_orders': {
        const orders = await cash.orders(args.owner as string, {
          ...(args.inFlight !== undefined ? { inFlight: args.inFlight as boolean } : {}),
        });
        return orders.map(orderToJson);
      }
      case 'cash_buyer':
        return buyerProfileToJson(await cash.buyer(args.address as string));
      case 'cash_source_status':
        return relayStatusToJson(await cash.relayStatus(args.requestId as string));
      case 'cash_withdraw': {
        const amount = args.amount !== undefined ? BigInt(args.amount as string) : undefined;
        const { txs, steps } = await cash.prepareWithdraw(args.depositId as string, {
          ...(amount !== undefined ? { amount } : {}),
        });
        return { txs: txs.map(preparedTxToJson), steps };
      }
      case 'cash_topup': {
        const { txs, steps } = await cash.prepareTopUp(
          args.depositId as string,
          BigInt(args.amount as string),
        );
        return { txs: txs.map(preparedTxToJson), steps };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    // Typed errors serialize cleanly into tool results the model can act on.
    if (isCashError(err)) return { error: err.toJSON() };
    throw err;
  }
}

// --- Demo loop: what an agent host would do with the manifest ---

console.log(`manifest: ${cashToolManifest.name}@${cashToolManifest.version}`);
console.log(`tools: ${cashToolManifest.tools.map((t) => t.name).join(', ')}\n`);

const caps = (await executeTool('cash_capabilities', {})) as {
  platforms: { platform: string; currencies: string[]; payeeHint: string }[];
};
console.log(`agent sees ${caps.platforms.length} platforms; venmo hint:`);
console.log(`  "${caps.platforms.find((p) => p.platform === 'venmo')?.payeeHint}"\n`);

const est = await executeTool('cash_estimate', {
  amount: usdc(250).toString(),
  currency: 'EUR',
});
console.log('cash_estimate →', JSON.stringify(est), '\n');

// A typed error round-trips as data, not an exception:
const notFound = await executeTool('cash_order', { depositId: '0xdead_999999' });
console.log('cash_order on unknown id →', JSON.stringify(notFound));
