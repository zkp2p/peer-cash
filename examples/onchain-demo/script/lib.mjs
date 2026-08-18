// Shared pieces for the build/deploy scripts. Pure module, no side effects.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** EIP-170 runtime-size limit; one data contract holds one chunk. */
export const MAX_CHUNK = 24576;

export const chunkCountFor = (byteLength) => Math.ceil(byteLength / MAX_CHUNK);

/**
 * Read the deploy key from DEPLOY_PRIVATE_KEY, or from the dotenv-format
 * ENV_FILE (var named by KEY_VAR, default BASE_DEPLOY_PRIVATE_KEY). The key
 * value must never be logged.
 */
export function loadKey() {
  if (process.env.DEPLOY_PRIVATE_KEY) return process.env.DEPLOY_PRIVATE_KEY;
  const file = process.env.ENV_FILE;
  if (!file) throw new Error('set DEPLOY_PRIVATE_KEY or ENV_FILE');
  const varName = process.env.KEY_VAR ?? 'BASE_DEPLOY_PRIVATE_KEY';
  const line = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${varName}=`));
  if (!line) throw new Error(`${varName} not found in ${file}`);
  const value = line.slice(varName.length + 1).trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error(`${varName} is empty in ${file}`);
  return value.startsWith('0x') ? value : `0x${value}`;
}
