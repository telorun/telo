// One journal per module scope — the controllers of a fixture module are one
// bundle, so `flaky` writes it and `journal` reads it.
const entries = [];

/**
 * A resource whose `init()` returns two effects and then fails, on the first
 * pass only.
 *
 * The point of the fixture is what the journal shows afterwards: the inverses
 * ran in LIFO order before the retry, and the retry ran against a NEW instance
 * (a fresh `create`), not the one holding half an allocation.
 */
export const flaky = {
  schema: { type: "object", additionalProperties: true },
  async create(resource, ctx) {
    const instanceId = entries.filter((e) => e === "create").length + 1;
    entries.push("create");
    let initAttempts = 0;
    return {
      init() {
        initAttempts++;
        entries.push(`init:${instanceId}:${initAttempts}`);
        return ctx
          .effect("alpha", async () => {
            entries.push("alpha");
            return { result: "a", inverse: () => entries.push("~alpha") };
          })
          // The generator form: one inverse per completed step, so a body that
          // throws between steps recovers exactly what it did.
          .effect("beta", async function* (fromAlpha) {
            for (const step of ["beta1", "beta2"]) {
              entries.push(step);
              yield () => entries.push(`~${step}`);
            }
            return fromAlpha + "b";
          })
          .effect("verdict", async () => {
            if (resource.failFirstInit !== false && instanceId === 1) {
              throw new Error("first init fails on purpose");
            }
            return { result: undefined, inverse: () => {} };
          });
      },
      run() {
        entries.push("run");
        return ctx
          .effect("gamma", async () => ({
            result: undefined,
            inverse: () => entries.push("~gamma"),
          }))
          // A hold is an effect too: released by the unwind at teardown, which is
          // what lets this service-shaped resource have no teardown() at all.
          .effect("hold", async () => ({
            result: undefined,
            inverse: ctx.acquireHold("flaky fixture"),
          }));
      },
      snapshot() {
        return { attempts: initAttempts };
      },
    };
  },
};

export const journal = {
  schema: { type: "object", additionalProperties: true },
  async create() {
    return {
      async provide() {
        return { entries: [...entries] };
      },
      snapshot() {
        return {};
      },
    };
  },
};
