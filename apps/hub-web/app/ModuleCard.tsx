import { ChevronRight, Eye } from "lucide-react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { Badge, CategoryBadges, RuntimeBadges, VersionBadge } from "@/Badges";
import { Highlight } from "@/Highlight";
import { KindChip } from "@/KindChip";
import { cn } from "@/lib/utils";
import { ModuleAvatar } from "@/ModuleAvatar";
import { ModuleLink } from "@/ModuleLink";
import { moduleDisplayName, modulePagePath } from "@/module-ref";
import type { ModuleHit } from "@/api";

/** How many matched kinds a card names before it stops. Enough to recognise the
 *  module without turning the card into a wall of chips. */
const INLINE_KINDS = 4;

/** Every kind the module exports is abstract, so importing it alone gives
 *  nothing to instantiate — an implementation is what to use. */
export function contractOnly(hit: ModuleHit): boolean {
  return hit.exportedKinds.length > 0 && hit.exportedKinds.every((k) => k.abstract);
}

/** Marks a card's opener, which the list's arrow-key navigation moves between. */
export const RESULT_OPENER = "data-result-opener";

/** Above the card's stretched opener, so it takes its own clicks. */
const RAISED = "relative z-10";

/**
 * One module in the catalogue.
 *
 * The whole card opens the module's page: its name is a real link stretched
 * over the card, so a click anywhere, a middle-click and the keyboard all do
 * what a link does. Quick look is the explicit second action, for comparing
 * candidates without leaving the list. A module with no page (a local
 * development ref) can only be looked at, so its card opens the quick look.
 *
 * Everything else that is clickable — kinds, categories, related modules — sits
 * above the stretched link and goes where it says.
 */
export function ModuleCard({
  hit,
  query,
  compact,
  selected,
  backTo,
  showTracked,
  onPreview,
}: {
  hit: ModuleHit;
  query: string;
  /** The grid's card: the same content, stacked for a narrow column. */
  compact: boolean;
  selected: boolean;
  /** The catalogue URL this card was listed under, for the page's way back. */
  backTo: string;
  /** Show when the hub first tracked the version — the list is ordered by it. */
  showTracked: boolean;
  onPreview: () => void;
}) {
  const m = hit.module;
  const path = modulePagePath(m.ref);
  const name = <Highlight text={moduleDisplayName(m)} query={query} />;
  const opener =
    "truncate font-semibold tracking-tight outline-none after:absolute after:inset-0 after:rounded-xl";

  return (
    <li
      data-selected={selected || undefined}
      className="group relative flex gap-3 rounded-xl border border-border bg-card p-4 transition-[border-color,box-shadow] hover:border-primary/40 hover:shadow-md has-[[data-result-opener]:focus-visible]:border-primary has-[[data-result-opener]:focus-visible]:ring-3 has-[[data-result-opener]:focus-visible]:ring-ring/40 data-selected:border-primary data-selected:bg-accent/40"
    >
      <ModuleAvatar module={m} />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          {path ? (
            <Link to={path} state={{ backTo }} {...{ [RESULT_OPENER]: "" }} className={opener}>
              {name}
            </Link>
          ) : (
            <button
              type="button"
              onClick={onPreview}
              {...{ [RESULT_OPENER]: "" }}
              className={cn(opener, "text-left")}
            >
              {name}
            </button>
          )}
          <VersionBadge version={m.version} />

          <span className="ml-auto flex shrink-0 items-center gap-1">
            {path && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onPreview}
                aria-label={`Quick look at ${moduleDisplayName(m)}`}
                // Hidden until the card is pointed at or focused; a touch
                // screen has neither, so there it always shows.
                className={cn(
                  RAISED,
                  "h-7 px-2 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
                )}
              >
                <Eye /> <span className={cn(compact && "sr-only")}>Quick look</span>
              </Button>
            )}
            <ChevronRight
              aria-hidden
              className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
            />
          </span>
        </div>

        {/* The full ref, because the name is only what the author calls it and
            two modules on different hosts can share one. */}
        <span className="truncate font-mono text-xs text-muted-foreground" title={m.ref}>
          {m.ref}
          {/* The date part of an RFC 3339 instant, so server and browser print
              the same text whatever their time zones. */}
          {showTracked && m.trackedAt && (
            <span className="font-sans"> · added {m.trackedAt.slice(0, 10)}</span>
          )}
        </span>

        {m.description && (
          <p
            className={cn(
              "text-sm leading-relaxed text-muted-foreground",
              compact ? "line-clamp-3" : "line-clamp-2",
            )}
          >
            <Highlight text={m.description} query={query} />
          </p>
        )}

        {hit.application && <ApplicationSummary application={hit.application} />}

        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {m.deprecated?.reason && <Badge tone="danger">Deprecated</Badge>}
          {hit.application && <Badge tone="contract">Application</Badge>}
          {contractOnly(hit) && (
            <Badge
              tone="contract"
              title="Every kind here is a contract — import an implementation to get something to run."
            >
              Contract only
            </Badge>
          )}
          {!hit.application &&
            hit.matchedKinds
              .slice(0, INLINE_KINDS)
              .map((k) => (
                <KindChip key={`${k.entry ?? "kind"}:${k.name ?? k.kind}`} entry={k} moduleRef={m.ref} />
              ))}
          {!hit.application && hit.matchedKinds.length > INLINE_KINDS && (
            <button
              type="button"
              onClick={onPreview}
              className={cn(
                RAISED,
                "rounded-md px-1 py-0.5 text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              +{hit.matchedKinds.length - INLINE_KINDS} more
            </button>
          )}
          <span className={cn("flex flex-wrap items-center gap-1.5", !compact && "ml-auto")}>
            <CategoryBadges categories={m.categories} />
            <RuntimeBadges runtime={m.runtime} />
          </span>
        </div>

        {contractOnly(hit) && hit.implementations && hit.implementations.length > 0 && (
          <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            <span>Implemented by</span>
            {hit.implementations.map((i) => (
              <ModuleLink
                key={i.ref}
                moduleRef={i.ref}
                title={i.ref}
                className={cn(RAISED, "font-medium text-primary underline-offset-2 hover:underline")}
              >
                {moduleDisplayName(i)}
              </ModuleLink>
            ))}
          </p>
        )}

        {hit.siblings && hit.siblings.length > 0 && (
          <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            <span>{hit.siblings.length} more like this:</span>
            {hit.siblings.map((s) => (
              <ModuleLink
                key={s.ref}
                moduleRef={s.ref}
                title={s.description || s.ref}
                className={cn(RAISED, "font-mono text-primary underline-offset-2 hover:underline")}
              >
                {s.matchedKinds[0]?.name ?? moduleDisplayName(s)}
              </ModuleLink>
            ))}
          </p>
        )}
      </div>
    </li>
  );
}

/** What an application asks for before it runs, in one line. */
function ApplicationSummary({ application }: { application: NonNullable<ModuleHit["application"]> }) {
  const parts = [
    [application.variables?.length ?? 0, "variable"],
    [application.secrets?.length ?? 0, "secret"],
    [application.ports?.length ?? 0, "port"],
  ]
    .filter(([count]) => (count as number) > 0)
    .map(([count, noun]) => `${count} ${noun}${count === 1 ? "" : "s"}`);
  return (
    <p className="text-xs text-muted-foreground">
      {parts.length > 0 ? `Asks for ${parts.join(", ")}.` : "Runs with no inputs."}
    </p>
  );
}
