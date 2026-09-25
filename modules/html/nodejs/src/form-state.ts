/** Form-control state as the HTML standard derives it from markup alone — what
 *  the user-interface pseudo-classes read in a static tree. Nothing here depends
 *  on interaction: a value is the `value` attribute (or a textarea's text),
 *  checkedness the `checked` attribute, and a length constraint never applies,
 *  since it needs a value a user edited. */

import { isHtmlElement, type ElementNode } from "./html-node.js";
import { isAncestor, textOf, type TreeIndex } from "./tree-index.js";

const TEXT_TYPES = new Set(["text", "search", "url", "tel", "email", "password"]);
const DATE_TYPES = new Set(["date", "month", "week", "time", "datetime-local"]);
const INPUT_TYPES = new Set([
  ...TEXT_TYPES, ...DATE_TYPES, "hidden", "number", "range", "color", "checkbox", "radio",
  "file", "submit", "image", "reset", "button",
]);

export function inputType(element: ElementNode): string {
  const type = (element.attrs.type ?? "").trim().toLowerCase();
  return INPUT_TYPES.has(type) ? type : "text";
}

function isInput(element: ElementNode, ...types: string[]): boolean {
  return isHtmlElement(element, "input") && (types.length === 0 || types.includes(inputType(element)));
}

/* --------------------------------------------------------------- values */

const FLOAT = /^-?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** A value parsed as the number the type orders by, or undefined. */
function numberOf(type: string, value: string): number | undefined {
  let m: RegExpExecArray | null;
  switch (type) {
    case "number":
    case "range":
      return FLOAT.test(value) ? Number(value) : undefined;
    case "date":
      if (!(m = /^(\d{4,})-(\d\d)-(\d\d)$/.exec(value))) return undefined;
      if (+m[2]! < 1 || +m[2]! > 12 || +m[3]! < 1 || +m[3]! > daysInMonth(+m[1]!, +m[2]!)) return undefined;
      return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
    case "month":
      if (!(m = /^(\d{4,})-(\d\d)$/.exec(value)) || +m[2]! < 1 || +m[2]! > 12) return undefined;
      return (+m[1]! - 1970) * 12 + (+m[2]! - 1);
    case "week": {
      if (!(m = /^(\d{4,})-W(\d\d)$/.exec(value))) return undefined;
      const year = +m[1]!;
      const week = +m[2]!;
      const jan4 = new Date(Date.UTC(year, 0, 4));
      const monday = Date.UTC(year, 0, 4 - ((jan4.getUTCDay() + 6) % 7));
      const weeks = new Date(Date.UTC(year, 11, 28)).getUTCDay() === 4 || jan4.getUTCDay() === 4 ? 53 : 52;
      return week >= 1 && week <= weeks ? monday + (week - 1) * 604800000 : undefined;
    }
    case "time":
      if (!(m = /^(\d\d):(\d\d)(?::(\d\d)(\.\d{1,3})?)?$/.exec(value))) return undefined;
      if (+m[1]! > 23 || +m[2]! > 59 || +(m[3] ?? 0) > 59) return undefined;
      return ((+m[1]! * 60 + +m[2]!) * 60 + +(m[3] ?? 0)) * 1000 + Math.round(+(m[4] ?? 0) * 1000);
    case "datetime-local": {
      if (!(m = /^(.+?)[T ](.+)$/.exec(value))) return undefined;
      const date = numberOf("date", m[1]!);
      const time = numberOf("time", m[2]!);
      return date === undefined || time === undefined ? undefined : date + time;
    }
    default:
      return undefined;
  }
}

/** The value a control carries in markup, after the type's sanitization. */
export function controlValue(element: ElementNode): string {
  if (isHtmlElement(element, "textarea")) return textOf(element.children);
  const raw = element.attrs.value ?? "";
  const type = inputType(element);
  if (TEXT_TYPES.has(type)) {
    const flat = raw.replace(/[\r\n]/g, "");
    return type === "url" || type === "email" ? flat.trim() : flat;
  }
  if (type === "number" || DATE_TYPES.has(type)) return numberOf(type, raw) === undefined ? "" : raw;
  if (type === "range") {
    const { min, max } = rangeLimits(element);
    return numberOf("range", raw) === undefined ? String(max < min ? min : min + (max - min) / 2) : raw;
  }
  return raw;
}

function rangeLimits(element: ElementNode): { min: number; max: number } {
  const type = inputType(element);
  const min = numberOf(type, element.attrs.min ?? "") ?? (type === "range" ? 0 : Number.NEGATIVE_INFINITY);
  const max = numberOf(type, element.attrs.max ?? "") ?? (type === "range" ? 100 : Number.POSITIVE_INFINITY);
  return { min, max };
}

function hasRangeLimits(element: ElementNode): boolean {
  const type = inputType(element);
  if (!isHtmlElement(element, "input") || !(type === "number" || type === "range" || DATE_TYPES.has(type))) {
    return false;
  }
  return (
    type === "range" ||
    numberOf(type, element.attrs.min ?? "") !== undefined ||
    numberOf(type, element.attrs.max ?? "") !== undefined
  );
}

/* ------------------------------------------------------ form association */

export function formOwner(index: TreeIndex, element: ElementNode): ElementNode | undefined {
  const id = element.attrs.form;
  if (id !== undefined) {
    const named = index.byId(id);
    return named && isHtmlElement(named, "form") ? named : undefined;
  }
  for (let at = index.parentOf(element); at; at = index.parentOf(at)) {
    if (isHtmlElement(at, "form")) return at;
  }
  return undefined;
}

/* ------------------------------------------------------------ disabled */

const DISABLEABLE = new Set(["button", "input", "select", "textarea", "fieldset"]);

export function isDisabled(index: TreeIndex, element: ElementNode): boolean {
  if (element.namespace !== undefined) return false;
  if (element.tag === "optgroup") return "disabled" in element.attrs;
  if (element.tag === "option") {
    const parent = index.parentOf(element);
    return "disabled" in element.attrs || (!!parent && isHtmlElement(parent, "optgroup") && "disabled" in parent.attrs);
  }
  if (!DISABLEABLE.has(element.tag)) return false;
  if ("disabled" in element.attrs) return true;
  for (let child = element, at = index.parentOf(element); at; child = at, at = index.parentOf(at)) {
    if (!isHtmlElement(at, "fieldset") || !isDisabled(index, at)) continue;
    const legend = at.children.find((node): node is ElementNode => node.type === "element" && isHtmlElement(node, "legend"));
    if (!(legend && (child === legend || isAncestor(index, legend, element)))) return true;
  }
  return false;
}

export function isEnablable(element: ElementNode): boolean {
  return isHtmlElement(element) && (DISABLEABLE.has(element.tag) || element.tag === "optgroup" || element.tag === "option");
}

/* --------------------------------------------------------- checkedness */

function radioGroup(index: TreeIndex, radio: ElementNode): ElementNode[] {
  const name = radio.attrs.name;
  if (!name) return [radio];
  const owner = formOwner(index, radio);
  return index.elements.filter(
    (other) => isInput(other, "radio") && other.attrs.name === name && formOwner(index, other) === owner,
  );
}

function selectOf(index: TreeIndex, option: ElementNode): ElementNode | undefined {
  const parent = index.parentOf(option);
  if (parent && isHtmlElement(parent, "select")) return parent;
  const grand = parent && isHtmlElement(parent, "optgroup") ? index.parentOf(parent) : undefined;
  return grand && isHtmlElement(grand, "select") ? grand : undefined;
}

function optionsOf(index: TreeIndex, select: ElementNode): ElementNode[] {
  return index.elements.filter((element) => isHtmlElement(element, "option") && selectOf(index, element) === select);
}

function isSelected(index: TreeIndex, option: ElementNode): boolean {
  const select = selectOf(index, option);
  if (!select) return "selected" in option.attrs;
  const options = optionsOf(index, select);
  if ("multiple" in select.attrs) return "selected" in option.attrs;
  const chosen = options.filter((o) => "selected" in o.attrs);
  if (chosen.length > 0) return chosen[chosen.length - 1] === option;
  const size = Number.parseInt(select.attrs.size ?? "", 10);
  if (Number.isFinite(size) && size > 1) return false;
  return options.find((o) => !isDisabled(index, o)) === option;
}

export function isChecked(index: TreeIndex, element: ElementNode): boolean {
  if (isInput(element, "checkbox")) return "checked" in element.attrs;
  if (isInput(element, "radio")) {
    if (!("checked" in element.attrs)) return false;
    const checked = radioGroup(index, element).filter((radio) => "checked" in radio.attrs);
    return checked[checked.length - 1] === element;
  }
  return isHtmlElement(element, "option") && isSelected(index, element);
}

function isSubmitButton(element: ElementNode): boolean {
  if (isHtmlElement(element, "button")) {
    const type = (element.attrs.type ?? "submit").trim().toLowerCase();
    return type === "submit" || !["reset", "button"].includes(type);
  }
  return isInput(element, "submit", "image");
}

export function isDefault(index: TreeIndex, element: ElementNode): boolean {
  if (isInput(element, "checkbox", "radio")) return "checked" in element.attrs;
  if (isHtmlElement(element, "option")) return "selected" in element.attrs;
  if (!isSubmitButton(element)) return false;
  const form = formOwner(index, element);
  return !!form && index.elements.find((other) => isSubmitButton(other) && formOwner(index, other) === form) === element;
}

export function isIndeterminate(index: TreeIndex, element: ElementNode): boolean {
  if (isInput(element, "radio")) return !radioGroup(index, element).some((radio) => isChecked(index, radio));
  return isHtmlElement(element, "progress") && !("value" in element.attrs);
}

/* ---------------------------------------------------- required / editing */

const REQUIRED_TYPES = new Set([...TEXT_TYPES, ...DATE_TYPES, "number", "checkbox", "radio", "file"]);
const READONLY_TYPES = new Set([...TEXT_TYPES, ...DATE_TYPES, "number"]);

export function isOptionalOrRequired(element: ElementNode): boolean {
  return isHtmlElement(element, "input") || isHtmlElement(element, "select") || isHtmlElement(element, "textarea");
}

export function isRequired(element: ElementNode): boolean {
  if (!("required" in element.attrs)) return false;
  if (isHtmlElement(element, "input")) return REQUIRED_TYPES.has(inputType(element));
  return isHtmlElement(element, "select") || isHtmlElement(element, "textarea");
}

function isEditingHost(index: TreeIndex, element: ElementNode): boolean {
  for (let at: ElementNode | undefined = element; at; at = index.parentOf(at)) {
    const value = at.attrs.contenteditable;
    if (value === undefined || at.namespace !== undefined) continue;
    return ["", "true", "plaintext-only"].includes(value.trim().toLowerCase());
  }
  return false;
}

export function isReadWrite(index: TreeIndex, element: ElementNode): boolean {
  if (isHtmlElement(element, "input")) {
    return READONLY_TYPES.has(inputType(element)) && !("readonly" in element.attrs) && !isDisabled(index, element);
  }
  if (isHtmlElement(element, "textarea")) return !("readonly" in element.attrs) && !isDisabled(index, element);
  return isEditingHost(index, element);
}

const PLACEHOLDER_TYPES = new Set([...TEXT_TYPES, "number"]);

export function isPlaceholderShown(element: ElementNode): boolean {
  if (!("placeholder" in element.attrs)) return false;
  if (isHtmlElement(element, "textarea")) return controlValue(element) === "";
  return isInput(element, ...PLACEHOLDER_TYPES) && controlValue(element) === "";
}

export function isBlank(element: ElementNode): boolean {
  if (!isHtmlElement(element, "textarea") && !isInput(element, ...PLACEHOLDER_TYPES)) return false;
  return controlValue(element).trim() === "";
}

/* ------------------------------------------------------------- validity */

function isCandidate(index: TreeIndex, element: ElementNode): boolean {
  if (element.namespace !== undefined) return false;
  if (isDisabled(index, element)) return false;
  for (let at = index.parentOf(element); at; at = index.parentOf(at)) {
    if (isHtmlElement(at, "datalist")) return false;
  }
  switch (element.tag) {
    case "input": {
      const type = inputType(element);
      if (["hidden", "reset", "button"].includes(type)) return false;
      return !(READONLY_TYPES.has(type) && "readonly" in element.attrs);
    }
    case "textarea":
      return !("readonly" in element.attrs);
    case "select":
      return true;
    case "button":
      return isSubmitButton(element);
    default:
      return false;
  }
}

const EMAIL =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function patternMatches(pattern: string, value: string): boolean {
  let regex: RegExp;
  try {
    regex = new RegExp(`^(?:${pattern})$`, "v");
  } catch {
    // An invalid pattern imposes no constraint, as the HTML standard says.
    return true;
  }
  return regex.test(value);
}

const STEP_DEFAULTS: Readonly<Record<string, { step: number; scale: number; base?: number }>> = {
  number: { step: 1, scale: 1 },
  range: { step: 1, scale: 1 },
  date: { step: 1, scale: 86400000 },
  month: { step: 1, scale: 1 },
  week: { step: 1, scale: 604800000, base: -259200000 },
  time: { step: 60, scale: 1000 },
  "datetime-local": { step: 60, scale: 1000 },
};

function suffersFromInput(index: TreeIndex, element: ElementNode): boolean {
  const type = inputType(element);
  const value = controlValue(element);
  const required = isRequired(element);
  if (type === "checkbox") return required && !isChecked(index, element);
  if (type === "radio") {
    const group = radioGroup(index, element);
    return group.some((radio) => isRequired(radio)) && !group.some((radio) => isChecked(index, radio));
  }
  if (type === "file") return required;
  if (required && value === "" && type !== "range" && type !== "color") return true;
  if (value === "") return false;
  if (type === "email") {
    const addresses = "multiple" in element.attrs ? value.split(",").map((part) => part.trim()) : [value];
    if (addresses.some((address) => !EMAIL.test(address))) return true;
  }
  if (type === "url") {
    try {
      new URL(value);
    } catch {
      return true;
    }
  }
  if (TEXT_TYPES.has(type) && element.attrs.pattern !== undefined) {
    const values = type === "email" && "multiple" in element.attrs ? value.split(",").map((v) => v.trim()) : [value];
    if (values.some((v) => !patternMatches(element.attrs.pattern!, v))) return true;
  }
  const stepping = STEP_DEFAULTS[type];
  if (stepping) {
    const number = numberOf(type, value)!;
    const { min, max } = rangeLimits(element);
    if (number < min || number > max) return true;
    const stepAttr = (element.attrs.step ?? "").trim().toLowerCase();
    if (stepAttr !== "any") {
      const declared = FLOAT.test(stepAttr) && Number(stepAttr) > 0 ? Number(stepAttr) : stepping.step;
      const step = declared * stepping.scale;
      const base = numberOf(type, element.attrs.min ?? "") ?? numberOf(type, element.attrs.value ?? "") ?? stepping.base ?? 0;
      const steps = (number - base) / step;
      if (Math.abs(steps - Math.round(steps)) > 1e-9) return true;
    }
  }
  return false;
}

function suffers(index: TreeIndex, element: ElementNode): boolean {
  if (isHtmlElement(element, "input")) return suffersFromInput(index, element);
  if (isHtmlElement(element, "textarea")) return isRequired(element) && controlValue(element) === "";
  if (isHtmlElement(element, "select")) {
    if (!isRequired(element)) return false;
    const selected = optionsOf(index, element).filter((option) => isSelected(index, option));
    if (selected.length === 0) return true;
    const size = Number.parseInt(element.attrs.size ?? "", 10);
    const single = !("multiple" in element.attrs) && !(Number.isFinite(size) && size > 1);
    const first = optionsOf(index, element)[0];
    const placeholder =
      single && first && index.parentOf(first) === element && (first.attrs.value ?? textOf(first.children)) === "";
    return !!placeholder && selected.every((option) => option === first);
  }
  return false;
}

/** `true` / `false` for a validated element, undefined for one that is neither. */
export function validity(index: TreeIndex, element: ElementNode): boolean | undefined {
  if (isHtmlElement(element, "form")) {
    return !index.elements.some((control) => formOwner(index, control) === element && validity(index, control) === false);
  }
  if (isHtmlElement(element, "fieldset")) {
    return !index.elements.some(
      (control) => control !== element && isAncestor(index, element, control) && !isHtmlElement(control, "fieldset") && validity(index, control) === false,
    );
  }
  if (!isCandidate(index, element)) return undefined;
  return !suffers(index, element);
}

/** `true` in range, `false` out of range, undefined when the element has no range. */
export function rangeState(index: TreeIndex, element: ElementNode): boolean | undefined {
  if (!hasRangeLimits(element) || !isCandidate(index, element)) return undefined;
  const type = inputType(element);
  const value = controlValue(element);
  if (value === "") return true;
  const number = numberOf(type, value)!;
  const { min, max } = rangeLimits(element);
  return number >= min && number <= max;
}
