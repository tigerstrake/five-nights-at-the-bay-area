// Vite config for the e2e client servers: the app's own config plus a private dependency-optimizer cache per server
// (E2E_VITE_CACHE). Two Vite servers sharing node_modules/.vite make each other reload pages mid-test when one
// re-optimizes dependencies, which looks like a flaky "execution context was destroyed".
import { resolve } from 'node:path';
import { defineConfig, mergeConfig, type UserConfig } from 'vite';
import base from '../client/vite.config.ts';

export default defineConfig(
  mergeConfig(base as UserConfig, {
    root: resolve(import.meta.dirname, '../client'),
    define: { 'import.meta.env.VITE_FNAB_TEST_HOOKS': JSON.stringify('1') },
    cacheDir: resolve(import.meta.dirname, '../node_modules', `.vite-e2e-${process.env.E2E_VITE_CACHE ?? 'main'}`),
  } satisfies UserConfig),
);
