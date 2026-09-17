import * as path from "path";
import ts from "typescript";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Type errors a fixture produces under strict checking. */
function typeErrors(fixture: string): string[] {
  const file = path.join(here, "__fixtures__/function-types", fixture);
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
  });
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file !== undefined && path.normalize(d.file.fileName) === path.normalize(file))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("a function controller's types", () => {
  it("refuse an async call and accept a synchronous one", () => {
    expect(typeErrors("async-call.ts").join("\n")).toMatch(/Promise<string>/);
    expect(typeErrors("sync-call.ts")).toEqual([]);
  });
});
