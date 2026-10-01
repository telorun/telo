import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

function entriesOf(value: object): Array<[string, unknown]> {
  return Array.isArray(value) ? value.map((item, i) => [String(i), item]) : Object.entries(value);
}

function Scalar({ value }: { value: unknown }) {
  return (
    <span className="whitespace-pre-wrap break-words">
      {typeof value === "string" ? value : String(value)}
    </span>
  );
}

function Node({ label, value, depth }: { label: string; value: unknown; depth: number }) {
  // The first level is what the result holds; anything deeper opens on request.
  const [open, setOpen] = useState(depth === 0);
  if (value === null || typeof value !== "object") {
    return (
      <div className="flex gap-1.5">
        <span className="shrink-0 text-muted-foreground">{label}:</span>
        <Scalar value={value} />
      </div>
    );
  }
  const entries = entriesOf(value);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        {label}
        <span>{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-1.5 border-l pl-3">
        {entries.map(([key, item]) => (
          <Node key={key} label={key} value={item} depth={depth + 1} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Structured data as a tree whose branches fold, rather than as JSON text. */
export function JsonTree({ value }: { value: unknown }) {
  if (value === null || typeof value !== "object") {
    return (
      <div className="font-mono text-xs">
        <Scalar value={value} />
      </div>
    );
  }
  return (
    <div className="space-y-0.5 font-mono text-xs">
      {entriesOf(value).map(([key, item]) => (
        <Node key={key} label={key} value={item} depth={0} />
      ))}
    </div>
  );
}
