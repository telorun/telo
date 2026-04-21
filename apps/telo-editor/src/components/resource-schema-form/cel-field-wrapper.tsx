import { CodeIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isCelExpression, type CelEvalMode } from "./cel-utils";

interface CelFieldWrapperProps {
  evalMode: CelEvalMode;
  value: unknown;
  onValueChange: (next: unknown) => void;
  onBlur: () => void;
  children: React.ReactNode;
}

export function CelFieldWrapper({
  evalMode,
  value,
  onValueChange,
  onBlur,
  children,
}: CelFieldWrapperProps) {
  const [expressionMode, setExpressionMode] = useState(() => isCelExpression(value));
  const [rawExpression, setRawExpression] = useState(() =>
    isCelExpression(value) ? (value as string) : "",
  );
  const typedValueRef = useRef<unknown>(isCelExpression(value) ? undefined : value);

  useEffect(() => {
    if (isCelExpression(value)) {
      setExpressionMode(true);
      setRawExpression(value as string);
    } else {
      typedValueRef.current = value;
    }
  }, [value]);

  function toggleMode() {
    if (expressionMode) {
      setExpressionMode(false);
      setRawExpression("");
      onValueChange(typedValueRef.current);
    } else {
      typedValueRef.current = value;
      setExpressionMode(true);
      setRawExpression("");
    }
  }

  const modeLabel = evalMode === "runtime" ? "runtime" : "compile";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={toggleMode}
          className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
            expressionMode
              ? "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300"
              : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
          }`}
          title={`${expressionMode ? "Switch to static value" : "Switch to CEL expression"} (${modeLabel})`}
        >
          <CodeIcon className="size-3" />
          {"${{ }}"}
        </button>
        {expressionMode && (
          <span className="text-[10px] text-violet-500 dark:text-violet-400">{modeLabel}</span>
        )}
      </div>

      {expressionMode ? (
        <input
          type="text"
          value={rawExpression}
          // Cleared CEL expression → "" (not undefined). Per the v1
          // null-vs-missing-key convention, backspace-clear preserves the
          // key as an explicit empty string; deleting the key is reserved
          // for the deferred "remove field" affordance (toggleMode handles
          // mode switching, not key removal).
          onChange={(e) => {
            setRawExpression(e.target.value);
            onValueChange(e.target.value);
          }}
          onBlur={onBlur}
          placeholder={'${{ variables.value }}'}
          className="w-full rounded border border-violet-300 bg-violet-50/50 px-3 py-1 font-mono text-sm text-violet-900 outline-none placeholder:text-violet-300 focus:border-violet-500 dark:border-violet-700 dark:bg-violet-950/30 dark:text-violet-100 dark:placeholder:text-violet-700 dark:focus:border-violet-500"
        />
      ) : (
        children
      )}
    </div>
  );
}
