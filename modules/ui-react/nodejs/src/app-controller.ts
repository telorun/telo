import type { RequestScope } from "@telorun/http-dispatch";
import {
  canonicalTypeSchemaId,
  formatMessage,
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

/** The keyed texts as the browser receives them: per set, each key's message
 *  in one language, and the set the renderer's own texts are drawn from. */
interface KeyedTexts {
  own: string;
  sets: Record<string, Record<string, Translated>>;
}

/** What is the same for every request landing on one language: built once per
 *  negotiated tag, so there are at most as many as the application serves. */
interface InLanguage {
  translator: SpecTranslator<Translated>;
  shell: string;
  title: Translated;
  pageTitles: Translated[];
  texts: KeyedTexts;
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
  /** The headers the shell, the application document and each page read. */
  vary: { app: HeaderReads; pages: HeaderReads[] };
  /** By negotiated tag. */
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
        scope.get("/_telo/ui/app", (request, reply) => this.serveApp(started, requestScope, request, reply));
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
        scope.setNotFoundHandler((request, reply) => this.serveShell(started, mount, requestScope, request, reply));
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
    // The server varies by the language itself; these are the other headers read.
    const vary = {
      app: unionReads(
        headerReads(this.tokenEntries().map((entry) => entry.when)),
        ...HEADER_SIDES.map((side) => header?.[side].headerReads ?? new Set<string>()),
        headerReads(navigation.items),
      ),
      pages: this.pages.map(({ instance }) => unionReads(instance.headerReads())),
    };
    return {
      mount,
      store,
      bundle,
      rendererUrl: urlOf(modules[RENDERER]),
      importMap,
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

  private requestOf(request: FastifyRequest, requestScope: RequestScope<FastifyRequest> | undefined): Record<string, unknown> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      headers[name] = Array.isArray(value) ? value.join(", ") : (value ?? "");
    }
    // Not enumerable: reading the language is what makes the response vary by it.
    return Object.defineProperty({ headers, ip: request.ip }, "lang", {
      get: () => this.languageOf(request, requestScope),
      enumerable: false,
      configurable: true,
    });
  }

  /** The language the server negotiated for the request; reading it records that the response depends on it. */
  private languageOf(request: FastifyRequest, requestScope: RequestScope<FastifyRequest> | undefined): string {
    return requestScope === undefined ? this.ctx.translations.fallback : requestScope.forRequest(request).lang;
  }

  /** What every request in one language shares, built once for it. */
  private inLanguage(started: Started, tag: string): InLanguage {
    const held = started.languages.get(tag);
    if (held) return held;
    const parsed = (record: TextRecord): Translated => {
      const read = readMessage(record.text);
      if (!read.ok) {
        throw new RuntimeError(
          "ERR_MESSAGE_SYNTAX_INVALID",
          `${this.owner}: a text it shows is no message: ${read.problems.map((problem) => problem.message).join("; ")}.`,
        );
      }
      return { message: read.message, lang: record.lang };
    };
    const translate = (record: TextRecord): Translated => parsed(this.ctx.translations.translate(tag, record));
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
      texts: this.keyedTexts(tag, parsed),
      shell: shellHtml({
        title: formatMessage(title.message, title.lang, {}),
        ...(tag === "und" ? {} : { lang: tag }),
        prefix: started.mount,
        bundle: started.bundle,
        rendererUrl: started.rendererUrl,
        importMap: started.importMap,
      }),
      translate,
    };
    started.languages.set(tag, made);
    return made;
  }

  /**
   * Every keyed set the App's kind names in `x-telo-text-keys`, layered, in
   * `tag`; the first it names is the one the renderer's own texts are drawn
   * from, so no set is named here or in the renderer.
   */
  private keyedTexts(tag: string, parsed: (record: TextRecord) => Translated): KeyedTexts {
    const keyed = this.ctx.translations.keyed();
    const [own] = Object.keys(keyed);
    if (own === undefined) {
      throw new RuntimeError(
        "ERR_TEXT_KEYS_INVALID",
        `${this.owner}: its kind names no keyed set in 'x-telo-text-keys', so the renderer has no texts of its own to draw. Name the set of the vocabulary it draws first.`,
      );
    }
    const sets: KeyedTexts["sets"] = {};
    for (const [set, byLanguage] of Object.entries(keyed)) {
      const messages = byLanguage[tag];
      if (messages === undefined) {
        throw new RuntimeError("ERR_FATAL", `${this.owner}: the keyed set '${set}' holds no messages in '${tag}', a language the application serves.`);
      }
      sets[set] = Object.fromEntries(Object.entries(messages).map(([key, record]) => [key, parsed(record)]));
    }
    return { own, sets };
  }

  private send(request: FastifyRequest, reply: FastifyReply, document: Record<string, unknown>, reads: HeaderReads) {
    const served = servedDocument(document);
    this.addVary(reply, reads);
    reply.header("cache-control", "private, no-cache").header("etag", `"${served.digest}"`);
    if (holdsCurrent(request.headers["if-none-match"], served.digest)) return reply.code(304).send();
    return reply.type("application/json; charset=utf-8").send(served.text);
  }

  /** Adds the headers an expression read to the `Vary` the server may already have set for the language. */
  private addVary(reply: FastifyReply, reads: HeaderReads): void {
    const own = varyHeader(reads);
    if (own === undefined) return;
    const held = reply.getHeader("vary");
    const existing = (Array.isArray(held) ? held.join(",") : String(held ?? "")).split(",").map((token) => token.trim()).filter(Boolean);
    const tokens = new Map<string, string>();
    for (const token of [...existing, ...own.split(", ")]) tokens.set(token.toLowerCase(), token);
    reply.header("vary", tokens.has("*") ? "*" : [...tokens.values()].join(", "));
  }

  private serveApp(started: Started, requestScope: RequestScope<FastifyRequest> | undefined, request: FastifyRequest, reply: FastifyReply) {
    const scope = { request: this.requestOf(request, requestScope) };
    const chosen = this.tokenEntries().find(
      (entry) => entry.when === undefined || this.ctx.expandValue(entry.when, scope) === true,
    );
    const tokens = chosen === undefined ? [] : [started.tokens.get(chosen.tokens) as string];
    const tag = this.languageOf(request, requestScope);
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
        ...(tag === "und" ? {} : { lang: tag }),
        pages: this.pages.map(({ reading }, index) => ({ path: reading.path, title: language.pageTitles[index] })),
        navigation: { items: translatedEntries(items), placement: started.navigation.placement },
        header,
        texts: language.texts,
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
    const scope = { request: this.requestOf(request, requestScope) };
    const pageWidth = this.resource.pageWidth ?? undefined;
    const delivered = await page.instance.invoke(
      { request: scope.request as { headers: Record<string, string>; ip?: string }, ...(pageWidth === undefined ? {} : { pageWidth }) },
      requestScope?.forRequest(request).context,
    );
    const tag = this.languageOf(request, requestScope);
    const language = this.inLanguage(started, tag);
    return this.send(
      request,
      reply,
      {
        specVersion: SPEC_VERSION,
        bundle: started.bundle,
        path: delivered.path,
        title: language.pageTitles[index],
        ...(tag === "und" ? {} : { lang: tag }),
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

  private serveShell(started: Started, mount: string, requestScope: RequestScope<FastifyRequest> | undefined, request: FastifyRequest, reply: FastifyReply) {
    const pathname = new URL(request.url, "http://telo.invalid").pathname;
    const path = pathname.slice(mount.length) || "/";
    if (path === "/_telo" || path.startsWith("/_telo/")) {
      return notFound(reply);
    }
    const declared = this.pages.some(({ reading }) => reading.path === path);
    const language = this.inLanguage(started, this.languageOf(request, requestScope));
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
