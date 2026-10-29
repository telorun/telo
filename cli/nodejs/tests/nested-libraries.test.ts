import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOwnerManifest } from "@telorun/kernel";
import { ModulePayloadBuilder } from "../src/bundle/module-payload.js";
import { readImportGraph } from "../src/release/targets.js";
import type { DiscoveredModule, Workspace } from "../src/release/workspace.js";
import { PublishFailure } from "../src/publish-failure.js";

/**
 * A library inside the directory of the module being published ships inside that
 * module's artifact; one outside it is a separate artifact, as before.
 */

const DESTINATION = "oci://reg.example.test/org/app";

let root: string;

function write(rel: string, text: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const pin = (text: string): string => `sha256-${createHash("sha256").update(text).digest("base64url")}`;

function builder(): ModulePayloadBuilder {
  return new ModulePayloadBuilder({ cacheRoot: path.join(root, ".telo-cache"), stagedFiles: "disk" });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "telo-nested-"));
  write("shared/telo.yaml", "kind: Telo.Library\nmetadata:\n  name: Shared\n  version: 1.0.0\n");
  write(
    "app/telo.yaml",
    [
      "kind: Telo.Application",
      "metadata:",
      "  name: App",
      "  version: 0.1.0",
      "files:",
      '  - "**"',
      "imports:",
      "  Chat: ./chat",
      "  Ordering: ./ordering.yaml",
      "  Shared: ../shared",
      "",
    ].join("\n"),
  );
  write(
    "app/chat/telo.yaml",
    [
      "kind: Telo.Library",
      "metadata:",
      "  name: Chat",
      "imports:",
      "  Shared: ../../shared",
      "---",
      "kind: Chat.Prompt",
      "metadata:",
      "  name: prompt",
      "text: !include-text ./prompt.md",
      "",
    ].join("\n"),
  );
  write("app/chat/prompt.md", "be helpful\n");
  write("app/ordering.yaml", "kind: Telo.Library\nmetadata:\n  name: Ordering\n");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("nested libraries", () => {
  it("ships nested libraries in the root's artifact, pinned and relative", async () => {
    const payload = await builder().payload(path.join(root, "app/telo.yaml"), DESTINATION);

    expect(payload.nested.map((n) => n.path)).toEqual(["chat/telo.yaml", "ordering.yaml"]);
    const [chat, ordering] = payload.nested;
    expect(payload.manifest).toContain(`Chat: ./chat#${pin(chat.manifest)}`);
    expect(payload.manifest).toContain(`Ordering: ./ordering.yaml#${pin(ordering.manifest)}`);
  });

  it("keeps an import leaving the root a separate, canonicalized artifact", async () => {
    const payload = await builder().payload(path.join(root, "app/telo.yaml"), DESTINATION);

    expect(payload.manifest).toMatch(
      new RegExp(`Shared: oci://reg\\.example\\.test/org/shared@1\\.0\\.0#sha256-`),
    );
    // The nested library's own import leaving the root reads the same ref.
    expect(payload.nested[0].manifest).toContain("oci://reg.example.test/org/shared@1.0.0#sha256-");
    expect(payload.relativeImports.map((i) => i.ref)).toEqual([
      "oci://reg.example.test/org/shared@1.0.0",
    ]);
  });

  it("gives a nested library its own layers and keeps its files out of the root's", async () => {
    const payload = await builder().payload(path.join(root, "app/telo.yaml"), DESTINATION);
    const chat = payload.nested[0];

    const chatFiles = chat.layers.flatMap((layer) => layer.files.map((f) => f.name));
    expect(chatFiles).toContain("prompt.md");
    expect(readOwnerManifest(chat.manifest).layers?.length).toBe(chat.layers.length);
    const rootFiles = payload.layers.flatMap((layer) => layer.files.map((f) => f.name));
    expect(rootFiles.some((name) => name.startsWith("chat/"))).toBe(false);
  });

  it("publishes a nested library that declares no version", async () => {
    const payload = await builder().payload(path.join(root, "app/telo.yaml"), DESTINATION);
    expect(readOwnerManifest(payload.nested[0].manifest).version).toBeUndefined();
  });

  it("ships a library nested in a nested library once, however many nested libraries import it", async () => {
    write(
      "rec/telo.yaml",
      "kind: Telo.Application\nmetadata:\n  name: Rec\n  version: 0.1.0\nfiles:\n  - \"**\"\nimports:\n  P: ./p\n  Q: ./q\n",
    );
    write("rec/p/telo.yaml", "kind: Telo.Library\nmetadata:\n  name: P\nimports:\n  Inner: ./inner\n");
    write(
      "rec/p/inner/telo.yaml",
      "kind: Telo.Library\nmetadata:\n  name: Inner\n---\nkind: Inner.Note\nmetadata:\n  name: note\ntext: !include-text ./note.md\n",
    );
    write("rec/p/inner/note.md", "inner note\n");
    write("rec/q/telo.yaml", "kind: Telo.Library\nmetadata:\n  name: Q\nimports:\n  Inner: ../p/inner\n");

    const payload = await builder().payload(path.join(root, "rec/telo.yaml"), DESTINATION);

    expect(payload.nested.map((n) => n.path)).toEqual(["p/inner/telo.yaml", "p/telo.yaml", "q/telo.yaml"]);
    const inner = payload.nested.find((n) => n.path === "p/inner/telo.yaml")!;
    const p = payload.nested.find((n) => n.path === "p/telo.yaml")!;
    const q = payload.nested.find((n) => n.path === "q/telo.yaml")!;
    expect(q.manifest).toContain(`Inner: ../p/inner#${pin(inner.manifest)}`);
    expect(p.manifest).toContain(`Inner: ./inner#${pin(inner.manifest)}`);
    const pFiles = p.layers.flatMap((layer) => layer.files.map((f) => f.name));
    expect(pFiles.some((name) => name.startsWith("inner/"))).toBe(false);
    expect(inner.layers.flatMap((layer) => layer.files.map((f) => f.name))).toContain("note.md");
  });

  it("refuses an unpinned remote import inside a nested library", async () => {
    write(
      "app/chat/telo.yaml",
      "kind: Telo.Library\nmetadata:\n  name: Chat\nimports:\n  Sql: oci://reg.example.test/org/sql@1.0.0\n",
    );
    const failure = await builder()
      .payload(path.join(root, "app/telo.yaml"), DESTINATION)
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(PublishFailure);
    expect((failure as PublishFailure).code).toBe("import_unpinned");
  });

  it("refuses an import of a library nested in another module", async () => {
    write("app/lib/telo.yaml", "kind: Telo.Library\nmetadata:\n  name: Lib\n  version: 1.0.0\n");
    write(
      "other/telo.yaml",
      "kind: Telo.Application\nmetadata:\n  name: Other\n  version: 0.1.0\nimports:\n  Lib: ../app/lib\n",
    );
    const failure = await builder()
      .payload(path.join(root, "other/telo.yaml"), "oci://reg.example.test/org/other")
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(PublishFailure);
    expect((failure as PublishFailure).code).toBe("import_nested");
    expect((failure as PublishFailure).details).toEqual({
      alias: "Lib",
      target: "../app/lib/telo.yaml",
      module: "app",
      enclosing: "../app/telo.yaml",
    });
    expect((failure as PublishFailure).message).not.toContain(root);
  });

  it("refuses a workspace module that lies inside the workspace module importing it", async () => {
    const module = (key: string, dir: string): DiscoveredModule =>
      ({
        key,
        dir: path.join(root, dir),
        manifestPath: path.join(root, dir, "telo.yaml"),
        name: key,
        version: "1.0.0",
        artifactKind: "registry",
        settings: {},
      }) as unknown as DiscoveredModule;
    const workspace = {
      root,
      release: {},
      diagnostics: [],
      modules: [module("app", "app"), module("app/chat", "app/chat")],
    } as unknown as Workspace;
    const targets = new Map(
      workspace.modules.map((m) => [m.key, { registry: "oci://reg.example.test/org", destination: `oci://reg.example.test/org/${m.key}` }]),
    );

    const graph = await readImportGraph(workspace, targets, builder());

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "WORKSPACE_MODULE_NESTED",
        message: expect.stringContaining("drop the 'app/chat' entry"),
      }),
    ]);
  });
});
