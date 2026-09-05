// One journal per module scope — the controllers of a fixture module are one
// bundle, so every `node` writes it and `journal` reads it. Module scope is also
// what lets the journal outlive the teardown it is recording.
const entries = [];

/**
 * A resource whose whole allocation is one line in the journal.
 *
 * `holds:` is a `use: dependency` ref, so the kernel has an init-order edge from
 * this node to the one it names: the target must be initialized first, and must
 * therefore still be alive when this node's inverse runs.
 */
export const node = {
  schema: { type: "object", additionalProperties: true },
  async create(resource, ctx) {
    const label = resource.label;
    return {
      init() {
        return ctx.effect(`node ${label}`, async () => {
          entries.push(label);
          return { result: undefined, inverse: () => entries.push(`~${label}`) };
        });
      },
      snapshot() {
        return { label };
      },
    };
  },
};

/** Same recording as `node`, with its references nested inside an array. */
export const group = {
  schema: { type: "object", additionalProperties: true },
  async create(resource, ctx) {
    const label = resource.label;
    return {
      init() {
        return ctx.effect(`group ${label}`, async () => {
          entries.push(label);
          return { result: undefined, inverse: () => entries.push(`~${label}`) };
        });
      },
      snapshot() {
        return { label };
      },
    };
  },
};

/** A boot target. `run()` records separately from `init()`, so a rebuild that
 *  re-initializes and never re-runs is visible in the journal. */
export const task = {
  schema: { type: "object", additionalProperties: true },
  async create(resource, ctx) {
    const label = resource.label;
    return {
      init() {
        return ctx.effect(`task ${label}`, async () => {
          entries.push(label);
          return { result: undefined, inverse: () => entries.push(`~${label}`) };
        });
      },
      run() {
        entries.push(`run:${label}`);
      },
      snapshot() {
        return { label };
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
