/**
 * `EVAL_MODE_BRANCH_CONFLICT` — a union whose branches give one property two
 * eval meanings, reported once at the document declaring the union: the kind's
 * own `schema:`, or the named shape its walk enters. A dependency's is reported
 * at the `imports:` entry reaching it (by the caller's `report`), since the
 * kernel refuses every kind whose walk meets it when it registers the kind.
 *
 * Browser-safe: no Node built-ins.
 */
import { canonicalTypeSchemaId, type ResourceManifest } from "@telorun/sdk";
import { evalModeBranchConflicts, type NamedShapeLookup } from "./eval-paths.js";
import {
  conflictLocation,
  conflictShape,
  EVAL_MODE_BRANCH_CONFLICT,
  evalModeBranchConflictMessage,
} from "./eval-mode-branch-conflict.js";
import { isKindDocument } from "./kind-declaration.js";
import { renderValuePath } from "./text-slot.js";

export interface EvalModeBranchProblem {
  readonly code: typeof EVAL_MODE_BRANCH_CONFLICT;
  readonly path: string;
  readonly message: string;
}

/** A named shape's declaring document, and the module it belongs to. */
export interface ShapeDocument {
  readonly manifest: ResourceManifest;
  readonly module: string | undefined;
}

export function validateEvalModeBranches(input: {
  /** Each kind document once, with the module declaring it and the schema of
   *  the kind it declares (a synthesized one's for a `Telo.NeedType`). */
  readonly kinds: ReadonlyArray<{ manifest: ResourceManifest; module: string | undefined; schema: unknown }>;
  readonly shapes: NamedShapeLookup;
  /** Every document that may declare a named shape. */
  readonly shapeDocuments: readonly ShapeDocument[];
  readonly report: (manifest: ResourceManifest, module: string | undefined, problem: EvalModeBranchProblem) => void;
}): void {
  const byId = new Map<string, ShapeDocument>();
  for (const document of input.shapeDocuments) {
    const name = document.manifest.metadata?.name;
    if (typeof name !== "string" || !document.module || isKindDocument(document.manifest)) continue;
    const id = canonicalTypeSchemaId(document.module, name);
    if (!byId.has(id)) byId.set(id, document);
  }
  const reported = new Set<string>();
  for (const { manifest, module, schema } of input.kinds) {
    for (const conflict of evalModeBranchConflicts(schema as Record<string, any> | undefined, input.shapes)) {
      const shape = conflictShape(conflict);
      const declaring = shape ? byId.get(shape.id) : { manifest, module };
      const root = (shape && input.shapes(shape.id)) || conflict.document;
      const path = renderValuePath(["schema", ...conflictLocation(conflict, root)]);
      const key = `${shape?.id ?? `${module ?? ""}\0${String(manifest.metadata?.name)}`}\0${path}`;
      if (reported.has(key)) continue;
      reported.add(key);
      if (declaring) {
        input.report(declaring.manifest, declaring.module, {
          code: EVAL_MODE_BRANCH_CONFLICT,
          path,
          message: evalModeBranchConflictMessage(conflict, `'${String(declaring.manifest.metadata?.name)}'`, root),
        });
      } else {
        input.report(manifest, module, {
          code: EVAL_MODE_BRANCH_CONFLICT,
          path: "schema",
          message: evalModeBranchConflictMessage(
            conflict,
            `'${String(manifest.metadata?.name)}' reaches the named shape '${shape?.name}', which`,
            root,
          ),
        });
      }
    }
  }
}
