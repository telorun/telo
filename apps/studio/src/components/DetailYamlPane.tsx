import type { OnMount } from "@monaco-editor/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModuleDocument, ModuleSourceFile } from "../model";
import type { LocatedDiagnostic } from "../diagnostics-aggregate";
import { parseModuleDocument, moduleParseError } from "../yaml-document";
import { CodeEditor } from "./code-editor";
import { toMonacoMarker } from "./views/source/markers";
import { locateSlice, rangeInSlice, spliceSlice, type LocatedSlice } from "./detail-yaml-slice";

const DEBOUNCE_MS = 500;

type MonacoEditor = Parameters<OnMount>[0];
type Monaco = Parameters<OnMount>[1];

interface DetailYamlPaneProps {
  sourceFiles: ModuleSourceFile[];
  resource: { kind: string; name: string };
  /** JSON pointer into the resource, or "" for the whole resource document. */
  pointer: string;
  readOnly: boolean;
  onSourceEdit: (filePath: string, moduleDoc: ModuleDocument) => void;
  /** The resource's analyzer diagnostics, addressed to the FILE. Those falling
   *  inside the slice are shown on the lines they belong to. */
  diagnostics: readonly LocatedDiagnostic[];
}

/**
 * The selected node's own YAML, editable in place.
 *
 * A commit SPLICES the edited span back into the file and re-parses the whole
 * file — the source view's write path, not the form's. The form's path diffs a
 * projected fields object and applies AST ops, which loses every comment inside
 * a structurally replaced subtree; splicing the span the pane just showed keeps
 * read and write symmetric, so what a user reads is what they edit.
 *
 * Validity is judged on the SPLICED FILE, never on the slice alone. A slice is
 * frequently not a standalone YAML document (a block scalar's body, a sequence
 * item's contents), so parsing it in isolation would invent errors for text that
 * is perfectly valid where it actually lives.
 */
export function DetailYamlPane({
  sourceFiles,
  resource,
  pointer,
  readOnly,
  onSourceEdit,
  diagnostics,
}: DetailYamlPaneProps) {
  const located = useMemo(
    () => locateSlice(sourceFiles, resource.kind, resource.name, pointer),
    [sourceFiles, resource.kind, resource.name, pointer],
  );

  const [buffer, setBuffer] = useState(located?.slice.text ?? "");
  const [parseError, setParseError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  // Set when a commit is handed to the host, cleared by the next incoming slice.
  // That bounce is our own edit coming back through the workspace, and absorbing
  // it is what stops the re-seed below from overwriting the buffer the user is
  // still in — the incoming text is only byte-identical when the re-indent
  // round-trips exactly, which a hand-indented line need not.
  const bouncingRef = useRef(false);

  // Refs the debounce and the flush read when they fire — each has advanced
  // past whatever scheduled it.
  const bufferRef = useRef(buffer);
  const readOnlyRef = useRef(readOnly);
  const onSourceEditRef = useRef(onSourceEdit);
  bufferRef.current = buffer;
  readOnlyRef.current = readOnly;
  onSourceEditRef.current = onSourceEdit;

  const identity = `${resource.kind} ${resource.name} ${pointer}`;
  const identityRef = useRef(identity);

  // The slice a pending commit writes into. Refreshed only while the identity
  // holds, so a workspace update mid-edit is adopted (the file text and the
  // node's offsets both move) while a MOVE to another node leaves it pointing
  // at the node the user was typing in — which is what the flush commits to.
  const targetRef = useRef(located);
  if (identityRef.current === identity) targetRef.current = located;
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function commit(target: LocatedSlice, text: string) {
    const nextText = spliceSlice(target.fileText, target.slice, text);
    let moduleDoc: ModuleDocument;
    try {
      moduleDoc = parseModuleDocument(target.filePath, nextText);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
      return;
    }
    const error = moduleParseError(moduleDoc);
    if (error) {
      // The edit stays in the buffer and `dirty` stays set, so the next
      // keystroke retries. Committing unparseable text would take the whole
      // module's AST down with it.
      setParseError(error);
      return;
    }
    setParseError(null);
    dirtyRef.current = false;
    bouncingRef.current = true;
    onSourceEditRef.current(target.filePath, moduleDoc);
  }

  function flush() {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    const target = targetRef.current;
    if (!dirtyRef.current || !target || readOnlyRef.current) return;
    commit(target, bufferRef.current);
  }

  // The debounce is scheduled by the keystroke, NOT by an effect over `buffer`:
  // an effect's cleanup runs on every buffer change, so flushing there committed
  // (and re-parsed the whole module) once per character — the debounce existed
  // and never applied.
  function handleChange(next: string) {
    dirtyRef.current = true;
    setBuffer(next);
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      const target = targetRef.current;
      if (!dirtyRef.current || !target || readOnlyRef.current) return;
      commit(target, bufferRef.current);
    }, DEBOUNCE_MS);
  }

  const incoming = located?.slice.text;
  useEffect(() => {
    // A different node is a different buffer — always re-seed, and drop the
    // dirty state, which belongs to the node just left (the flush below has
    // already committed it). `targetRef` moves here too: a re-seed that sets an
    // identical string bails out of the re-render, so waiting for the next
    // render to adopt the new slice would leave the next edit aimed at the node
    // the user has already left.
    if (identityRef.current !== identity) {
      identityRef.current = identity;
      targetRef.current = located;
      dirtyRef.current = false;
      bouncingRef.current = false;
      setParseError(null);
      setBuffer(incoming ?? "");
      return;
    }
    if (incoming === undefined) return;
    if (bouncingRef.current) {
      bouncingRef.current = false;
      return;
    }
    if (dirtyRef.current) return;
    setBuffer(incoming);
    // `located` is read only on the identity-change branch, where it is this
    // render's value by construction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, incoming]);

  // Flush on the way out — moving to another node, or unmounting (switching
  // back to the form), inside the debounce window would otherwise drop the
  // edit. Keyed on identity alone: React runs every cleanup before any effect
  // body, so this commits to the old node before the re-seed above swaps in the
  // new one.
  useEffect(
    () => () => flush(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity],
  );

  // Analyzer diagnostics on the lines they belong to. Positions are the FILE's,
  // so each is shifted into the slice; one falling outside is dropped rather
  // than clamped, which would underline a line it says nothing about.
  const handles = useRef<{ editor: MonacoEditor; monaco: Monaco } | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const current = handles.current;
    const model = current?.editor.getModel();
    if (!current || !model || !located) return;
    const markers = diagnostics
      .filter((entry) => entry.filePath === located.filePath)
      .flatMap((entry) => {
        const range = rangeInSlice(located.fileText, located.slice, entry.diagnostic.range);
        if (!range) return [];
        return [toMonacoMarker({ ...entry.diagnostic, range }, current.monaco)];
      });
    current.monaco.editor.setModelMarkers(model, "telo", markers);
    // `buffer` is a dependency because a marker sits at a position in the text
    // the user may have moved since the analysis that produced it.
  }, [diagnostics, located, buffer, ready]);

  if (!located) {
    return (
      <p className="p-3 text-xs text-zinc-400 dark:text-zinc-600">
        {pointer
          ? `Nothing is written at ${pointer} yet — author it in the form, then it appears here.`
          : "No source document found for this resource."}
      </p>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {parseError && (
        <p className="shrink-0 border-b border-red-500/30 bg-red-500/10 px-3 py-1 text-xs text-red-700 dark:text-red-300">
          {parseError}
        </p>
      )}
      <div className="min-h-0 flex-1 p-2">
        <CodeEditor
          value={buffer}
          onValueChange={handleChange}
          mimeType="application/yaml"
          height="100%"
          readOnly={readOnly}
          className="h-full"
          onReady={(editor, monaco) => {
            handles.current = { editor, monaco };
            setReady(true);
          }}
        />
      </div>
    </div>
  );
}
