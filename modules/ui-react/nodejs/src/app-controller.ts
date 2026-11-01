import type { RequestScope } from "@telorun/http-dispatch";
import { catalogSetOf, type CatalogSet } from "@telorun/i18n";
import {
  canonicalTypeSchemaId,
  formatMessage,
  lookupLanguage,
  readMessage,
  RuntimeError,
  type Message,
  type ResourceContext,
  type RuntimeResource,
  type TextRecord,
} from "@telorun/sdk";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { basename } from "node:path";
import {
  deliveredNavigation,
  isPage,
  isWords,
  preparedNavigation,
  resolvedPageWidth,
  RequestNodes,
  SpecTranslator,
  type NavigationConfig,
  type NavigationEntrySpec,
  type PageInstance,
  type PageReading,
  type PageWidth,
  type PreparedNavigation,
  type Words,
} from "@telorun/ui";
import abi from "./contract/abi.json" with { type: "json" };
import layoutsContract from "./contract/layouts.json" with { type: "json" };
import { AssetStore, entryAssets, type AssetRef } from "./asset-store.js";
import { CONTROL_MECHANICS, mechanicsFileName } from "./browser/controls/mechanics.js";
import { HostedNodes, type SpecNode } from "./component-abi.js";
import { holdsCurrent, servedDocument, SPEC_VERSION } from "./documents.js";
import { EventStreams } from "./event-streams.js";
import { headerReads, unionReads, varyHeader, type HeaderReads } from "./header-reads.js";
import { servedIconFormat } from "./icon-file.js";
import { shellHtml } from "./shell.js";
import type { ProvidedTheme } from "./theme-controller.js";
import { tokensStylesheet, type ProvidedTokens } from "./tokens-stylesheet.js";

type TokensEntry = { tokens: unknown; when?: unknown };

/** The nodes of the application's own in its header, by side, and how wide its content is drawn. */
interface HeaderConfig {
  start?: unknown;
  end?: unknown;
  width?: PageWidth | null;
}

const HEADER_SIDES = ["start", "end"] as const;
type HeaderSide = (typeof HEADER_SIDES)[number];

/** Nothing served here: the bare problem of a 404, as the server answers one. */
function notFound(reply: FastifyReply) {
  return reply
    .code(404)
    .type("application/problem+json; charset=utf-8")
    .send(JSON.stringify({ type: "about:blank", title: "Not Found", status: 404 }));
}

export type AppResource = RuntimeResource & {
  title: TextRecord;
  /** A fixed tag, or an expression read per request. */
  lang?: unknown;
  translator?: unknown;
  words: unknown;
  theme: unknown;
  tokens?: unknown;
  stylesheets?: string[];
  compactBelow?: string;
  /** Left to each page to fill when omitted. */
  pageWidth?: PageWidth | null;
  header?: HeaderConfig | null;
  /** Each a `Ui.Page`. */
  pages: unknown[];
  navigation?: NavigationConfig | null;
};

/** A listed page, with what it publishes. */
interface ListedPage {
  instance: PageInstance;
  reading: PageReading;
}

interface Providing<T> {
  provide(): Promise<T>;
}

const isObject = (candidate: unknown): candidate is object => typeof candidate === "object" && candidate !== null;

const provides = <T>(candidate: unknown): candidate is Providing<T> =>
  typeof (candidate as Providing<T> | null)?.provide === "function";

/** What a component may leave to the page: the ABI's supplied specifiers. */
const SUPPLIED: string[] = abi.specifiers;
/** The renderer imports the root API too, so the import map carries it. */
const MAPPED = [...SUPPLIED, "react-dom/client"];
/** The renderer's entry. Internal: the shell loads it by URL. */
const RENDERER = "@telorun/ui-react-renderer";
const HOST = "@telorun/ui-react";

const IMMUTABLE = "public, max-age=31536000, immutable";

/** A text as the browser receives it: the chosen Message, parsed, and the
 *  language it is written in. */
interface Translated {
  message: Message;
  lang: string;
}

/** What is the same for every request landing on one language: built once per
 *  effective tag, so there are at most as many as the catalog languages, plus one. */
interface InLanguage {
  translator: SpecTranslator<Translated>;
  shell: string;
  title: Translated;
  pageTitles: Translated[];
  words: Record<string, Translated>;
  /** Translates a text the application document carries. */
  translate(record: TextRecord): Translated;
}

/** Everything resolved once, when the application is mounted. */
interface Started {
  /** Mount prefix, with no trailing slash; empty at the root. */
  mount: string;
  store: AssetStore;
  bundle: string;
  rendererUrl: string;
  importMap: Record<string, string>;
  /** The translator's catalogs, when the application names one. */
  catalogs?: CatalogSet;
  /** The language the application's own module writes in, when it declares one. */
  sourceLang?: string;
  words: Words;
  /** The headers the shell, the application document and each page read. */
  vary: { shell: HeaderReads; app: HeaderReads; pages: HeaderReads[] };
  /** By effective tag; `""` for none. */
  languages: Map<string, InLanguage>;
  /** The header's nodes by side, prepared once; nothing when the application
   *  declares no header. */
  header?: Record<HeaderSide, RequestNodes>;
  /** The navigation, every default filled; its entries delivered per request. */
  navigation: PreparedNavigation;
  /** Components this renderer cannot host, replaced as they are delivered. */
  hosted: HostedNodes;
  /** The stylesheet of each of the application's token sets, by instance. */
  tokens: Map<unknown, string>;
  /** Stylesheets every request gets, before and after its token set's. */
  leading: string[];
  trailing: string[];
  /** What the application document says of the controls: each built-in's
   *  mechanics stylesheet by control, and the sets replacing built-ins. */
  controls: { stylesheets: Record<string, string>; sets: { module: string; exports: string[] }[] };
}

/** A mount path with one leading slash and no trailing one; `""` at the root. */
function mountPrefix(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, "");
  return trimmed === "" || trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export class UiReactApp {
  private readonly owner: string;
  private readonly streams: EventStreams;
  private readonly pages: ListedPage[];

  constructor(
    private readonly resource: AppResource,
    private readonly ctx: ResourceContext,
  ) {
    this.owner = `UiReact.App '${resource.metadata.name}'`;
    this.streams = new EventStreams(this.owner, ctx);
    this.pages = resource.pages.map((page, index) => {
      const instance = ctx.resolveRef(page, isPage, () => `'pages[${index}]' of ${this.owner}`, "Ui.Page");
      return { instance, reading: instance.snapshot() };
    });
    const seen = new Set<string>();
    for (const [index, { reading }] of this.pages.entries()) {
      if (seen.has(reading.path)) {
        throw new RuntimeError(
          "ERR_UI_PAGE_PATH_DUPLICATE",
          `${this.owner}: 'pages[${index}]' declares a path another page already has ('${reading.path}'). Give each page a path of its own.`,
        );
      }
      seen.add(reading.path);
    }
    this.refuseUnroutedEntries(resource.navigation?.items ?? [], "navigation.items");
  }

  /** Every entry naming a page, at any depth, names one `pages` lists. */
  private refuseUnroutedEntries(entries: NavigationConfig["items"], at: string): void {
    for (const [index, entry] of (entries ?? []).entries()) {
      const where = `${at}[${index}]`;
      if (entry.type === "group") this.refuseUnroutedEntries(entry.items, `${where}.items`);
      if (entry.type !== "page") continue;
      const page = this.ctx.resolveRef(entry.page, isPage, () => `'${where}.page' of ${this.owner}`, "Ui.Page");
      if (this.pages.some(({ instance }) => instance === page)) continue;
      throw new RuntimeError(
        "ERR_UI_NAVIGATION_PAGE_UNROUTED",
        `${this.owner}: '${where}' names a page the application does not list in its pages ('${page.snapshot().path}'), so it leads nowhere. Add the page to pages, or remove the entry.`,
      );
    }
  }

  /** Mount contract. Everything lives in one encapsulated scope under the
   *  prefix, so the routes and the not-found handler that answers with the
   *  shell are this mount's alone; the scope loads before the server listens,
   *  which is when the application's composites, themes and files are resolved. */
  register(app: FastifyInstance, prefix = "", requestScope?: RequestScope<FastifyRequest>): void {
    const mount = mountPrefix(prefix);
    app.register(
      async (scope) => {
        const started = await this.start(mount);
        // A server stops by waiting for its connections, and an event stream
        // never ends on its own.
        scope.addHook("preClose", () => this.streams.closeAll());
        scope.get("/_telo/ui/app", (request, reply) => this.serveApp(started, request, reply));
        scope.get("/_telo/ui/page", (request, reply) => this.servePage(started, requestScope, request, reply));
        scope.get("/_telo/ui/events", async (request, reply) => {
          reply.hijack();
          try {
            await this.streams.start(reply.raw, started.bundle);
          } catch (error) {
            // The reply is no longer the server's to answer: nothing else ends it.
            reply.raw.destroy();
            this.ctx.log.error("An event stream could not be started", {
              owner: this.owner,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        });
        scope.get("/_telo/ui/assets/:digest/*", (request, reply) => this.serveAsset(started, request, reply));
        scope.setNotFoundHandler((request, reply) => this.serveShell(started, mount, request, reply));
      },
      { prefix: mount === "" ? "/" : mount },
    );
  }

  private async start(mount: string): Promise<Started> {
    const store = new AssetStore();
    const urlOf = (ref: AssetRef) => `${mount}/_telo/ui/assets/${ref.digest}/${ref.name}`;

    const modules: Record<string, AssetRef> = {};
    const stylesheets: Record<string, AssetRef[]> = {};
    let hostAbi: string | undefined;
    for (const specifier of [...MAPPED, RENDERER]) {
      const entry = await this.ctx.resolveControllerBrowserEntry(specifier);
      const { module, assets } = entryAssets(entry);
      for (const asset of assets) await store.hold(asset);
      modules[specifier] = module;
      stylesheets[specifier] = assets.filter((asset) => asset.mediaType === "text/css");
      if (specifier === HOST) hostAbi = entry.abi;
    }
    for (const { instance } of this.pages) {
      for (const asset of instance.assets()) await store.hold(asset);
    }
    const declaredHeader = this.resource.header ?? undefined;
    let header: Record<HeaderSide, RequestNodes> | undefined;
    if (declaredHeader !== undefined) {
      header = {} as Record<HeaderSide, RequestNodes>;
      for (const side of HEADER_SIDES) {
        const nodes = await RequestNodes.prepare(declaredHeader[side] ?? [], {}, this.ctx, `${this.owner} header.${side}`);
        for (const asset of nodes.assets) await store.hold(asset);
        header[side] = nodes;
      }
    }
    // Each icon's file served as it is, by its digest, and drawn as a mask.
    const navigation = await preparedNavigation(
      this.resource.navigation,
      this.pages.map(({ instance }) => instance),
      this.ctx,
      this.owner,
      async ({ file }, where) => {
        const bytes = await store.bytesOf(file);
        const format = servedIconFormat(bytes, file, this.owner, where);
        const slug = basename(file).replace(/\.[^.]*$/, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        const name = `${slug || "icon"}.${format.extension}`;
        return urlOf(store.addBytes(name, format.mediaType, bytes));
      },
    );
    const hosted = new HostedNodes(
      { abis: hostAbi === undefined ? [] : [hostAbi], layoutAbis: [layoutsContract.generation], specifiers: SUPPLIED },
      (error) =>
        this.ctx.log.error("A component cannot be hosted and is shown as an error", {
          code: error.code,
          message: error.message,
        }),
    );

    const serveFont = (name: string, format: { mediaType: string }, bytes: Uint8Array) =>
      urlOf(store.addBytes(name, format.mediaType, Buffer.from(bytes)));
    const tokensSheet = (tokens: ProvidedTokens, name: string, owner: string) =>
      urlOf(store.addBytes(name, "text/css", Buffer.from(tokensStylesheet(tokens, owner, serveFont))));
    /** A stylesheet placed in a layer: served as it is, and named in the
     *  document by a stylesheet importing it into the layer. */
    const layered = (layer: string, ref: AssetRef) =>
      urlOf(store.addBytes(ref.name, "text/css", Buffer.from(`@import url(${JSON.stringify(urlOf(ref))}) layer(${layer});\n`)));

    const theme = await this.ctx
      .resolveRef(this.resource.theme, provides<ProvidedTheme>, () => `'theme' of ${this.owner}`, "UiReact.Theme")
      .provide();
    // Each control set the theme lists: its module and chunks served, its own
    // stylesheet in the control layer, and the built-in it replaces left unserved.
    const sets: Started["controls"]["sets"] = [];
    const setSheets: string[] = [];
    const replaced = new Set<string>();
    for (const set of theme.controls) {
      const { module, assets } = entryAssets(set.files);
      for (const asset of assets) await store.hold(asset);
      sets.push({ module: urlOf(module), exports: set.implements });
      for (const sheet of assets.filter((asset) => asset.mediaType === "text/css")) setSheets.push(layered("telo.control", sheet));
      for (const control of set.implements) replaced.add(control);
    }
    const themeSheets: string[] = [];
    if (theme.tokens !== undefined) themeSheets.push(tokensSheet(theme.tokens, "theme-tokens.css", theme.owner));
    for (const file of theme.stylesheets) {
      themeSheets.push(layered("telo.theme", store.addBytes(basename(file), "text/css", await store.bytesOf(file))));
    }

    const tokens = new Map<unknown, string>();
    for (const instance of this.tokenEntries().map((entry) => entry.tokens)) {
      if (tokens.has(instance)) continue;
      const provided = await this.ctx
        .resolveRef(instance, provides<ProvidedTokens>, () => `'tokens' of ${this.owner}`, "Ui.DesignTokens")
        .provide();
      tokens.set(instance, tokensSheet(provided, "tokens.css", this.owner));
    }

    const leading = [...stylesheets[RENDERER].map(urlOf), ...setSheets, ...themeSheets];
    const trailing: string[] = [];
    for (const file of this.resource.stylesheets ?? []) {
      trailing.push(urlOf(store.addBytes(basename(file), "text/css", await store.bytesOf(file))));
    }
    // Each built-in control's mechanics, served on its own and named per
    // control — except a control the theme's sets replace.
    const controlStylesheets: Record<string, string> = {};
    for (const [control, css] of Object.entries(CONTROL_MECHANICS)) {
      if (replaced.has(control)) continue;
      controlStylesheets[control] = urlOf(store.addBytes(mechanicsFileName(control), "text/css", Buffer.from(css as string)));
    }

    const bundle = modules[RENDERER].digest;
    const importMap: Record<string, string> = {};
    for (const specifier of MAPPED) importMap[specifier] = urlOf(modules[specifier]);
    Object.assign(importMap, store.sharedFileRemaps(urlOf));
    const words = await this.ctx
      .resolveRef(this.resource.words, isWords, () => `'words' of ${this.owner}`, "Ui.Words")
      .provide();
    const catalogs =
      this.resource.translator === undefined
        ? undefined
        : catalogSetOf(this.ctx.resolveRef(this.resource.translator, isObject, () => `'translator' of ${this.owner}`, "I18n.Translator"));
    // The application module's own language: the one its title is written in.
    const sourceLang = this.resource.title.lang === "und" ? undefined : this.resource.title.lang;
    const langReads = headerReads(this.resource.lang);
    const vary = {
      shell: langReads,
      app: unionReads(
        langReads,
        headerReads(this.tokenEntries().map((entry) => entry.when)),
        ...HEADER_SIDES.map((side) => header?.[side].headerReads ?? new Set<string>()),
        headerReads(navigation.items),
      ),
      pages: this.pages.map(({ instance }) => unionReads(langReads, instance.headerReads())),
    };
    return {
      mount,
      store,
      bundle,
      rendererUrl: urlOf(modules[RENDERER]),
      importMap,
      catalogs,
      sourceLang,
      words,
      vary,
      languages: new Map(),
      header,
      navigation,
      hosted,
      tokens,
      leading,
      trailing,
      controls: { stylesheets: controlStylesheets, sets },
    };
  }

  private tokenEntries(): TokensEntry[] {
    const tokens = this.resource.tokens;
    if (tokens === undefined) return [];
    return Array.isArray(tokens) ? (tokens as TokensEntry[]) : [{ tokens }];
  }

  private requestOf(request: FastifyRequest): Record<string, unknown> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      headers[name] = Array.isArray(value) ? value.join(", ") : (value ?? "");
    }
    return { headers, ip: request.ip };
  }

  /**
   * The language a request's documents are in: the catalog language its
   * requested tag lands on through the translator, else the language the
   * application's module writes in, else none.
   */
  private effectiveTag(started: Started, request: Record<string, unknown>): string | undefined {
    const declared = this.resource.lang;
    const requested = typeof declared === "string" ? declared : declared === undefined ? undefined : this.ctx.expandValue(declared, { request });
    if (typeof requested === "string" && started.catalogs) {
      const found = lookupLanguage(requested, started.catalogs.languages);
      if (found !== null) return found;
    }
    return started.sourceLang;
  }

  /** What every request in one language shares, built once for it. */
  private inLanguage(started: Started, tag: string | undefined): InLanguage {
    const key = tag ?? "";
    const held = started.languages.get(key);
    if (held) return held;
    const translate = (record: TextRecord): Translated => {
      const found = tag === undefined || !started.catalogs ? null : started.catalogs.lookup(record, tag);
      if (found) return { message: found.message, lang: found.lang };
      const read = readMessage(record.text);
      if (!read.ok) {
        throw new RuntimeError(
          "ERR_MESSAGE_SYNTAX_INVALID",
          `${this.owner}: a text it shows is no message: ${read.problems.map((problem) => problem.message).join("; ")}.`,
        );
      }
      return { message: read.message, lang: record.lang };
    };
    const translator = new SpecTranslator<Translated>(
      {
        root: this.ctx.lookupSchema(canonicalTypeSchemaId("Ui", "SpecNode")) as Record<string, any>,
        resolve: (id) => this.ctx.lookupSchema(id) as Record<string, any> | undefined,
      },
      translate,
    );
    const title = translate(this.resource.title);
    const made: InLanguage = {
      translator,
      title,
      pageTitles: this.pages.map(({ reading }) => translate(reading.title)),
      words: Object.fromEntries(Object.entries(started.words).map(([id, record]) => [id, translate(record)])),
      shell: shellHtml({
        title: formatMessage(title.message, title.lang, {}),
        ...(tag === undefined ? {} : { lang: tag }),
        prefix: started.mount,
        bundle: started.bundle,
        rendererUrl: started.rendererUrl,
        importMap: started.importMap,
      }),
      translate,
    };
    started.languages.set(key, made);
    return made;
  }

  private send(request: FastifyRequest, reply: FastifyReply, document: Record<string, unknown>, reads: HeaderReads) {
    const served = servedDocument(document);
    const vary = varyHeader(reads);
    if (vary !== undefined) reply.header("vary", vary);
    reply.header("cache-control", "private, no-cache").header("etag", `"${served.digest}"`);
    if (holdsCurrent(request.headers["if-none-match"], served.digest)) return reply.code(304).send();
    return reply.type("application/json; charset=utf-8").send(served.text);
  }

  private serveApp(started: Started, request: FastifyRequest, reply: FastifyReply) {
    const scope = { request: this.requestOf(request) };
    const chosen = this.tokenEntries().find(
      (entry) => entry.when === undefined || this.ctx.expandValue(entry.when, scope) === true,
    );
    const tokens = chosen === undefined ? [] : [started.tokens.get(chosen.tokens) as string];
    const tag = this.effectiveTag(started, scope.request);
    const language = this.inLanguage(started, tag);
    const header = {
      width: resolvedPageWidth(this.resource.header?.width, this.resource.pageWidth),
      ...Object.fromEntries(
        HEADER_SIDES.map((side) => [side, started.header ? this.shown(started, started.header[side].deliver(scope.request), language) : []]),
      ),
    };
    const translatedEntries = (entries: NavigationEntrySpec[]): unknown[] =>
      entries.map((entry) =>
        entry.type === "group"
          ? { ...entry, text: language.translate(entry.text), items: translatedEntries(entry.items) }
          : { ...entry, text: language.translate(entry.text) },
      );
    const items = deliveredNavigation(this.ctx.expandValue(started.navigation.items, scope));
    return this.send(
      request,
      reply,
      {
        specVersion: SPEC_VERSION,
        bundle: started.bundle,
        title: language.title,
        ...(tag === undefined ? {} : { lang: tag }),
        pages: this.pages.map(({ reading }, index) => ({ path: reading.path, title: language.pageTitles[index] })),
        navigation: { items: translatedEntries(items), placement: started.navigation.placement },
        header,
        words: language.words,
        stylesheets: [...started.leading, ...tokens, ...started.trailing],
        controls: started.controls,
        compactBelow: this.resource.compactBelow ?? "40rem",
      },
      started.vary.app,
    );
  }

  /** `requestScope` is the one of the server this request reached: one App may be mounted on several. */
  private async servePage(started: Started, requestScope: RequestScope<FastifyRequest> | undefined, request: FastifyRequest, reply: FastifyReply) {
    const path = (request.query as Record<string, unknown>).path;
    const index = this.pages.findIndex(({ reading }) => reading.path === path);
    const page = this.pages[index];
    if (!page) {
      return notFound(reply.header("cache-control", "private, no-cache"));
    }
    const scope = { request: this.requestOf(request) };
    const pageWidth = this.resource.pageWidth ?? undefined;
    const delivered = await page.instance.invoke(
      { request: scope.request as { headers: Record<string, string>; ip?: string }, ...(pageWidth === undefined ? {} : { pageWidth }) },
      requestScope?.forRequest(request).context,
    );
    const tag = this.effectiveTag(started, scope.request);
    const language = this.inLanguage(started, tag);
    return this.send(
      request,
      reply,
      {
        specVersion: SPEC_VERSION,
        bundle: started.bundle,
        path: delivered.path,
        title: language.pageTitles[index],
        ...(tag === undefined ? {} : { lang: tag }),
        query: delivered.query,
        width: delivered.width,
        children: this.shown(started, delivered.children, language),
      },
      started.vary.pages[index],
    );
  }

  /** Nodes as a request is sent them: every component this renderer cannot
   *  host replaced, every text translated. */
  private shown(started: Started, nodes: SpecNode[], language: InLanguage): SpecNode[] {
    return nodes.map((node) => language.translator.node(started.hosted.node(node)) as SpecNode);
  }

  private serveAsset(started: Started, request: FastifyRequest, reply: FastifyReply) {
    const params = request.params as { digest: string; "*": string };
    const asset = started.store.get(params.digest, params["*"]);
    if (!asset) {
      return notFound(reply);
    }
    reply.header("cache-control", IMMUTABLE).type(asset.mediaType);
    return reply.send(asset.body);
  }

  private serveShell(started: Started, mount: string, request: FastifyRequest, reply: FastifyReply) {
    const pathname = new URL(request.url, "http://telo.invalid").pathname;
    const path = pathname.slice(mount.length) || "/";
    if (path === "/_telo" || path.startsWith("/_telo/")) {
      return notFound(reply);
    }
    const declared = this.pages.some(({ reading }) => reading.path === path);
    const language = this.inLanguage(started, this.effectiveTag(started, this.requestOf(request)));
    const vary = varyHeader(started.vary.shell);
    if (vary !== undefined) reply.header("vary", vary);
    return reply
      .code(declared ? 200 : 404)
      .header("cache-control", "no-cache")
      .type("text/html; charset=utf-8")
      .send(language.shell);
  }
}

export async function create(resource: AppResource, ctx: ResourceContext): Promise<UiReactApp> {
  return new UiReactApp(resource, ctx);
}
