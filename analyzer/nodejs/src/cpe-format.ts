/** The Node checker for the `cpe` Telo format: a CPE 2.3 formatted string
 *  (NISTIR 7695 §6.2). Browser-safe. */

import type { TeloFormatChecker, TeloFormatFailure } from "./telo-format.js";

const FIELDS = 13;
const PARTS = new Set(["a", "o", "h"]);
const ATTRIBUTE_NAMES = [
  "part",
  "vendor",
  "product",
  "version",
  "update",
  "edition",
  "language",
  "sw_edition",
  "target_sw",
  "target_hw",
  "other",
];
const PLAIN = /[A-Za-z0-9_.\-*?]/;
const ESCAPABLE = /[!"#$%&'()+,/:;<=>@[\]^`{|}~*?\-._\\]/;

/** Split on colons a backslash does not escape, keeping each field's offset. */
function fieldsOf(value: string): Array<{ text: string; offset: number }> {
  const fields: Array<{ text: string; offset: number }> = [];
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "\\") i += 1;
    else if (value[i] === ":") {
      fields.push({ text: value.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  fields.push({ text: value.slice(start), offset: start });
  return fields;
}

function checkCpe(value: string): TeloFormatFailure | undefined {
  if (!value.startsWith("cpe:")) {
    return { reason: "a CPE 2.3 formatted string starts with cpe:2.3:", offset: 0 };
  }
  const fields = fieldsOf(value);
  if (fields[1]?.text !== "2.3") {
    return {
      reason: `only CPE 2.3 formatted strings are accepted, so the second field must be 2.3`,
      offset: fields[1]?.offset ?? value.length,
    };
  }
  if (fields.length !== FIELDS) {
    return {
      reason: `a CPE 2.3 formatted string has ${FIELDS} colon-separated fields, this one has ${fields.length}`,
      offset: value.length,
    };
  }
  for (let i = 2; i < FIELDS; i += 1) {
    const { text, offset } = fields[i]!;
    const name = ATTRIBUTE_NAMES[i - 2]!;
    if (text === "") return { reason: `the ${name} field is empty: write * for any value`, offset };
    if (i === 2 && !PARTS.has(text)) {
      return { reason: "the part must be a (application), o (operating system) or h (hardware)", offset };
    }
    for (let j = 0; j < text.length; j += 1) {
      const ch = text[j]!;
      if (ch === "\\") {
        const next = text[j + 1];
        if (next === undefined || !ESCAPABLE.test(next)) {
          return { reason: `the ${name} field has a backslash that escapes no punctuation`, offset: offset + j };
        }
        j += 1;
      } else if (!PLAIN.test(ch)) {
        return {
          reason: `the ${name} field has '${ch}', which must be written \\${ch}`,
          offset: offset + j,
        };
      }
    }
  }
  return undefined;
}

export const cpeChecker: TeloFormatChecker = { check: checkCpe };
