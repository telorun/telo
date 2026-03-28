import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  output: 'export',
  transpilePackages: ['@telorun/analyzer', '@telorun/sdk'],
  turbopack: {
    resolveAlias: {
      // NodeAdapter (exported from @telorun/analyzer) imports fs/promises but is
      // never used in the browser. Stub it out so Turbopack doesn't fail.
      'fs/promises': './src/empty.ts',
      'fs': './src/empty.ts',
    },
  },
};

export default nextConfig;
