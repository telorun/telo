// Answers with the captions as its controller received them.
export const Caption = {
  async create(resource) {
    return { invoke: () => ({ label: resource.label, computedLabel: resource.computedLabel }) };
  },
};
