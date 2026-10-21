// Answers a slider over the property, or why it cannot rate it.
export const Rating = {
  async create(resource) {
    return {
      async invoke({ model }) {
        const property = model.properties?.[resource.property];
        if (!property) return { property: resource.property, problems: [] };
        const bounded = ["number", "integer"].includes(property.type) && property.minimum !== undefined && property.maximum !== undefined;
        if (!bounded) {
          return {
            property: resource.property,
            problems: [{ code: "STARS_RATING_UNBOUNDED", message: `rates a property that is not a number declaring 'minimum' and 'maximum' ('${resource.property}').` }],
          };
        }
        // A label read off the model is a text record of its words, of no
        // language in particular: the renderer looks it up as written.
        const words = (property.title ?? resource.property).replace(/[\\{}]/g, (character) => `\\${character}`);
        return {
          property: resource.property,
          problems: [],
          spec: {
            type: "input",
            property: resource.property,
            label: { text: words, context: null, lang: "und", computed: false },
            description: null,
            labels: [],
            control: "slider",
          },
        };
      },
    };
  },
};
