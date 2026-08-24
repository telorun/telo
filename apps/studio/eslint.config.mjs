import { defineConfig, globalIgnores } from "eslint/config";

const eslintConfig = defineConfig([
  globalIgnores(["dist/**", "build/**"]),
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/run/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/run/adapters/**", "**/run/ui/**"],
              message:
                "Import from src/run (the barrel), not from src/run/adapters or src/run/ui.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
