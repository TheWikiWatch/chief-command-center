import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.{test,spec}.{ts,tsx}"],
    reporters: ["default"],
    testTimeout: 20_000,
    pool: "vmThreads",
  },
  resolve: {
    // The @/ imports, as tsconfig.json has them (built into Vite since 8).
    tsconfigPaths: true,
    // next/dynamic's CommonJS build imports ESM helpers that Vitest's runner can't load: a React.lazy stand-in.
    alias: {
      "next/dynamic": fileURLToPath(new URL("./tests/shims/next-dynamic.tsx", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/shims/server-only.ts", import.meta.url)),
      // As in the build (next.config.ts): KaTeX stays out.
      "rehype-katex": fileURLToPath(new URL("./lib/no-katex.ts", import.meta.url)),
    },
  },
});
