import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface CodeEditorProps {
  value: string;
  onValueChange: (next: string) => void;
  onBlur?: () => void;
  /** IANA media type (e.g. "application/javascript"). Resolved to a Monaco
   *  language id via Monaco's own language registry at mount time. The editor
   *  holds no table of language ids itself — unknown/missing mime types fall
   *  back to `plaintext`. */
  mimeType?: string;
  height?: string | number;
  readOnly?: boolean;
  className?: string;
}

type Monaco = Parameters<OnMount>[1];

function resolveLanguageId(monaco: Monaco, mimeType: string | undefined): string {
  if (!mimeType) return "plaintext";
  const match = monaco.languages.getLanguages().find(
    (lang) => lang.mimetypes?.includes(mimeType),
  );
  return match?.id ?? "plaintext";
}

export function CodeEditor({
  value,
  onValueChange,
  onBlur,
  mimeType,
  height = 200,
  readOnly = false,
  className,
}: CodeEditorProps) {
  const onBlurRef = useRef(onBlur);
  useEffect(() => {
    onBlurRef.current = onBlur;
  }, [onBlur]);

  type Editor = Parameters<OnMount>[0];
  const [handles, setHandles] = useState<{ editor: Editor; monaco: Monaco } | null>(null);

  const handleMount: OnMount = (editor, monaco) => {
    editor.onDidBlurEditorWidget(() => onBlurRef.current?.());
    setHandles({ editor, monaco });
  };

  useEffect(() => {
    if (!handles) return;
    const model = handles.editor.getModel();
    if (!model) return;
    handles.monaco.editor.setModelLanguage(
      model,
      resolveLanguageId(handles.monaco, mimeType),
    );
  }, [handles, mimeType]);

  return (
    <div
      className={cn(
        "overflow-hidden rounded border border-zinc-300 dark:border-zinc-700",
        className,
      )}
    >
      <Editor
        height={height}
        value={value}
        onChange={(next) => onValueChange(next ?? "")}
        onMount={handleMount}
        options={{
          minimap: { enabled: false },
          fontSize: 12,
          wordWrap: "on",
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          lineNumbers: "on",
          folding: false,
          readOnly,
        }}
      />
    </div>
  );
}
