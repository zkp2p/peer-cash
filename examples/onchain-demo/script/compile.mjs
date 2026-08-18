// Compile src/PeerCashPage.sol with solc standard JSON and save artifacts
// (abi, bytecode, metadata, and the exact standard input for verification).
import solc from 'solc';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib.mjs';

const source = readFileSync(join(root, 'src/PeerCashPage.sol'), 'utf8');

const input = {
  language: 'Solidity',
  sources: { 'src/PeerCashPage.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'cancun',
    metadata: { bytecodeHash: 'ipfs' },
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
let failed = false;
for (const e of output.errors ?? []) {
  console.error(e.formattedMessage);
  failed ||= e.severity === 'error';
}
if (failed) process.exit(1);

const contract = output.contracts['src/PeerCashPage.sol'].PeerCashPage;
mkdirSync(join(root, 'out'), { recursive: true });
writeFileSync(
  join(root, 'out/PeerCashPage.json'),
  JSON.stringify(
    {
      contractName: 'PeerCashPage',
      sourceName: 'src/PeerCashPage.sol',
      solcVersion: solc.version(),
      abi: contract.abi,
      bytecode: '0x' + contract.evm.bytecode.object,
      deployedBytecode: '0x' + contract.evm.deployedBytecode.object,
      metadata: contract.metadata,
      standardInput: input,
    },
    null,
    2,
  ),
);
console.log(`compiled with solc ${solc.version()}`);
console.log(`creation bytecode: ${contract.evm.bytecode.object.length / 2} bytes`);
