import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".next/**", "node_modules/**", "src/generated/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      // The landing page links to route handlers (/docs, /api/*), not Next pages, so <a> is correct.
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  // Node build scripts and flat-config files.
  {
    files: ["scripts/**/*.mjs", "e2e/**/*.mjs", "*.mjs", "*.config.ts"],
    languageOptions: { globals: { ...globals.node } },
  },
);
