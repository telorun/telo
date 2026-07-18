import { defineConfig, globalIgnores } from "eslint/config";

const eslintConfig = defineConfig([
  globalIgnores(["dist/**", "build/**"]),
  {
    files: ["src/**/*.{ts,tsx}"],
  },
]);

export default eslintConfig;
