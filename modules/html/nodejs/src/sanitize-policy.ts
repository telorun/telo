/**
 * The sanitize policy walk over `Html.Node` — an allowlist, applied directly,
 * with nothing merged in from any library's default schema.
 *
 * - An element whose local name is in `dropContent` (in any namespace) is
 *   removed with everything inside it.
 * - An HTML-namespace element listed in `elements` is kept with its allowed
 *   attributes; any other element — unlisted, or foreign (SVG/MathML) — is
 *   unwrapped: it goes, its children stay and pass through the same policy. A
 *   `<template>` unwraps to its contents.
 * - Text is kept; comments only with `comments: true`, and never one that
 *   written on its own would not read back as itself; a doctype never.
 * - A kept void element's children follow it as siblings, and a kept
 *   `textarea` / `title` holds only the text of what was inside it. What else
 *   the markup would not carry is settled by the controller's readback.
 */

import type { ElementNode, HtmlNode } from "./html-node.js";
import {
  ESCAPABLE_RAW_TEXT_ELEMENTS,
  findUnserializableIn,
  RAW_TEXT_ELEMENTS,
  VOID_ELEMENTS,
} from "./html-serialization.js";
import { textOf } from "./tree-index.js";

export interface AttributeConstraint {
  values?: string[];
  prefixes?: string[];
  protocols?: string[];
}

export interface SanitizePolicy {
  elements: string[];
  attributes?: Record<string, Record<string, AttributeConstraint>>;
  setAttributes?: Record<string, Record<string, string>>;
  dropContent?: string[];
  comments?: boolean;
  idPrefix?: string;
}

/** Attributes whose value is a URL, checked by the URL rule. */
export const URL_ATTRIBUTES: readonly string[] = [
  "href", "src", "srcset", "action", "formaction", "cite", "poster", "background", "longdesc", "xlink:href",
];

const DEFAULT_DROP_CONTENT = ["script", "style"];

/** Names whose start tag the parser never leaves an HTML element of that name:
 *  `svg` and `math` open foreign content, `image` becomes `img`. */
const NOT_HTML_ELEMENTS: ReadonlySet<string> = new Set(["svg", "math", "image"]);

const SCRIPT_PROTOCOLS: ReadonlySet<string> = new Set(["javascript", "vbscript"]);

/** The ways a policy can contradict itself or keep what it cannot sanitize —
 *  the controller's twin of the kind's resource rules. */
export function policyProblems(policy: SanitizePolicy): string[] {
  const problems: string[] = [];
  const listed = new Set(policy.elements);
  for (const tag of policy.elements) {
    if (RAW_TEXT_ELEMENTS.has(tag)) {
      problems.push(
        `HTML_SANITIZE_RAW_TEXT_ELEMENT: 'elements' lists '${tag}', whose content is raw text an allowlist cannot vet; drop it with 'dropContent' or leave it out`,
      );
    }
    if (NOT_HTML_ELEMENTS.has(tag)) {
      problems.push(
        `HTML_SANITIZE_NOT_AN_HTML_ELEMENT: 'elements' lists '${tag}', which markup cannot write as an HTML element`,
      );
    }
  }
  for (const tag of Object.keys(policy.attributes ?? {})) {
    if (tag !== "*" && !listed.has(tag)) {
      problems.push(`HTML_SANITIZE_UNKNOWN_ELEMENT: 'attributes' names '${tag}', which 'elements' does not list`);
    }
  }
  for (const [tag, forced] of Object.entries(policy.setAttributes ?? {})) {
    if (!listed.has(tag)) {
      problems.push(
        `HTML_SANITIZE_UNKNOWN_ELEMENT_FORCED: 'setAttributes' names '${tag}', which 'elements' does not list`,
      );
    }
    for (const attr of Object.keys(forced)) {
      if (attr.startsWith("on")) {
        problems.push(
          `HTML_SANITIZE_EVENT_HANDLER_FORCED: 'setAttributes' forces the event handler '${attr}' onto '${tag}'`,
        );
      }
    }
  }
  for (const [tag, attrs] of Object.entries(policy.attributes ?? {})) {
    for (const [attr, constraint] of Object.entries(attrs)) {
      if (attr.startsWith("on")) {
        problems.push(`HTML_SANITIZE_EVENT_HANDLER: '${tag}' allows the event handler '${attr}'`);
      }
      if (URL_ATTRIBUTES.includes(attr) && constraint.protocols === undefined) {
        problems.push(
          `HTML_SANITIZE_URL_WITHOUT_PROTOCOLS: '${tag}' allows the URL attribute '${attr}' with no 'protocols'`,
        );
      }
      for (const scheme of constraint.protocols ?? []) {
        if (SCRIPT_PROTOCOLS.has(scheme)) {
          problems.push(
            `HTML_SANITIZE_SCRIPT_PROTOCOL: '${tag}' allows '${attr}' with the '${scheme}' scheme, which runs script`,
          );
        }
      }
    }
  }
  if (policy.idPrefix !== undefined) {
    const allowsIds = Object.values(policy.attributes ?? {}).some((attrs) => "id" in attrs || "name" in attrs);
    if (!allowsIds) {
      problems.push(
        "HTML_SANITIZE_ID_PREFIX_UNUSED: 'idPrefix' is set, but no element may keep an 'id' or 'name' for it to prefix",
      );
    }
  }
  for (const tag of policy.dropContent ?? DEFAULT_DROP_CONTENT) {
    if (listed.has(tag)) {
      problems.push(`HTML_SANITIZE_DROP_ALLOWED: '${tag}' is both allowed and dropped with its content`);
    }
  }
  return problems;
}

/** Tab, newline and carriage return are removed anywhere in a URL; C0 controls
 *  and spaces around it are trimmed — so `java\tscript:` is read as a browser
 *  reads it. */
function schemeOf(url: string): string | undefined {
  const cleaned = url.replace(/[\t\n\r]/g, "").replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
  return match ? match[1]!.toLowerCase() : undefined;
}

function urlAllowed(url: string, protocols: readonly string[]): boolean {
  const scheme = schemeOf(url);
  return scheme === undefined || protocols.includes(scheme);
}

function srcsetAllowed(value: string, protocols: readonly string[]): boolean {
  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
    .every((url) => urlAllowed(url, protocols));
}

function valueAllowed(attr: string, value: string, constraint: AttributeConstraint): boolean {
  if (constraint.values || constraint.prefixes) {
    const exact = constraint.values?.includes(value) ?? false;
    const prefixed = constraint.prefixes?.some((prefix) => value.startsWith(prefix)) ?? false;
    if (!exact && !prefixed) return false;
  }
  if (URL_ATTRIBUTES.includes(attr)) {
    const protocols = constraint.protocols ?? [];
    return attr === "srcset" ? srcsetAllowed(value, protocols) : urlAllowed(value, protocols);
  }
  return true;
}

/** Attributes holding id references (IDREF / IDREFS), whose every token is
 *  prefixed with `idPrefix` so a reference keeps pointing at the id it named. */
export const IDREF_ATTRIBUTES: readonly string[] = [
  "for", "headers", "list", "form", "itemref", "popovertarget", "commandfor",
  "aria-activedescendant", "aria-controls", "aria-describedby", "aria-details",
  "aria-errormessage", "aria-flowto", "aria-labelledby", "aria-owns",
];

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    // A malformed escape is matched as written, as a browser does.
    return fragment;
  }
}

export function sanitizeNodes(nodes: readonly HtmlNode[], policy: SanitizePolicy): HtmlNode[] {
  const listed = new Set(policy.elements);
  const dropped = new Set(policy.dropContent ?? DEFAULT_DROP_CONTENT);
  const prefix = policy.idPrefix;
  // What a fragment link may point at, by the values the author wrote.
  const keptIds = new Set<string>();
  const keptAnchorNames = new Set<string>();
  const fragmentLinks: { attrs: Record<string, string>; attr: string; fragment: string }[] = [];

  const keepAttributes = (element: ElementNode): Record<string, string> => {
    const own = policy.attributes?.[element.tag] ?? {};
    const any = policy.attributes?.["*"] ?? {};
    const forced = policy.setAttributes?.[element.tag] ?? {};
    const out: Record<string, string> = {};
    const links: { attr: string; fragment: string }[] = [];
    for (const [attr, value] of Object.entries(element.attrs)) {
      const constraint = own[attr] ?? any[attr];
      if (!constraint || !valueAllowed(attr, value, constraint)) continue;
      if (attr === "id") keptIds.add(value);
      if (attr === "name" && element.tag === "a") keptAnchorNames.add(value);
      if (prefix === undefined) {
        out[attr] = value;
      } else if (attr === "id" || attr === "name") {
        out[attr] = prefix + value;
      } else if (IDREF_ATTRIBUTES.includes(attr)) {
        out[attr] = value.replace(/[^\t\n\f\r ]+/g, (token) => prefix + token);
      } else {
        out[attr] = value;
        if (URL_ATTRIBUTES.includes(attr) && value.startsWith("#") && value.length > 1 && !(attr in forced)) {
          links.push({ attr, fragment: value.slice(1) });
        }
      }
    }
    const attrs = { ...out, ...forced };
    for (const link of links) fragmentLinks.push({ attrs, ...link });
    return attrs;
  };

  const walk = (children: readonly HtmlNode[]): HtmlNode[] => {
    const out: HtmlNode[] = [];
    for (const node of children) {
      switch (node.type) {
        case "text":
          out.push({ type: "text", text: node.text });
          break;
        case "comment":
          if (policy.comments === true && findUnserializableIn(node, "") === undefined) {
            out.push({ type: "comment", text: node.text });
          }
          break;
        case "doctype":
          break;
        case "element":
          if (dropped.has(node.tag)) break;
          if (node.namespace === undefined && listed.has(node.tag)) {
            const attrs = keepAttributes(node);
            const children = walk(node.children);
            if (VOID_ELEMENTS.has(node.tag)) {
              out.push({ type: "element", tag: node.tag, attrs, children: [] }, ...children);
            } else if (ESCAPABLE_RAW_TEXT_ELEMENTS.has(node.tag)) {
              const text = textOf(children);
              out.push({ type: "element", tag: node.tag, attrs, children: text ? [{ type: "text", text }] : [] });
            } else {
              out.push({ type: "element", tag: node.tag, attrs, children });
            }
          } else {
            out.push(...walk(node.children));
          }
          break;
      }
    }
    return mergeText(out);
  };

  const sanitized = walk(nodes);
  // A fragment link follows its target's prefix only when the target was kept
  // — found as HTML finds one, by id, then by an `<a name>`.
  for (const { attrs, attr, fragment } of fragmentLinks) {
    const target = decodeFragment(fragment);
    if (keptIds.has(target) || keptAnchorNames.has(target)) attrs[attr] = `#${prefix}${fragment}`;
  }
  return sanitized;
}

/** Unwrapping leaves text nodes side by side; the parser never produces two in
 *  a row, so neither does the policy. */
function mergeText(nodes: HtmlNode[]): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (node.type === "text" && last?.type === "text") {
      out[out.length - 1] = { type: "text", text: last.text + node.text };
    } else {
      out.push(node);
    }
  }
  return out;
}
