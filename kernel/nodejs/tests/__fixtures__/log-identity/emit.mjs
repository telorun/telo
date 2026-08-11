// A Runnable that emits one record through `ctx.log`.
//
// The logger is captured in `create()` ON PURPOSE. That is the natural thing to
// do when the logger is handed to a helper that outlives the call, and it is the
// path that regressed: identity used to be bound after `create()` returned, so a
// logger taken here carried no `resource` for the resource's whole life.
export const emit = {
  schema: { type: "object", additionalProperties: true },
  async create(resource, ctx) {
    const log = ctx.log;
    return {
      async run() {
        log.info("fixture emitted");
      },
      snapshot() {
        return {};
      },
    };
  },
};
