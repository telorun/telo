import * as React from "react";
import { AlertCircle, ArrowLeft, GitBranch, Globe, Loader2, Scale } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DeprecationNotice, RuntimeBadges } from "@/Badges";
import { CopyButton } from "@/CopyButton";
import { ResourcePopover } from "@/KindPopover";
import { fetchModule, type KindInfo, type ModulePage as ModulePageData } from "@/api";
import { moduleDisplayName, moduleLabel, refToPath, shortCapability } from "@/module-ref";
import { navigate } from "@/routing";

type State =
  | { kind: "loading" }
  | { kind: "ready"; page: ModulePageData }
  | { kind: "failed"; error: string };

/** A module's own page, reachable by URL.
 *
 *  Everything here comes from one `/module` call. The alternative — reusing a
 *  search hit — cannot address a non-latest version and carries only the kinds
 *  that matched a query, which is the wrong content for a page whose subject is
 *  the module itself. */
export function ModulePage({ moduleRef, version }: { moduleRef: string; version: string }) {
  const [state, setState] = React.useState<State>({ kind: "loading" });

  React.useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    fetchModule(moduleRef, version, controller.signal)
      .then((result) =>
        setState(
          result.ok ? { kind: "ready", page: result.page } : { kind: "failed", error: result.error },
        ),
      )
      .catch(() => {
        // Superseded by a newer request, which owns the state.
      });
    return () => controller.abort();
  }, [moduleRef, version]);

  return (
    <div className="flex flex-col gap-6">
      <Button
        variant="ghost"
        size="sm"
        className="self-start -ml-2"
        onClick={() => navigate("/")}
      >
        <ArrowLeft className="size-3.5" /> All modules
      </Button>

      {state.kind === "loading" && (
        <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading {moduleLabel(moduleRef)}…
        </p>
      )}

      {state.kind === "failed" && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium">Module unavailable</span>
            <span className="break-all text-muted-foreground">{state.error}</span>
            <code className="mt-1 font-mono text-xs break-all">{moduleRef}</code>
          </div>
        </div>
      )}

      {state.kind === "ready" && <ModuleBody page={state.page} />}
    </div>
  );
}

function ModuleBody({ page }: { page: ModulePageData }) {
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
            <button
              type="button"
              onClick={() => navigate(refToPath(m.ref))}
              className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary underline-offset-2 hover:underline"
            >
              latest is v{m.latestVersion}
            </button>
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
                <button
                  type="button"
                  onClick={() =>
                    navigate(v === m.latestVersion ? refToPath(m.ref) : `${refToPath(m.ref)}?version=${v}`)
                  }
                  aria-current={v === m.version ? "true" : undefined}
                  className={`rounded px-1.5 py-0.5 font-mono text-xs transition-colors ${
                    v === m.version
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground hover:bg-muted/60"
                  }`}
                >
                  {v}
                </button>
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

