import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/server/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/**/index.ts',
        'src/server/routes/**/*.ts', // Routes require full Express setup
        'src/server/clients/firefly.ts', // External API client
        'src/server/clients/ai.ts', // External API client
        'src/server/clients/fints.ts', // External FinTS client wrapper
        'src/server/clients/fints/client.ts', // FinTS client implementation
        'src/server/clients/fints/transport.ts', // FinTS transport layer
        'src/server/middleware/auth.ts', // Auth middleware requires full setup
        'src/server/middleware/security.ts', // Security middleware
      ],
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/client', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
});
