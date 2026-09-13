// Reads the native file named `greeting`, so a manifest's staging of it is
// exercised by the kernel's own read path.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const reader = {
  async create(resource, ctx) {
    return {
      async invoke() {
        const uri = await ctx.resolveNativeFile("greeting");
        return { text: (await readFile(fileURLToPath(uri), "utf-8")).trim() };
      },
      snapshot() {
        return {};
      },
    };
  },
};
