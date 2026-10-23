// A leaf provider, and a tree holder reporting what each reference slot of its
// tree holds once the kernel has injected it.
export const Leaf = {
  async create(resource) {
    return { provide: async () => ({ leaf: resource.metadata.name }) };
  },
};

const held = (node) =>
  node.type === "ref"
    ? { type: "ref", live: typeof node.ref?.provide === "function" }
    : { type: node.type, children: node.children.map(held) };

export const Tree = {
  async create(resource) {
    return { provide: async () => resource.children.map(held) };
  },
};
