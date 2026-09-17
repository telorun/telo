// A callable's instance: one synchronous `call`, and neither `invoke` nor
// `run` — which is exactly what a step dispatching it finds missing.
export const sign = {
  async create() {
    return {
      call: ({ message }) => `signed:${message}`,
    };
  },
};
