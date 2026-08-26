import { buildCelSegments } from "@telorun/analyzer";
import { celCompletions } from "@telorun/ide-support";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor, Position } from "monaco-editor";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useMonacoTheme } from "../../theme/color-mode";
import { analysisRef } from "../views/source/provider-state";
import type { CelFieldTarget } from "./types";

type Monaco = Parameters<OnMount>[1];
type MonacoEditor = Parameters<OnMount>[0];

/** Its own language id rather than a mode of `yaml`: the source view registers
 *  its providers on `yaml`, and a model holding a bare CEL body is not a YAML
 *  document — offering it a manifest key would be a completion that cannot
 *  apply. */
const CEL_LANGUAGE_ID = "telo-cel";

/**
 * Which resource and which field each open CEL model belongs to.
 *
 * Monaco resolves a completion provider per LANGUAGE, so the provider is
 * registered once and reads what it needs per model — the `provider-state`
 * pattern the source view's providers already use, keyed by model here because
 * several fields can be open at once (a form and the panel beside it).
 */
const targets = new Map<string, CelFieldTarget & { path: string }>();

let registered = false;

function registerCelLanguage(monaco: Monaco): void {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: CEL_LANGUAGE_ID });

  monaco.languages.registerCompletionItemProvider(CEL_LANGUAGE_ID, {
    triggerCharacters: ["."],
    provideCompletionItems(model: editor.ITextModel, position: Position) {
      const target = targets.get(model.uri.toString());
      // The analysis of the module on screen — the same resolutions that
      // produced its diagnostics, so what is offered is what type-checks.
      const query = analysisRef.current?.celScope;
      if (!target || !query) return { suggestions: [] };

      const text = model.getValue();
      // The field holds a `!cel` BODY, so it is one segment spanning the whole
      // text. Completion never parses it — `celCursorChain` is textual, which
      // is what keeps the list alive while `request.` is mid-typed.
      const segment = buildCelSegments(text, 0, "!cel", text)[0];
      if (!segment) return { suggestions: [] };

      const results = celCompletions(
        text,
        segment,
        model.getOffsetAt(position),
        target.path,
        target.resource,
        query,
      );

      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return {
        suggestions: results.map((r) => ({
          label: r.label,
          kind:
            r.kind === "value"
              ? monaco.languages.CompletionItemKind.Function
              : monaco.languages.CompletionItemKind.Property,
          detail: r.detail,
          documentation: r.documentation,
          insertText: r.insertText ?? r.label,
          sortText: r.sortText,
          range,
        })),
      };
    },
  });
}

interface CelExpressionEditorProps {
  value: string;
  onValueChange: (next: string) => void;
  onBlur?: () => void;
  /** The site this expression is written at — what its scope is resolved for. */
  target: CelFieldTarget & { path: string };
  className?: string;
}

const LINE_HEIGHT = 19;
/** Breathing room inside the box. Given to MONACO rather than to the wrapper so
 *  it is part of `contentHeight` — the height then follows the content exactly,
 *  instead of the wrapper adding space Monaco does not know about and leaving a
 *  one-line field looking bottom-heavy. */
const PADDING_Y = 4;
/** Left inset for the text. With line numbers, folding and the glyph margin all
 *  off, the decorations gutter is the only thing between the border and the
 *  first character, and zeroing it put the text flush against the border. */
const PADDING_X = 8;

/**
 * A CEL body with the completions the analyzer resolves for this exact site.
 *
 * The alternative — a plain text box — is what the field had, and it made the
 * editor the one surface where an author writing CEL has no idea what is in
 * scope, while the same names are offered a keystroke away in the source view.
 * Nothing here models the scope: the candidates come from `celCompletions` over
 * the analysis on screen, so the list is the same claim `telo check` makes.
 */
export function CelExpressionEditor({
  value,
  onValueChange,
  onBlur,
  target,
  className,
}: CelExpressionEditorProps) {
  const monacoTheme = useMonacoTheme();
  const [height, setHeight] = useState(LINE_HEIGHT + PADDING_Y * 2);
  const onBlurRef = useRef(onBlur);
  onBlurRef.current = onBlur;
  const uriRef = useRef<string | undefined>(undefined);
  const targetRef = useRef(target);
  targetRef.current = target;

  // Re-published on every render: the same field can move to another resource
  // or path while the model stays (a selection change re-renders the form), and
  // a stale entry would resolve the scope of the field the user just left.
  useEffect(() => {
    const uri = uriRef.current;
    if (uri) targets.set(uri, target);
  });

  useEffect(
    () => () => {
      const uri = uriRef.current;
      if (uri) targets.delete(uri);
    },
    [],
  );

  const handleMount: OnMount = (editor: MonacoEditor, monaco) => {
    registerCelLanguage(monaco);
    const model = editor.getModel();
    if (model) {
      uriRef.current = model.uri.toString();
      targets.set(model.uri.toString(), targetRef.current);
      monaco.editor.setModelLanguage(model, CEL_LANGUAGE_ID);
    }
    editor.onDidBlurEditorWidget(() => onBlurRef.current?.());
    const fit = () =>
      setHeight(Math.max(LINE_HEIGHT + PADDING_Y * 2, editor.getContentHeight()));
    fit();
    editor.onDidContentSizeChange(fit);
  };

  return (
    <div
      // Named so a field carrying a diagnostic can colour its frame — Monaco
      // paints its own interior, so the frame is what is left to say it.
      data-cel-box=""
      className={cn(
        "overflow-hidden rounded border border-violet-300 bg-violet-50/50 dark:border-violet-700 dark:bg-violet-950/30",
        className,
      )}
    >
      <Editor
        height={height}
        language={CEL_LANGUAGE_ID}
        theme={monacoTheme}
        value={value}
        onChange={(next) => onValueChange(next ?? "")}
        onMount={handleMount}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineNumbers: "off",
          folding: false,
          glyphMargin: false,
          lineDecorationsWidth: PADDING_X,
          lineNumbersMinChars: 0,
          overviewRulerLanes: 0,
          padding: { top: PADDING_Y, bottom: PADDING_Y },
          scrollBeyondLastLine: false,
          scrollbar: { vertical: "hidden", horizontalScrollbarSize: 6 },
          renderLineHighlight: "none",
          automaticLayout: true,
          // Only the scope's names, never words scraped from the buffer: a
          // suggestion that came from the text the author just typed is a
          // suggestion nothing checked.
          wordBasedSuggestions: "off",
          quickSuggestions: true,
          suggestOnTriggerCharacters: true,
          tabSize: 2,
          fixedOverflowWidgets: true,
        }}
      />
    </div>
  );
}
