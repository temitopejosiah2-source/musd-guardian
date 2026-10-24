import globals from "globals";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "web/**", ".git/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
    plugins: { security },
    rules: security.configs.recommended.rules,
  },
];
