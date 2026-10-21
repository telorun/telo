import type { RequestScope } from "@telorun/http-dispatch";
import { catalogSetOf, type CatalogSet } from "@telorun/i18n";
import {
  canonicalTypeSchemaId,
  formatMessage,
  lookupLanguage,
  readMessage,
  RuntimeError,
  type DataValidator,
  type Message,
  type ResourceContext,
  type RuntimeResource,
  type TextRecord,
} from "@telorun/sdk";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { basename } from "node:path";
import { isWords, modelShape, presented, SpecTranslator, type AuthoredNode, type Words } from "@telorun/ui";
import abi from "./contract/abi.json" with { type: "json" };
import { AssetStore, entryAssets, type Asset, type AssetRef } from "./asset-store.js";
import { withUnhostedComponentsReplaced, type Hosted, type SpecNode } from "./component-abi.js";
import { DEFAULT_THEME_CSS } from "./default-theme.js";
import { holdsCurrent, servedDocument, SPEC_VERSION } from "./documents.js";
import { EventStreams } from "./event-streams.js";
import { headerReads, unionReads, varyHeader, type HeaderReads } from "./header-reads.js";
import { judgedComposite, producedNode, type EvaluatedNode } from "./page-nodes.js";
import { shellHtml } from "./shell.js";
import { themeStylesheet, type ProvidedTheme } from "./theme-stylesheet.js";

interface PageConfig {
  path: string;
  title: TextRecord;
  query?: Record<string, unknown> | null;
  children: unknown;
}

type ThemeEntry = { theme: unknown; when?: unknown };

export type AppResource = RuntimeResource & {
  title: TextRecord;
  /** A fixed tag, or an expression read per request. */
  lang?: unknown;
  translator?: unknown;
  words: unknown;
  theme?: unknown;
  defaultTheme?: boolean;
  stylesheets?: string[];
  compactBelow?: string;
  pages: PageConfig[];
};

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
  /** What each placed composite provided — `null` for nothing — in the order
   *  the pages place them. */
  composites: (SpecNode | null)[];
  /** Each page's children as written, every composite's `ref` replaced by its
   *  place in `composites`. */
  pages: unknown[];
  /** The stylesheet of each theme, by instance. */
  themes: Map<unknown, string>;
  /** Stylesheets every request gets, before and after its theme's. */
  leading: string[];
  trailing: string[];
  validator: DataValidator;
}

/**
 * A page's children with each composite's `ref`, and each list row action's
 * `action`, replaced by its index in `placed`, where the instance is appended.
 * A page's structure and references are literal — only leaf values are
 * evaluated per request — so the numbering made once holds for every request,
 * and no instance passes through evaluation.
 */
function withCompositesNumbered(node: unknown, placed: unknown[]): unknown {
  if (Array.isArray(node)) return node.map((child) => withCompositesNumbered(child, placed));
  if (node === null || typeof node !== "object") return node;
  const { type, ref, children, rowActions } = node as EvaluatedNode;
  if (type === "composite" && provides(ref)) return { ...node, ref: placed.push(ref) - 1 };
  if (Array.isArray(children)) return { ...node, children: withCompositesNumbered(children, placed) };
  if (type === "list" && Array.isArray(rowActions)) {
    return {
      ...node,
      rowActions: (rowActions as Record<string, unknown>[]).map((entry) =>
        provides(entry.action) ? { ...entry, action: placed.push(entry.action) - 1 } : entry,
      ),
    };
  }
  return node;
}

/** A mount path with one leading slash and no trailing one; `""` at the root. */
function mountPrefix(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, "");
  return trimmed === "" || trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export class UiReactApp {
  private readonly owner: string;
  private readonly streams: EventStreams;

  constructor(
    private readonly resource: AppResource,
    private readonly ctx: ResourceContext,
  ) {
    this.owner = `UiReact.App '${resource.metadata.name}'`;
    this.streams = new EventStreams(this.owner, ctx);
    const seen = new Set<string>();
    for (const [index, page] of resource.pages.entries()) {
      if (seen.has(page.path)) {
        throw new RuntimeError(
          "ERR_UI_PAGE_PATH_DUPLICATE",
          `${this.owner}: 'pages[${index}]' declares a path another page already has ('${page.path}'). Give each page a path of its own.`,
        );
      }
      seen.add(page.path);
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
        scope.get("/_telo/ui/page", (request, reply) => this.servePage(started, request, reply));
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
    const hosted: Hosted = { abis: hostAbi === undefined ? [] : [hostAbi], specifiers: SUPPLIED };

    const placed: unknown[] = [];
    const pages = this.resource.pages.map((page, index) =>
      withCompositesNumbered(this.presentedChildren(page, index), placed),
    );
    const validator = this.ctx.createTypeValidator(canonicalTypeSchemaId("Ui", "SpecNode"));
    const composites: (SpecNode | null)[] = [];
    for (const instance of placed) {
      const provided = await (instance as Providing<{ node?: SpecNode; assets: Asset[] }>).provide();
      for (const asset of provided.assets) await store.hold(asset);
      if (provided.node === undefined) {
        composites.push(null);
        continue;
      }
      const hostable = withUnhostedComponentsReplaced(provided.node, hosted, (error) =>
        this.ctx.log.error("A component cannot be hosted and is shown as an error", {
          code: error.code,
          message: error.message,
        }),
      );
      // Judged here, once: a request places it as it stands.
      composites.push(
        judgedComposite(hostable, validator, (invalid, reason) =>
          this.ctx.log.error("A composite provides a node that is not valid and is shown as an error", {
            code: "ERR_UI_NODE_INVALID",
            type: String(invalid.type),
            reason,
          }),
        ),
      );
    }

    const themes = new Map<unknown, string>();
    for (const instance of this.themeEntries().map((entry) => entry.theme)) {
      if (themes.has(instance)) continue;
      const theme = await this.ctx
        .resolveRef(instance, provides<ProvidedTheme>, () => `'theme' of ${this.owner}`, "Ui.Theme")
        .provide();
      const css = themeStylesheet(theme, this.owner, (name, format, bytes) =>
        urlOf(store.addBytes(name, format.mediaType, Buffer.from(bytes))),
      );
      themes.set(instance, urlOf(store.addBytes("theme.css", "text/css", Buffer.from(css))));
    }

    const leading = stylesheets[RENDERER].map(urlOf);
    if (this.resource.defaultTheme !== false) {
      leading.push(urlOf(store.addBytes("default-theme.css", "text/css", Buffer.from(DEFAULT_THEME_CSS))));
    }
    const trailing: string[] = [];
    for (const file of this.resource.stylesheets ?? []) {
      trailing.push(urlOf(store.addBytes(basename(file), "text/css", await store.bytesOf(file))));
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
      app: unionReads(langReads, headerReads(this.themeEntries().map((entry) => entry.when))),
      pages: pages.map((page) => unionReads(langReads, headerReads(page))),
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
      composites,
      pages,
      themes,
      leading,
      trailing,
      validator,
    };
  }

  /** A page's children with what its declared query parameters say about the
   *  values its `value` and `list` nodes name; the page's only browser root. */
  private presentedChildren(page: PageConfig, index: number): unknown {
    const where = `${this.owner} pages[${index}]`;
    const reader = { ctx: this.ctx, owner: where };
    const query = modelShape({ type: "object", properties: page.query ?? {}, additionalProperties: false }, reader, "query");
    return (page.children as AuthoredNode[]).map((child, at) =>
      presented(child, { query }, reader, `${where}.children[${at}]`),
    );
  }

  private themeEntries(): ThemeEntry[] {
    const theme = this.resource.theme;
    if (theme === undefined) return [];
    return Array.isArray(theme) ? (theme as ThemeEntry[]) : [{ theme }];
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
      pageTitles: this.resource.pages.map((page) => translate(page.title)),
      words: Object.fromEntries(Object.entries(started.words).map(([id, record]) => [id, translate(record)])),
      shell: shellHtml({
        title: formatMessage(title.message, title.lang, {}),
        ...(tag === undefined ? {} : { lang: tag }),
        prefix: started.mount,
        bundle: started.bundle,
        rendererUrl: started.rendererUrl,
        importMap: started.importMap,
      }),
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
    const chosen = this.themeEntries().find(
      (entry) => entry.when === undefined || this.ctx.expandValue(entry.when, scope) === true,
    );
    const theme = chosen === undefined ? [] : [started.themes.get(chosen.theme) as string];
    const tag = this.effectiveTag(started, scope.request);
    const language = this.inLanguage(started, tag);
    return this.send(
      request,
      reply,
      {
        specVersion: SPEC_VERSION,
        bundle: started.bundle,
        title: language.title,
        ...(tag === undefined ? {} : { lang: tag }),
        pages: this.resource.pages.map(({ path }, index) => ({ path, title: language.pageTitles[index] })),
        words: language.words,
        stylesheets: [...started.leading, ...theme, ...started.trailing],
        compactBelow: this.resource.compactBelow ?? "40rem",
      },
      started.vary.app,
    );
  }

  private servePage(started: Started, request: FastifyRequest, reply: FastifyReply) {
    const path = (request.query as Record<string, unknown>).path;
    const index = this.resource.pages.findIndex((candidate) => candidate.path === path);
    const page = this.resource.pages[index];
    if (!page) {
      return reply
        .code(404)
        .header("cache-control", "private, no-cache")
        .send({ error: "NotFound", message: `This application declares no page at '${String(path)}'.`, status: 404 });
    }
    const scope = { request: this.requestOf(request) };
    const evaluated = this.ctx.expandValue(started.pages[index], scope) as EvaluatedNode[];
    const tag = this.effectiveTag(started, scope.request);
    const language = this.inLanguage(started, tag);
    const children = evaluated
      .map((node) =>
        producedNode(
          node,
          (ref) => started.composites[ref as number],
          started.validator,
          (invalid, reason) =>
            this.ctx.log.error("A page node is not valid for this request and is shown as an error", {
              code: "ERR_UI_NODE_INVALID",
              page: page.path,
              type: String(invalid.type),
              reason,
            }),
        ),
      )
      .filter((node) => node !== undefined)
      .map((node) => language.translator.node(node));
    return this.send(
      request,
      reply,
      {
        specVersion: SPEC_VERSION,
        bundle: started.bundle,
        path: page.path,
        title: language.pageTitles[index],
        ...(tag === undefined ? {} : { lang: tag }),
        query: page.query ?? {},
        children,
      },
      started.vary.pages[index],
    );
  }

  private serveAsset(started: Started, request: FastifyRequest, reply: FastifyReply) {
    const params = request.params as { digest: string; "*": string };
    const asset = started.store.get(params.digest, params["*"]);
    if (!asset) {
      return reply.code(404).send({ error: "NotFound", message: "No such asset.", status: 404 });
    }
    reply.header("cache-control", IMMUTABLE).type(asset.mediaType);
    return reply.send(asset.body);
  }

  private serveShell(started: Started, mount: string, request: FastifyRequest, reply: FastifyReply) {
    const pathname = new URL(request.url, "http://telo.invalid").pathname;
    const path = pathname.slice(mount.length) || "/";
    if (path === "/_telo" || path.startsWith("/_telo/")) {
      return reply.code(404).send({ error: "NotFound", message: `Nothing is served at '${path}'.`, status: 404 });
    }
    const declared = this.resource.pages.some((page) => page.path === path);
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
