import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests use a separate database so they can truncate freely.
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? "postgres://app:app@localhost:5432/ops_test",
      JWT_SECRET: "test-secret",
    },
    fileParallelism: false,
    testTimeout: 20000,
  },
});
