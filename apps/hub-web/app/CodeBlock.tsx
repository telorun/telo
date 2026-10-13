import * as React from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Text to paste somewhere else, with the copy button inside the block it
 *  copies. `copy` is what lands on the clipboard when that differs from what is
 *  shown. */
export function CodeBlock({
  text,
  copy = text,
  label = "Copy",
}: {
  text: string;
  copy?: string;
  label?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="relative rounded-lg border border-border bg-muted/60">
      <pre className="overflow-x-auto px-3 py-2.5 pr-12 font-mono text-xs leading-relaxed">
        <code>{text}</code>
      </pre>
      <Button
        variant="outline"
        size="icon"
        className="absolute top-1.5 right-1.5 size-7"
        aria-label={copied ? "Copied" : label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(copy);
            setCopied(true);
          } catch {
            // Clipboard blocked (insecure origin / denied permission) — leave the
            // button unchanged rather than claiming a copy that did not happen.
          }
        }}
      >
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  );
}
