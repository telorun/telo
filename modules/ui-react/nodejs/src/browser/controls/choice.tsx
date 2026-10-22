import { Check } from "lucide-react";
import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { CheckboxProps, OptionGroupProps, SliderProps, SwitchProps } from "../../contract/ui-react-controls.js";
import { aria, invalidMark } from "./shared.js";

/** A checkbox and a switch are pressed, not submitted: Enter does nothing, as the pattern has it. */
const noEnter = (event: KeyboardEvent) => event.key === "Enter" && event.preventDefault();

export function Checkbox({ id, name, checked, onChange, required, disabled, ...semantics }: CheckboxProps) {
  return (
    <button
      {...aria({ ...semantics, required })}
      type="button"
      role="checkbox"
      aria-checked={checked}
      data-telo-part="checkbox"
      data-state={checked ? "checked" : "unchecked"}
      data-invalid={invalidMark(semantics.invalid)}
      id={id}
      name={name}
      value="on"
      disabled={disabled}
      onKeyDown={noEnter}
      onClick={() => onChange(!checked)}
    >
      {checked && <Check data-telo-part="icon" aria-hidden="true" focusable="false" />}
    </button>
  );
}

export function Switch({ id, part, checked, onChange, required, disabled, ...semantics }: SwitchProps) {
  return (
    <button
      {...aria({ ...semantics, required })}
      type="button"
      role="switch"
      aria-checked={checked}
      data-telo-part={part}
      data-state={checked ? "checked" : "unchecked"}
      data-invalid={invalidMark(semantics.invalid)}
      id={id}
      value="on"
      disabled={disabled}
      onKeyDown={noEnter}
      onClick={() => onChange(!checked)}
    />
  );
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A position snapped to the slider's steps from its minimum. */
const snapped = (value: number, min: number, max: number, step: number) => {
  const steps = Math.round((value - min) / step);
  const decimals = (String(step).split(".")[1] ?? "").length;
  return clamp(Number((min + steps * step).toFixed(decimals)), min, max);
};

/** A thumb on a track, then the position as text: what a person moves is the
 *  thumb, so it carries the id and the relations. A move is reported, then
 *  that it is let go. */
export function Slider({ id, part, min, max, step, value, valueText, onChange, onCommit, disabled, ...semantics }: SliderProps) {
  const root = useRef<HTMLSpanElement>(null);
  // Where a drag began, while one is under way.
  const dragged = useRef<number | null>(null);
  const current = Number(value);
  const percent = max === min ? 0 : ((clamp(current, min, max) - min) / (max - min)) * 100;
  /** Report a move to another position, answering whether it was one. */
  const move = (next: number) => {
    const placed = snapped(next, min, max, step);
    if (placed === current) return false;
    onChange(String(placed));
    return true;
  };
  const fromPointer = (event: PointerEvent) => {
    const box = root.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const share = (event.clientX - box.left) / box.width;
    move(min + clamp(document.documentElement.dir === "rtl" ? 1 - share : share, 0, 1) * (max - min));
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const big = Math.max(step, (max - min) / 10);
    const forward = document.documentElement.dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    const backward = document.documentElement.dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    const keys: Record<string, number> = {
      [forward]: current + step,
      ArrowUp: current + step,
      [backward]: current - step,
      ArrowDown: current - step,
      PageUp: current + big,
      PageDown: current - big,
      Home: min,
      End: max,
    };
    if (!(event.key in keys)) return;
    event.preventDefault();
    if (move(keys[event.key])) onCommit();
  };
  return (
    <span
      data-telo-part={part}
      data-invalid={invalidMark(semantics.invalid)}
      data-disabled={disabled ? "" : undefined}
      ref={root}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return;
        dragged.current = current;
        event.currentTarget.setPointerCapture(event.pointerId);
        fromPointer(event);
        (event.currentTarget.querySelector('[role="slider"]') as HTMLElement | null)?.focus();
      }}
      onPointerMove={(event) => dragged.current !== null && fromPointer(event)}
      onPointerUp={(event) => {
        if (dragged.current === null) return;
        const began = dragged.current;
        dragged.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        if (began !== current) onCommit();
      }}
    >
      <span>
        <span style={{ left: 0, right: `${100 - percent}%` }} />
      </span>
      <span style={{ position: "absolute", insetInlineStart: `${percent}%`, transform: "translateX(-50%)" }}>
        <span
          {...aria(semantics)}
          role="slider"
          id={id}
          tabIndex={disabled ? undefined : 0}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={current}
          aria-valuetext={valueText}
          aria-orientation="horizontal"
          aria-disabled={disabled || undefined}
          onKeyDown={disabled ? undefined : onKeyDown}
        />
      </span>
      {/* Read out by the thumb already. */}
      <span data-telo-part={`${part}-value`} aria-hidden="true">
        {valueText ?? value}
      </span>
    </span>
  );
}

/** Options side by side, one or any number on: the arrows move the focus among them. */
export function OptionGroup({ id, parts, multiple, options, value, onChange, disabled, ...semantics }: OptionGroupProps) {
  // The one the Tab key reaches: the first on, else the first.
  const reached = Math.max(0, options.findIndex((option) => value.includes(option.key)));
  const press = (key: string) =>
    multiple ? onChange(value.includes(key) ? value.filter((held) => held !== key) : [...value, key]) : onChange(value.includes(key) ? [] : [key]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    const forward = document.documentElement.dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    const backward = document.documentElement.dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    const next =
      event.key === forward || event.key === "ArrowDown" ? (at + 1) % all.length
      : event.key === backward || event.key === "ArrowUp" ? (at - 1 + all.length) % all.length
      : event.key === "Home" ? 0
      : event.key === "End" ? all.length - 1
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    all[next].focus();
  };
  return (
    <div
      {...aria(semantics)}
      role="group"
      aria-disabled={disabled || undefined}
      data-telo-part={parts.root}
      data-invalid={invalidMark(semantics.invalid)}
      id={id}
      onKeyDown={onKeyDown}
    >
      {options.map((option, index) => {
        const on = value.includes(option.key);
        return (
          <button
            key={option.key}
            type="button"
            data-telo-part={parts.option}
            data-state={on ? "on" : "off"}
            {...(multiple ? { "aria-pressed": on } : { role: "radio", "aria-checked": on })}
            tabIndex={index === reached ? 0 : -1}
            disabled={disabled}
            onClick={() => press(option.key)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
