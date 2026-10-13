import { Link } from "react-router";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { RuntimeBadges } from "@/Badges";
import { CapabilityLabel } from "@/Capability";
import { modulePagePath } from "@/module-ref";
import type { KindInfo } from "@/api";

type Entry = KindInfo & { entry?: "kind" | "instance" | "application"; name?: string };

const CHIP =
  "relative z-10 inline-flex items-center rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-foreground/80 transition-colors outline-none hover:border-primary/50 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring";

/** Where an entry lives on its module's page. */
export function entryAnchor(entry: Entry): string {
  return entry.entry === "instance" ? "#instances" : `#kind-${entry.kind}`;
}

/** One kind or ready-made instance of a module, as a chip.
 *
 *  The chip is a link to that entry on the module's page; its detail — which
 *  already travels in the search response — shows on hover or keyboard focus.
 *  A hover card rather than a click popover, so a chip inside the preview panel
 *  never stacks one overlay on another, and a tap simply follows the link. A
 *  module with no page (a local development ref) gets a focusable chip with the
 *  same card. */
export function KindChip({ entry, moduleRef }: { entry: Entry; moduleRef: string }) {
  const label = entry.name ?? entry.kind;
  const path = modulePagePath(moduleRef);
  return (
    <HoverCard openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>
        {path ? (
          <Link to={`${path}${entryAnchor(entry)}`} className={CHIP}>
            {label}
          </Link>
        ) : (
          <span tabIndex={0} className={CHIP}>
            {label}
          </span>
        )}
      </HoverCardTrigger>
      <HoverCardContent align="start" className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        <KindDetail entry={entry} />
      </HoverCardContent>
    </HoverCard>
  );
}

function KindDetail({ entry }: { entry: Entry }) {
  const replacement = entry.deprecated?.replacedBy;
  const instance = entry.entry === "instance";
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-sm font-medium">{entry.name ?? entry.kind}</span>
        {instance ? (
          <span className="text-xs text-muted-foreground">
            ready-made <code className="font-mono">{entry.kind}</code>
          </span>
        ) : (
          <CapabilityLabel kind={entry} />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1 empty:hidden">
        <RuntimeBadges runtime={entry.runtime} />
      </div>

      {entry.description && (
        <p className="text-xs leading-relaxed text-muted-foreground">{entry.description}</p>
      )}

      {entry.extends?.kind && (
        <p className="text-xs text-muted-foreground">
          Implements <code className="font-mono text-foreground">{entry.extends.kind}</code>
          {entry.extends.ref && (
            <>
              {" "}
              from <code className="font-mono break-all">{entry.extends.ref}</code>
            </>
          )}
        </p>
      )}

      {entry.deprecated?.reason && (
        <p className="text-xs text-destructive">
          Deprecated — {entry.deprecated.reason}
          {replacement?.kind && (
            <>
              {" "}
              Use <code className="font-mono">{replacement.kind}</code>
              {replacement.ref ? (
                <>
                  {" "}
                  from <code className="font-mono break-all">{replacement.ref}</code>
                </>
              ) : (
                <> (a kernel built-in)</>
              )}
              .
            </>
          )}
        </p>
      )}

      <p className="border-t border-border pt-2 text-xs text-muted-foreground">
        {instance ? (
          <>
            Reference it as <code className="font-mono">{`!ref <Alias>.${entry.name}`}</code>.
          </>
        ) : (
          <>
            Write it as <code className="font-mono">{`<Alias>.${entry.kind}`}</code> — the prefix is
            the alias you import the module under.
          </>
        )}
      </p>
    </>
  );
}
