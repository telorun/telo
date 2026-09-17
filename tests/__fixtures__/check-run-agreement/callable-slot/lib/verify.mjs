// An invocable holding functions through slots constrained to callable
// abstracts, calling each by the names its abstract declares and returning what
// the signer makes of its inputs.
export const Verify = {
  async create(resource) {
    return {
      invoke: async ({ key, message }) => {
        const signed = resource.signer.call({ key, message });
        if (resource.nonced) resource.nonced.call({ key, message });
        return signed;
      },
    };
  },
};
