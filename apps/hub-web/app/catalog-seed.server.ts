import type { CatalogSeed } from "@/Catalog";
import type { HubReader } from "@/hub-reader.server";

/** What a catalogue route reads before it renders: the two facets and the first
 *  page of the listing, side by side. Each part is `null` when the hub did not
 *  answer it; `absent` is the hub saying no module declares the category. */
export async function readCatalogSeed(
  hub: HubReader,
  scope: { category: string; publisher: string },
): Promise<{ seed: CatalogSeed; absent: boolean }> {
  const [categories, publishers, listing] = await Promise.all([
    hub.readCategories(),
    hub.readPublishers(),
    hub.readListing(scope),
  ]);
  for (const read of [categories, publishers, listing]) {
    if (read.kind === "unavailable") {
      console.error(`hub unavailable (${read.reason}) while seeding the catalogue: ${read.detail}`);
    }
  }
  return {
    absent: listing.kind === "absent",
    seed: {
      facets: categories.kind === "found" ? categories.categories : null,
      publishers: publishers.kind === "found" ? publishers.publishers : null,
      page: listing.kind === "found" ? { ...listing.page, categoryDropped: false } : null,
    },
  };
}
