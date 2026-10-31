import * as React from "react";
import {
  AlertTriangle,
  ChevronRight,
  GitBranch,
  Globe,
  Hash,
  Loader2,
  Scale,
  Store,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Link, useLocation, useNavigate } from "react-router";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge, CategoryBadges, DeprecationNotice, RuntimeBadges, VersionBadge } from "@/Badges";
import { capabilityOf, CapabilityLabel } from "@/Capability";
import { useHubOrigins } from "@/hub-origins";
import { catalogPath, NO_FILTERS } from "@/catalog-filters";
import { importAlias, ImportSnippet, pinnedSource } from "@/ImportSnippet";
import { usageExample, type KindSchema, type KindSchemas, type SchemaField } from "@/kind-schema";
import { ManifestSource } from "@/ManifestSource";
import {
  fetchDependents,
  fetchImplementations,
  fetchInstances,
  type Dependent,
  type ApplicationContract,
  type ApplicationInput,
  type Implementation,
  type KindInfo,
  type KindInstance,
  type ModulePage as ModulePageData,
} from "@/api";
import { ModuleAvatar } from "@/ModuleAvatar";
import { ModuleLink } from "@/ModuleLink";
import { moduleDisplayName, moduleLabel } from "@/module-ref";
import { requirementSentence } from "@/requirement-sentence";

/** A module's own page, reachable by URL.
 *
 *  Everything here comes from one `/module` read, done by the server before the
 *  page renders. The alternative — reusing a search hit — cannot address a
 *  non-latest version and carries only the kinds that matched a query, which is
 *  the wrong content for a page whose subject is the module itself. `pagePath`
 *  is the module's own page, which its version picker addresses.
 *
 *  Two columns on a wide screen: what the module is on the left, what you do
 *  with it — import it, pick a version, follow its provenance — pinned on the
 *  right. On a narrow one the right column comes first, since the import entry
 *  is what most visits are for. */
/** The lists the server already read for a page; a `null` one is read by the
 *  browser instead. */
export interface RelatedModules {
  dependents: Dependent[] | null;
  /** By contract kind. */
  implementations: Record<string, Implementation[] | null>;
}

export function ModulePage({
  page,
  pagePath,
  schemas,
  related,
}: {
  related: RelatedModules;
  page: ModulePageData;
  pagePath: string;
  /** Each kind's field tables, read from the version's manifest; `null` when
   *  the hub served none, and the page then goes without them. */
  schemas: KindSchemas | null;
}) {
  const m = page.module;
  const name = moduleDisplayName(m);
  const isOlder = Boolean(m.latestVersion) && m.version !== m.latestVersion;
  const groups = groupKinds(page.kinds);

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumb name={name} publisher={m.publisher} version={isOlder ? m.version : ""} pagePath={pagePath} />

      <header className="flex items-start gap-4">
        <ModuleAvatar module={m} className="size-14 rounded-xl text-lg" />
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">{name}</h1>
          <code className="font-mono text-xs break-all text-muted-foreground">{m.ref}</code>
          <div className="flex flex-wrap items-center gap-1.5">
            <VersionBadge version={m.version} />
            {page.application && <Badge tone="contract">Application</Badge>}
            <RuntimeBadges runtime={m.runtime} />
            <CategoryBadges categories={m.categories} />
          </div>
        </div>
      </header>

      {isOlder && (
        <div
          role="note"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
        >
          <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span>
            You are reading <span className="font-mono font-medium">v{m.version}</span>, an older
            version.
          </span>
          <Link to={pagePath} className="font-medium text-primary underline-offset-4 hover:underline">
            Go to the latest, v{m.latestVersion}
          </Link>
        </div>
      )}

      {m.deprecated?.reason && (
        <DeprecationNotice
          reason={m.deprecated.reason}
          replacedBy={
            m.deprecated.replacedBy ? (
              <ModuleLink
                // The replacement is an import source; its page is the ref alone.
                moduleRef={m.deprecated.replacedBy.replace(/[@#].*$/, "")}
                className="font-mono text-xs font-medium text-primary underline-offset-4 hover:underline"
              >
                {m.deprecated.replacedBy}
              </ModuleLink>
            ) : undefined
          }
        />
      )}

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-8">
          <p className="max-w-prose text-base leading-relaxed">
            {m.description || "This module publishes no description."}
          </p>

          {page.application && <ApplicationInputs application={page.application} />}

          {groups.map((group) => (
            <section key={group.title} className="flex flex-col gap-3">
              <SectionTitle>
                <group.icon className="size-3.5" aria-hidden /> {group.title}{" "}
                <span className="tabular-nums">({group.kinds.length})</span>
              </SectionTitle>
              <ul className="flex flex-col gap-3">
                {group.kinds.map((k) => (
                  <KindCard
                    key={k.kind}
                    kind={k}
                    moduleRef={m.ref}
                    alias={importAlias(name)}
                    // A re-exported kind is defined in another module's manifest.
                    schema={k.reexported ? undefined : schemas?.[k.kind]}
                    implementations={related.implementations[k.kind] ?? null}
                  />
                ))}
              </ul>
            </section>
          ))}

          {page.exportedResources.length > 0 && (
            <section id="instances" className="flex flex-col gap-3">
              <SectionTitle>Ready-made instances ({page.exportedResources.length})</SectionTitle>
              <p className="text-sm text-muted-foreground">
                Reference one directly as <code className="font-mono">!ref {"<Alias>"}.name</code> —
                no need to declare your own.
              </p>
              <ul className="grid gap-2 sm:grid-cols-2">
                {page.exportedResources.map((r) => (
                  <li
                    key={r.name}
                    className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2"
                  >
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <code className="font-mono text-sm font-medium">{r.name}</code>
                      {r.kind && <span className="font-mono text-xs text-muted-foreground">{r.kind}</span>}
                    </span>
                    {r.description && (
                      <span className="text-xs leading-relaxed text-muted-foreground">{r.description}</span>
                    )}
                    {/* A re-export's declaring doc lives in another module, so
                        the hub has nothing local to report — say that rather
                        than showing an empty card. */}
                    {r.declared.includes(".") && (
                      <span className="text-xs text-muted-foreground">
                        Re-exported from <code className="font-mono">{r.declared}</code>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(page.dependents ?? 0) > 0 && (
            <UsedBy moduleRef={m.ref} count={page.dependents!} initial={related.dependents} />
          )}

          {schemas && <ManifestSource moduleRef={m.ref} version={m.version} />}
        </div>

        <aside className="order-first flex flex-col gap-4 lg:sticky lg:top-20 lg:order-last">
          <SideCard title={page.application ? "Run it" : "Import it"}>
            {page.application ? (
              <pre className="overflow-x-auto rounded-lg border border-border bg-muted/60 px-3 py-2.5 font-mono text-xs leading-relaxed">
                <code>telo run {pinnedSource(m.ref, m.version, m.integrity)}</code>
              </pre>
            ) : (
              <>
                <ImportSnippet name={name} source={pinnedSource(m.ref, m.version, m.integrity)} />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  The key is the alias its kinds are written under — rename it freely.
                </p>
              </>
            )}
          </SideCard>

          {page.versions.length > 1 && (
            <SideCard title="Version">
              <VersionPicker
                versions={page.versions}
                current={m.version}
                latest={m.latestVersion}
                pagePath={pagePath}
              />
            </SideCard>
          )}

          <SideCard title="About">
            <dl className="flex flex-col gap-2 text-sm">
              {m.publisher && (
                <Fact icon={<Store />} term="Published on">
                  {m.publisher}
                </Fact>
              )}
              {m.license && (
                <Fact icon={<Scale />} term="License">
                  {m.license}
                </Fact>
              )}
              {m.repository && (
                <Fact icon={<GitBranch />} term="Source">
                  <ExternalLink href={m.repository} />
                </Fact>
              )}
              {m.homepage && (
                <Fact icon={<Globe />} term="Homepage">
                  <ExternalLink href={m.homepage} />
                </Fact>
              )}
            </dl>
          </SideCard>

          {page.imports && page.imports.length > 0 && (
            <SideCard title={`Imports (${page.imports.length})`}>
              <ul className="flex flex-col gap-1.5 text-sm">
                {page.imports.map((i) => (
                  <li key={i.alias} className="flex items-baseline justify-between gap-2">
                    <ModuleLink
                      moduleRef={i.ref}
                      title={i.ref}
                      className="truncate font-mono text-xs text-primary underline-offset-2 hover:underline"
                    >
                      {moduleLabel(i.ref)}
                    </ModuleLink>
                    {i.version && (
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {i.version}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </SideCard>
          )}

          {page.kinds.length > 1 && (
            <SideCard title="On this page" className="hidden lg:flex">
              <ul className="flex max-h-72 flex-col overflow-y-auto">
                {groups.flatMap((group) =>
                  group.kinds.map((k) => (
                    <li key={k.kind}>
                      <a
                        href={`#kind-${k.kind}`}
                        className="block truncate rounded-md px-2 py-1 font-mono text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {k.kind}
                      </a>
                    </li>
                  )),
                )}
              </ul>
            </SideCard>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Where the page sits: the catalogue, the host and org it is published under,
 *  then the module. The catalogue crumb goes back to the listing the reader
 *  came from, filters and all, when they came from one. */
function Breadcrumb({
  name,
  publisher,
  version,
  pagePath,
}: {
  name: string;
  publisher?: string;
  version: string;
  pagePath: string;
}) {
  const backTo = (useLocation().state as { backTo?: unknown } | null)?.backTo;
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        <li>
          <Link
            to={typeof backTo === "string" ? backTo : "/"}
            className="rounded underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Modules
          </Link>
        </li>
        {publisher && (
          <>
            <Crumb />
            <li>
              <Link
                to={catalogPath("", { ...NO_FILTERS, publisher })}
                className="rounded font-mono text-xs underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                {publisher}
              </Link>
            </li>
          </>
        )}
        <Crumb />
        <li>
          {version ? (
            <Link to={pagePath} className="underline-offset-4 hover:text-foreground hover:underline">
              {name}
            </Link>
          ) : (
            <span aria-current="page" className="font-medium text-foreground">
              {name}
            </span>
          )}
        </li>
        {version && (
          <>
            <Crumb />
            <li aria-current="page" className="font-mono text-xs font-medium text-foreground">
              v{version}
            </li>
          </>
        )}
      </ol>
    </nav>
  );
}

function Crumb() {
  return (
    <li aria-hidden>
      <ChevronRight className="size-3.5" />
    </li>
  );
}

/** A module's kinds by what they are: contracts first — the kinds others
 *  implement — then each capability in the order its first kind appears. */
function groupKinds(kinds: KindInfo[]) {
  const groups = new Map<string, { title: string; icon: ReturnType<typeof capabilityOf>["icon"]; kinds: KindInfo[] }>();
  for (const kind of [...kinds.filter((k) => k.abstract), ...kinds.filter((k) => !k.abstract)]) {
    const { plural, icon } = capabilityOf(kind);
    const group = groups.get(plural) ?? { title: plural, icon, kinds: [] };
    group.kinds.push(kind);
    groups.set(plural, group);
  }
  return [...groups.values()];
}

function KindCard({
  kind,
  moduleRef,
  alias,
  schema,
  implementations,
}: {
  implementations: Implementation[] | null;
  kind: KindInfo;
  moduleRef: string;
  /** The alias the import entry suggests, so the example matches it. */
  alias: string;
  schema?: KindSchema;
}) {
  const replacement = kind.deprecated?.replacedBy;
  const owner = kind.ref ?? moduleRef;
  return (
    <li
      id={`kind-${kind.kind}`}
      className="group/kind flex flex-col gap-2 rounded-xl border border-border bg-card p-4 target:border-primary target:ring-3 target:ring-ring/30"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h3 className="font-mono text-sm font-semibold">{kind.kind}</h3>
        <CapabilityLabel kind={kind} />
        <RuntimeBadges runtime={kind.runtime} />
        {kind.deprecated?.reason && <Badge tone="danger">Deprecated</Badge>}
        <a
          href={`#kind-${kind.kind}`}
          aria-label={`Link to ${kind.kind}`}
          className="ml-auto rounded p-1 text-muted-foreground opacity-0 outline-none group-hover/kind:opacity-100 hover:text-primary focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:opacity-100"
        >
          <Hash className="size-3.5" />
        </a>
      </div>

      {kind.description && (
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{kind.description}</p>
      )}

      {schema && (
        <>
          <FieldTable title="Fields" fields={schema.fields} />
          <FieldTable title="Inputs" fields={schema.inputs} />
          <FieldTable title="Outputs" fields={schema.outputs} />
          {/* A contract is implemented, not declared, so it has no example. */}
          {!kind.abstract && (
            <Collapsible className="flex flex-col gap-1.5">
              <CollapsibleTrigger className="group flex items-center gap-1 self-start rounded text-xs font-medium text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
                Example
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="overflow-x-auto rounded-lg border border-border bg-muted/60 px-3 py-2.5 font-mono text-xs leading-relaxed">
                  <code>{usageExample(alias, kind.kind, schema)}</code>
                </pre>
              </CollapsibleContent>
            </Collapsible>
          )}
        </>
      )}

      {kind.reexported && kind.ref && (
        <p className="text-xs text-muted-foreground">
          Re-exported from{" "}
          <ModuleLink
            moduleRef={kind.ref}
            hash={`#kind-${kind.kind}`}
            className="font-mono text-primary underline-offset-2 hover:underline"
          >
            {kind.ref}
          </ModuleLink>
        </p>
      )}

      {/* The contract a kind implements is the axis that groups backends across
          module boundaries, so it links to the contract's own entry. */}
      {kind.extends?.kind && (
        <p className="text-xs text-muted-foreground">
          Implements{" "}
          {kind.extends.ref ? (
            <ModuleLink
              moduleRef={kind.extends.ref}
              hash={`#kind-${kind.extends.kind}`}
              className="font-mono font-medium text-primary underline-offset-2 hover:underline"
            >
              {moduleLabel(kind.extends.ref)}.{kind.extends.kind}
            </ModuleLink>
          ) : (
            <code className="font-mono text-foreground">{kind.extends.kind}</code>
          )}
        </p>
      )}

      {kind.abstract && (
        <KindImplementations ownerRef={owner} kind={kind.kind} initial={implementations} />
      )}

      {(kind.instances ?? 0) > 0 && (
        <KindInstances ownerRef={owner} kind={kind.kind} count={kind.instances!} />
      )}

      {kind.deprecated?.reason && (
        <p className="text-xs text-destructive">
          Deprecated — {kind.deprecated.reason}
          {replacement?.kind && (
            <>
              {" "}
              Use{" "}
              {replacement.ref ? (
                <ModuleLink
                  moduleRef={replacement.ref}
                  hash={`#kind-${replacement.kind}`}
                  className="font-mono font-medium underline underline-offset-2"
                >
                  {moduleLabel(replacement.ref)}.{replacement.kind}
                </ModuleLink>
              ) : (
                <>
                  <code className="font-mono">{replacement.kind}</code> (a kernel built-in)
                </>
              )}
              .
            </>
          )}
        </p>
      )}
    </li>
  );
}

/** One table of a kind's fields, inputs or outputs. A narrow screen stacks each
 *  row instead of scrolling a table sideways. */
function FieldTable({ title, fields }: { title: string; fields: SchemaField[] }) {
  if (fields.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">
        {title} ({fields.length})
      </span>
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {fields.map((field) => (
          <li
            key={field.name}
            className="grid gap-x-4 gap-y-1 px-3 py-2 text-xs sm:grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)]"
          >
            <div className="flex flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-1.5">
                <code className="font-mono text-sm font-medium">{field.name}</code>
                {field.required && <Badge tone="partial">required</Badge>}
              </span>
              <span className="font-mono break-words text-muted-foreground">{field.type}</span>
            </div>
            <div className="flex flex-col gap-1 leading-relaxed text-muted-foreground">
              {field.description && <span>{field.description}</span>}
              {field.options.length > 0 && (
                <span>
                  One of{" "}
                  {field.options.map((option, i) => (
                    <React.Fragment key={option}>
                      {i > 0 && ", "}
                      <code className="font-mono text-foreground">{option}</code>
                    </React.Fragment>
                  ))}
                </span>
              )}
              {field.default && (
                <span>
                  Default <code className="font-mono break-all text-foreground">{field.default}</code>
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The modules importing this one, each at its latest version — where working
 *  uses of its kinds are. `initial` is the server's read; without one the list
 *  is read as the page opens. The hub answers a page at a time, and `count` is
 *  how many there are in all. */
function UsedBy({
  moduleRef,
  count,
  initial,
}: {
  moduleRef: string;
  count: number;
  initial: Dependent[] | null;
}) {
  const { browserApiOrigin } = useHubOrigins();
  const [state, setState] = React.useState<Loaded<Dependent>>(
    initial ? { kind: "ready", items: initial } : { kind: "loading" },
  );

  React.useEffect(() => {
    if (initial) return;
    const controller = new AbortController();
    fetchDependents(browserApiOrigin, moduleRef, 0, controller.signal)
      .then((result) =>
        setState(
          result.ok
            ? { kind: "ready", items: result.dependents }
            : { kind: "failed", error: result.error },
        ),
      )
      .catch(() => {
        // Aborted by unmount; nothing is left to update.
      });
    return () => controller.abort();
  }, [browserApiOrigin, moduleRef, initial]);

  const [loadingMore, setLoadingMore] = React.useState(false);
  const loadMore = (items: Dependent[]) => {
    setLoadingMore(true);
    fetchDependents(browserApiOrigin, moduleRef, items.length)
      .then((result) =>
        setState(
          result.ok
            ? { kind: "ready", items: [...items, ...result.dependents] }
            : { kind: "failed", error: result.error },
        ),
      )
      .finally(() => setLoadingMore(false));
  };

  return (
    <section id="used-by" className="flex flex-col gap-3">
      <SectionTitle>Used by ({count})</SectionTitle>
      {state.kind === "failed" && (
        <p className="text-xs text-destructive">Could not load the modules using this: {state.error}</p>
      )}
      {state.kind === "ready" && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {state.items.map((d) => (
            <li key={d.ref} className="flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2">
              <ModuleAvatar module={d} className="size-8 text-xs" />
              <div className="flex min-w-0 flex-col gap-0.5">
                <ModuleLink
                  moduleRef={d.ref}
                  title={d.ref}
                  className="self-start text-sm font-medium text-primary underline-offset-2 hover:underline"
                >
                  {moduleDisplayName(d)}
                </ModuleLink>
                {d.description && (
                  <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    {d.description}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {state.kind === "ready" && state.items.length > 0 && state.items.length < count && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={loadingMore}
          onClick={() => loadMore(state.items)}
        >
          {loadingMore && <Loader2 className="animate-spin" />}
          Show more
          <span className="text-muted-foreground tabular-nums">
            {state.items.length} / {count}
          </span>
        </Button>
      )}
    </section>
  );
}

type Loaded<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; items: T[] }
  | { kind: "failed"; error: string };

/** Every kind implementing a contract, in whichever module declares it — the
 *  reverse of "Implements". `initial` is the server's read; without one the
 *  list is read as the page opens. */
function KindImplementations({
  ownerRef,
  kind,
  initial,
}: {
  ownerRef: string;
  kind: string;
  initial: Implementation[] | null;
}) {
  const { browserApiOrigin } = useHubOrigins();
  const [state, setState] = React.useState<Loaded<Implementation>>(
    initial ? { kind: "ready", items: initial } : { kind: "loading" },
  );

  React.useEffect(() => {
    if (initial) return;
    const controller = new AbortController();
    fetchImplementations(browserApiOrigin, ownerRef, kind, controller.signal)
      .then((result) =>
        setState(
          result.ok
            ? { kind: "ready", items: result.implementations }
            : { kind: "failed", error: result.error },
        ),
      )
      .catch(() => {
        // Aborted by unmount; nothing is left to update.
      });
    return () => controller.abort();
  }, [browserApiOrigin, ownerRef, kind, initial]);

  if (state.kind === "failed") {
    return <p className="text-xs text-destructive">Could not load implementations: {state.error}</p>;
  }
  if (state.kind !== "ready") return null;
  if (state.items.length === 0) {
    return <p className="text-xs text-muted-foreground">No registered module implements this yet.</p>;
  }
  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-2">
      <span className="text-xs font-medium text-muted-foreground">
        Implemented by ({state.items.length})
      </span>
      <ul className="flex flex-col gap-1.5">
        {state.items.map((i) => (
          <li key={`${i.ref}/${i.kind}`} className="flex flex-col gap-0.5 text-xs">
            <ModuleLink
              moduleRef={i.ref}
              hash={`#kind-${i.kind}`}
              className="self-start font-mono font-medium text-primary underline-offset-2 hover:underline"
            >
              {moduleLabel(i.ref)}.{i.kind}
            </ModuleLink>
            {i.description && (
              <span className="line-clamp-2 leading-relaxed text-muted-foreground">{i.description}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The ready-made instances of one kind, across every module that exports one —
 *  how a module that only packages instances (one per OCR language) is reached.
 *  Fetched on first open, since most readers never expand it. */
function KindInstances({ ownerRef, kind, count }: { ownerRef: string; kind: string; count: number }) {
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState<Loaded<KindInstance>>({ kind: "idle" });
  const controller = React.useRef<AbortController | null>(null);
  const { browserApiOrigin } = useHubOrigins();

  React.useEffect(() => () => controller.current?.abort(), []);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next || state.kind !== "idle") return;
    controller.current = new AbortController();
    setState({ kind: "loading" });
    fetchInstances(browserApiOrigin, ownerRef, kind, controller.current.signal)
      .then((result) =>
        setState(
          result.ok
            ? { kind: "ready", items: result.instances }
            : { kind: "failed", error: result.error },
        ),
      )
      .catch(() => {
        // Aborted by unmount; nothing is left to update.
      });
  };

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="flex flex-col gap-1.5">
      <CollapsibleTrigger className="group flex items-center gap-1 self-start rounded text-xs font-medium text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
        {count} ready-made {count === 1 ? "instance" : "instances"}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {state.kind === "loading" && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </p>
        )}
        {state.kind === "failed" && (
          <p className="text-xs text-destructive">Could not load instances: {state.error}</p>
        )}
        {state.kind === "ready" && (
          <ul className="flex flex-col gap-1">
            {state.items.map((i) => (
              <li key={`${i.module.ref}/${i.name}`} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <code className="font-mono font-medium">{i.name}</code>
                {i.description && <span className="text-muted-foreground">{i.description}</span>}
                <ModuleLink
                  moduleRef={i.module.ref}
                  hash="#instances"
                  className="font-mono text-primary underline-offset-2 hover:underline"
                >
                  {i.module.ref}
                </ModuleLink>
              </li>
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** What an application asks for before it runs — the whole of its interface,
 *  since it exports nothing to import. */
function ApplicationInputs({ application }: { application: ApplicationContract }) {
  const blocks: [string, ApplicationInput[]][] = [
    ["Variables", application.variables ?? []],
    ["Secrets", application.secrets ?? []],
    ["Ports", application.ports ?? []],
  ];
  const declared = blocks.filter(([, inputs]) => inputs.length > 0);
  return (
    <section id="application" className="flex flex-col gap-4">
      <SectionTitle>What it asks for</SectionTitle>
      {declared.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing — it runs with no inputs.</p>
      )}
      {declared.map(([title, inputs]) => (
        <div key={title} className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{title}</h3>
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
            {inputs.map((input) => (
              <li key={input.name} className="flex flex-col gap-1 px-4 py-3">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <code className="font-mono text-sm font-medium">{input.name}</code>
                  {input.required && (
                    <Badge tone="partial">
                      {input.requiredWhen
                        ? `required when ${requirementSentence(input.requiredWhen, application.dimensions ?? [])}`
                        : "required"}
                    </Badge>
                  )}
                  {input.protocol && <Badge>{input.protocol}</Badge>}
                  {input.env && (
                    <Badge title="Environment variable">
                      <span className="font-mono">{input.env}</span>
                    </Badge>
                  )}
                  {input.arg && (
                    <Badge title="Command-line argument">
                      <span className="font-mono">
                        {input.arg.form === "flag"
                          ? `--${input.arg.flag}`
                          : `argument ${input.arg.position}`}
                      </span>
                    </Badge>
                  )}
                  {input.default != null && (
                    <span className="text-xs text-muted-foreground">
                      default <code className="font-mono">{String(input.default)}</code>
                    </span>
                  )}
                </span>
                {input.description && (
                  <span className="text-sm leading-relaxed text-muted-foreground">{input.description}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** One control for every tracked version. Picking one is a navigation, so each
 *  version keeps an address of its own (`?version=`, the latest unversioned). */
function VersionPicker({
  versions,
  current,
  latest,
  pagePath,
}: {
  versions: string[];
  current: string;
  latest: string;
  pagePath: string;
}) {
  const navigate = useNavigate();
  return (
    <Select
      value={current}
      onValueChange={(version) =>
        navigate(
          version === latest ? pagePath : `${pagePath}?${new URLSearchParams({ version })}`,
          { preventScrollReset: true },
        )
      }
    >
      <SelectTrigger aria-label="Version" className="w-full font-mono">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {versions.map((version) => (
          <SelectItem key={version} value={version} className="font-mono">
            {version}
            {version === latest && (
              <span className="ml-auto pl-3 font-sans text-xs text-muted-foreground">latest</span>
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </h2>
  );
}

function SideCard({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4 ${className ?? ""}`}>
      <SectionTitle>{title}</SectionTitle>
      {children}
    </section>
  );
}

function Fact({
  icon,
  term,
  children,
}: {
  icon: React.ReactNode;
  term: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
      {icon}
      <div className="flex min-w-0 flex-col">
        <dt className="text-xs text-muted-foreground">{term}</dt>
        <dd className="break-all">{children}</dd>
      </div>
    </div>
  );
}

/** An outbound link shown as the address it goes to, minus the scheme. The
 *  address is whatever the module's author declared, and registration is open —
 *  so it is marked as user-supplied and passes no ranking on. */
function ExternalLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="nofollow ugc noreferrer noopener"
      className="text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      {href.replace(/^https?:\/\//, "").replace(/\/$/, "")}
    </a>
  );
}
