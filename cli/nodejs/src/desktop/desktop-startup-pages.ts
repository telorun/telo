import type { UnresolvedApplicationInput } from "@telorun/kernel";

import { describeConstraints } from "../application-input-prompt.js";

/**
 * The pages the desktop host serves itself while the application starts
 * (`kernel/specs/desktop-host.md` §5.8), on its own origin: the startup view,
 * the missing-inputs form and the boot-refusal view. Plain HTML with inline style, no script: a
 * page that retries does so with a `refresh` meta tag.
 */

/** The startup window's page and the form's submission, on the host origin. */
export const STARTUP_PATH = "/startup";
export const ANSWERS_PATH = "/startup/answers";
export const TOKEN_FIELD = "_telo.token";

const STYLE =
  "body{font:15px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:34rem;padding:0 1rem;color:#222;background:#fafafa}" +
  "@media(prefers-color-scheme:dark){body{color:#eee;background:#1b1b1b}input,select,textarea{background:#2a2a2a;color:#eee}}" +
  "h1{font-size:1.3rem}label{display:block;margin:1rem 0 .2rem;font-weight:600}.hint{font-size:.85rem;opacity:.75}" +
  ".error{color:#c0392b;font-size:.9rem}input,select,textarea{width:100%;box-sizing:border-box;padding:.4rem;font:inherit}" +
  "pre{white-space:pre-wrap;word-break:break-word;font:13px/1.45 ui-monospace,monospace}button{margin-top:1.2rem;padding:.4rem 1.2rem;font:inherit}";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(view: string, title: string, body: string, refresh: boolean): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    (refresh ? `<meta http-equiv="refresh" content="1">` : "") +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>` +
    `<body data-view="${view}">${body}</body></html>`
  );
}

/** The window while the application starts; it reloads itself until something else answers. */
export function startupView(productName: string): string {
  const name = escapeHtml(productName);
  return page("startup", productName, `<h1>${name}</h1><p>Starting…</p>`, true);
}

/** Startup ended and nothing serves the address: retrying would not change that. */
export function notServedView(productName: string): string {
  const name = escapeHtml(productName);
  return page("not-served", productName, `<h1>${name}</h1><p>Nothing is serving this page.</p>`, false);
}

/** What failed to start: the diagnostics `telo run` printed, as text. */
export function refusalView(productName: string, diagnostics: string): string {
  const name = escapeHtml(productName);
  return page(
    "refusal",
    productName,
    `<h1>${name} could not start</h1><pre>${escapeHtml(diagnostics)}</pre><p class="hint">Close this window to exit.</p>`,
    false,
  );
}

type FieldKind =
  | { kind: "text"; numeric: boolean }
  | { kind: "password" }
  | { kind: "textarea" }
  | { kind: "select"; options: string[] };

/** How an input is entered, read from its residual schema and sensitivity. */
export function fieldKindOf(input: UnresolvedApplicationInput): FieldKind {
  const { schema } = input;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return { kind: "select", options: schema.enum.map((value) => (typeof value === "string" ? value : JSON.stringify(value))) };
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("boolean")) return { kind: "select", options: ["true", "false"] };
  if (input.sensitive) return { kind: "password" };
  if (types.includes("object") || types.includes("array")) return { kind: "textarea" };
  return { kind: "text", numeric: types.includes("integer") || types.includes("number") };
}

export function fieldName(index: number): string {
  return `a${index}`;
}

function fieldHtml(input: UnresolvedApplicationInput, index: number, value: string | undefined): string {
  const name = fieldName(index);
  const label = escapeHtml(input.env ?? input.name);
  const field = fieldKindOf(input);
  const current = value ?? "";
  let control: string;
  if (field.kind === "select") {
    const options = field.options.map(
      (option) => `<option value="${escapeHtml(option)}"${option === current ? " selected" : ""}>${escapeHtml(option)}</option>`,
    );
    control = `<select id="${name}" name="${name}">${options.join("")}</select>`;
  } else if (field.kind === "textarea") {
    control = `<textarea id="${name}" name="${name}" rows="4">${escapeHtml(current)}</textarea>`;
  } else if (field.kind === "password") {
    control = `<input id="${name}" name="${name}" type="password" autocomplete="off">`;
  } else {
    control = `<input id="${name}" name="${name}" type="text"${field.numeric ? ` inputmode="decimal"` : ""} value="${escapeHtml(current)}">`;
  }
  const hints = [
    input.title ?? input.description,
    ...describeConstraints(input.schema),
    input.schema.default !== undefined ? `default ${JSON.stringify(input.schema.default)}` : undefined,
    input.type === "object" || input.type === "array" ? "JSON" : input.type,
    input.sensitive ? "secret" : undefined,
  ].filter((hint): hint is string => Boolean(hint));
  const refusal = input.refusal === undefined ? "" : `<div class="error">${escapeHtml(input.refusal)}</div>`;
  return (
    `<label for="${name}">${label}</label>${control}` +
    `<div class="hint">${escapeHtml(hints.join(" · "))}</div>${refusal}`
  );
}

/**
 * The form asking for the inputs nothing supplied. A previously given value of a
 * non-sensitive input is put back; a sensitive one never is.
 */
export function inputFormView(
  productName: string,
  inputs: readonly UnresolvedApplicationInput[],
  values: ReadonlyMap<string, string>,
  token: string,
): string {
  const name = escapeHtml(productName);
  const count = inputs.length;
  const fields = inputs.map((input, index) => fieldHtml(input, index, input.sensitive ? undefined : values.get(input.id))).join("");
  return page(
    "form",
    productName,
    `<h1>${name}</h1><p>${count === 1 ? "1 input has" : `${count} inputs have`} no value. Enter ${count === 1 ? "it" : "each"} to start.</p>` +
      `<form method="post" action="${ANSWERS_PATH}" autocomplete="off">` +
      `<input type="hidden" name="${TOKEN_FIELD}" value="${escapeHtml(token)}">${fields}` +
      `<button type="submit">Start</button></form>`,
    false,
  );
}
