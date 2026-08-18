// Generate a fresh throwaway deployer key into .deployer.key (mode 0600)
// and print only its address. Refuses to overwrite an existing key.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib.mjs';

const file = join(root, '.deployer.key');
if (existsSync(file)) {
  const existing = privateKeyToAccount(readFileSync(file, 'utf8').trim());
  console.log(`existing key kept · address ${existing.address}`);
} else {
  const key = generatePrivateKey();
  writeFileSync(file, key + '\n', { mode: 0o600 });
  console.log(`new key written to .deployer.key · address ${privateKeyToAccount(key).address}`);
}
