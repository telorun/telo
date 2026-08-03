import { ArrowUpRight } from "lucide-react";

import { SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { DeprecationNotice, RuntimeBadges } from "@/Badges";
import { KindPopover, ResourcePopover } from "@/KindPopover";
import { CopyButton } from "@/CopyButton";
import { moduleDisplayName, refToPath, shortCapability } from "@/module-ref";
import { navigate } from "@/routing";
import type { ModuleHit } from "@/api";

/**
 * Quick preview of a module, in the side panel.
 *
 * Scanning candidates is the common case, and making that a page navigation
 * costs a round trip and a Back for every module considered. This panel answers
 * "is this the one?" in place; the page answers "tell me everything" and stays
 * one click (or a middle-click on the row) away.
 *
 * It renders entirely from the search hit — the response already carries every
 * exported kind with its capability, description, runtime and deprecation, plus
 * the exported instances — so opening it fires no request at all. The version
 * list is the one thing it does not show; that needs a call, and it belongs to
 * the page.
 */
export function ModulePreview({ hit }: { hit: ModuleHit }) {
  const m = hit.module;
  const pinned = `${m.ref}@${m.version}`;
  const matched = new Set(hit.matchedKinds.map((k) => k.kind));
  const otherKinds = hit.exportedKinds.filter((k) => !matched.has(k.kind));
  const path = refToPath(m.ref);

  return (
    <div className="flex flex-col gap-5">
      {/* pr-10 keeps the heading clear of the sheet's close button. */}
      <div className="flex flex-col gap-2 pr-10">
        <SheetTitle>{moduleDisplayName(m)}</SheetTitle>
        <code className="font-mono text-xs break-all text-muted-foreground">{m.ref}</code>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">v{m.version}</span>
          <RuntimeBadges runtime={m.runtime} />
        </div>
      </div>

      {/* Always rendered: Radix uses it for the dialog's accessible description. */}
      <SheetDescription className="leading-relaxed">
        {m.description || "This module publishes no description."}
      </SheetDescription>

      {m.deprecated?.reason && (
        <DeprecationNotice
          reason={m.deprecated.reason}
          replacedBy={
            m.deprecated.replacedBy ? (
              <code className="font-mono text-xs break-all">{m.deprecated.replacedBy}</code>
            ) : undefined
          }
        />
      )}

      <a
        href={path}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          navigate(path);
        }}
        className="flex items-center gap-1 self-start text-sm text-primary underline-offset-4 hover:underline"
      >
        Open full page <ArrowUpRight className="size-3.5" />
      </a>

      <section className="flex flex-col gap-2">
        <PanelTitle>Import it</PanelTitle>
        {/* The prefix in `kind:` is the importer's own alias, so the snippet
            shows a placeholder rather than inventing a canonical name. */}
        <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
          <code>{`imports:\n  Alias: ${pinned}`}</code>
        </pre>
        <CopyButton value={pinned} label="Copy ref" />
      </section>

      {hit.matchedKinds.length > 0 && (
        <section className="flex flex-col gap-2">
          <PanelTitle>Matching kinds</PanelTitle>
          <ul className="flex flex-col gap-2.5">
            {hit.matchedKinds.map((k) => (
              <li key={k.kind} className="flex flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <KindPopover
                    kind={k}
                    className="font-mono text-sm font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                  />
                  <span className="text-xs text-muted-foreground">
                    {k.abstract ? "abstract" : shortCapability(k.capability)}
                  </span>
                  {k.deprecated?.reason && (
                    <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive">
                      Deprecated
                    </span>
                  )}
                </div>
                {k.description && (
                  <p className="text-sm leading-relaxed text-muted-foreground">{k.description}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {hit.exportedResources.length > 0 && (
        <section className="flex flex-col gap-2">
          <PanelTitle>Ready-made instances</PanelTitle>
          <ul className="flex flex-wrap gap-1.5">
            {hit.exportedResources.map((r) => (
              <li key={r.name}>
                <ResourcePopover resource={r} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {otherKinds.length > 0 && (
        <section className="flex flex-col gap-2">
          <PanelTitle>Also exports</PanelTitle>
          <ul className="flex flex-wrap gap-1.5">
            {otherKinds.map((k) => (
              <li key={k.kind}>
                <KindPopover kind={k} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function PanelTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{children}</h3>
  );
}
