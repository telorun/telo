// `Database` opens the fulfilment whole and publishes what it was handed: the URL value,
// its text as a reader outside Telo is given it, and the fields marked sensitive as
// delivered. `LogUrl` logs the URL value it is called with, as a controller would.
import { toPlainJson } from "@telorun/sdk";

export const Database = {
  async create(resource, ctx) {
    let opened;
    return {
      init() {
        opened = ctx.resolveNeed("/access");
      },
      snapshot() {
        return {
          url: opened?.fields.url ?? null,
          text: opened ? toPlainJson(opened.fields.url) : null,
          sensitive: opened?.sensitive ?? null,
        };
      },
    };
  },
};

export const LogUrl = {
  async create(resource, ctx) {
    return {
      async invoke(inputs) {
        ctx.log.info(inputs.marker, { url: inputs.url, host: inputs.url.host });
        return {};
      },
    };
  },
};
