import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useCelFieldSource } from "../../language/cel-field-context";
import {
  bindCelField,
  CEL_FIELD_LANGUAGE_ID,
  registerCelFieldLanguage,
  type CelFieldBinding,
} from "../../language/cel-field-provider";
import { useMonacoTheme } from "../../theme/color-mode";
import type { CelFieldTarget } from "./types";

type MonacoEditor = Parameters<OnMount>[0];

interface CelExpressionEditorProps {
  /** The tag the scalar is written under, without its `!`. */
  tag: string;
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
 * A tagged scalar holding CEL — a `!cel` body, or text with `${{ }}` holes —
 * with the completions the module's engine resolves for this exact site,
 * inside whichever expression the cursor is in.
 *
 * The alternative — a plain text box — is what the field had, and it made the
 * editor the one surface where an author writing CEL has no idea what is in
 * scope, while the same names are offered a keystroke away in the source view.
 * Nothing here models the scope: the candidates come from the engine the
 * module is edited against, so the list is the same claim `telo check` makes.
 */
export function CelExpressionEditor({
  tag,
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
  const source = useCelFieldSource();
  const binding: CelFieldBinding | undefined = source
    ? {
        session: source.session,
        site: { modulePath: source.modulePath, resource: target.resource, path: target.path, tag },
      }
    : undefined;
  const bindingRef = useRef(binding);
  bindingRef.current = binding;

  // Re-bound on every render: the same field can move to another resource or
  // path while the model stays (a selection change re-renders the form), and a
  // stale binding would resolve the scope of the field the user just left.
  useEffect(() => {
    const uri = uriRef.current;
    if (uri) bindCelField(uri, binding);
  });

  useEffect(
    () => () => {
      const uri = uriRef.current;
      if (uri) bindCelField(uri, undefined);
    },
    [],
  );

  const handleMount: OnMount = (editor: MonacoEditor, monaco) => {
    registerCelFieldLanguage(monaco);
    const model = editor.getModel();
    if (model) {
      uriRef.current = model.uri.toString();
      bindCelField(model.uri.toString(), bindingRef.current);
      monaco.editor.setModelLanguage(model, CEL_FIELD_LANGUAGE_ID);
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
        language={CEL_FIELD_LANGUAGE_ID}
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
