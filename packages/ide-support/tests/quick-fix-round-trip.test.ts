import type { ResourceManifest } from "@telorun/sdk";
import {
  StaticAnalyzer,
  buildPositionIndex,
  parseToAst,
  withSyntheticPositions,
} from "@telorun/analyzer";
import { describe, expect, it } from "vitest";

import { normalizeDiagnostic } from "../src/diagnostics/normalize.js";
import { renderFixReplacement } from "../src/diagnostics/fix-edit.js";

/**
 * The quick fix, end to end: analyze source text, resolve the diagnostic to a
 * span, render the repair into that span, and re-analyze the result.
 *
 * Every unit below this is green in isolation and could still produce an edit
 * that breaks the document — the span includes the author's quotes but not the
 * `!cel` tag, so an off-by-one in either direction yields YAML that parses into
 * something else. Re-analyzing the patched text is the only assertion that
 * catches that, and it is what "the lightbulb actually fixes it" means.
 */
describe("applying a quick fix repairs the manifest", () => {
  const definition = {
    kind: "Telo.Definition",
    metadata: { name: "Thing", module: "mod" },
    capability: "Telo.Invocable",
    schema: {
      type: "object",
      properties: {
        flag: {
          type: "boolean",
          "x-telo-eval": "runtime",
          // The fixture expressions read `a.b`. Declared, because an undeclared
          // ROOT is now a diagnostic of its own, and these cases are about the
          // call form — an expression carrying a second, unrelated error would
          // make "the repaired text analyzes clean" assert the wrong thing.
          "x-telo-context": {
            type: "object",
            properties: {
              a: { type: "object", properties: { b: { type: "string" } } },
            },
          },
        },
      },
    },
  } as unknown as ResourceManifest;

  /** Analyze one resource written as YAML text, returning its diagnostics plus
   *  the position index the editor would resolve ranges against. */
  function analyze(yamlText: string, expr?: string) {
    const doc = parseToAst(yamlText)[0]!;
    const lineOffsets = [0];
    for (let i = 0; i < yamlText.length; i++) {
      if (yamlText[i] === "\n") lineOffsets.push(i + 1);
    }
    const positionIndex = buildPositionIndex(doc, lineOffsets);
    // The analyzer takes parsed manifests; the AST above is only what maps a
    // diagnostic's `path` back to a span in the text.
    // The YAML text supplies the SPAN; the expression is what the loader would
    // have handed the analyzer. Passed explicitly for a block scalar, whose
    // folded value this harness does not reconstruct.
    const flag = expr ?? /flag: (.*)$/m.exec(yamlText)![1]!;
    const manifests = [
      definition,
      {
        kind: "mod.Thing",
        metadata: { name: "t", source: "telo.yaml" },
        flag: expr === undefined ? taggedFrom(flag) : { __tagged: true, engine: "cel", source: flag },
      },
    ] as unknown as ResourceManifest[];
    return {
      diagnostics: new StaticAnalyzer().analyze(withSyntheticPositions(manifests)),
      positionIndex,
      lineOffsets,
    };
  }

  /** Mirror the loader's `!cel` handling for the one field under test. */
  function taggedFrom(written: string): unknown {
    const body = /^!cel\s+(.*)$/.exec(written.trim());
    if (!body) return written;
    const raw = body[1]!.trim();
    const unquoted =
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1).replaceAll("''", "'")
        : raw;
    return { __tagged: true, engine: "cel", source: unquoted };
  }

  function offsetOf(pos: { line: number; character: number }, lineOffsets: number[]): number {
    return lineOffsets[pos.line]! + pos.character;
  }

  /** The repair as a consumer would apply it, or undefined when the span
   *  cannot be rewritten safely. */
  function renderedFix(yamlText: string, expr?: string): string | undefined {
    const { diagnostics, positionIndex, lineOffsets } = analyze(yamlText, expr);
    const target = diagnostics.find((d) => d.code === "CEL_WRONG_CALL_FORM");
    expect(target, "expected a repairable diagnostic").toBeDefined();

    const normalized = normalizeDiagnostic(target!, { registry: undefined as never, positionIndex });
    const replace = normalized.suggestions?.find((s) => s.kind === "replace");
    expect(replace, "expected the diagnostic to carry a repair").toBeDefined();

    const start = offsetOf(normalized.range.start, lineOffsets);
    const end = offsetOf(normalized.range.end, lineOffsets);
    const rendered = renderFixReplacement(yamlText.slice(start, end), replace!.replacement);
    return rendered === undefined
      ? undefined
      : yamlText.slice(0, start) + rendered + yamlText.slice(end);
  }

  function applyFix(yamlText: string): string {
    const after = renderedFix(yamlText);
    expect(after, "expected an applicable repair").toBeDefined();
    return after!;
  }

  it("repairs a double-quoted `!cel` scalar, keeping the tag and the quotes", () => {
    const before = `kind: mod.Thing\nmetadata:\n  name: t\nflag: !cel "startsWith(a.b, 'x')"\n`;
    const after = applyFix(before);

    expect(after).toBe(`kind: mod.Thing\nmetadata:\n  name: t\nflag: !cel "a.b.startsWith('x')"\n`);
    // The point of the round trip: the repaired text analyzes clean.
    expect(analyze(after).diagnostics.filter((d) => String(d.code).startsWith("CEL_"))).toEqual([]);
  });

  it("offers NO edit for a block scalar, rather than one that breaks the document", () => {
    // The span for `>-` covers the indicator and the trailing newline, so any
    // single-line replacement deletes the break that ended the entry and glues
    // `other:` onto the value. A following key is what makes that visible.
    const before =
      `kind: mod.Thing\nmetadata:\n  name: t\nflag: !cel >-\n  startsWith(a.b,\n  'x')\nother: keep-me\n`;
    expect(renderedFix(before, "startsWith(a.b, 'x')")).toBeUndefined();
  });

  it("repairs a single-quoted scalar without breaking on CEL's own quotes", () => {
    const before = `kind: mod.Thing\nmetadata:\n  name: t\nflag: !cel 'startsWith(a.b, "x")'\n`;
    const after = applyFix(before);

    expect(after).toContain(`!cel 'a.b.startsWith("x")'`);
    expect(analyze(after).diagnostics.filter((d) => String(d.code).startsWith("CEL_"))).toEqual([]);
  });
});
