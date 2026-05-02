import { defineConfig } from 'rollup';
import nodeResolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';

export default defineConfig({
  input: 'src/index.ts',
  output: {
    file: 'com.hogehoge.spyserver-ex.sdPlugin/bin/index.js',
    format: 'cjs',
    sourcemap: true,
  },
  plugins: [
    nodeResolve({ preferBuiltins: true }),
    commonjs(),
    typescript(),
  ],
  external: ['naudiodon', 'net', 'fs', 'path', 'os', 'events', 'fs/promises', 'child_process',
             'node:fs', 'node:path', 'node:process', 'node:crypto', 'stream', 'http', 'https',
             'url', 'zlib', 'buffer', 'crypto', 'tls'],
});
