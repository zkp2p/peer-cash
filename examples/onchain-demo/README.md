# Peer Cash Demo, stored onchain

The Peer express sell flow as one self-contained page: amount, platform,
currency, payee, estimate, cash out, then watch the order to delivered. The
page bundles [`@zkp2p/cash`](https://www.npmjs.com/package/@zkp2p/cash) and
viem, and the whole thing - markup, styles, and SDK - is stored on Base as
contract runtime bytecode and served back by an immutable ERC-5219 / ERC-4804
wrapper. No server, no IPFS, no build pipeline between the user and the chain.
After [zSwap by z0r0z](https://github.com/z-fi/zFi).

This example is a self-contained npm project. It pins the published
`@zkp2p/cash` from npm (the exact bytes that ship onchain) plus esbuild, solc,
and a local EVM for verification, so it installs and runs from this directory
alone and stays outside the repository's bun toolchain.

## How it works

- `script/build.mjs` bundles `src/app.js` with esbuild and inlines it into
  `src/shell.html`, producing `out/PeerCash.html`: the exact bytes that go
  onchain. Every byte ships as deposit gas, so build-time stubs
  (`src/stubs/`) replace viem's ~700-chain catalog and zod's locale catalog
  with only what the app imports.
- The page is split into 24,576-byte chunks (the EIP-170 runtime size limit)
  and each chunk is installed byte-for-byte as the **runtime bytecode of a
  data contract** (SSTORE2-style initcode). `eth_getCode` on a chunk address
  returns that slice of the page.
- `src/PeerCashPage.sol` is an immutable wrapper over the chunk list.
  `html()` reassembles the page with `EXTCODECOPY`; `request()` serves it per
  **ERC-5219** with `Content-Type: text/html` and an immutable cache header;
  `resolveMode()` returns `"5219"` per **ERC-4804**, so `web3://` gateways
  render it straight from any Base RPC. Both view functions ABI-encode their
  return data in assembly, writing the multi-megabyte body to memory exactly
  once, which keeps view calls under public `eth_call` gas caps.
- The wrapper address is predicted from the deployer nonce and baked into the
  page before chunking, so the deployed page names its own contract and links
  its own gateway URL in the footer.

## Build and verify

```sh
npm install
node script/build.mjs          # bundle + inline → out/PeerCash.html
node script/boot-test.mjs      # boot the app under a DOM shim (catches dead element refs)
node script/compile.mjs        # solc → out/PeerCashPage.json (incl. verification input)
node script/test-contract.mjs  # deploy chunks + wrapper on a local EVM, assert byte-exact
                               # html()/request() and view gas under eth_call caps
```

Open `out/PeerCash.html` in a browser to use the flow before deploying:
capabilities, estimates, and fill times are live against production Peer, and
a connected wallet on Base performs a real cash-out.

## Deploy to Base

```sh
DEPLOY_PRIVATE_KEY=0x… node script/deploy.mjs      # or:
ENV_FILE=path/to/.env KEY_VAR=BASE_DEPLOY_PRIVATE_KEY node script/deploy.mjs
```

The deploy predicts every address from the deployer nonce, prices one chunk,
checks the balance, sends the chunk transactions in pre-priced parallel
batches with explicit nonces, deploys the wrapper over the chunk list, then
asserts the predicted addresses, per-chunk `getCode` spot checks, and a
byte-exact `html()` readback. It writes `out/deployment.json` and
`out/PeerCash.deployed.html` (the canonical bytes onchain).

A ~2.2 MB page is ~90 chunks and ~485M gas total, roughly $4-15 on Base
depending on gas price. Rerunning after a partial failure deploys a fresh
set; orphaned data contracts are harmless dead bytes.

`script/check-deployer.mjs` prints the deploy account's address, balance, and
nonce without sending anything. `script/gen-key.mjs` generates a throwaway
`.deployer.key` (0600) and prints only its address.

## Read it back

```sh
cast call <PAGE> 'html()(string)' -r https://mainnet.base.org
cast code <CHUNK> -r https://mainnet.base.org     # one slice of the HTML
```

or `https://<page-address-lowercase>.8453.w3link.io/` · `web3://<PAGE>:8453/`
