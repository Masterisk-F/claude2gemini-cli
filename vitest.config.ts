import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['gemini-cli/**', 'antigravity-client/**', 'node_modules/**']
  }
});
