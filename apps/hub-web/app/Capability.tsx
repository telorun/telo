import {
  Box,
  Cable,
  Inbox,
  Play,
  Plug,
  Puzzle,
  Server,
  Shapes,
  Sigma,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { shortCapability } from "@/module-ref";

/** The kernel's capabilities are a closed set, so each can have a glyph. An
 *  unknown one — a hub ahead of this app — falls back to a plain box. */
const CAPABILITIES: Record<string, { icon: LucideIcon; label: string; plural: string }> = {
  "Telo.Service": { icon: Server, label: "Service", plural: "Services" },
  "Telo.Runnable": { icon: Play, label: "Runnable", plural: "Runnables" },
  "Telo.Invocable": { icon: Zap, label: "Invocable", plural: "Invocables" },
  "Telo.Provider": { icon: Plug, label: "Provider", plural: "Providers" },
  "Telo.Mount": { icon: Cable, label: "Mount", plural: "Mounts" },
  "Telo.Sink": { icon: Inbox, label: "Sink", plural: "Sinks" },
  "Telo.Type": { icon: Shapes, label: "Type", plural: "Types" },
  "Telo.Callable": { icon: Sigma, label: "Function", plural: "Functions" },
};

const CONTRACT = { icon: Puzzle, label: "Contract", plural: "Contracts" };

/** How a kind's role reads: a contract (an abstract kind others implement) or
 *  its capability. */
export function capabilityOf(kind: { capability: string; abstract?: boolean }) {
  if (kind.abstract) return CONTRACT;
  const label = shortCapability(kind.capability) || "Kind";
  return CAPABILITIES[kind.capability] ?? { icon: Box, label, plural: label };
}

export function CapabilityLabel({
  kind,
  className,
}: {
  kind: { capability: string; abstract?: boolean };
  className?: string;
}) {
  const { icon: Icon, label } = capabilityOf(kind);
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground", className)}>
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}
