/**
 * Naming rules for every author-written Telo identifier — resource instances,
 * kinds, modules, import aliases, step names, config declarations and CEL
 * bindings. The single reader, so no surface re-derives the vocabulary; the
 * `ref-slot.ts` / `zone-slot.ts` precedent.
 *
 * **The rules exist because Telo has no lexer.** A name is a YAML scalar, so
 * nothing rejects its shape where it is declared, and every consequence
 * surfaces later at a CEL site that references it — or not at all. Probed
 * against the engine the runtime actually uses (`@marcbachmann/cel-js`):
 *
 *     resources.my-server.url  →  EVALUATES, as `resources.my - server.url`
 *     resources.in             →  ParseError: Expected IDENTIFIER, got IN
 *     resources.2fa            →  ParseError
 *     resources.for            →  parses fine
 *
 * The first line is the one that decides the design. When a bare name is in
 * scope — which `x-telo-bindings-from` deliberately makes possible — a
 * hyphenated resource name yields a wrong number with no diagnostic anywhere.
 * That is a swallowed error in the reference grammar, not a style preference.
 * The last line is why the reserved set here is the whole keyword list rather
 * than the subset today's parser happens to reject in field position: which
 * keywords tokenize there is a property of a dependency, and a name that
 * breaks on a parser upgrade was never safe.
 *
 * **Three tiers, because they fail in three different ways.**
 *
 * 1. `INVALID_NAME` (error, every surface) — not a CEL-safe identifier, or a
 *    CEL keyword. Below this line the name is unreferenceable or silently
 *    mis-referenced. This subsumes the old dot-only rule, which was the
 *    strictest special case of it: `!ref` splits on the first dot.
 *
 * 2. `INVALID_TYPE_NAME` (error) — a type-level name not starting uppercase.
 *    An error rather than a warning because half the reference grammar already
 *    rejects the alternative: `EXTENDS_ALIAS_PATTERN` in the kernel's manifest
 *    schema hard-rejects `extends: foo.Bar`, while nothing rejects the
 *    `metadata.name: foo` that produced it. A lowercase kind is a kind nobody
 *    can extend, so this only moves an existing failure to where it is
 *    fixable.
 *
 * 3. `NAME_CASE_CONVENTION` (warning) — a value-level name not starting
 *    lowercase. Warn-only, Rust's `non_snake_case` posture: a name is
 *    occasionally dictated from outside, and Telo has no `#[allow]`, so a hard
 *    error would leave no escape.
 *
 * **The convention: case encodes what the name denotes.** PascalCase names a
 * *type* — something writable in `kind:` / `extends:` / an `x-telo-ref` or type
 * slot. camelCase names a *value* — something holding data at runtime, read
 * through `resources.` / `steps.` / `variables.` in CEL. That is what
 * distinguishes `kind: Console.WriteLine` from `!ref Console.writeLine`, two
 * character-identical grammars otherwise, and the collision is not
 * hypothetical: it is the sanctioned singleton pattern (declare
 * `kind: Self.WriteLine`, export the instance, withhold the kind).
 *
 * **Only the first character is checked.** A full camelCase pattern would
 * relitigate `httpApi` vs `httpAPI` and `OAuthClient` vs `OauthClient` with no
 * benefit — the first character is what carries the type/value signal, and a
 * stricter rule would fight legitimate names containing acronyms or digits
 * while owning a judgement nobody asked this pass to make. An
 * entirely-acronym type name (`SQL`, `AI`) passes unchanged.
 *
 * **No `DiagnosticFix`.** A fix is a whole-value replacement for ONE node,
 * and a rename is only correct when every reference moves with it — offering
 * one here would rewrite `metadata.name` and break every `!ref` and CEL read
 * of it. Renaming belongs to a refactor that owns the reference graph.
 *
 * Browser-safe: pure string predicates, no I/O, no Node built-ins.
 */

import { DiagnosticSeverity } from "./types.js";

/**
 * CEL keywords. A name matching one is unreachable — `true` lexes as a
 * literal, `in` as an operator — so it is reserved everywhere a name becomes a
 * CEL identifier, which is every surface this file governs.
 */
export const CEL_RESERVED_WORDS: readonly string[] = [
  "as",
  "break",
  "const",
  "continue",
  "else",
  "false",
  "for",
  "function",
  "if",
  "import",
  "in",
  "let",
  "loop",
  "namespace",
  "null",
  "package",
  "return",
  "true",
  "var",
  "void",
  "while",
];

const RESERVED = new Set(CEL_RESERVED_WORDS);

/** What a CEL identifier may be — and therefore what a name that will be read
 *  through `resources.` / `steps.` / `variables.` must be. */
const CEL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Which half of the convention a name falls under.
 *
 * `type` — a name writable in a `kind:` / `extends:` / type slot: a module, a
 * kind, an import alias, or a resource whose capability is `Telo.Type` (a
 * named shape has no runtime instance, so its name denotes a type even though
 * it is declared as a resource).
 *
 * `value` — a name read through a CEL scope: a resource instance, a step, a
 * `variables` / `secrets` / `ports` declaration, a CEL binding.
 */
export type NameLevel = "type" | "value";

/** Document kinds whose `metadata.name` is type-level. Everything else
 *  declaring a name is a resource instance, whose level is decided by its
 *  kind's capability (see {@link NameLevel}). */
export const TYPE_LEVEL_DOC_KINDS: ReadonlySet<string> = new Set([
  "Telo.Application",
  "Telo.Library",
  "Telo.Definition",
  "Telo.Abstract",
  "Telo.Import",
]);

export interface NameViolation {
  /** Which tier failed. Callers use it to suppress a tier another check
   *  already reports better at that surface (the bindings site owns
   *  `reserved`, where it can also say what is being shadowed). */
  tier: "grammar" | "reserved" | "case";
  code: "INVALID_NAME" | "INVALID_TYPE_NAME" | "NAME_CASE_CONVENTION";
  severity: DiagnosticSeverity;
  /** Complete sentence(s), subject included — so every surface words the same
   *  rule the same way. */
  message: string;
}

/**
 * Check one author-written name.
 *
 * `surface` is the noun phrase naming what was declared ("resource name",
 * "step name", "import alias"), used as the message's subject.
 *
 * Returns the first violation only: the tiers are ordered by how badly the
 * name is broken, and telling an author their unparseable name is also
 * miscased buries the part that matters.
 */
export function checkName(
  name: string,
  level: NameLevel,
  surface: string,
): NameViolation | undefined {
  const subject = `${surface} '${name}'`;

  if (!CEL_IDENTIFIER_RE.test(name)) {
    return {
      tier: "grammar",
      code: "INVALID_NAME",
      severity: DiagnosticSeverity.Error,
      message: `${subject} must match /^[A-Za-z_][A-Za-z0-9_]*$/ — ${grammarReason(name, level)}`,
    };
  }

  if (RESERVED.has(name)) {
    return {
      tier: "reserved",
      code: "INVALID_NAME",
      severity: DiagnosticSeverity.Error,
      message: `${subject} is a CEL keyword, so no expression can reference it. Rename it.`,
    };
  }

  const first = name[0]!;
  if (level === "type" && !(first >= "A" && first <= "Z")) {
    return {
      tier: "case",
      code: "INVALID_TYPE_NAME",
      severity: DiagnosticSeverity.Error,
      message:
        `${subject} must start with an uppercase letter — it names a type, and the ` +
        `alias-qualified grammar of 'kind:' / 'extends:' accepts only PascalCase.`,
    };
  }

  if (level === "value" && !(first >= "a" && first <= "z")) {
    return {
      tier: "case",
      code: "NAME_CASE_CONVENTION",
      severity: DiagnosticSeverity.Warning,
      message:
        `${subject} should start with a lowercase letter — camelCase names a value (read ` +
        `through a CEL scope), PascalCase names a type.`,
    };
  }

  return undefined;
}

/**
 * Why the character set is what it is — which differs by level, and saying so
 * accurately matters more than one shared sentence. A value-level name becomes
 * a CEL identifier. A type-level name never does: it is a kind prefix or
 * suffix, so what constrains it is the alias-qualified `<Alias>.<Kind>` grammar
 * (`EXTENDS_ALIAS_PATTERN` in the kernel's manifest schema), which accepts the
 * same characters for its own reasons.
 */
function grammarReason(name: string, level: NameLevel): string {
  if (level === "type") {
    return name.includes(".")
      ? `a '.' separates the two halves of every '<Alias>.<Kind>' reference, so a dotted name cannot appear in either.`
      : `that is the character set the alias-qualified '<Alias>.<Kind>' grammar accepts on both sides.`;
  }
  if (name.includes("-")) {
    return (
      `it becomes a CEL identifier and CEL reads '-' as subtraction, so where a bare name is in ` +
      `scope this evaluates as arithmetic instead of failing.`
    );
  }
  if (name.includes(".")) {
    return `in a '!ref' the first '.' separates the import alias from the name.`;
  }
  return `it becomes a CEL identifier, so as written it cannot be referenced.`;
}
