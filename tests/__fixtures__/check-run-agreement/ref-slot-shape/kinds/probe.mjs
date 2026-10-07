// Each probe reports, per node of a tree, whether Phase 5 handed the node's
// target over as the live instance, and what that instance returns when
// invoked. One that did not arrive live is resolved through `ctx.resolveRef`,
// which refuses a name that resolves to nothing.
const isInvocable = (candidate) => typeof candidate?.invoke === "function";

const probeTree = async (node, ctx, out = []) => {
  if (node.target !== undefined) {
    const injected = isInvocable(node.target);
    const target = injected
      ? node.target
      : ctx.resolveRef(node.target, isInvocable, () => `'target' of '${node.label}'`, "Telo.Invocable");
    out.push({ label: node.label, injected, result: await target.invoke({}) });
  }
  for (const child of node.children ?? []) await probeTree(child, ctx, out);
  return out;
};

export const Tree = {
  async create(resource, ctx) {
    return { invoke: () => probeTree(resource.tree, ctx) };
  },
};

// Evaluates the tree against the call's inputs before probing it.
export const RuntimeTree = {
  async create(resource, ctx) {
    return { invoke: (inputs) => probeTree(ctx.expandValue(resource.tree, { inputs }), ctx) };
  },
};

// Evaluates the tree against a request of its own making — no call's inputs,
// and no `invoke()` — and reports what it found as observed state.
export const RegionTree = {
  async create(resource, ctx) {
    return {
      async run() {
        const request = { prefix: resource.prefix };
        await ctx.setStatus({
          nodes: await probeTree(ctx.expandValue(resource.tree, { request }), ctx),
          handler: isInvocable(resource.handler) ? await resource.handler.invoke({}) : null,
        });
      },
      snapshot() {
        return { prefix: resource.prefix };
      },
    };
  },
};

// The same over a list of trees.
export const RegionForest = {
  async create(resource, ctx) {
    return {
      async run() {
        const nodes = [];
        for (const tree of ctx.expandValue(resource.trees, { request: { prefix: "" } })) {
          await probeTree(tree, ctx, nodes);
        }
        await ctx.setStatus({ nodes });
      },
    };
  },
};

export const Held = {
  async create(resource) {
    return { provide: async () => ({ label: resource.tree.label }) };
  },
};
