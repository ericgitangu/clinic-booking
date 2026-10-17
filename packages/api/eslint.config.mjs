import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "src/generated/**", ".drift-tmp/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["*.mjs", "*.config.ts"],
    languageOptions: { globals: { ...globals.node } },
  },
);
