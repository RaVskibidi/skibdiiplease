
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  minify: false,
  splitting: false,
  noExternal: [/^@t77\//],
external: [
  'pg',
  'pg-native',
  'ioredis',
  '@prisma/client',
  '@prisma/client/runtime/*',
  '@prisma/adapter-pg',
],
});
