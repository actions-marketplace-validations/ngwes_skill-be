import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The code tests run the compiled child, so every run builds a fresh dist/ first.
    globalSetup: ['test/global-setup.ts'],
  },
});
