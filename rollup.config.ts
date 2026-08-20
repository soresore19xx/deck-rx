import { defineConfig } from 'rollup';
import nodeResolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';

const plugins = () => [
  nodeResolve({ preferBuiltins: true }),
  commonjs(),
  typescript(),
];

const external = ['naudiodon', 'deck-rx-asrc',
                  'net', 'fs', 'path', 'os', 'events', 'fs/promises', 'child_process',
                  'node:fs', 'node:path', 'node:process', 'node:crypto', 'stream', 'http', 'https',
                  'url', 'zlib', 'buffer', 'crypto', 'tls'];

// Two entry points over one core. The headless bundle lands NEXT TO the plugin
// bundle on purpose: spyService resolves config.json, the preset store and the
// station DBs relative to __dirname, so both processes read the same files
// without a special case.
export default defineConfig([
  {
    input: 'src/index.ts',
    output: { file: 'com.hogehoge.deck-rx.sdPlugin/bin/index.js', format: 'cjs', sourcemap: true },
    plugins: plugins(),
    external,
  },
  {
    input: 'src/headless.ts',
    output: { file: 'com.hogehoge.deck-rx.sdPlugin/bin/headless.js', format: 'cjs', sourcemap: true },
    plugins: plugins(),
    external,
  },
]);
