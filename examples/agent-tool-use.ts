/**
 * Example: wiring the cash verbs into an agent tool-use loop.
 *
 * The host owns signing: mutating tools return UNSIGNED transactions the host
 * submits with its own key management. Everything crossing the tool boundary
 * is JSON — the codecs make that lossless.
 *
 * Run: bun examples/agent-tool-use.ts   (read-only tools run against staging)
 */
import { createCashClient, usdc, isCashError } from '@zkp2p/cash';
import { capabilitiesToJson, estimateToJson, orderToJson, prepareResultToJson } from '@zkp2p/cash';
import { cashToolManifest } from '@zkp2p/cash/tools';

const cash = createCashClient({ environment: 'staging' });

/** The host's tool executor: tool name + JSON args in, JSON result out. */
async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'cash_capabilities':
        return capabilitiesToJson(cash.capabilities());
      case 'cash_estimate':
        return estimateToJson(
          await cash.estimate({
            amount: BigInt(args.amount as string),
            currency: args.currency as never,
          }),
        );
      case 'cash_cashout': {
        // Prepare path: return unsigned txs; the host signs and submits.
        const input = {
          amount: BigInt(args.amount as string),
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
      case 'cash_withdraw': {
        const { txs } = await cash.prepareWithdraw(args.depositId as string);
        return { txs: txs.map((tx) => ({ ...tx, value: tx.value.toString() })) };
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
