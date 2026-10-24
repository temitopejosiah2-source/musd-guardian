import globals from "globals";
import nextVitals from "eslint-config-next/core-web-vitals";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

const config = [
  {
    ignores: [".next/**", "node_modules/**", "out/**", "coverage/**"],
  },
  ...nextVitals,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { security },
    rules: security.configs.recommended.rules,
  },
];

export default config;
