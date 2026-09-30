import type { ModulePage } from "@/api";

/** How long the hub may stay silent — before its response headers, and between
 *  two body chunks — before the read is abandoned as unavailable. */
const SILENCE_MS = 10_000;

export type Unavailable = {
  kind: "unavailable";
  reason: "refused" | "silent" | "status" | "unreadable";
  detail: string;
};

export type ModuleRead = { kind: "found"; page: ModulePage } | { kind: "absent" } | Unavailable;

export interface CatalogueEntry {
  ref: string;
  latestVersion: string;
  seq: number;
}

export interface CataloguePage {
  modules: CatalogueEntry[];
  next: number | null;
}

export type CatalogueRead = { kind: "found"; page: CataloguePage } | Unavailable;

export interface HubReader {
  /** `GET /module`: everything a module page renders, in one call — keyed by
   *  ref rather than ranked, able to address a non-latest version, and carrying
   *  the full kind list. */
  readModule(ref: string, version: string): Promise<ModuleRead>;
  /** `GET /modules`: one page of the catalogue, ascending by `seq`. */
  readCatalogue(after: number, limit: number): Promise<CatalogueRead>;
}

type Fetched = {
  kind: "response";
  status: number;
  /** The parsed JSON body, or why it could not be read. */
  body: () => Promise<unknown | Unavailable>;
  /** Drop a body the caller has no use for (a 404, an unexpected status). */
  cancel: () => Promise<void>;
};

function unavailable(reason: Unavailable["reason"], detail: string): Unavailable {
  return { kind: "unavailable", reason, detail };
}

function isUnavailable(value: unknown): value is Unavailable {
  return (
    typeof value === "object" && value !== null && (value as Unavailable).kind === "unavailable"
  );
}

/** One GET whose every wait — the headers, then each body chunk — is bounded by
 *  `SILENCE_MS`. The body is read only when the caller asks for it. */
async function get(url: URL): Promise<Fetched | Unavailable> {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), SILENCE_MS);
  const target = `${url.origin}${url.pathname}`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      return unavailable("silent", `${target}: no response headers within ${SILENCE_MS} ms`);
    }
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return unavailable(
      "refused",
      `${target}: ${cause?.code ?? cause?.message ?? (err as Error).message}`,
    );
  }

  const body = async (): Promise<unknown | Unavailable> => {
    const chunks: Uint8Array[] = [];
    try {
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          clearTimeout(timer);
          timer = setTimeout(() => controller.abort(), SILENCE_MS);
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        return unavailable("silent", `${target}: body stalled for ${SILENCE_MS} ms`);
      }
      return unavailable("unreadable", `${target}: body read failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (err) {
      return unavailable("unreadable", `${target}: body is not JSON: ${(err as Error).message}`);
    }
  };

  const cancel = async (): Promise<void> => {
    clearTimeout(timer);
    await res.body?.cancel();
  };

  return { kind: "response", status: res.status, body, cancel };
}

function unexpectedStatus(url: URL, status: number): Unavailable {
  return unavailable("status", `${url.origin}${url.pathname}: answered ${status}`);
}

/** The page cannot render without the ref and version: everything else has a
 *  sensible empty rendering, but a missing ref or version would produce a
 *  broken import snippet and a version picker that navigates nowhere. */
function modulePage(url: URL, data: unknown): ModulePage | Unavailable {
  const page = (typeof data === "object" && data !== null ? data : {}) as Partial<ModulePage>;
  const module = page.module;
  if (typeof module?.ref !== "string" || typeof module?.version !== "string") {
    return unavailable("unreadable", `${url.origin}${url.pathname}: no module ref and version`);
  }
  return {
    module,
    kinds: Array.isArray(page.kinds) ? page.kinds : [],
    exportedResources: Array.isArray(page.exportedResources) ? page.exportedResources : [],
    versions: Array.isArray(page.versions)
      ? page.versions.filter((v): v is string => typeof v === "string")
      : [],
  };
}

function cataloguePage(url: URL, data: unknown): CataloguePage | Unavailable {
  const page = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const { modules, next } = page;
  const wellFormed =
    Array.isArray(modules) &&
    modules.every(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        typeof (m as CatalogueEntry).ref === "string" &&
        typeof (m as CatalogueEntry).latestVersion === "string" &&
        Number.isSafeInteger((m as CatalogueEntry).seq),
    ) &&
    (next === null || Number.isSafeInteger(next));
  if (!wellFormed) {
    return unavailable("unreadable", `${url.origin}${url.pathname}: not a catalogue page`);
  }
  return { modules: modules as CatalogueEntry[], next: next as number | null };
}

export function createHubReader(origin: string): HubReader {
  return {
    async readModule(ref, version) {
      const url = new URL("/module", origin);
      url.searchParams.set("ref", ref);
      if (version) url.searchParams.set("version", version);
      const fetched = await get(url);
      if (isUnavailable(fetched)) return fetched;
      if (fetched.status === 404) {
        await fetched.cancel();
        return { kind: "absent" };
      }
      if (fetched.status !== 200) {
        await fetched.cancel();
        return unexpectedStatus(url, fetched.status);
      }
      const data = await fetched.body();
      if (isUnavailable(data)) return data;
      const page = modulePage(url, data);
      return isUnavailable(page) ? page : { kind: "found", page };
    },

    async readCatalogue(after, limit) {
      const url = new URL("/modules", origin);
      url.searchParams.set("after", String(after));
      url.searchParams.set("limit", String(limit));
      const fetched = await get(url);
      if (isUnavailable(fetched)) return fetched;
      if (fetched.status !== 200) {
        await fetched.cancel();
        return unexpectedStatus(url, fetched.status);
      }
      const data = await fetched.body();
      if (isUnavailable(data)) return data;
      const page = cataloguePage(url, data);
      return isUnavailable(page) ? page : { kind: "found", page };
    },
  };
}

/** Logs why the hub could not be read and gives the bare 503 a route throws;
 *  the detail stays in the server log, never in the response. */
export function unavailableResponse(read: Unavailable, during: string): Response {
  console.error(`hub unavailable (${read.reason}) while ${during}: ${read.detail}`);
  return new Response(null, { status: 503 });
}
