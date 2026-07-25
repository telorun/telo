import { describe, expect, it, vi } from "vitest";
import type { DirEntry, WorkspaceAdapter } from "../model";
import { materializeModule, ModuleExistsError } from "./crud";
import type { TemplateDescriptor } from "./templates";

// The template path calls out to the network via `fetchTemplateFiles`; stub it
// so the atomicity test can force a fetch failure deterministically.
vi.mock("./templates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./templates")>();
  return { ...actual, fetchTemplateFiles: vi.fn(async () => { throw new Error("offline"); }) };
});

function memAdapter(existing: Record<string, DirEntry[]> = {}) {
  const writes: Record<string, string> = {};
  const deleted: string[] = [];
  const adapter: WorkspaceAdapter = {
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async (p: string, t: string) => {
      writes[p] = t;
    }),
    listDir: vi.fn(async (dir: string) => existing[dir] ?? []),
    createDir: vi.fn(async () => {}),
    delete: vi.fn(async (p: string) => {
      deleted.push(p);
    }),
    rename: vi.fn(async () => {}),
  };
  return { adapter, writes, deleted };
}

const CTX = { templatesBaseUrl: "https://x.dev", registryAdapters: [] };
const TEMPLATE: TemplateDescriptor = {
  id: "t",
  title: "T",
  description: "",
  category: "app",
  path: "apps/t/telo.yaml",
};

describe("materializeModule — blank", () => {
  it("writes telo.yaml under apps/<slug> with the picked name", async () => {
    const { adapter, writes } = memAdapter();
    const res = await materializeModule(adapter, "/ws", {
      kind: "Application",
      name: "Weather Api",
      selection: { type: "blank" },
      ...CTX,
    });
    expect(res.rootPath).toBe("/ws/apps/weather-api/telo.yaml");
    expect(writes["/ws/apps/weather-api/telo.yaml"]).toContain("name: Weather Api");
  });

  it("puts libraries under libs/<slug>", async () => {
    const { adapter } = memAdapter();
    const res = await materializeModule(adapter, "/ws", {
      kind: "Library",
      name: "Notes",
      selection: { type: "blank" },
      ...CTX,
    });
    expect(res.rootPath).toBe("/ws/libs/notes/telo.yaml");
  });
});

describe("materializeModule — overwrite", () => {
  it("throws ModuleExistsError naming the directory when occupied", async () => {
    const { adapter } = memAdapter({ "/ws/apps/notes": [{ name: "telo.yaml", isDirectory: false }] });
    await expect(
      materializeModule(adapter, "/ws", {
        kind: "Application",
        name: "Notes",
        selection: { type: "blank" },
        ...CTX,
      }),
    ).rejects.toBeInstanceOf(ModuleExistsError);
  });

  it("detects a directory with content even without a telo.yaml", async () => {
    const { adapter } = memAdapter({ "/ws/apps/notes": [{ name: "index.html", isDirectory: false }] });
    await expect(
      materializeModule(adapter, "/ws", {
        kind: "Application",
        name: "Notes",
        selection: { type: "blank" },
        ...CTX,
      }),
    ).rejects.toBeInstanceOf(ModuleExistsError);
  });

  it("deletes then writes when overwrite is set", async () => {
    const { adapter, deleted, writes } = memAdapter({
      "/ws/apps/notes": [{ name: "telo.yaml", isDirectory: false }],
    });
    await materializeModule(adapter, "/ws", {
      kind: "Application",
      name: "Notes",
      selection: { type: "blank" },
      overwrite: true,
      ...CTX,
    });
    expect(deleted).toContain("/ws/apps/notes");
    expect(writes["/ws/apps/notes/telo.yaml"]).toBeDefined();
  });
});

describe("materializeModule — atomicity", () => {
  it("does not delete the existing directory when the template fetch fails", async () => {
    const { adapter, deleted, writes } = memAdapter({
      "/ws/apps/notes": [{ name: "index.html", isDirectory: false }],
    });
    await expect(
      materializeModule(adapter, "/ws", {
        kind: "Application",
        name: "Notes",
        selection: { type: "template", template: TEMPLATE },
        overwrite: true,
        ...CTX,
      }),
    ).rejects.toThrow(/offline/);
    // The file set is built before any delete — a fetch failure leaves the
    // user's directory untouched.
    expect(deleted).toEqual([]);
    expect(writes).toEqual({});
  });
});
