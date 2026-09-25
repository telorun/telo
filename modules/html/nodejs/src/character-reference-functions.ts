/** `Html.escape` / `Html.unescape`: CEL functions over character references. */

import { decodeHTML } from "entities";

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const Escape = {
  async create() {
    return { call: ({ text }: { text: string }) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!) };
  },
};

/** Named and numeric references, decoded as in text content. */
export const Unescape = {
  async create() {
    return { call: ({ text }: { text: string }) => decodeHTML(text) };
  },
};
