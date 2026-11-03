// Answers the keyed texts the kernel hands a resource of its kind.
export const shownTexts = {
  async create(resource, ctx) {
    return {
      async invoke() {
        return ctx.translations.keyed();
      },
    };
  },
};
