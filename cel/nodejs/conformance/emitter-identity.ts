/**
 * Every conformance row, answered by **both** backends and compared against each other.
 *
 * The two replays beside this one ask whether the engine's answer is RIGHT — against the
 * recording, against cel-spec. This one asks whether the two backends give the SAME answer,
 * which is a different question and is not implied by either: both drivers run the closure
 * backend, so an emitter that disagreed on 200 rows would leave every count in this
 * directory untouched. The comparison is per row, on the canonical text of the answer, so a
 * difference of CEL type or of error range is a difference of text.
 *
 * **One module per environment, not per row.** Rows share an environment unless they
 * declare a function of their own, so the rows are grouped by the environment's own digest
 * — which is exactly what the emitter's key is over — and each group is emitted as one
 * module and loaded once. That is also how a host will use the emitter, so the gate
 * exercises a module of 1,700-odd expressions rather than 1,700 modules of one.
 *
 * **The filter, and what it cannot reach.** It compares every row whose source reads whole
 * and compiles. A row that reads but cannot be compiled by either backend (`has(1)`) is
 * held to refusing with the same message on both, and a row that does not read is held to
 * being refused by both — so no row is silently dropped, and the test asserts that the
 * three counts add up to the file. What it cannot reach is a *form no row writes*: the
 * vectors are cel-spec's corpus, which has no comprehension over a host map, no chain into
 * declared state and no host-supplied implementation. Those are the package suite's
 * `backend-identity.test.ts`, whose own completeness is over the grammar's node kinds.
 */

import { CelCompileError, type CelEnvironment, type CelProgram, type CelValue } from "../src/index.js";
import { answerText, loadEmittedPrograms } from "../tests/emitted-host.js";
import { languageEnvironment, type LanguageRow } from "./language-replay.js";
import { activationOf, evaluationEnvironment } from "./value-replay.js";

export interface IdentityDifference {
  readonly id: string;
  readonly source: string;
  readonly closure: string;
  readonly emitted: string;
}

export interface IdentityReport {
  readonly rows: number;
  /** Rows whose answer both backends produced, and which were compared value for value. */
  readonly compared: number;
  /** Rows whose source does not read whole, so neither backend is given a tree. */
  readonly unreadable: number;
  /** Rows both backends refuse to compile, held to refusing with the same message. */
  readonly refusedAtCompile: number;
  /** Rows whose recorded bindings the conformance encoding itself cannot read. */
  readonly bindingsUnreadable: readonly string[];
  /** How many modules the rows were emitted as — one per distinct environment. */
  readonly modules: number;
  readonly differences: readonly IdentityDifference[];
}

interface Group {
  readonly environment: CelEnvironment;
  readonly sources: string[];
  readonly indexOfSource: Map<string, number>;
  readonly rows: { readonly row: LanguageRow; readonly at: number }[];
}

export async function replayEmitterIdentity(rows: readonly LanguageRow[]): Promise<IdentityReport> {
  const base = languageEnvironment();
  const groups = new Map<string, Group>();
  const differences: IdentityDifference[] = [];
  const bindingsUnreadable: string[] = [];
  let unreadable = 0;
  let refusedAtCompile = 0;

  for (const row of rows) {
    const environment = evaluationEnvironment(base, row);
    const expression = environment.parse(row.source);
    if (expression.diagnostics.length > 0) {
      unreadable += 1;
      continue;
    }
    // A tree neither backend can compile at all. Held to refusing the same way rather than
    // dropped: the refusal is a compile-time answer, and two backends that refuse different
    // trees are two languages.
    const closureRefusal = compileRefusal(() => environment.compile(row.source));
    const emittedRefusal = compileRefusal(() => environment.emit([row.source]));
    if (closureRefusal !== undefined || emittedRefusal !== undefined) {
      refusedAtCompile += 1;
      if (closureRefusal !== emittedRefusal) {
        differences.push({
          id: row.id,
          source: row.source,
          closure: closureRefusal ?? "it compiled",
          emitted: emittedRefusal ?? "it compiled",
        });
      }
      continue;
    }
    const digest = environment.digest();
    let group = groups.get(digest);
    if (!group) {
      group = { environment, sources: [], indexOfSource: new Map(), rows: [] };
      groups.set(digest, group);
    }
    let at = group.indexOfSource.get(row.source);
    if (at === undefined) {
      at = group.sources.length;
      group.sources.push(row.source);
      group.indexOfSource.set(row.source, at);
    }
    group.rows.push({ row, at });
  }

  let compared = 0;
  for (const group of groups.values()) {
    const programs = await loadEmittedPrograms(group.environment, group.environment.emit(group.sources));
    for (const held of group.rows) {
      let activation: Record<string, CelValue>;
      try {
        activation = activationOf(held.row);
      } catch {
        bindingsUnreadable.push(held.row.id);
        continue;
      }
      compared += 1;
      const closure = answerText(group.environment.compile(held.row.source), activation);
      const emitted = answerText(programs[held.at]!, activation);
      if (closure !== emitted) {
        differences.push({ id: held.row.id, source: held.row.source, closure, emitted });
      }
    }
  }

  return {
    rows: rows.length,
    compared,
    unreadable,
    refusedAtCompile,
    bindingsUnreadable,
    modules: groups.size,
    differences,
  };
}

/** Why a backend refused to compile a tree, or nothing where it compiled it. */
function compileRefusal(run: () => CelProgram | unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (cause) {
    if (cause instanceof CelCompileError) return `CelCompileError: ${cause.message}`;
    throw cause;
  }
}
