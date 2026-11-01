export const Caller = {
  create: (resource, ctx) => ({
    run: () => ctx.invoke("Assert.Equals", "matcher", { actual: 2, expected: 3 }),
  }),
};
