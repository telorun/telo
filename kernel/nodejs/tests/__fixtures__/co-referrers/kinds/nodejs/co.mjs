/** Runs every co-referrer of its topic, one at a time, and returns their labels;
 *  `coReferrersAt` asks its own context, for a test. */
export const announce = {
  schema: { type: "object", additionalProperties: true },
  async create(resource, ctx) {
    return {
      async invoke(inputs, invokeCtx) {
        const ran = [];
        for (const { target, instance } of ctx.resolveCoReferrers("/topic")) {
          const out = await ctx.invokeResolved(target.ref.kind, target.ref.name, instance, inputs, invokeCtx);
          ran.push(out.label);
        }
        return { ran };
      },
      coReferrersAt: (slot) => ctx.resolveCoReferrers(slot),
    };
  },
};

/** Answers with its label; `coReferrersAt` asks its own context, for a test. */
export const listener = {
  schema: { type: "object", additionalProperties: true },
  async create(resource, ctx) {
    return {
      async invoke() {
        return { label: resource.label };
      },
      coReferrersAt: (slot) => ctx.resolveCoReferrers(slot),
    };
  },
};
