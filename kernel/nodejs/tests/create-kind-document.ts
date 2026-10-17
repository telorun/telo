import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";

/** The module the kind documents are declared in — so `Lib.<Kind>` names one. */
export const KIND_DOCUMENT_MODULE = "Lib";

/**
 * Creates one `Telo.Definition` / `Telo.Abstract` document through the kernel's
 * own create path — opened as a scope member of a booted application declaring
 * `declarations`, so no load-time analysis stands in front of it. Resolves to
 * the root cause that refused it, or `undefined` when the kernel created it.
 */
export async function createKindDocument(
  document: Record<string, unknown>,
  declarations = "",
): Promise<{ code?: string; message: string } | undefined> {
  const memory = new MemorySource();
  memory.set(
    "app",
    `kind: Telo.Application\nmetadata:\n  name: ${KIND_DOCUMENT_MODULE}\n${declarations ? `---\n${declarations}` : ""}`,
  );
  const kernel = new Kernel({ sources: [memory], env: {} });
  await kernel.load("memory://app");
  await kernel.boot();
  const metadata = (document.metadata ?? {}) as Record<string, unknown>;
  const scope = (
    kernel as unknown as {
      rootContext: { createScopeHandle(manifests: unknown[]): { run(fn: () => Promise<void>): Promise<void> } };
    }
  ).rootContext.createScopeHandle([
    { ...document, metadata: { ...metadata, module: KIND_DOCUMENT_MODULE } },
  ]);
  try {
    await scope.run(async () => {});
    return undefined;
  } catch (error) {
    return rootCause(error);
  } finally {
    await kernel.teardown();
  }
}

type Failure = { code?: string; message: string; diagnostics?: Failure[]; children?: Failure[]; derived?: boolean };

function rootCause(error: unknown): { code?: string; message: string } {
  const failure = error as Failure;
  const nested = [...(failure.diagnostics ?? []), ...(failure.children ?? [])].filter((d) => !d.derived);
  return nested.length > 0 ? rootCause(nested[0]) : { code: failure.code, message: failure.message };
}
