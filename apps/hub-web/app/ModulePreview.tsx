import * as React from "react";
import { ArrowRight, X } from "lucide-react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { CategoryBadges, DeprecationNotice, RuntimeBadges, VersionBadge } from "@/Badges";
import { CapabilityLabel } from "@/Capability";
import { useHubOrigins } from "@/hub-origins";
import { ImportSnippet, pinnedSource } from "@/ImportSnippet";
import { KindChip } from "@/KindChip";
import { ModuleAvatar } from "@/ModuleAvatar";
import { moduleDisplayName, modulePagePath } from "@/module-ref";
import { fetchVersionPins, type ModuleHit } from "@/api";

/**
 * A quick look at a module, beside the list it was picked from.
 *
 * Scanning candidates is the common case, and a page navigation per module
 * costs a round trip and a Back for each one considered. This answers "is this
 * the one?" in place; the page answers "tell me everything" and is the panel's
 * primary action.
 *
 * It renders from the search hit, which already carries every exported kind
 * and instance, so opening it shows everything at once. One request follows:
 * the version's import pin, so the entry copied here is the same pinned one the
 * page offers.
 *
 * `docked` is the wide-screen form, a column beside the list; otherwise it is
 * the content of a sheet, whose title and description Radix needs for the
 * dialog's accessible name.
 */
export function ModulePreview({
  hit,
  docked,
  onClose,
}: {
  hit: ModuleHit;
  docked: boolean;
  onClose: () => void;
}) {
  const m = hit.module;
  const integrity = useIntegrity(m.ref, m.version);
  const matched = new Set(
    hit.matchedKinds.filter((k) => k.entry !== "instance").map((k) => k.kind),
  );
  const otherKinds = hit.exportedKinds.filter((k) => !matched.has(k.kind));
  const path = modulePagePath(m.ref);
  const Title = docked ? "h2" : SheetTitle;
  const Description = docked ? "p" : SheetDescription;

  return (
    <div className="flex flex-col gap-5">
      {/* pr-10 keeps the heading clear of the close button. */}
      <div className="flex items-start gap-3 pr-10">
        <ModuleAvatar module={m} />
        <div className="flex min-w-0 flex-col gap-1">
          <Title className="text-base leading-tight font-semibold tracking-tight">
            {moduleDisplayName(m)}
          </Title>
          <code className="font-mono text-xs break-all text-muted-foreground">{m.ref}</code>
        </div>
        {docked && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-3 right-3"
            aria-label="Close preview"
            onClick={onClose}
          >
            <X />
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <VersionBadge version={m.version} />
        <RuntimeBadges runtime={m.runtime} />
        <CategoryBadges categories={m.categories} />
      </div>

      {path && (
        <Button asChild>
          <Link to={path}>
            Open module page <ArrowRight />
          </Link>
        </Button>
      )}

      <Description className="text-sm leading-relaxed text-muted-foreground">
        {m.description || "This module publishes no description."}
      </Description>

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

      {!hit.application && (
        <section className="flex flex-col gap-2">
          <PanelTitle>Import it</PanelTitle>
          <ImportSnippet name={moduleDisplayName(m)} source={pinnedSource(m.ref, m.version, integrity)} />
        </section>
      )}

      {hit.matchedKinds.length > 0 && !hit.application && (
        <section className="flex flex-col gap-2">
          <PanelTitle>Matches</PanelTitle>
          <ul className="flex flex-col gap-3">
            {hit.matchedKinds.map((k) => (
              <li key={`${k.entry ?? "kind"}:${k.name ?? k.kind}`} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <KindChip entry={k} moduleRef={m.ref} />
                  {k.entry === "instance" ? (
                    <span className="text-xs text-muted-foreground">
                      ready-made <code className="font-mono">{k.kind}</code>
                    </span>
                  ) : (
                    <CapabilityLabel kind={k} />
                  )}
                  {k.deprecated?.reason && (
                    <span className="rounded-md bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
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
          <ul className="flex flex-col gap-1.5">
            {hit.exportedResources.map((r) => (
              <li key={r.name} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <code className="font-mono font-medium">{r.name}</code>
                {r.kind && <span className="text-muted-foreground">{r.kind}</span>}
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
                <KindChip entry={k} moduleRef={m.ref} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** The import pin of one version, once the hub has answered. Empty until then,
 *  and when nothing can hash the ref, so the snippet is simply unpinned. */
function useIntegrity(ref: string, version: string): string {
  const { browserApiOrigin } = useHubOrigins();
  const [pin, setPin] = React.useState({ key: "", integrity: "" });
  const key = `${ref}@${version}`;

  React.useEffect(() => {
    const controller = new AbortController();
    fetchVersionPins(browserApiOrigin, ref, controller.signal)
      .then((result) => {
        if (!result.ok) return;
        const integrity = result.versions.find((v) => v.version === version)?.integrity ?? "";
        setPin({ key: `${ref}@${version}`, integrity });
      })
      .catch(() => {
        // Aborted by a newer selection — that run owns the state.
      });
    return () => controller.abort();
  }, [browserApiOrigin, ref, version]);

  return pin.key === key ? pin.integrity : "";
}

function PanelTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{children}</h3>
  );
}
