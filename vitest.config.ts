import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The fixtures' code tests are skill-be's input, run by skill-be, not by vitest.
    exclude: [...configDefaults.exclude, 'test/fixtures/**'],
    // The code tests run the compiled child, so every run builds a fresh dist/ first.
    globalSetup: ['test/global-setup.ts'],
  },
});
