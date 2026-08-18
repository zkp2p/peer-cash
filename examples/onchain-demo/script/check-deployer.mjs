// Print the deploy account's address, Base balance, and nonce. Nothing else.
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, formatEther } from 'viem';
import { base } from 'viem/chains';
import { loadKey } from './lib.mjs';

const account = privateKeyToAccount(loadKey());
const client = createPublicClient({ chain: base, transport: http(process.env.RPC_URL) });
const [balance, nonce] = await Promise.all([
  client.getBalance({ address: account.address }),
  client.getTransactionCount({ address: account.address }),
]);
console.log(`address ${account.address}`);
console.log(`balance ${formatEther(balance)} ETH on Base`);
console.log(`nonce   ${nonce}`);
