export const task = {
  async create() {
    return {
      async run() {
        (globalThis.__effectiveKindChainRuns ??= []).push("Task");
      },
    };
  },
};
