// @claustrum/eslint-config — shared flat config for all @claustrum/* packages.
//
// ESLint v9 flat-config shape. Consumers (root eslint.config.mjs, or any
// per-package config) just `import` and re-export this array.

import eslint from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Global ignores — apply before any rule blocks so they short-circuit.
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "**/vitest.config.ts",
      "**/eslint.config.{js,mjs,cjs}",
    ],
  },

  // Base recommended sets — eslint:recommended + typescript-eslint:recommended.
  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  // Project rules — apply to TypeScript only.
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      import: importPlugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "import/order": [
        "warn",
        {
          groups: [
            "builtin",
            "external",
            "internal",
            "parent",
            "sibling",
            "index",
          ],
          "newlines-between": "never",
        },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
);
