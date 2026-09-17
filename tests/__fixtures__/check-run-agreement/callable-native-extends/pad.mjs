// Surrounds a text with the configured fill.
export const Pad = {
  create(resource) {
    return { call: ({ text }) => `${resource.fill}${text}${resource.fill}` };
  },
};
