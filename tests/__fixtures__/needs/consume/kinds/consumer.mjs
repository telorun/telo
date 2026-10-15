// Opens the fulfilment whole and reports what it was told the server is. The
// kernel compares the report with the need; nothing here reads a range.
export const Database = {
  async create(resource, ctx) {
    let opened;
    return {
      init() {
        if (resource.probe !== undefined) ctx.resolveNeed(resource.probe);
        opened = ctx.resolveNeed("/access");
        if (resource.report === false) return;
        ctx.verifyNeed("/access", {
          version: resource.serverVersion,
          features: resource.extensions ?? [],
        });
      },
      snapshot() {
        return {
          url: opened?.fields.url ?? null,
          sensitive: opened?.sensitive ?? null,
          constraints: opened?.constraints ?? null,
        };
      },
    };
  },
};
