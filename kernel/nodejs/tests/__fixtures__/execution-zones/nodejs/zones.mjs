// Controllers for the execution-zone fixture. Between them they exercise every
// half of the contract: opening a zone from an annotated slot, requiring one
// from an annotated field, reading the ambient stack, and the three clearing
// paths (detached dispatch, a Service's run(), an explicit root context).
//
// Note what none of them writes: a kind name, a module name, or an alias. The
// zone kind and the correlation key both come from the annotation.

/** Where each probe's observation lands, so a test reads results directly. */
const observations = [];

export const reporter = {
  schema: { type: "object", additionalProperties: true },
  async create() {
    return {
      async init() {},
      async provide() {
        return { observations: [...observations] };
      },
      snapshot() {
        return {};
      },
    };
  },
};

export const session = {
  schema: { type: "object", additionalProperties: true },
  async create(resource) {
    return {
      async init() {},
      async provide() {
        return { label: resource.label ?? "" };
      },
      snapshot() {
        return { label: resource.label ?? "" };
      },
    };
  },
};

/** Correlated provider: names its OWN slot; the kernel derives the zone kind
 *  (this kind) and the correlation key (`/session`) from the annotation. */
export const batch = {
  schema: { type: "object", additionalProperties: true },
  async create(resource, ctx) {
    return {
      async init() {},
      async invoke(inputs) {
        return ctx.withZone("steps", async (zoneCtx, entry) => {
          // A provider with private state keys its own map on `entry` — here we
          // just prove the entry the caller sees is the entry we minted.
          observations.push({ kind: "provider-entry", zone: entry.kind, provider: entry.provider.ref.name, key: entry.key?.ref.name });
          return ctx.invokeResolved("", "steps", resource.steps, inputs ?? {}, zoneCtx);
        });
      },
      snapshot() {
        return {};
      },
    };
  },
};

/** Uncorrelated provider (`x-telo-provides-zone: true`) — no correlation
 *  payload, so any requirer of this kind is satisfied by kind alone. */
export const ambient = {
  schema: { type: "object", additionalProperties: true },
  async create(resource, ctx) {
    return {
      async init() {},
      async invoke(inputs) {
        return ctx.withZone("steps", async (zoneCtx, entry) => {
          observations.push({ kind: "ambient-entry", zone: entry.kind, key: entry.key?.ref.name ?? null });
          return ctx.invokeResolved("", "steps", resource.steps, inputs ?? {}, zoneCtx);
        });
      },
      snapshot() {
        return {};
      },
    };
  },
};

/** Requirer: names its OWN field. Throws ERR_ZONE_REQUIRED when no matching
 *  zone is open — including one open on a different session. */
export const enqueue = {
  schema: { type: "object", additionalProperties: true },
  async create(resource, ctx) {
    return {
      async init() {},
      async invoke(inputs, invokeCtx) {
        const zone = ctx.requireZone("batch", invokeCtx);
        return { zone: zone.kind, correlatedOn: zone.key?.ref.name ?? null };
      },
      snapshot() {
        return {};
      },
    };
  },
};

/** Reports the ambient stack it observes. */
export const probe = {
  schema: { type: "object", additionalProperties: true },
  async create(resource, ctx) {
    return {
      async init() {},
      async invoke(inputs, invokeCtx) {
        const seen = ((invokeCtx ?? {}).zones ?? []).map((z) => z.kind);
        // What each open zone DECLARES about its contents, read off the
        // declaring kind's schema rather than off the entry — which stays three
        // identities so it remains ABI-serializable.
        const attributes = ctx.zoneAttributes(invokeCtx).map((z) => ({
          kind: z.kind,
          attributes: z.attributes,
        }));
        observations.push({
          kind: "probe",
          label: inputs?.label ?? "",
          zones: seen,
          attributes,
        });
        return { zones: seen };
      },
      snapshot() {
        return {};
      },
    };
  },
};

/** Detached dispatch: `runDetached` swaps the ambient for the uncancellable
 *  root, so the target sheds every zone with no zone-specific code. */
export const detacher = {
  schema: { type: "object", additionalProperties: true },
  async create(resource, ctx) {
    return {
      async init() {},
      async invoke(inputs) {
        let settle;
        const done = new Promise((resolve) => {
          settle = resolve;
        });
        ctx.runDetached(async () => {
          try {
            await ctx.invokeResolved("", "invoke", resource.invoke, inputs ?? {});
          } finally {
            settle();
          }
        });
        await done;
        return {};
      },
      snapshot() {
        return {};
      },
    };
  },
};

/** A Service. Its `run()` gets no ambient scope from the kernel, so work it
 *  triggers starts zone-free — and it dispatches through `rootContext()`, the
 *  conformance obligation for an inbound registrant. */
export const starter = {
  schema: { type: "object", additionalProperties: true },
  async create(resource, ctx) {
    return {
      async init() {},
      async run() {
        await ctx.invokeResolved("", "invoke", resource.invoke, { label: "from-service" }, ctx.rootContext());
      },
      snapshot() {
        return {};
      },
    };
  },
};
