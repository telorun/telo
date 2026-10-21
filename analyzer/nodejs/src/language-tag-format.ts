/** The Node checker for the `language-tag` Telo format: RFC 5646 §2.1's
 *  `Language-Tag` production — well-formed, compared case-insensitively. Whether a
 *  subtag is registered is a question of validity (§2.2.9) and is not asked.
 *  Browser-safe. */

import type { TeloFormatChecker, TeloFormatFailure } from "./telo-format.js";

/** RFC 5646's `grandfathered` production, irregular and regular. */
const GRANDFATHERED: ReadonlySet<string> = new Set([
  "en-gb-oed",
  "i-ami",
  "i-bnn",
  "i-default",
  "i-enochian",
  "i-hak",
  "i-klingon",
  "i-lux",
  "i-mingo",
  "i-navajo",
  "i-pwn",
  "i-tao",
  "i-tay",
  "i-tsu",
  "sgn-be-fr",
  "sgn-be-nl",
  "sgn-ch-de",
  "art-lojban",
  "cel-gaulish",
  "no-bok",
  "no-nyn",
  "zh-guoyu",
  "zh-hakka",
  "zh-min",
  "zh-min-nan",
  "zh-xiang",
]);

const ALPHA = /^[a-z]+$/;
const DIGIT = /^[0-9]+$/;
const ALPHANUM = /^[a-z0-9]+$/;

interface Subtag {
  readonly text: string;
  readonly offset: number;
}

function isAlpha(subtag: string, min: number, max: number): boolean {
  return subtag.length >= min && subtag.length <= max && ALPHA.test(subtag);
}

function isVariant(subtag: string): boolean {
  return (
    (subtag.length >= 5 && subtag.length <= 8 && ALPHANUM.test(subtag)) ||
    (subtag.length === 4 && DIGIT.test(subtag[0]!) && ALPHANUM.test(subtag))
  );
}

function isRegion(subtag: string): boolean {
  return isAlpha(subtag, 2, 2) || (subtag.length === 3 && DIGIT.test(subtag));
}

function isSingleton(subtag: string): boolean {
  return subtag.length === 1 && ALPHANUM.test(subtag) && subtag !== "x";
}

function checkLanguageTag(value: string): TeloFormatFailure | undefined {
  if (value === "") return { reason: "a language tag is not empty", offset: 0 };
  const lower = value.toLowerCase();
  if (GRANDFATHERED.has(lower)) return undefined;
  const subtags: Subtag[] = [];
  let offset = 0;
  for (const text of lower.split("-")) {
    if (text === "" || text.length > 8 || !ALPHANUM.test(text)) {
      return { reason: "a subtag is 1 to 8 letters or digits, separated by -", offset };
    }
    subtags.push({ text, offset });
    offset += text.length + 1;
  }
  let at = 0;
  const next = (): Subtag | undefined => subtags[at];
  const privateUse = (): TeloFormatFailure | undefined => {
    const x = subtags[at]!;
    at += 1;
    if (at >= subtags.length) {
      return { reason: "x introduces a private-use part and must be followed by a subtag", offset: x.offset };
    }
    at = subtags.length;
    return undefined;
  };

  const first = subtags[0]!;
  if (first.text === "x") return privateUse();
  if (!isAlpha(first.text, 2, 8)) {
    return { reason: "a language tag starts with a language subtag of 2 to 8 letters", offset: first.offset };
  }
  at = 1;
  if (first.text.length <= 3) {
    for (let count = 0; count < 3 && next() && isAlpha(next()!.text, 3, 3); count += 1) at += 1;
  }
  if (next() && isAlpha(next()!.text, 4, 4)) at += 1;
  if (next() && isRegion(next()!.text)) at += 1;
  while (next() && isVariant(next()!.text)) at += 1;
  while (next() && isSingleton(next()!.text)) {
    const singleton = next()!;
    at += 1;
    const start = at;
    while (next() && next()!.text.length >= 2) at += 1;
    if (at === start) {
      return {
        reason: `extension ${singleton.text} must be followed by a subtag of 2 to 8 letters or digits`,
        offset: singleton.offset,
      };
    }
  }
  if (next()?.text === "x") return privateUse();
  const stray = next();
  if (stray) {
    return {
      reason: `${stray.text} is not a subtag that can appear here: expected a script, region, variant, extension or private-use part`,
      offset: stray.offset,
    };
  }
  return undefined;
}

export const languageTagChecker: TeloFormatChecker = { check: checkLanguageTag };
