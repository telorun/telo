// A callable reporting which instance of it answered: instances created from this
// file are numbered in creation order, so two imports calling it can tell whether
// they were bound to one instance or two.
let created = 0;

export const Ordinal = {
  async create() {
    created += 1;
    const ordinal = created;
    return { call: () => ordinal };
  },
};
