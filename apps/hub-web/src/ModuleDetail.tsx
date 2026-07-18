import * as React from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { moduleLabel, shortCapability } from "@/module-ref";
import { fetchModuleVersions, type ModuleHit } from "@/api";

export function ModuleDetail({ hit }: { hit: ModuleHit }) {
  const { ref, version, description } = hit.module;
  const pinned = `${ref}@${version}`;
  const matched = new Set(hit.matchedKinds.map((k) => k.kind));
  const otherKinds = hit.exportedKinds.filter((k) => !matched.has(k));

  const [versions, setVersions] = React.useState<string[]>([]);
  React.useEffect(() => {
    const controller = new AbortController();
    setVersions([]);
    fetchModuleVersions(ref, controller.signal).then(setVersions).catch(() => {
      // Version list is supplementary — the pane still shows the latest version.
    });
    return () => controller.abort();
  }, [ref]);

  return (
    <div className="flex flex-col gap-5">
      {/* pr-10 keeps the heading clear of the sheet's close button. */}
      <div className="flex flex-col gap-2 pr-10">
        <SheetTitle>{moduleLabel(ref)}</SheetTitle>
        <code className="font-mono text-xs break-all text-muted-foreground">{ref}</code>
        <div className="flex items-center gap-2">
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">v{version}</span>
          <span className="text-xs text-muted-foreground">latest tracked</span>
        </div>
      </div>

      {/* Always rendered: Radix uses it for the dialog's accessible description. */}
      <SheetDescription className="leading-relaxed">
        {description || "This module publishes no description."}
      </SheetDescription>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Import it
        </h3>
        {/* The prefix in `kind:` is the importer's own alias, so the snippet
            shows a placeholder rather than inventing a canonical name. */}
        <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
          <code>{`imports:\n  Alias: ${pinned}`}</code>
        </pre>
        <CopyButton value={pinned} label="Copy ref" />
      </section>

      {hit.matchedKinds.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Matching kinds
          </h3>
          <ul className="flex flex-col gap-2.5">
            {hit.matchedKinds.map((k) => (
              <li key={k.kind} className="flex flex-col gap-0.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-sm font-medium">{k.kind}</span>
                  <span className="text-xs text-muted-foreground">
                    {shortCapability(k.capability)}
                  </span>
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
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Ready-made instances
          </h3>
          <p className="text-xs text-muted-foreground">
            Reference directly as <code className="font-mono">!ref Alias.name</code> — no need to
            declare your own.
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {hit.exportedResources.map((name) => (
              <li key={name} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {name}
              </li>
            ))}
          </ul>
        </section>
      )}

      {otherKinds.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Also exports
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {otherKinds.map((k) => (
              <li
                key={k}
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
              >
                {k}
              </li>
            ))}
          </ul>
        </section>
      )}

      {versions.length > 1 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Tracked versions
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {versions.map((v) => (
              <li
                key={v}
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
              >
                {v}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      variant="outline"
      size="sm"
      className="self-start"
      aria-label={`${label}: ${value}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          // Clipboard blocked (insecure origin / denied permission) — leave the
          // button unchanged rather than claiming a copy that did not happen.
        }
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : label}
    </Button>
  );
}
