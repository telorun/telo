export const Read = {
  create(resource) {
    return { call: () => resource.source };
  },
};
export const Label = { create: () => ({}) };
export const Respond = { create: () => ({ invoke: () => ({}) }) };
