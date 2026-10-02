// Lint for the dashboard (part of `npm run check`). Hooks rules include the React Compiler's checks, so code
// the compiler can't optimise (refs read or written during render, state set in render) is caught early.
import nextPlugin from "@next/eslint-plugin-next";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts", "public/**"] },
  {
    files: ["**/*.{ts,tsx,mjs,js,cjs}"],
    extends: [tseslint.configs.base],
    plugins: { "@next/next": nextPlugin, "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      // Labels wrap their control with the text in nested spans built from data.
      "jsx-a11y/label-has-associated-control": ["error", { assert: "either", depth: 4 }],
      // Components take a `role` prop (a bot's job title); only DOM elements carry ARIA roles.
      "jsx-a11y/aria-role": ["error", { ignoreNonDOM: true }],
      // Media here is the owner's own attachments and recordings, which have no caption tracks to offer.
      "jsx-a11y/media-has-caption": "off",
      // React Compiler readiness: refs read or written during render, state set in effects, impure calls and
      // mutation during render. Warnings until the Phase 4 split removes them; then errors and the compiler on.
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/immutability": "warn",
    },
  },
  {
    // Tests and scripts: hooks and accessibility rules don't apply to fixtures and Node tooling.
    files: ["tests/**", "scripts/**", "*.config.*"],
    rules: { "react-hooks/rules-of-hooks": "off", "jsx-a11y/no-noninteractive-element-interactions": "off" },
  },
);
