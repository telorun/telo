import { describe, expect, it } from "vitest";
import type { RepositoryLimits } from "../api";
import type { SnapshotEntry } from "../snapshot-tar";
import { CommitLimitError, ImportPathError, WorkingCopy } from "../working-copy";
import { WorkingCopyAdapter } from "../working-copy-adapter";
import { bytes, MemoryByteStore, text } from "./memory-byte-store";

const LIMITS: RepositoryLimits = {
  maxFileBytes: 1024,
  maxSnapshotFiles: 100,
  maxSnapshotBytes: 10_000,
  maxCommitChanges: 10,
  maxCommitBytes: 4096,
};

const BINARY = new Uint8Array([0, 255, 254, 10, 13, 128, 200]);

const file = (path: string, content: string | Uint8Array, executable = false): SnapshotEntry => ({
  path,
  kind: "file",
  executable,
  bytes: typeof content === "string" ? bytes(content) : content,
});

const BASE: SnapshotEntry[] = [
  file("apps/shop/telo.yaml", "kind: Telo.Application\n"),
  file("scripts/run.sh", "#!/bin/sh\n", true),
  file("logo.png", BINARY),
  { path: "latest", kind: "symlink", target: "apps/shop" },
];

async function seeded() {
  const store = new MemoryByteStore();
  const copy = new WorkingCopy(store);
  await copy.seed("main", "c1", BASE);
  const adapter = new WorkingCopyAdapter("prj_1", store, () => undefined);
  return { store, copy, adapter };
}

describe("WorkingCopy", () => {
  it("is clean after a seed, and keeps a link out of the working tree", async () => {
    const { store, copy, adapter } = await seeded();
    expect(await copy.changes()).toEqual([]);
    expect(store.files.has("tree/latest")).toBe(false);
    expect((await adapter.listDir("/cloud/prj_1")).map((e) => e.name).sort()).toEqual([
      "apps",
      "logo.png",
      "scripts",
    ]);
  });

  it("reports what the editor changed, by bytes", async () => {
    const { copy, adapter } = await seeded();
    await adapter.writeFile("/cloud/prj_1/apps/shop/telo.yaml", "kind: Telo.Application\n# edit\n");
    await adapter.writeFile("/cloud/prj_1/notes.md", "new");
    await adapter.delete("/cloud/prj_1/logo.png");
    // Written back with the same text: not a change.
    await adapter.writeFile("/cloud/prj_1/scripts/run.sh", "#!/bin/sh\n");
    expect(await copy.changes()).toEqual([
      { path: "apps/shop/telo.yaml", status: "modified" },
      { path: "logo.png", status: "deleted" },
      { path: "notes.md", status: "added" },
    ]);
  });

  it("commits a changed file with the mode its base records, and binary as base64", async () => {
    const { store, copy, adapter } = await seeded();
    await adapter.writeFile("/cloud/prj_1/scripts/run.sh", "#!/bin/sh\necho hi\n");
    await store.write("tree/logo.png", new Uint8Array([1, 2, 255]));
    await adapter.writeFile("/cloud/prj_1/notes.md", "new");
    const prepared = await copy.prepareCommit(LIMITS);
    expect(prepared.changes).toEqual([
      { op: "put", path: "logo.png", mode: "file", encoding: "base64", content: "AQL/" },
      { op: "put", path: "notes.md", mode: "file", encoding: "utf8", content: "new" },
      {
        op: "put",
        path: "scripts/run.sh",
        mode: "executable",
        encoding: "utf8",
        content: "#!/bin/sh\necho hi\n",
      },
    ]);
    await copy.recordCommit("c2", prepared);
    expect(await copy.baseCommit()).toBe("c2");
    expect(await copy.changes()).toEqual([]);
  });

  it("leaves a binary file and an executable byte for byte through an unrelated commit", async () => {
    const { store, copy, adapter } = await seeded();
    await adapter.writeFile("/cloud/prj_1/notes.md", "unrelated");
    const prepared = await copy.prepareCommit(LIMITS);
    expect(prepared.changes.map((c) => c.path)).toEqual(["notes.md"]);
    await copy.recordCommit("c2", prepared);
    expect([...(await store.read("tree/logo.png"))]).toEqual([...BINARY]);
    expect(await copy.changes()).toEqual([]);
    // Still executable in the base record: a later edit commits it as such.
    await adapter.writeFile("/cloud/prj_1/scripts/run.sh", "#!/bin/sh\n# later\n");
    expect((await copy.prepareCommit(LIMITS)).changes[0]).toMatchObject({ mode: "executable" });
  });

  it("names the file a limit refuses", async () => {
    const { copy, adapter } = await seeded();
    await adapter.writeFile("/cloud/prj_1/big.txt", "x".repeat(2000));
    await expect(copy.prepareCommit(LIMITS)).rejects.toThrow(CommitLimitError);
    await expect(copy.prepareCommit(LIMITS)).rejects.toThrow(/big\.txt/);
  });

  it("updates a clean working copy to the head", async () => {
    const { store, copy } = await seeded();
    const head = [
      file("apps/shop/telo.yaml", "kind: Telo.Application\n# theirs\n"),
      file("scripts/run.sh", "#!/bin/sh\n", true),
      file("added.txt", "theirs"),
    ];
    const prepared = await copy.prepareUpdate("c2", head);
    expect(prepared.plan).toEqual({
      takeHead: ["added.txt", "apps/shop/telo.yaml", "latest", "logo.png"],
      conflicts: [],
    });
    await copy.applyUpdate(prepared, new Set());
    expect(text(await store.read("tree/added.txt"))).toBe("theirs");
    expect(store.files.has("tree/logo.png")).toBe(false);
    expect(await copy.baseCommit()).toBe("c2");
    expect(await copy.changes()).toEqual([]);
  });

  it("merges per path and settles a conflict by the user's choice", async () => {
    const { store, copy, adapter } = await seeded();
    await adapter.writeFile("/cloud/prj_1/apps/shop/telo.yaml", "mine\n");
    await adapter.writeFile("/cloud/prj_1/scripts/run.sh", "mine too\n");
    await adapter.writeFile("/cloud/prj_1/local.txt", "only mine");
    const head = [
      file("apps/shop/telo.yaml", "theirs\n"),
      file("scripts/run.sh", "theirs too\n", true),
      file("logo.png", BINARY),
      file("remote.txt", "only theirs"),
      { path: "latest", kind: "symlink", target: "apps/shop" } as const,
    ];
    const prepared = await copy.prepareUpdate("c2", head);
    expect(prepared.plan).toEqual({
      takeHead: ["remote.txt"],
      conflicts: ["apps/shop/telo.yaml", "scripts/run.sh"],
    });
    // Nothing is touched until the user has chosen.
    expect(await copy.baseCommit()).toBe("c1");
    await copy.applyUpdate(prepared, new Set(["scripts/run.sh"]));
    expect(text(await store.read("tree/apps/shop/telo.yaml"))).toBe("mine\n");
    expect(text(await store.read("tree/scripts/run.sh"))).toBe("theirs too\n");
    expect(text(await store.read("tree/remote.txt"))).toBe("only theirs");
    // The head is the base and nothing was committed: mine are still changes.
    expect(await copy.baseCommit()).toBe("c2");
    expect(await copy.changes()).toEqual([
      { path: "apps/shop/telo.yaml", status: "modified" },
      { path: "local.txt", status: "added" },
    ]);
  });

  it("opens an empty repository as an empty tree and commits the first file", async () => {
    const store = new MemoryByteStore();
    const copy = new WorkingCopy(store);
    await copy.seed("main", null, []);
    const adapter = new WorkingCopyAdapter("prj_1", store, () => undefined);
    expect(await adapter.listDir("/cloud/prj_1")).toEqual([]);
    await adapter.writeFile("/cloud/prj_1/apps/shop/telo.yaml", "kind: Telo.Application\n");
    expect((await copy.prepareCommit(LIMITS)).changes).toHaveLength(1);
    expect(await copy.baseCommit()).toBeNull();
  });

  it("discards local changes back to the base", async () => {
    const { store, copy, adapter } = await seeded();
    await adapter.writeFile("/cloud/prj_1/notes.md", "new");
    await adapter.delete("/cloud/prj_1/logo.png");
    await copy.discard();
    expect(await copy.changes()).toEqual([]);
    expect([...(await store.read("tree/logo.png"))]).toEqual([...BINARY]);
  });

  it("copies files in as uncommitted changes, naming what it would replace", async () => {
    const { store, copy } = await seeded();
    const prepared = await copy.prepareImport(
      [
        { path: "apps/shop/telo.yaml", bytes: bytes("kind: Telo.Application\n# mine\n") },
        { path: "notes.md", bytes: bytes("new") },
        // Byte-identical to what the tree holds: not written, not a replacement.
        { path: "scripts/run.sh", bytes: bytes("#!/bin/sh\n") },
        { path: "latest", bytes: bytes("no longer a link") },
      ],
      LIMITS,
    );
    expect(prepared.overwrites).toEqual(["apps/shop/telo.yaml", "latest"]);
    expect(prepared.files.map((f) => f.path)).toEqual(["apps/shop/telo.yaml", "notes.md", "latest"]);
    // Preparing changes nothing.
    expect(await copy.changes()).toEqual([]);

    await copy.applyImport(prepared);
    expect(await copy.changes()).toEqual([
      { path: "apps/shop/telo.yaml", status: "modified" },
      { path: "latest", status: "modified" },
      { path: "notes.md", status: "added" },
    ]);
    expect(text(await store.read("tree/notes.md"))).toBe("new");

    await copy.discard();
    expect(await copy.changes()).toEqual([]);
  });

  it("refuses a copy before writing anything", async () => {
    const { copy } = await seeded();
    const small = { path: "notes.md", bytes: bytes("new") };
    await expect(
      copy.prepareImport([small, { path: "big.txt", bytes: new Uint8Array(2048) }], LIMITS),
    ).rejects.toThrow(/big\.txt/);
    // A file where the project holds a directory, and under a path it holds as a file.
    await expect(copy.prepareImport([{ path: "apps", bytes: bytes("x") }], LIMITS)).rejects.toThrow(
      ImportPathError,
    );
    await expect(
      copy.prepareImport([{ path: "logo.png/readme.md", bytes: bytes("x") }], LIMITS),
    ).rejects.toThrow(/logo\.png/);
    const many = Array.from({ length: 11 }, (_, i) => ({ path: `f${i}.txt`, bytes: bytes("x") }));
    await expect(copy.prepareImport(many, LIMITS)).rejects.toThrow(CommitLimitError);
    expect(await copy.changes()).toEqual([]);
  });

  describe("sensitive env files", () => {
    // `.env.local` at the root is sensitive by default; under apps/shop a
    // nearer marker marks `.secrets` instead, so its `.env.local` is not.
    const MARKER_TEXT = "env:\n  files: [.env.local, { name: .secrets, sensitive: true }]\n";
    const MARKER = file("apps/shop/telo-workspace.yaml", MARKER_TEXT);
    const COMMITTED_SECRET = file(".env.local", "TOKEN=committed\n");

    async function seededWithSecrets() {
      const store = new MemoryByteStore();
      const copy = new WorkingCopy(store);
      await copy.seed("main", "c1", [...BASE, MARKER, COMMITTED_SECRET]);
      const adapter = new WorkingCopyAdapter("prj_1", store, () => undefined);
      return { store, copy, adapter };
    }

    it("are never listed or committed, and a committed one is never deleted", async () => {
      const { store, copy, adapter } = await seededWithSecrets();
      expect(store.files.has("tree/.env.local")).toBe(false);
      await adapter.writeFile("/cloud/prj_1/apps/shop/.secrets", "TOKEN=mine\n");
      await adapter.writeFile("/cloud/prj_1/apps/shop/.env.local", "PORT=8080\n");
      expect(await copy.changes()).toEqual([{ path: "apps/shop/.env.local", status: "added" }]);
      const prepared = await copy.prepareCommit(LIMITS);
      expect(prepared.changes.map((change) => change.path)).toEqual(["apps/shop/.env.local"]);
    });

    it("are left as they are by an update, a discard and a branch switch", async () => {
      const { store, copy, adapter } = await seededWithSecrets();
      await adapter.writeFile("/cloud/prj_1/apps/shop/.secrets", "TOKEN=mine\n");
      await adapter.writeFile("/cloud/prj_1/.env.local", "TOKEN=mine\n");
      const head = [
        ...BASE,
        MARKER,
        file(".env.local", "TOKEN=theirs\n"),
        file("apps/shop/.secrets", "TOKEN=theirs\n"),
      ];
      const prepared = await copy.prepareUpdate("c2", head);
      expect(prepared.plan).toEqual({ takeHead: [], conflicts: [] });
      await copy.applyUpdate(prepared, new Set());
      await copy.discard();
      await copy.seed("feature", "c3", head);
      expect(text(await store.read("tree/apps/shop/.secrets"))).toBe("TOKEN=mine\n");
      expect(text(await store.read("tree/.env.local"))).toBe("TOKEN=mine\n");
      expect(await copy.changes()).toEqual([]);
    });

    it("are kept by a discard when only the base's markers mark them", async () => {
      const { store, copy, adapter } = await seededWithSecrets();
      await adapter.writeFile("/cloud/prj_1/apps/shop/telo-workspace.yaml", "env:\n  files: [.env.local]\n");
      await adapter.writeFile("/cloud/prj_1/apps/shop/.secrets", "TOKEN=mine\n");
      await copy.discard();
      expect(text(await store.read("tree/apps/shop/.secrets"))).toBe("TOKEN=mine\n");
      expect(await copy.changes()).toEqual([]);
    });

    it("are kept by a branch switch the snapshot does not mark, and then show as added", async () => {
      const { store, copy, adapter } = await seededWithSecrets();
      await adapter.writeFile("/cloud/prj_1/apps/shop/.secrets", "TOKEN=mine\n");
      await copy.seed("feature", "c3", BASE);
      expect(text(await store.read("tree/apps/shop/.secrets"))).toBe("TOKEN=mine\n");
      expect(await copy.changes()).toEqual([{ path: "apps/shop/.secrets", status: "added" }]);
    });

    it("are left out of an update whose head newly marks them", async () => {
      const { store, copy, adapter } = await seeded();
      await adapter.writeFile("/cloud/prj_1/apps/shop/.secrets", "TOKEN=mine\n");
      const head = [...BASE, MARKER, file("apps/shop/.secrets", "TOKEN=theirs\n")];
      const prepared = await copy.prepareUpdate("c2", head);
      expect(prepared.plan).toEqual({ takeHead: ["apps/shop/telo-workspace.yaml"], conflicts: [] });
      await copy.applyUpdate(prepared, new Set());
      expect(text(await store.read("tree/apps/shop/.secrets"))).toBe("TOKEN=mine\n");
      expect(await copy.changes()).toEqual([]);
    });

    describe("when a marker's env block is refused", () => {
      const BROKEN_TEXT = "env:\n  files: [{ name: .secrets, sensitve: true }]\n";
      const BROKEN_MARKER = file("apps/shop/telo-workspace.yaml", BROKEN_TEXT);

      it("seeds every file from a snapshot carrying it, then refuses to list or commit until it is fixed", async () => {
        const store = new MemoryByteStore();
        const copy = new WorkingCopy(store);
        await copy.seed("main", "c1", [...BASE, BROKEN_MARKER, file("apps/shop/.secrets", "TOKEN=committed\n")]);
        expect(text(await store.read("tree/apps/shop/.secrets"))).toBe("TOKEN=committed\n");
        await expect(copy.changes()).rejects.toThrow(/sensitve/);
        await expect(copy.prepareCommit(LIMITS)).rejects.toThrow(/sensitve/);
        const adapter = new WorkingCopyAdapter("prj_1", store, () => undefined);
        await adapter.writeFile("/cloud/prj_1/apps/shop/telo-workspace.yaml", MARKER_TEXT);
        expect(await copy.changes()).toEqual([
          { path: "apps/shop/telo-workspace.yaml", status: "modified" },
        ]);
      });

      it("keeps a secret the working tree marks through a branch switch to a snapshot carrying it", async () => {
        const { store, copy, adapter } = await seededWithSecrets();
        await adapter.writeFile("/cloud/prj_1/apps/shop/.secrets", "TOKEN=mine\n");
        await copy.seed("feature", "c3", [...BASE, BROKEN_MARKER, file("apps/shop/.secrets", "TOKEN=theirs\n")]);
        expect(text(await store.read("tree/apps/shop/.secrets"))).toBe("TOKEN=mine\n");
        expect(text(await store.read("tree/apps/shop/telo-workspace.yaml"))).toBe(BROKEN_TEXT);
      });

      it("refuses a seed, a discard and an update while the working tree carries it, changing nothing", async () => {
        const { store, copy, adapter } = await seededWithSecrets();
        await adapter.writeFile("/cloud/prj_1/apps/shop/telo-workspace.yaml", BROKEN_TEXT);
        await adapter.writeFile("/cloud/prj_1/apps/shop/.secrets", "TOKEN=mine\n");
        await adapter.writeFile("/cloud/prj_1/notes.md", "new");
        const before = new Map([...store.files].map(([path, bytes]) => [path, [...bytes]]));
        await expect(copy.seed("feature", "c3", BASE)).rejects.toThrow(/sensitve/);
        await expect(copy.discard()).rejects.toThrow(/sensitve/);
        await expect(copy.prepareUpdate("c2", BASE)).rejects.toThrow(/sensitve/);
        expect(new Map([...store.files].map(([path, bytes]) => [path, [...bytes]]))).toEqual(before);
      });

      it("updates a clean working copy to a head carrying it", async () => {
        const { store, copy } = await seeded();
        const head = [...BASE, BROKEN_MARKER, file("apps/shop/.secrets", "TOKEN=theirs\n")];
        const prepared = await copy.prepareUpdate("c2", head);
        await copy.applyUpdate(prepared, new Set());
        expect(text(await store.read("tree/apps/shop/.secrets"))).toBe("TOKEN=theirs\n");
        expect(await copy.baseCommit()).toBe("c2");
      });
    });

    it("refuses with the marker's message when its env block is refused", async () => {
      const { copy, adapter } = await seededWithSecrets();
      await adapter.writeFile(
        "/cloud/prj_1/apps/shop/telo-workspace.yaml",
        "env:\n  files: [{ name: .secrets, sensitve: true }]\n",
      );
      await expect(copy.changes()).rejects.toThrow(/sensitve/);
      await expect(copy.prepareCommit(LIMITS)).rejects.toThrow(/sensitve/);
    });
  });
});

describe("WorkingCopyAdapter", () => {
  it("moves a directory with a binary file intact, and tells the listener", async () => {
    const store = new MemoryByteStore();
    await new WorkingCopy(store).seed("main", "c1", BASE);
    let writes = 0;
    const adapter = new WorkingCopyAdapter("prj_1", store, () => writes++);
    await store.write("tree/apps/shop/icon.bin", BINARY);
    await adapter.rename("/cloud/prj_1/apps/shop", "/cloud/prj_1/apps/store");
    expect([...(await store.read("tree/apps/store/icon.bin"))]).toEqual([...BINARY]);
    expect(await store.exists("tree/apps/shop")).toBe(false);
    expect(writes).toBe(1);
  });

  it("refuses a path outside the working copy", async () => {
    const { adapter } = await seeded();
    await expect(adapter.readFile("/cloud/prj_2/telo.yaml")).rejects.toThrow(/outside/);
    await expect(adapter.readFile("/etc/passwd")).rejects.toThrow(/outside/);
  });
});
