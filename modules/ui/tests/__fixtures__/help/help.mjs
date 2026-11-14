import { deliveredNavigation, preparedNavigation } from "@telorun/ui";

const words = (text) => ({ text, context: null, lang: "und", computed: false });

// A heading over a column, the tree prepared and delivered as `ui`'s own
// navigation panes do, its glyphs' files published as its reading.
export const Links = {
  async create(resource, ctx) {
    const navigation = await preparedNavigation(resource.navigation, ctx, `Help.Links '${resource.metadata.name}'`);
    return {
      async invoke({ request }) {
        const items = deliveredNavigation(ctx.expandValue(navigation.items, { request: request ?? null }));
        return {
          node: {
            type: "stack",
            fill: false,
            children: [
              { type: "text", text: resource.heading, style: "subheading", fill: false },
              { type: "navigation-column", navigation: { items }, state: null, fill: false },
            ],
          },
        };
      },
      snapshot: () => ({ assets: navigation.assets }),
    };
  },
};

// Says how many times it was invoked, and whether it was handed a request.
export const Counter = {
  async create() {
    let invoked = 0;
    return {
      async invoke({ request }) {
        invoked += 1;
        return { node: { type: "text", text: words(`invoked ${invoked}${request ? " for a request" : ""}`), fill: false } };
      },
    };
  },
};
