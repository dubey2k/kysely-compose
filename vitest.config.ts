import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    typecheck: {
      enabled: false,
    },
    pool: "threads",
    reporters: process.env.CI ? ["default", "github-actions"] : ["default"],
  },
});
