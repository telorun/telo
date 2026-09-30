import * as React from "react";
import { ArrowLeft, ChevronRight, GitBranch, Globe, Loader2, Scale } from "lucide-react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DeprecationNotice, RuntimeBadges } from "@/Badges";
import { CopyButton } from "@/CopyButton";
import { useHubOrigins } from "@/hub-origins";
import { ResourcePopover } from "@/KindPopover";
import {
  fetchInstances,
  type KindInfo,
  type KindInstance,
  type ModulePage as ModulePageData,
} from "@/api";
import { ModuleLink } from "@/ModuleLink";
import { moduleDisplayName, shortCapability } from "@/module-ref";

/** A module's own page, reachable by URL.
 *
 *  Everything here comes from one `/module` read, done by the server before the
 *  page renders. The alternative — reusing a search hit — cannot address a
 *  non-latest version and carries only the kinds that matched a query, which is
 *  the wrong content for a page whose subject is the module itself. `pagePath`
 *  is the module's own page, which its version links address. */
export function ModulePage({ page, pagePath }: { page: ModulePageData; pagePath: string }) {
  return (
    <div className="flex flex-col gap-6">
      <Button variant="ghost" size="sm" className="self-start -ml-2" asChild>
        <Link to="/">
          <ArrowLeft className="size-3.5" /> All modules
        </Link>
      </Button>

      <ModuleBody page={page} pagePath={pagePath} />
    </div>
  );
}

function ModuleBody({ page, pagePath }: { page: ModulePageData; pagePath: string }) {
  const m = page.module;
  const pinned = `${m.ref}@${m.version}`;
  const isOlder = Boolean(m.latestVersion) && m.version !== m.latestVersion;

  return (
    <>
      <header className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">{moduleDisplayName(m)}</h1>
          <code className="font-mono text-xs break-all text-muted-foreground">{m.ref}</code>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">v{m.version}</span>
          {isOlder && (
            <Link
              to={pagePath}
              className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary underline-offset-2 hover:underline"
            >
              latest is v{m.latestVersion}
            </Link>
          )}
          <RuntimeBadges runtime={m.runtime} />
          {m.categories?.map((c) => (
            <span key={c.slug} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {c.label}
            </span>
          ))}
        </div>

        {m.publisher && (
          <p className="text-xs text-muted-foreground">
            Published on <span className="font-medium">{m.publisher}</span> — the hub indexes
            metadata only and does not vouch for content.
          </p>
        )}
      </header>

      {m.deprecated?.reason && (
        <DeprecationNotice
          reason={m.deprecated.reason}
          replacedBy={
            m.deprecated.replacedBy ? (
              <code className="font-mono text-xs">{m.deprecated.replacedBy}</code>
            ) : undefined
          }
        />
      )}

      <p className="text-sm leading-relaxed">
        {m.description || "This module publishes no description."}
      </p>

      {(m.repository || m.homepage || m.license) && (
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          {m.homepage && (
            <li>
              <ExternalLink href={m.homepage} icon={<Globe className="size-3.5" />}>
                Homepage
              </ExternalLink>
            </li>
          )}
          {m.repository && (
            <li>
              <ExternalLink href={m.repository} icon={<GitBranch className="size-3.5" />}>
                Source
              </ExternalLink>
            </li>
          )}
          {m.license && (
            <li className="flex items-center gap-1.5 text-muted-foreground">
              <Scale className="size-3.5" /> {m.license}
            </li>
          )}
        </ul>
      )}

      <section className="flex flex-col gap-2">
        <SectionTitle>Import it</SectionTitle>
        {/* The prefix in `kind:` is the importer's own alias, so the snippet
            shows a placeholder rather than inventing a canonical name. */}
        <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
          <code>{`imports:\n  Alias: ${pinned}${m.integrity ? `#${m.integrity}` : ""}`}</code>
        </pre>
        <CopyButton
          value={`${pinned}${m.integrity ? `#${m.integrity}` : ""}`}
          label={m.integrity ? "Copy pinned ref" : "Copy ref"}
        />
      </section>

      {page.kinds.length > 0 && (
        <section className="flex flex-col gap-3">
          <SectionTitle>
            Kinds it exports ({page.kinds.length})
          </SectionTitle>
          <ul className="flex flex-col gap-3">
            {page.kinds.map((k) => (
              <KindRow key={k.kind} kind={k} />
            ))}
          </ul>
        </section>
      )}

      {page.exportedResources.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionTitle>Ready-made instances</SectionTitle>
          <p className="text-xs text-muted-foreground">
            Reference directly as <code className="font-mono">!ref Alias.name</code> — no need to
            declare your own.
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {page.exportedResources.map((r) => (
              <li key={r.name}>
                <ResourcePopover resource={r} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {page.versions.length > 1 && (
        <section className="flex flex-col gap-2">
          <SectionTitle>Tracked versions</SectionTitle>
          <ul className="flex flex-wrap gap-1.5">
            {page.versions.map((v) => (
              <li key={v}>
                <Link
                  to={
                    v === m.latestVersion
                      ? pagePath
                      : `${pagePath}?${new URLSearchParams({ version: v })}`
                  }
                  aria-current={v === m.version ? "true" : undefined}
                  className={`rounded px-1.5 py-0.5 font-mono text-xs transition-colors ${
                    v === m.version
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground hover:bg-muted/60"
                  }`}
                >
                  {v}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function KindRow({ kind }: { kind: KindInfo }) {
  const replacement = kind.deprecated?.replacedBy;
  return (
    <li className="flex flex-col gap-1 border-l-2 border-muted pl-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-sm font-medium">{kind.kind}</span>
        <span className="text-xs text-muted-foreground">
          {kind.abstract ? "abstract" : shortCapability(kind.capability)}
        </span>
        <RuntimeBadges runtime={kind.runtime} />
      </div>

      {kind.description && (
        <p className="text-sm leading-relaxed text-muted-foreground">{kind.description}</p>
      )}

      {kind.reexported && kind.ref && (
        <p className="text-xs text-muted-foreground">
          Re-exported from{" "}
          <ModuleLink
            moduleRef={kind.ref}
            className="font-mono underline-offset-2 hover:text-foreground hover:underline"
          >
            {kind.ref}
          </ModuleLink>
        </p>
      )}

      {kind.ref && (kind.instances ?? 0) > 0 && (
        <KindInstances ownerRef={kind.ref} kind={kind.kind} count={kind.instances!} />
      )}

      {/* The contract a kind implements is the axis that groups backends across
          module boundaries — worth naming even before it becomes a link. */}
      {kind.extends?.kind && (
        <p className="text-xs text-muted-foreground">
          Implements <code className="font-mono">{kind.extends.kind}</code>
          {kind.extends.ref && <> from <code className="font-mono">{kind.extends.ref}</code></>}
        </p>
      )}

      {kind.deprecated?.reason && (
        <p className="text-xs text-destructive">
          Deprecated — {kind.deprecated.reason}
          {replacement?.kind && (
            <>
              {" "}Use <code className="font-mono">{replacement.kind}</code>
              {replacement.ref ? (
                <> from <code className="font-mono">{replacement.ref}</code></>
              ) : (
                <> (a kernel built-in)</>
              )}
              .
            </>
          )}
        </p>
      )}
    </li>
  );
}

type InstancesState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; instances: KindInstance[] }
  | { kind: "failed"; error: string };

/** The ready-made instances of one kind, across every module that exports one —
 *  how a module that only packages instances (one per OCR language) is reached.
 *  Fetched on first open, since most readers never expand it. */
function KindInstances({ ownerRef, kind, count }: { ownerRef: string; kind: string; count: number }) {
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState<InstancesState>({ kind: "idle" });
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
            ? { kind: "ready", instances: result.instances }
            : { kind: "failed", error: result.error },
        ),
      )
      .catch(() => {
        // Aborted by unmount; nothing is left to update.
      });
  };

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="flex flex-col gap-1.5">
      <CollapsibleTrigger className="group flex items-center gap-1 self-start text-xs text-primary underline-offset-2 hover:underline">
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
            {state.instances.map((i) => (
              <li key={`${i.module.ref}/${i.name}`} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <code className="font-mono font-medium">{i.name}</code>
                {i.description && <span className="text-muted-foreground">{i.description}</span>}
                <ModuleLink
                  moduleRef={i.module.ref}
                  className="font-mono text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{children}</h2>
  );
}

function ExternalLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="flex items-center gap-1.5 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
    >
      {icon}
      {children}
    </a>
  );
}

