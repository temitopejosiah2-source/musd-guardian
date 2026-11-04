import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/*.ts", "src/store/*.ts"],
      exclude: ["src/**/*.test.ts", "web/**", "coverage/**"],
    },
  },
});
