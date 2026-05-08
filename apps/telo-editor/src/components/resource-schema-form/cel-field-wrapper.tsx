import { CodeIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  getCelExpressionSource,
  getTaggedSentinel,
  isCelExpression,
  type CelEvalMode,
} from "./cel-utils";

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
  const [rawExpression, setRawExpression] = useState(() => getCelExpressionSource(value) ?? "");
  const typedValueRef = useRef<unknown>(isCelExpression(value) ? undefined : value);

  useEffect(() => {
    if (isCelExpression(value)) {
      setExpressionMode(true);
      setRawExpression(getCelExpressionSource(value) ?? "");
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

  // A non-CEL tagged sentinel (today: `!literal`) gets a dedicated chrome:
  // we don't enter expression-mode (the value is intentionally inert text)
  // and we don't pass the raw sentinel object to `children` (the underlying
  // input control was designed for primitives, not for our `{__tagged: ...}`
  // shape). Render a read-only literal display showing `value.source`.
  const tagged = getTaggedSentinel(value);
  if (tagged && tagged.engine !== "cel") {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
            title={`Tagged !${tagged.engine} — text passes through unchanged`}
          >
            <CodeIcon className="size-3" />
            {`!${tagged.engine}`}
          </span>
        </div>
        <input
          type="text"
          readOnly
          value={tagged.source}
          className="w-full rounded border border-zinc-200 bg-zinc-50 px-3 py-1 font-mono text-sm text-zinc-700 outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
        />
      </div>
    );
  }

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
