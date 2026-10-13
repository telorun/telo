import * as React from "react";
import { ChevronRight, Loader2 } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useHubOrigins } from "@/hub-origins";
import { fetchManifestText } from "@/api";

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; text: string }
  | { kind: "failed"; error: string };

/** The version's `telo.yaml` as its author wrote it, comments and tags
 *  included. Read on first open — it is the longest thing on the page and most
 *  readers never open it — and shown with light colouring for keys, comments,
 *  tags and document breaks. */
export function ManifestSource({ moduleRef, version }: { moduleRef: string; version: string }) {
  const { browserApiOrigin } = useHubOrigins();
  const [state, setState] = React.useState<State>({ kind: "idle" });
  const controller = React.useRef<AbortController | null>(null);

  React.useEffect(() => () => controller.current?.abort(), []);

  const onOpenChange = (open: boolean) => {
    if (!open || state.kind !== "idle") return;
    controller.current = new AbortController();
    setState({ kind: "loading" });
    fetchManifestText(browserApiOrigin, moduleRef, version, controller.current.signal)
      .then((result) =>
        setState(result.ok ? { kind: "ready", text: result.text } : { kind: "failed", error: result.error }),
      )
      .catch(() => {
        // Aborted by unmount; nothing is left to update.
      });
  };

  return (
    <Collapsible id="manifest" onOpenChange={onOpenChange} className="flex flex-col gap-3">
      <CollapsibleTrigger className="group flex items-center gap-1.5 self-start rounded text-xs font-medium tracking-wide text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
        Manifest source
      </CollapsibleTrigger>
      <CollapsibleContent>
        {state.kind === "loading" && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </p>
        )}
        {state.kind === "failed" && (
          <p className="text-xs text-destructive">Could not load the manifest: {state.error}</p>
        )}
        {state.kind === "ready" && (
          <pre className="max-h-[32rem] overflow-auto rounded-xl border border-border bg-card p-4 font-mono text-xs leading-relaxed">
            <code>
              {state.text.split("\n").map((line, i) => (
                <React.Fragment key={i}>
                  <YamlLine line={line} />
                  {"\n"}
                </React.Fragment>
              ))}
            </code>
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** `  key: !tag value  # comment`, in parts. Deliberately line-by-line: block
 *  scalars and flow collections are not tracked, so text inside one that
 *  happens to look like a key is coloured as one. Reading aid, not a parser. */
const KEYED = /^(\s*(?:- )*)([^\s#:"'][^:#]*?)(:)(\s|$)(.*)$/;

function YamlLine({ line }: { line: string }) {
  if (/^\s*#/.test(line)) return <span className="text-muted-foreground italic">{line}</span>;
  if (/^(---|\.\.\.)\s*$/.test(line)) return <span className="text-muted-foreground">{line}</span>;
  const keyed = KEYED.exec(line);
  if (!keyed) return <YamlValue text={line} />;
  const [, indent, key, colon, gap, rest] = keyed;
  return (
    <>
      {indent}
      <span className="text-primary">{key}</span>
      {colon}
      {gap}
      <YamlValue text={rest} />
    </>
  );
}

function YamlValue({ text }: { text: string }) {
  const tagged = /^(\s*(?:- )?)(![\w-]+)(.*)$/.exec(text);
  if (!tagged) return <>{text}</>;
  return (
    <>
      {tagged[1]}
      <span className="text-violet-600 dark:text-violet-300">{tagged[2]}</span>
      {tagged[3]}
    </>
  );
}
