// Reads the native file named `greeting` through the resource context, so the
// test observes which module's `native:` block the kernel resolved it against.
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
