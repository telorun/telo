import { defineConfig, globalIgnores } from "eslint/config";

const eslintConfig = defineConfig([
  globalIgnores(["build/**", ".react-router/**"]),
  {
    files: ["app/**/*.{ts,tsx}"],
  },
]);

export default eslintConfig;
