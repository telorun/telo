// `Peek` reads the configuration it was handed for `target`, by a dotted path.
export const Peek = {
  create(resource) {
    const target = resource.target;
    return {
      call: ({ path }) =>
        JSON.stringify({
          frozen: Object.isFrozen(target),
          at: path.split(".").reduce((value, key) => value?.[key], target),
        }),
    };
  },
};
// `Ask` calls each function it holds with one path, in order.
export const Ask = {
  create(resource) {
    return {
      invoke: () => ({ answers: resource.functions.map((fn) => fn.call({ path: resource.path })) }),
    };
  },
};
export const Inert = { create: () => ({}) };
export const Late = { create: () => ({ invoke: () => ({}) }) };
