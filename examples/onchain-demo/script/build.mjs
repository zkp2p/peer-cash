// Bundle src/app.js (with @zkp2p/cash + viem) and inline it into
// src/shell.html → out/PeerCash.html, the exact bytes that go onchain.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { root, MAX_CHUNK, chunkCountFor } from './lib.mjs';

const result = await build({
  entryPoints: [join(root, 'src/app.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  write: false,
  // Without this, esbuild discovers the nearest tsconfig.json above the entry
  // point; inside the SDK repo that maps @zkp2p/cash to the workspace TS
  // source. The page must bundle the pinned npm package from node_modules.
  tsconfigRaw: {},
  // Every byte ships onchain: swap the huge viem chain catalog and zod locale
  // catalog for stubs of what the app actually uses (see src/stubs/).
  alias: { 'viem/chains': join(root, 'src/stubs/viem-chains.mjs') },
  plugins: [{
    name: 'slim-zod-locales',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /locales\/index\.js$/ }, (args) =>
        args.importer.includes(`${'/'}zod${'/'}`)
          ? { path: join(root, 'src/stubs/zod-locales.mjs') }
          : null,
      );
    },
  }],
});

// A literal "</script" inside the bundle would close our inline tag early.
// In JS source that sequence only occurs inside strings/regexes, where the
// escaped form is equivalent.
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const shell = readFileSync(join(root, 'src/shell.html'), 'utf8');
if (!shell.includes('<!--APP_JS-->')) throw new Error('shell missing <!--APP_JS--> marker');
const html = shell.replace('<!--APP_JS-->', () => js);

mkdirSync(join(root, 'out'), { recursive: true });
writeFileSync(join(root, 'out/PeerCash.html'), html);

// Preview the deploy shape with the same math deploy.mjs uses, on the same
// substituted length it will ship.
const shipped = Buffer.byteLength(html.replaceAll('__PAGE_ADDRESS__', `0x${'f'.repeat(40)}`));
const chunkCount = chunkCountFor(shipped);
console.log(`bundle: ${(Buffer.byteLength(js) / 1024).toFixed(1)} KB js`);
console.log(`page:   ${(shipped / 1024).toFixed(1)} KB → ${chunkCount} data contract chunk(s)`);
console.log(`gas:    ~${Math.round((shipped * 216 + chunkCount * 55000 + 4_000_000) / 1e6)}M (deposit+calldata+wrapper, rough)`);
