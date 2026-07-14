/**
 * Prove that the publish artifact exposes all three public type entry points
 * to TypeScript's classic `node10` resolver (which ignores package exports).
 *
 * The check operates on the real npm tarball. It extracts that artifact into
 * an isolated temporary consumer and never installs a workspace link or
 * mutates the package lockfile.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface PackResult {
  filename: string;
  files: Array<{ path: string }>;
}

const cwd = process.cwd();
const temporaryRoot = mkdtempSync(join(tmpdir(), 'peer-cash-pack-compat-'));
const classicRoot = mkdtempSync(join(tmpdir(), 'peer-cash-classic-compat-'));
let tarballPath: string | undefined;

function run(command: string, args: string[], workingDirectory = cwd) {
  const result = spawnSync(command, args, {
    cwd: workingDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(
      `${command} ${args.join(' ')} failed with status ${result.status ?? 'unknown'}`,
    );
  }
  return result.stdout;
}

try {
  const packOutput = run('npm', ['pack', '--json']);
  const json = packOutput.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/)?.[1];
  if (!json) throw new Error(`Could not parse npm pack output:\n${packOutput}`);

  const [packResult] = JSON.parse(json) as PackResult[];
  if (!packResult?.filename) throw new Error('npm pack did not return a tarball filename');
  tarballPath = resolve(cwd, packResult.filename);

  const packedPaths = packResult.files.map(({ path }) => path);
  const forbiddenPath = packedPaths.find(
    (path) =>
      path.endsWith('.map') ||
      path.startsWith('src/') ||
      path.startsWith('test/') ||
      path.startsWith('scripts/') ||
      path.startsWith('.github/') ||
      /(^|\/)\.env($|\.)/.test(path) ||
      /(^|\/)(bun\.lock|package-lock\.json|yarn\.lock)$/.test(path),
  );
  if (forbiddenPath) throw new Error(`Forbidden file in packed artifact: ${forbiddenPath}`);

  for (const requiredPath of [
    'dist/index.js',
    'dist/index.cjs',
    'dist/react.js',
    'dist/react.cjs',
    'dist/tools.js',
    'dist/tools.cjs',
    'README.md',
    'docs/lifecycle-and-recovery.md',
    'skills/peer-cash-integration/SKILL.md',
  ]) {
    if (!packedPaths.includes(requiredPath)) {
      throw new Error(`Required packed file is missing: ${requiredPath}`);
    }
  }

  // Keep the classic-resolver fixture in a separate root with no installed
  // transitive declarations. Its job is subpath lookup, not type-checking the
  // dependency trees that modern NodeNext verifies below.
  const classicPackageRoot = join(classicRoot, 'node_modules', '@zkp2p', 'cash');
  mkdirSync(classicPackageRoot, { recursive: true });
  run('tar', ['-xzf', tarballPath, '-C', classicPackageRoot, '--strip-components=1']);

  writeFileSync(
    join(temporaryRoot, 'package.json'),
    JSON.stringify({ name: 'peer-cash-packed-smoke', private: true, type: 'module' }),
  );
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      tarballPath,
      'viem@2.55.0',
      'react@19.2.0',
      '@types/react@19.2.17',
    ],
    temporaryRoot,
  );

  const packageRoot = join(temporaryRoot, 'node_modules', '@zkp2p', 'cash');

  const packedPackage = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    version: string;
    typesVersions?: Record<string, Record<string, string[]>>;
  };
  const classicTypes = packedPackage.typesVersions?.['*'];
  if (
    JSON.stringify(classicTypes?.react) !== JSON.stringify(['./dist/react.d.ts']) ||
    JSON.stringify(classicTypes?.tools) !== JSON.stringify(['./dist/tools.d.ts']) ||
    Object.keys(classicTypes ?? {}).some((key) => key !== 'react' && key !== 'tools')
  ) {
    throw new Error(
      'Packed typesVersions must contain only the explicit react and tools fallbacks',
    );
  }

  const consumerSource = `import { createCashClient, type CashClient } from '@zkp2p/cash';
import { useCashout, type UseCashoutOptions } from '@zkp2p/cash/react';
import {
  cashTools,
  type BuiltInCashToolName,
  type CashToolDefinition,
  type CashToolName,
} from '@zkp2p/cash/tools';

const rootExport: typeof createCashClient = createCashClient;
const rootType = null as CashClient | null;
const reactExport: typeof useCashout = useCashout;
const reactType = null as UseCashoutOptions | null;
const customName: CashToolName = 'merchant_custom_tool';
const builtInName: BuiltInCashToolName = 'cash_fill_stats';
const mutableRegistry: CashToolDefinition[] = cashTools;

void [rootExport, rootType, reactExport, reactType, customName, builtInName, mutableRegistry];
`;
  writeFileSync(join(temporaryRoot, 'consumer-modern.ts'), consumerSource);
  writeFileSync(join(classicRoot, 'consumer-classic.ts'), consumerSource);
  writeFileSync(
    join(temporaryRoot, 'smoke.mjs'),
    `import { createCashClient, usdc } from '@zkp2p/cash';
import { useCashout } from '@zkp2p/cash/react';
import { cashToolManifest, cashTools } from '@zkp2p/cash/tools';

const client = createCashClient({ environment: 'staging' });
if (typeof client.cashout !== 'function' || typeof client.fillStats !== 'function' || usdc('1') !== 1_000_000n) throw new Error('root ESM failed');
if (typeof useCashout !== 'function') throw new Error('react ESM failed');
if (cashToolManifest.version !== ${JSON.stringify(packedPackage.version)} || cashTools.length !== 11) throw new Error('tools ESM failed');
`,
  );
  writeFileSync(
    join(temporaryRoot, 'smoke.cjs'),
    `const { createCashClient, usdc } = require('@zkp2p/cash');
const { useCashout } = require('@zkp2p/cash/react');
const { cashToolManifest, cashTools } = require('@zkp2p/cash/tools');

const client = createCashClient({ environment: 'staging' });
if (typeof client.cashout !== 'function' || typeof client.fillStats !== 'function' || usdc('1') !== 1000000n) throw new Error('root CJS failed');
if (typeof useCashout !== 'function') throw new Error('react CJS failed');
if (cashToolManifest.version !== ${JSON.stringify(packedPackage.version)} || cashTools.length !== 11) throw new Error('tools CJS failed');
`,
  );
  run('node', ['smoke.mjs'], temporaryRoot);
  run('node', ['smoke.cjs'], temporaryRoot);

  writeFileSync(
    join(temporaryRoot, 'tsconfig.modern.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        files: ['./consumer-modern.ts'],
      },
      null,
      2,
    ),
  );
  run(join(cwd, 'node_modules', '.bin', 'tsc'), [
    '--project',
    join(temporaryRoot, 'tsconfig.modern.json'),
  ]);

  // The gate is about this tarball's entry-point resolution. Shorthand
  // ambient modules keep classic TypeScript from recursively checking the
  // modern source declarations of transitive dependencies (notably ox).
  writeFileSync(
    join(classicRoot, 'dependency-shims.d.ts'),
    `declare module '@relayprotocol/relay-sdk';
declare module '@zkp2p/sdk';
declare module 'viem';
`,
  );
  writeFileSync(
    join(classicRoot, 'tsconfig.classic.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM'],
          module: 'CommonJS',
          moduleResolution: 'node10',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        files: ['./dependency-shims.d.ts', './consumer-classic.ts'],
      },
      null,
      2,
    ),
  );

  run(join(cwd, 'node_modules', '.bin', 'tsc'), [
    '--project',
    join(classicRoot, 'tsconfig.classic.json'),
  ]);
  process.stdout.write(
    'Packed artifact passed content, ESM/CJS runtime, NodeNext, and classic-resolver smoke checks.\n',
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
  rmSync(classicRoot, { recursive: true, force: true });
  if (tarballPath) rmSync(tarballPath, { force: true });
}
