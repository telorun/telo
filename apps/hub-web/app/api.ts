/** The browser's hub client: every call the page makes from the reader's
 *  browser, against the origin the server hands it (`HUB_BROWSER_API_ORIGIN`).
 *  The module page's own read is the server's, in the hub reader. */

export type RegisterResult =
  | { ok: true; ref: string }
  | { ok: false; error: string };

/** POST a module ref to the hub's open /register verb. The hub validates the ref
 *  resolves to a real Telo module and, on success, records it and schedules the
 *  indexing — so a 202 means ACCEPTED, not searchable. A bad ref comes back as a
 *  400 with an inline reason. Poll {@link registrationStatus} for the rest. */
export async function registerModule(origin: string, ref: string): Promise<RegisterResult> {
  let res: Response;
  try {
    res = await fetch(`${origin}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref }),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }

  const data: unknown = await res.json().catch(() => ({}));
  if (res.ok && isRegistered(data)) {
    return { ok: true, ref: data.ref };
  }
  return { ok: false, error: errorMessage(data, res.status) };
}

/** How far a registration has got.
 *
 *  `pending` — recorded, nothing of it indexed yet. `ingesting` — some versions
 *  are in, more are arriving. `ready` — searchable. `failed` — the last attempt
 *  recorded an error; `nextAttemptAt` is empty when the hub has given up and an
 *  operator has to intervene. `unknown` — the hub answered, and has no such
 *  module.
 *
 *  `unavailable` is NOT one of those: it means the hub could not be reached or
 *  did not answer, which is a fact about the connection rather than about the
 *  module. Folding it into `unknown` told a user their module was never
 *  registered every time the hub restarted, and the poll could not tell the two
 *  apart. */
export type RegistrationState =
  | "unavailable"
  | "unknown"
  | "pending"
  | "ingesting"
  | "ready"
  | "failed";

export interface RegistrationStatus {
  ref: string;
  status: RegistrationState;
  latestVersion: string;
  versionsKnown: number;
  versionsIngested: number;
  error: string;
  nextAttemptAt: string;
}

/** The states the HUB reports. `unavailable` is this client's own and is never
 *  read off a response. */
const REPORTED_STATES: readonly RegistrationState[] = [
  "unknown",
  "pending",
  "ingesting",
  "ready",
  "failed",
];

/** A response field is whatever the wire carried, so each is read with its own
 *  type check rather than spread in wholesale: `versionsIngested` arriving as a
 *  string and reaching an `${x} of ${y}` render is the bug a spread produces. */
const asText = (v: unknown): string => (typeof v === "string" ? v : "");
const asCount = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Read a registration's progress.
 *
 *  A hub that cannot be reached, or answers with something this cannot read, is
 *  `unavailable` — never a claim about the module. A 404 IS the hub answering,
 *  and its body carries `status: unknown` like every other reply, so it is read
 *  the same way. */
export async function registrationStatus(
  origin: string,
  ref: string,
): Promise<RegistrationStatus> {
  const unavailable: RegistrationStatus = {
    ref,
    status: "unavailable",
    latestVersion: "",
    versionsKnown: 0,
    versionsIngested: 0,
    error: "",
    nextAttemptAt: "",
  };
  try {
    const res = await fetch(`${origin}/register/status?ref=${encodeURIComponent(ref)}`);
    const data: unknown = await res.json().catch(() => null);
    if (typeof data !== "object" || data === null) return unavailable;
    const d = data as Record<string, unknown>;
    const status = REPORTED_STATES.find((s) => s === d.status);
    if (!status) return unavailable;
    return {
      ref,
      status,
      latestVersion: asText(d.latestVersion),
      versionsKnown: asCount(d.versionsKnown),
      versionsIngested: asCount(d.versionsIngested),
      error: asText(d.error),
      nextAttemptAt: asText(d.nextAttemptAt),
    };
  } catch {
    return unavailable;
  }
}

/** One facet value. `label` is what the module's author wrote; `slug` is what
 *  the hub derived from it and what filtering and URLs use. */
export interface Category {
  slug: string;
  label: string;
}

/** Which kernels can load something, and what its controllers are written in.
 *
 *  Telo is polyglot, so this is a capability of the thing rather than trivia:
 *  a kind whose only controller is JavaScript cannot run on the Rust kernel.
 *  `portable` means it declares no controllers at all and therefore has no
 *  kernel constraint — recorded as a flag rather than by listing today's
 *  kernels, which would go stale the day a third one ships.
 *
 *  On a module, `runtimes` is every kernel with at least partial reach and
 *  `full` the subset covering every kind, so `console` reads as Node (full),
 *  Rust (partial). A kind carries no `full` — it either runs or it does not. */
export interface RuntimeSupport {
  runtimes: string[];
  full?: string[];
  languages: string[];
  portable: boolean;
}

/** A module's replacement is another module, addressed as an import source. */
export interface ModuleDeprecation {
  reason: string;
  replacedBy: string;
}

/** A kind's replacement is another kind, resolved by the hub through the
 *  declaring manifest's imports — so it is a target that can be linked. An
 *  empty `ref` with a non-empty `kind` names a kernel built-in. */
export interface KindDeprecation {
  reason: string;
  replacedBy: { kind: string; ref: string };
}

export interface ModuleRef {
  ref: string;
  version: string;
  /** The module's declared `metadata.name` — what its author calls it, and what
   *  the kind registry and diagnostics print. Display identity only: it is not a
   *  locator (the `ref` is) and it is not unique across the federation, which is
   *  why the ref is always shown alongside it. Absent from a hub that predates
   *  this field, hence the ref-tail fallback at every call site. */
  name?: string;
  description: string;
  /** Declared categories. Absent from a hub that predates the facet. */
  categories?: Category[];
  /** The fields below are absent from a hub that predates them — this app
   *  deploys independently of the backend, so every one is optional. */
  repository?: string;
  license?: string;
  homepage?: string;
  publisher?: string;
  /** When the hub first tracked this version (RFC 3339, UTC) — the hub's own
   *  observation, not a publish date. */
  trackedAt?: string;
  deprecated?: ModuleDeprecation;
  runtime?: RuntimeSupport;
}

/** One kind a module exports. `KindInfo` on the module page and `MatchedKind` in
 *  a search hit are the same thing seen from two angles — a match adds a
 *  relevance score, which is the only reason the two lists stay separate. */
export interface KindInfo {
  kind: string;
  /** The module that owns the kind — this module's own ref, or the import a
   *  re-exported kind comes from. With `kind` it keys `/instances`. */
  ref?: string;
  /** Declared by another module and passed through this one's `exports.kinds`. */
  reexported?: boolean;
  capability: string;
  abstract?: boolean;
  description: string;
  extends?: { kind: string; ref: string };
  runtime?: RuntimeSupport;
  deprecated?: KindDeprecation;
  /** How many ready-made instances of this kind modules export. */
  instances?: number;
}

/** One matched search entry: a kind to declare (`entry: "kind"`) or a
 *  ready-made instance to reference (`entry: "instance"`), ranked together.
 *  `name` is what an importer writes after its alias; `kind` is the kind the
 *  entry is or instantiates, owned by `kindRef`. */
export interface MatchedKind extends KindInfo {
  entry?: "kind" | "instance";
  name?: string;
  kindRef?: string;
  score: number;
}

/** A ready-made singleton instance a library exports, referenced by an importer
 *  as `!ref <Alias>.<name>`.
 *
 *  `kind` and `description` come from the declaring doc in the exporting module,
 *  so both are empty for a re-export — that doc belongs to another module
 *  entirely. `declared` is the verbatim entry, which is what tells the two
 *  apart (`Other.thing` vs `thing`). */
export interface ExportedResource {
  name: string;
  kind: string;
  description: string;
  declared: string;
}

/** One module-first search hit. The export lists come from the index, so a
 *  result card shows the module's whole public surface with no second fetch.
 *  That surface is two lists: `exportedKinds` (kinds an importer may
 *  instantiate) and `exportedResources` (ready-made singleton instances
 *  referenced as `!ref <Alias>.<name>`) — a library may offer either or both. */
export interface ModuleHit {
  module: ModuleRef;
  score: number;
  matchedKinds: MatchedKind[];
  /** Full detail for every exported kind, not just the matched ones — which is
   *  what lets the preview panel describe any of them without a second request. */
  exportedKinds: KindInfo[];
  exportedResources: ExportedResource[];
  /** Other modules whose every match is an instance of the same kind as this
   *  hit's (language model packs), ranked below it and folded into it. */
  siblings?: ModuleSibling[];
  /** Modules implementing any of this module's kinds. */
  implementations?: { ref: string; name: string }[];
  /** An application's declared contract; absent or `null` for a library. */
  application?: ApplicationContract | null;
}

/** One input an application asks for. `arg` is how the command line supplies
 *  it, `env` the environment variable; a secret has neither `arg` nor
 *  `default`, and only a port has a `protocol`. */
export interface ApplicationInput {
  name: string;
  description?: string;
  required?: boolean;
  env?: string;
  default?: unknown;
  arg?: { form: "flag"; flag: string; short?: string } | { form: "position"; position: number } | null;
  protocol?: string;
}

/** What an application declares it needs to run. */
export interface ApplicationContract {
  variables: ApplicationInput[];
  secrets: ApplicationInput[];
  ports: ApplicationInput[];
}

export interface ModuleSibling {
  ref: string;
  version: string;
  name: string;
  description: string;
  score: number;
  matchedKinds: MatchedKind[];
}

export type SearchResult =
  | {
      ok: true;
      hits: ModuleHit[];
      total: number;
      hidden: HiddenMatches;
      categoryFilterDropped: boolean;
    }
  | { ok: false; error: string };

/** Page size for the module list. The hub caps `limit` at 100 and reports the
 *  pre-limit `total`, which is what "load more" counts down against. */
export const PAGE_SIZE = 30;

/** The kernels the hub's `runtime` filter knows. */
export type RuntimeFilter = "" | "nodejs" | "rust";

/** Which modules a listing holds. Every module is one or the other: a library
 *  is imported for the kinds and instances it exports, an application is run. */
export type ModuleType = "all" | "library" | "application";

/** The hub's `entry` parameter for a type. A library is found by its kinds and
 *  instances, which is the hub's own default and so needs no parameter. */
export function entryQuery(type: ModuleType): URLSearchParams {
  const params = new URLSearchParams();
  const entries =
    type === "all" ? ["kind", "instance", "application"] : type === "application" ? ["application"] : [];
  for (const entry of entries) params.append("entry", entry);
  return params;
}

/** The type a request actually asks the hub for. The hub does not index which
 *  kernels an application runs on and refuses `runtime` beside one, so a
 *  runtime narrows "all" to libraries. */
export function requestedType(request: Pick<SearchRequest, "type" | "runtime">): ModuleType {
  return request.runtime && request.type === "all" ? "library" : request.type;
}

/** The orders the hub's `sort` parameter knows. */
export type SortOrder = "relevance" | "name" | "recent";

/** What one catalogue request asks the hub for. */
export interface SearchRequest {
  query: string;
  /** A category slug, or empty for every category. */
  category: string;
  /** A publisher as `module.publisher` reports it, or empty for all of them. */
  publisher: string;
  sort: SortOrder;
  runtime: RuntimeFilter;
  type: ModuleType;
  /** Deprecated modules are left out unless this is set. */
  showDeprecated: boolean;
  /** Leaves out modules exporting only contracts. */
  hideContractOnly: boolean;
  offset: number;
}

/** The matches the hub left out of a listing, by the filter that hid them. */
export interface HiddenMatches {
  deprecated: number;
  contractOnly: number;
}

/** What a response says it left out. A hub that predates the two filters says
 *  nothing, and hid nothing. */
export function hiddenMatches(data: unknown): HiddenMatches {
  const hidden = (data as { hidden?: { deprecated?: unknown; contractOnly?: unknown } } | null)?.hidden;
  return {
    deprecated: typeof hidden?.deprecated === "number" ? hidden.deprecated : 0,
    contractOnly: typeof hidden?.contractOnly === "number" ? hidden.contractOnly : 0,
  };
}

/** The `/search/modules` query for a request. The runtime is left out of an
 *  application request, which the hub would refuse. */
export function searchQuery(request: SearchRequest): URLSearchParams {
  const params = new URLSearchParams({ q: request.query, limit: String(PAGE_SIZE) });
  if (request.offset > 0) params.set("offset", String(request.offset));
  if (request.category) params.set("category", request.category);
  if (request.publisher) params.set("publisher", request.publisher);
  if (request.sort !== "relevance") params.set("sort", request.sort);
  if (!request.showDeprecated) params.set("deprecated", "exclude");
  if (request.hideContractOnly) params.set("contractOnly", "exclude");
  const type = requestedType(request);
  for (const entry of entryQuery(type).getAll("entry")) params.append("entry", entry);
  if (request.runtime && type !== "application") params.set("runtime", request.runtime);
  return params;
}

/** Why a response cannot be shown as the answer to `request`, or `null`.
 *
 *  A hub that predates the `publisher` and `sort` parameters accepts them and
 *  ignores them, answering with every publisher in its own order. The hub
 *  echoes each one it applied, so an answer without the echo is the unfiltered
 *  catalogue — and showing it under a publisher's name would be wrong rows
 *  presented as right ones. The same holds for the contract-only filter, which
 *  a reader chose. Leaving deprecated modules out is the default and not a
 *  choice, so a hub that ignores it is shown as it answered: the listing then
 *  includes them, each marked deprecated. */
export function unappliedFilter(request: SearchRequest, data: unknown): string | null {
  const echo = (typeof data === "object" && data !== null ? data : {}) as {
    publisher?: unknown;
    sort?: unknown;
    contractOnly?: unknown;
  };
  if (request.publisher && echo.publisher !== request.publisher) {
    return "this hub cannot filter by publisher yet";
  }
  if (request.sort !== "relevance" && echo.sort !== request.sort) {
    return "this hub cannot sort its results yet";
  }
  if (request.hideContractOnly && echo.contractOnly !== "exclude") {
    return "this hub cannot hide contract-only modules yet";
  }
  return null;
}

/** Module-first search over the hub's federated index. Browsing is the same
 *  call with an empty query: the hub degrades to an unranked listing, which a
 *  category, a runtime and an offset narrow and page. */
export async function searchModules(
  origin: string,
  request: SearchRequest,
  signal?: AbortSignal,
): Promise<SearchResult> {
  let res: Response;
  try {
    res = await fetch(`${origin}/search/modules?${searchQuery(request)}`, {
      headers: { accept: "application/json" },
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }

  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: errorMessage(data, res.status) };
  const unapplied = unappliedFilter(request, data);
  if (unapplied) return { ok: false, error: unapplied };
  const hits = (data as { hits?: unknown }).hits;
  if (!Array.isArray(hits)) return { ok: false, error: "unexpected response from the hub" };
  const total = (data as { total?: unknown }).total;
  return {
    ok: true,
    hits: hits as ModuleHit[],
    total: typeof total === "number" ? total : hits.length,
    hidden: hiddenMatches(data),
    categoryFilterDropped: (data as { categoryFilterDropped?: unknown }).categoryFilterDropped === true,
  };
}

/** One entry of the category facet: the slug to filter by, the label to print,
 *  and how many modules and kinds are in it. Several authored labels can
 *  normalize to one slug, in which case the hub picks the most-declared one. */
export interface CategoryFacet {
  category: string;
  label: string;
  modules: number;
  kinds?: number;
}

/** The categories that exist, derived by the hub from what modules declare —
 *  there is no fixed vocabulary to hardcode here. A failure yields an empty
 *  list: the filter is an optional narrowing, so search still works without it. */
export async function fetchCategories(
  origin: string,
  type: ModuleType,
  signal?: AbortSignal,
): Promise<CategoryFacet[]> {
  const res = await fetch(`${origin}/categories?${entryQuery(type)}`, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) return [];
  const data: unknown = await res.json().catch(() => ({}));
  const categories = (data as { categories?: unknown }).categories;
  return Array.isArray(categories) ? (categories as CategoryFacet[]) : [];
}

/** One entry of the publisher facet: a host and org modules are published
 *  under, and how many modules it holds. */
export interface PublisherFacet {
  publisher: string;
  modules: number;
}

/** The publishers that exist. Empty on any failure — including a hub that
 *  predates the facet — since, like the categories, it is an optional narrowing. */
export async function fetchPublishers(
  origin: string,
  type: ModuleType,
  signal?: AbortSignal,
): Promise<PublisherFacet[]> {
  const res = await fetch(`${origin}/publishers?${entryQuery(type)}`, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) return [];
  const data: unknown = await res.json().catch(() => ({}));
  const publishers = (data as { publishers?: unknown }).publishers;
  return Array.isArray(publishers) ? (publishers as PublisherFacet[]) : [];
}

/** One registered ref the typeahead offers. */
export interface RefSuggestion {
  ref: string;
  latestVersion: string;
  description: string;
}

/** Fuzzy completion of a ref whose name the reader half-remembers. Lexical
 *  only — the hub embeds nothing for it — so it is cheap enough per keystroke. */
export async function fetchRefSuggestions(
  origin: string,
  query: string,
  signal?: AbortSignal,
): Promise<RefSuggestion[]> {
  const res = await fetch(`${origin}/refs?${new URLSearchParams({ q: query })}`, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) return [];
  const data: unknown = await res.json().catch(() => ({}));
  const refs = (data as { refs?: unknown }).refs;
  return Array.isArray(refs) ? (refs as RefSuggestion[]) : [];
}

/** One kind implementing a contract, in whichever module declares it. */
export interface Implementation {
  ref: string;
  version: string;
  kind: string;
  capability: string;
  description: string;
}

type Listed<K extends string, T> = ({ ok: true } & Record<K, T[]>) | { ok: false; error: string };

/** One keyed list read: a hub route answering `{ <member>: [...] }`. */
async function fetchList<K extends string, T>(
  url: string,
  member: K,
  signal?: AbortSignal,
): Promise<Listed<K, T>> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: errorMessage(data, res.status) };
  const list = (data as Record<string, unknown>)[member];
  if (!Array.isArray(list)) return { ok: false, error: "unexpected response from the hub" };
  return { ok: true, [member]: list as T[] } as Listed<K, T>;
}

/** Every kind extending a contract, across module boundaries. */
export function fetchImplementations(origin: string, ref: string, kind: string, signal?: AbortSignal) {
  return fetchList<"implementations", Implementation>(
    `${origin}/implementations?${new URLSearchParams({ ref, kind })}`,
    "implementations",
    signal,
  );
}

/** One module importing another, at the importer's latest version. */
export interface Dependent {
  ref: string;
  version: string;
  name: string;
  description: string;
  application?: boolean;
}

/** The modules importing a given module, a page at a time from `offset`. */
export function fetchDependents(origin: string, ref: string, offset: number, signal?: AbortSignal) {
  return fetchList<"dependents", Dependent>(
    `${origin}/dependents?${new URLSearchParams({ ref, offset: String(offset) })}`,
    "dependents",
    signal,
  );
}

/** The cached `telo.yaml` of one version, as its author wrote it. */
export async function fetchManifestText(
  origin: string,
  ref: string,
  version: string,
  signal?: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${origin}/module/manifest?${new URLSearchParams({ ref, version })}`, { signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }
  if (!res.ok) return { ok: false, error: `request failed (${res.status})` };
  return { ok: true, text: await res.text() };
}

/** A tracked version with the pin an `imports:` entry writes after `#`. */
export interface VersionPin {
  version: string;
  integrity: string;
}

/** A module's tracked versions, newest first, each with its import pin. */
export function fetchVersionPins(origin: string, ref: string, signal?: AbortSignal) {
  return fetchList<"versions", VersionPin>(
    `${origin}/module/versions?${new URLSearchParams({ ref })}`,
    "versions",
    signal,
  );
}

export interface ModuleInfo extends ModuleRef {
  latestVersion: string;
  name: string;
  transport: string;
  /** The import pin for this version, or empty when nothing can hash the ref. */
  integrity: string;
}

export interface ModulePage {
  module: ModuleInfo;
  kinds: KindInfo[];
  exportedResources: ExportedResource[];
  versions: string[];
  /** An application's declared contract; `null` for a library. */
  application?: ApplicationContract | null;
  /** What this version imports. Absent from a hub that predates the field. */
  imports?: ModuleImport[];
  /** How many other modules import this one at their latest version. */
  dependents?: number;
}

/** One `imports:` entry: the alias the module chose, the imported ref, and the
 *  version its pin names (empty for an unpinned source). */
export interface ModuleImport {
  alias: string;
  ref: string;
  version: string;
}

/** One ready-made instance of a kind, exported by some module — a language
 *  model pack, say, which the hub lists under the kind it instantiates rather
 *  than as a search result of its own. */
export interface KindInstance {
  name: string;
  description: string;
  module: { ref: string; version: string; name: string; description: string };
}

/** Every ready-made instance of a kind, across module boundaries. */
export function fetchInstances(origin: string, ref: string, kind: string, signal?: AbortSignal) {
  return fetchList<"instances", KindInstance>(
    `${origin}/instances?${new URLSearchParams({ ref, kind })}`,
    "instances",
    signal,
  );
}

function isRegistered(data: unknown): data is { registered: true; ref: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { registered?: unknown }).registered === true &&
    typeof (data as { ref?: unknown }).ref === "string"
  );
}

function errorMessage(data: unknown, status: number): string {
  if (typeof data === "object" && data !== null) {
    const { error, message } = data as { error?: unknown; message?: unknown };
    if (typeof error === "string" && error) return error;
    if (typeof message === "string" && message) return message;
  }
  return `request failed (${status})`;
}
