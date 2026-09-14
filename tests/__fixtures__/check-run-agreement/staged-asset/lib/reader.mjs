// Reads the library's own staged asset, so the kernel's verification of it — and
// its resolution against the library rather than the consuming app — is exercised.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const reader = {
  async create(resource, ctx) {
    return {
      async invoke() {
        const uri = await ctx.resolveControllerFile("./assets/greeting.txt");
        return { text: (await readFile(fileURLToPath(uri), "utf-8")).trim() };
      },
      snapshot() {
        return {};
      },
    };
  },
};
