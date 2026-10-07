import { basename, extname } from "node:path";

// What a resolved browser entry looks like, without the content hashes a build
// puts in its chunk names.
const describe = (entry) => ({
  specifier: entry.specifier,
  file: basename(entry.file),
  siblings: entry.siblings.map((uri) => extname(uri)).sort(),
  digest: /^sha256-[A-Za-z0-9_-]{43}$/.test(entry.digest),
  abi: entry.abi ?? null,
  external: entry.external,
  exports: entry.exports,
});

const chunksOf = (entry) => entry.siblings.filter((uri) => uri.endsWith(".js"));

export const Widget = {
  async create(resource, ctx) {
    return {
      invoke: async () => {
        const named = await ctx.resolveBrowserEntry(resource.entry);
        const out = {
          named: describe(named),
          shell: describe(await ctx.resolveControllerBrowserEntry("@fixture/shell")),
        };
        if (resource.beside !== undefined) {
          // Two entries of one module built together load the same chunk.
          const other = await ctx.resolveBrowserEntry(resource.beside);
          out.sharesChunk = chunksOf(named).some((uri) => chunksOf(other).includes(uri));
        }
        return out;
      },
    };
  },
};
