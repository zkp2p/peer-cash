// Slim stand-in for viem/chains. The full catalog is ~700 chain definitions
// (~250 KB minified) and every byte of this page is paid for in deploy gas;
// the app and its SDKs only ever import these two.
export { base } from '../../node_modules/viem/_esm/chains/definitions/base.js';
export { hardhat } from '../../node_modules/viem/_esm/chains/definitions/hardhat.js';
export { mainnet } from '../../node_modules/viem/_esm/chains/definitions/mainnet.js';
export { sepolia } from '../../node_modules/viem/_esm/chains/definitions/sepolia.js';
