// Reads a provider, so a manifest test can assert on what it provides.
export const Read = {
  async create(resource) {
    return { invoke: () => resource.source.provide() };
  },
};

// Checks a manifest, so a test can assert on exactly what was reported — a
// warning that must be absent included.
export const Diagnostics = {
  async create(resource, ctx) {
    return {
      async invoke() {
        const checked = await ctx.runtime.check(await ctx.resolveModuleFile(resource.source), { desugarImports: true });
        return {
          loadError: checked.loadError ?? null,
          reported: checked.diagnostics
            .filter((diagnostic) => diagnostic.severity !== "information")
            .map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`),
        };
      },
    };
  },
};
