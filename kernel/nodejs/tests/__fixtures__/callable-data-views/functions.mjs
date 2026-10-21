// `Read` returns the configuration it was handed for `source`, read when it is
// called — after Phase-5 injection has run over its own declaration.
export const Read = {
  create(resource) {
    return { call: () => resource.source };
  },
};
export const Label = { create: () => ({}) };
