import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RuntimeBadges } from "@/Badges";
import { shortCapability } from "@/module-ref";
import type { ExportedResource, KindInfo } from "@/api";

/** Detail for one kind, on demand.
 *
 *  Scanning a result list is the common case, and opening a module to find out
 *  what one of its kinds does costs a navigation. Everything shown here already
 *  travels in the search response, so the popover is instant and adds no
 *  request — which is the only reason it is worth having over a link. */
export function KindPopover({ kind, className }: { kind: KindInfo; className?: string }) {
  const replacement = kind.deprecated?.replacedBy;
  return (
    <Popover>
      <PopoverTrigger
        // A button inside the row's anchor would nest interactive elements, so
        // callers render this outside the link — see SearchModules.
        className={
          className ??
          "rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        }
        aria-label={`Details for ${kind.kind}`}
      >
        {kind.kind}
      </PopoverTrigger>
      <PopoverContent align="start" className="max-w-[min(20rem,calc(100vw-2rem))]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-sm font-medium">{kind.kind}</span>
          <span className="text-xs text-muted-foreground">
            {kind.abstract ? "abstract" : shortCapability(kind.capability)}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <RuntimeBadges runtime={kind.runtime} />
        </div>

        {kind.description && (
          <p className="text-xs leading-relaxed text-muted-foreground">{kind.description}</p>
        )}

        {kind.extends?.kind && (
          <p className="text-xs text-muted-foreground">
            Implements <code className="font-mono">{kind.extends.kind}</code>
            {kind.extends.ref && (
              <>
                {" "}
                from <code className="font-mono break-all">{kind.extends.ref}</code>
              </>
            )}
          </p>
        )}

        {kind.deprecated?.reason && (
          <p className="text-xs text-destructive">
            Deprecated — {kind.deprecated.reason}
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

        <p className="text-[11px] text-muted-foreground">
          Write it as <code className="font-mono">{`<Alias>.${kind.kind}`}</code> — the prefix is
          the alias you choose when importing.
        </p>
      </PopoverContent>
    </Popover>
  );
}

/** Detail for one exported singleton instance.
 *
 *  A re-export carries no kind or description: the declaring doc lives in
 *  another module, so the hub has nothing local to report. Say that rather than
 *  showing an empty panel. */
export function ResourcePopover({ resource }: { resource: ExportedResource }) {
  const reExported = resource.declared.includes(".");
  return (
    <Popover>
      <PopoverTrigger
        className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        aria-label={`Details for ${resource.name}`}
      >
        {resource.name}
      </PopoverTrigger>
      <PopoverContent align="start" className="max-w-[min(20rem,calc(100vw-2rem))]">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-sm font-medium">{resource.name}</span>
          {resource.kind && (
            <span className="text-xs text-muted-foreground">
              an instance of <code className="font-mono">{resource.kind}</code>
            </span>
          )}
        </div>

        {resource.description && (
          <p className="text-xs leading-relaxed text-muted-foreground">{resource.description}</p>
        )}

        {reExported && (
          <p className="text-xs text-muted-foreground">
            Re-exported from <code className="font-mono">{resource.declared}</code> — it is declared
            in a module this one imports, so its details live there.
          </p>
        )}

        <p className="text-[11px] text-muted-foreground">
          Reference it as <code className="font-mono">{`!ref <Alias>.${resource.name}`}</code> — no
          need to declare your own.
        </p>
      </PopoverContent>
    </Popover>
  );
}
