import { type HubReader, unavailableResponse } from "@/hub-reader.server";
import { modulePagePath } from "@/module-ref";

/** A shard holds the modules whose `seq` is in (SHARD_SIZE·k, SHARD_SIZE·(k+1)] —
 *  the sitemap protocol's per-file URL limit. */
export const SHARD_SIZE = 50_000;

/** The hub's `/modules` page limit. */
const PAGE_LIMIT = 1000;

const XML_HEAD = `<?xml version="1.0" encoding="UTF-8"?>\n`;
const NS = `xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"`;

const XML_HEADERS = {
  "Content-Type": "application/xml; charset=utf-8",
  "Cache-Control": "no-cache",
};

function escapeXml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!,
  );
}

function loc(url: string): string {
  return `<loc>${escapeXml(url)}</loc>`;
}

/** The sitemap index: one entry per non-empty shard. Each probe asks for the
 *  first module past the previous shard, and its `seq` names the next non-empty
 *  shard directly, so sparse ranges cost nothing. */
export async function sitemapIndex(hub: HubReader, siteOrigin: string): Promise<Response> {
  const entries: string[] = [];
  let after = 0;
  for (;;) {
    const read = await hub.readCatalogue(after, 1);
    if (read.kind === "unavailable") throw unavailableResponse(read, "building the sitemap index");
    const first = read.page.modules[0];
    if (!first) break;
    const shard = Math.floor((first.seq - 1) / SHARD_SIZE);
    entries.push(`<sitemap>${loc(`${siteOrigin}/sitemaps/modules-${shard}.xml`)}</sitemap>`);
    after = (shard + 1) * SHARD_SIZE;
  }
  return new Response(`${XML_HEAD}<sitemapindex ${NS}>\n${entries.join("\n")}\n</sitemapindex>\n`, {
    headers: XML_HEADERS,
  });
}

/** One shard, streamed page by page from `/modules`. The first page is read
 *  before the response starts, so a hub that is down is a 503. A page failing
 *  after that errors the body stream, which ends the connection without
 *  `</urlset>` — a truncated sitemap must never parse as a complete one. */
export async function sitemapShard(
  hub: HubReader,
  siteOrigin: string,
  shard: number,
): Promise<Response> {
  const lower = shard * SHARD_SIZE;
  const upper = lower + SHARD_SIZE;
  const limitAfter = (after: number) => Math.min(PAGE_LIMIT, upper - after);

  const first = await hub.readCatalogue(lower, limitAfter(lower));
  if (first.kind === "unavailable") {
    throw unavailableResponse(first, `reading sitemap shard ${shard}`);
  }
  const firstPage = first.page;

  async function* chunks(): AsyncGenerator<string> {
    yield `${XML_HEAD}<urlset ${NS}>\n`;
    let page = firstPage;
    for (;;) {
      let beyond = false;
      let urls = "";
      for (const module of page.modules) {
        if (module.seq > upper) {
          beyond = true;
          break;
        }
        const pagePath = modulePagePath(module.ref);
        if (pagePath !== null) urls += `<url>${loc(`${siteOrigin}${pagePath}`)}</url>\n`;
      }
      if (urls) yield urls;
      if (beyond || page.next === null || page.next >= upper) break;
      const read = await hub.readCatalogue(page.next, limitAfter(page.next));
      if (read.kind === "unavailable") {
        throw new Error(
          `sitemap shard ${shard} aborted mid-stream: hub unavailable (${read.reason}): ${read.detail}`,
        );
      }
      page = read.page;
    }
    yield `</urlset>\n`;
  }

  const encoder = new TextEncoder();
  const source = chunks();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await source.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      await source.return(undefined);
    },
  });
  return new Response(body, { headers: XML_HEADERS });
}
