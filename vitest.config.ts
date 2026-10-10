import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests that touch the database get a fresh in-memory one per test file.
    env: { DATABASE_PATH: ':memory:' },
  },
});
