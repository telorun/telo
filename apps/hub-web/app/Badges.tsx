import { AlertTriangle, Globe } from "lucide-react";

import type { RuntimeSupport } from "@/api";

/** How a kernel name reads on screen. The keys are the ecosystem's own labels
 *  (an `imports:` entry's `runtime:` field, and the implementation directory
 *  name), not a spelling invented here. Unknown kernels pass through verbatim so
 *  a hub that learns a third one needs no change. */
const KERNEL_LABELS: Record<string, string> = { nodejs: "Node", rust: "Rust" };
const LANGUAGE_LABELS: Record<string, string> = { javascript: "JavaScript", rust: "Rust" };

function label(map: Record<string, string>, value: string): string {
  return map[value] ?? value;
}

function Chip({
  children,
  tone = "muted",
  title,
}: {
  children: React.ReactNode;
  tone?: "muted" | "accent" | "warn";
  title?: string;
}) {
  const tones = {
    muted: "bg-muted text-muted-foreground",
    accent: "bg-primary/10 text-primary",
    warn: "bg-destructive/10 text-destructive",
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Which kernels can run this, and what it is written in.
 *
 * The two are separate axes on purpose: `pkg:npm` and a bundled `pkg:telo/local/js`
 * are both JavaScript *and* Node-kernel, while a `pkg:cargo` controller is Rust
 * and runs on both kernels (Node builds it as a napi addon). Collapsing them
 * would make one of the two claims wrong.
 *
 * Renders nothing when the hub reported no runtime data — an older backend, or a
 * version tracked before the field existed. An empty space is honest; a "runs
 * nowhere" badge would not be.
 */
export function RuntimeBadges({ runtime }: { runtime?: RuntimeSupport }) {
  if (!runtime) return null;
  const { runtimes = [], full = [], languages = [], portable } = runtime;

  if (portable) {
    return (
      <Chip tone="accent" title="Declares no controllers, so any Telo kernel can run it.">
        <Globe className="size-3" /> Portable
      </Chip>
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
          <Chip
            key={kernel}
            title={
              partial
                ? `Some of this module's kinds run on the ${label(KERNEL_LABELS, kernel)} kernel.`
                : `Runs on the ${label(KERNEL_LABELS, kernel)} kernel.`
            }
          >
            {label(KERNEL_LABELS, kernel)}
            {partial && <span className="opacity-70">partial</span>}
          </Chip>
        );
      })}
      {languages.map((lang) => (
        <Chip key={lang} title="Language the controllers are written in.">
          {label(LANGUAGE_LABELS, lang)}
        </Chip>
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
