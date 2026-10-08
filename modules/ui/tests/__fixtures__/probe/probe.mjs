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
        const lines = (keep) =>
          checked.diagnostics.filter(keep).map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`);
        return {
          loadError: checked.loadError ?? null,
          reported: lines((diagnostic) => diagnostic.severity !== "information"),
          noted: lines((diagnostic) => diagnostic.severity === "info" || diagnostic.severity === "hint"),
        };
      },
    };
  },
};
