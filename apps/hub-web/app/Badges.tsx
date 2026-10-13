import { AlertTriangle, Code2, Cpu, Globe } from "lucide-react";
import { Link } from "react-router";

import type { Category, RuntimeSupport } from "@/api";
import { catalogPath } from "@/catalog-filters";
import { cn } from "@/lib/utils";

/** How a kernel name reads on screen. The keys are the ecosystem's own labels
 *  (an `imports:` entry's `runtime:` field, and the implementation directory
 *  name), not a spelling invented here. Unknown kernels pass through verbatim so
 *  a hub that learns a third one needs no change. */
const KERNEL_LABELS: Record<string, string> = { nodejs: "Node", rust: "Rust" };
const LANGUAGE_LABELS: Record<string, string> = { javascript: "JavaScript", rust: "Rust" };

function label(map: Record<string, string>, value: string): string {
  return map[value] ?? value;
}

/** One badge system, one tone per question a badge answers — so a category, a
 *  kernel and a warning are told apart by colour before they are read. */
const TONES = {
  neutral: "bg-muted text-muted-foreground",
  version: "border border-border bg-background font-mono text-foreground",
  category: "bg-primary/10 text-primary",
  runtime: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  partial: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  portable: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  contract: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
  danger: "bg-destructive/10 text-destructive",
} as const;

export type BadgeTone = keyof typeof TONES;

const BADGE = "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs leading-4";

/** A badge, or — given `to` — a badge that is a link applying what it names. */
export function Badge({
  children,
  tone = "neutral",
  title,
  to,
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
  title?: string;
  to?: string;
}) {
  if (to) {
    return (
      <Link
        to={to}
        title={title}
        className={cn(
          BADGE,
          TONES[tone],
          "relative z-10 transition-shadow outline-none hover:ring-1 hover:ring-current/40 focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        {children}
      </Link>
    );
  }
  return (
    <span title={title} className={cn(BADGE, TONES[tone])}>
      {children}
    </span>
  );
}

export function VersionBadge({ version }: { version: string }) {
  return <Badge tone="version">v{version}</Badge>;
}

/** A module's categories. Each links to its category page, so a badge is also
 *  the way to "more like this". */
export function CategoryBadges({ categories }: { categories?: Category[] }) {
  if (!categories || categories.length === 0) return null;
  return (
    <>
      {categories.map((category) => (
        <Badge
          key={category.slug}
          tone="category"
          to={catalogPath(category.slug)}
          title={`Browse ${category.label}`}
        >
          {category.label}
        </Badge>
      ))}
    </>
  );
}

/**
 * Which kernels can run this, and what it is written in.
 *
 * The two are separate axes on purpose: `pkg:npm` and a bundled `pkg:telo/local/js`
 * are both JavaScript *and* Node-kernel, while a `pkg:cargo` controller is Rust
 * and runs on both kernels (Node builds it as a napi addon). Collapsing them
 * would make one of the two claims wrong. A kernel badge is tinted and carries
 * a chip glyph; a language badge is neutral with a code glyph.
 *
 * Renders nothing when the hub reported no runtime data — an older backend, or a
 * version tracked before the field existed. An empty space is honest; a "runs
 * nowhere" badge would not be.
 */
export function RuntimeBadges({ runtime }: { runtime?: RuntimeSupport | null }) {
  if (!runtime) return null;
  const { runtimes = [], full = [], languages = [], portable } = runtime;

  if (portable) {
    return (
      <Badge tone="portable" title="Declares no controllers, so any Telo kernel can run it.">
        <Globe className="size-3" aria-hidden /> Portable
      </Badge>
    );
  }

  if (runtimes.length === 0 && languages.length === 0) return null;

  return (
    <>
      {runtimes.map((kernel) => {
        // `full` is only sent for a module; a kind either runs on a kernel or
        // does not, so treat a missing list as full coverage.
        const partial = full.length > 0 && !full.includes(kernel);
        return (
          <Badge
            key={kernel}
            tone={partial ? "partial" : "runtime"}
            title={
              partial
                ? `Some of this module's kinds run on the ${label(KERNEL_LABELS, kernel)} kernel.`
                : `Runs on the ${label(KERNEL_LABELS, kernel)} kernel.`
            }
          >
            <Cpu className="size-3" aria-hidden />
            {label(KERNEL_LABELS, kernel)}
            {partial && <span className="opacity-80">partial</span>}
          </Badge>
        );
      })}
      {languages.map((lang) => (
        <Badge key={lang} title="Language the controllers are written in.">
          <Code2 className="size-3" aria-hidden />
          {label(LANGUAGE_LABELS, lang)}
        </Badge>
      ))}
    </>
  );
}

/** A deprecation notice with its replacement.
 *
 *  `replacedBy` is optional by design: a module superseded by a kernel built-in
 *  has no module ref to point at, so the reason carries the instruction. */
export function DeprecationNotice({
  reason,
  replacedBy,
}: {
  reason: string;
  replacedBy?: React.ReactNode;
}) {
  if (!reason) return null;
  return (
    <div
      role="note"
      className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">Deprecated</span>
        <span className="text-muted-foreground">{reason}</span>
        {replacedBy && <span className="text-muted-foreground">Use {replacedBy} instead.</span>}
      </div>
    </div>
  );
}
