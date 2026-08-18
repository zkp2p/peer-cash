import { createServer } from 'node:http';

import type { CurrencyType } from '@zkp2p/cash';
import { NodeListener, Request as ServerRequest } from 'mppx/server';

import { createApp } from './app.js';

const recipient = process.env.MPPX_RECIPIENT as `0x${string}` | undefined;
const facilitator = process.env.X402_FACILITATOR_URL;
const secretKey = process.env.MPP_SECRET_KEY;
const platform = process.env.PEER_CASH_PLATFORM;
const currency = process.env.PEER_CASH_CURRENCY;
const payee = process.env.PEER_CASH_PAYEE;

if (!recipient || !facilitator || !secretKey || !platform || !currency || !payee) {
  throw new Error(
    'MPPX_RECIPIENT, X402_FACILITATOR_URL, MPP_SECRET_KEY, PEER_CASH_PLATFORM, PEER_CASH_CURRENCY, and PEER_CASH_PAYEE are required.',
  );
}

const { adminApp, publicApp } = createApp({
  cashout: {
    currency: currency as CurrencyType,
    payee,
    platform,
    ...(process.env.PEER_CASH_THRESHOLD_USDC
      ? { thresholdUsdc: process.env.PEER_CASH_THRESHOLD_USDC }
      : {}),
  },
  facilitator,
  recipient,
  secretKey,
});

serve(publicApp.fetch, Number(process.env.PORT ?? 5173), '0.0.0.0');
serve(adminApp.fetch, Number(process.env.ADMIN_PORT ?? 5174), '127.0.0.1');

console.log(`MPP merchant API: http://localhost:${process.env.PORT ?? 5173}/api/report`);
console.log(`Peer Cash planner: http://127.0.0.1:${process.env.ADMIN_PORT ?? 5174}/cashout`);

function serve(
  fetch: (request: Request) => Response | Promise<Response>,
  port: number,
  hostname: string,
) {
  const server = createServer(async (request, response) => {
    const serverRequest = ServerRequest.fromNodeListener(request, response);
    const serverResponse = await fetch(serverRequest);
    return NodeListener.sendResponse(response, serverResponse);
  });
  server.listen(port, hostname);
}
