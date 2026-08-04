import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the `@/*` -> `src/*` alias from tsconfig so tests can import
      // project modules the same way application code does.
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
