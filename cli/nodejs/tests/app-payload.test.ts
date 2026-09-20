import * as fs from "fs/promises";
import { realpathSync } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APP_FORMAT_VERSION,
  MACHO_SECTION,
  MACHO_SEGMENT,
  encodeTrailer,
  payloadDigest,
  readEmbeddedPayload,
} from "../src/package/app-trailer.js";
import {
  PAYLOAD_INDEX,
  analysisKeyFor,
  packPayload,
  readPayloadIndex,
  unpackPayload,
} from "../src/package/app-payload.js";
import { appsRoot, userCacheRoot } from "../src/package/app-home.js";
import { NODE_CARRIER, unportableKinds } from "../src/package/portability.js";
import {
  assertCarrierExists,
  assertMayDownloadCarrier,
  carrierExtension,
  carrierReadsPayloads,
  carrierTarget,
} from "../src/package/carrier.js";
import { distributionKind } from "../src/distribution-versions.js";
import { readZipEntry, zipEntryNames } from "../src/package/zip.js";
import { deflateRawSync } from "node:zlib";

/**
 * The payload a packaged application carries: how it is found inside a carrier,
 * what it holds, and which closures may travel in one.
 *
 * The two placements are tested against the same reader, because that is the
 * property that matters: an appended payload and one riding in a Mach-O segment
 * are the same bytes found two ways, and a second reader would be the thing that
 * drifts.
 */

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "telo-app-test-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const PAYLOAD = Buffer.from("a packaged application's bytes");

describe("the trailer", () => {
  it("finds an appended payload after a carrier's own bytes", async () => {
    const file = path.join(dir, "app");
    await fs.writeFile(file, Buffer.concat([Buffer.alloc(4096, 7), PAYLOAD, encodeTrailer(PAYLOAD)]));
    const found = await readEmbeddedPayload(file);
    expect(found?.placement).toBe("appended");
    expect(found?.bytes.equals(PAYLOAD)).toBe(true);
  });

  it("finds a payload carried in a Mach-O segment", async () => {
    const file = path.join(dir, "app.macho");
    await fs.writeFile(file, machoCarrying(Buffer.concat([PAYLOAD, encodeTrailer(PAYLOAD)])));
    const found = await readEmbeddedPayload(file);
    expect(found?.placement).toBe("macho-segment");
    expect(found?.bytes.equals(PAYLOAD)).toBe(true);
  });

  it("reports a carrier with no payload rather than guessing", async () => {
    const file = path.join(dir, "plain");
    await fs.writeFile(file, Buffer.alloc(8192, 3));
    expect(await readEmbeddedPayload(file)).toBeUndefined();
  });

  it("refuses a payload whose bytes do not match the trailer's digest", async () => {
    const file = path.join(dir, "tampered");
    const trailer = encodeTrailer(PAYLOAD);
    const tampered = Buffer.from(PAYLOAD);
    tampered[0] ^= 0xff;
    await fs.writeFile(file, Buffer.concat([tampered, trailer]));
    // The magic can occur by accident inside a 140 MB binary's own data, so the
    // digest is what separates a payload from a coincidence.
    await expect(readEmbeddedPayload(file)).rejects.toThrow(/does not match its digest/);
  });

  it("refuses a format version it does not know", async () => {
    const file = path.join(dir, "future");
    const trailer = encodeTrailer(PAYLOAD);
    trailer.writeUInt32LE(APP_FORMAT_VERSION + 1, 0);
    await fs.writeFile(file, Buffer.concat([PAYLOAD, trailer]));
    await expect(readEmbeddedPayload(file)).rejects.toThrow(/format version/);
  });
});

describe("the payload", () => {
  it("round-trips its index and files, and frames identically for identical input", async () => {
    const entries = [
      { name: PAYLOAD_INDEX, content: JSON.stringify({ format: 1, app: { name: "Orders" } }) },
      { name: "app/telo.yaml", content: "kind: Telo.Application\n" },
      { name: "cache/manifests/x.yaml", content: "kind: Telo.Library\n" },
    ];
    const first = await packPayload(entries);
    const second = await packPayload([...entries].reverse());
    // Same closure, same bytes — which is what makes a rebuilt-but-unchanged
    // application reuse the unpack directory already on disk.
    expect(payloadDigest(first)).toBe(payloadDigest(second));

    const index = await readPayloadIndex(first);
    expect(index.app.name).toBe("Orders");

    const out = path.join(dir, "unpacked");
    await unpackPayload(first, out);
    expect(await fs.readFile(path.join(out, "app/telo.yaml"), "utf8")).toBe(
      "kind: Telo.Application\n",
    );
  });

  it("refuses an entry that would write outside the app directory", async () => {
    const payload = await packPayload([{ name: "../escape", content: "x" }]);
    await expect(unpackPayload(payload, path.join(dir, "unpacked"))).rejects.toThrow(
      /resolves outside/,
    );
  });

  it("keys the analysis verdict on the files it is a verdict about", async () => {
    const base = [
      { name: "app/telo.yaml", content: "kind: Telo.Application\n" },
      { name: "cache/manifests/x.yaml", content: "kind: Telo.Library\n" },
    ];
    const key = analysisKeyFor(base);
    // The stamp cannot name itself, and a compiled validator is a pure function
    // of a schema the key already covers.
    expect(
      analysisKeyFor([
        ...base,
        { name: "cache/analysis/abc.json", content: "{}" },
        { name: "cache/validators/v.js", content: "//" },
      ]),
    ).toBe(key);
    // Anything that can change the verdict moves it.
    expect(analysisKeyFor([...base, { name: "app/extra.yaml", content: "kind: X\n" }])).not.toBe(key);
  });
});

describe("what may be packaged", () => {
  const definition = (name: string, controllers: string[]) => ({
    kind: "Telo.Definition",
    metadata: { name, module: "demo" },
    controllers,
  });
  /** A resource of that kind — what makes the definition one the kernel will
   *  actually resolve a controller for. */
  const resource = (name: string) => ({ kind: `Demo.${name}`, metadata: { name: "x" } });
  const closure = (...docs: unknown[]) => docs as never;

  it("carries a bundled controller and a prebuilt native one", () => {
    expect(
      unportableKinds(
        closure(
          definition("Thing", ["pkg:telo/local/js?path=./nodejs/demo.mjs#Thing"]),
          resource("Thing"),
          definition("Addon", ["pkg:telo/local/napi?path=./x.node&os=linux&arch=amd64"]),
          resource("Addon"),
        ),
      ),
    ).toEqual([]);
  });

  it("refuses a candidate that needs a program on the target machine", () => {
    const [refusal] = unportableKinds(
      closure(definition("Blank", ["pkg:npm/@telorun/image@0.7.1?local_path=./nodejs#blank"]), resource("Blank")),
    );
    expect(refusal.kind).toBe("Blank");
    expect(refusal.module).toBe("demo");
    expect(refusal.candidates[0].reason).toMatch(/needs npm/);
  });

  it("refuses a format this carrier's kernel does not open", () => {
    const rusty = closure(
      definition("Rusty", ["pkg:telo/local/dylib?path=./libx.so&abi=telo-3"]),
      resource("Rusty"),
    );
    const [refusal] = unportableKinds(rusty);
    expect(refusal.candidates[0].reason).toMatch(/does not open/);
    // Derived from the carrier, not listed: another carrier answers differently.
    expect(unportableKinds(rusty, { formats: new Set(["dylib"]), label: "the Rust kernel" })).toEqual(
      [],
    );
  });

  it("passes a kind as soon as ONE candidate can travel", () => {
    expect(
      unportableKinds(
        closure(
          definition("Either", [
            "pkg:cargo/demo?local_path=./rust#thing",
            "pkg:telo/local/js?path=./nodejs/demo.mjs#Thing",
          ]),
          resource("Either"),
        ),
      ),
    ).toEqual([]);
  });

  it("reads candidates per kind, so an application's own definition is judged too", () => {
    const own = {
      kind: "Telo.Definition",
      metadata: { name: "Mine" },
      controllers: ["pkg:cargo/mine?local_path=./rust#mine"],
    };
    const [refusal] = unportableKinds(closure(own, { kind: "Self.Mine", metadata: { name: "m" } }));
    expect(refusal.kind).toBe("Mine");
    expect(refusal.candidates[0].reason).toMatch(/needs cargo/);
  });

  it("names the carrier's own kernel in its refusals", () => {
    expect(NODE_CARRIER.label).toContain("Node");
  });

  it("leaves a kind nothing instantiates alone", () => {
    // The kernel resolves a controller when a kind is INSTANTIATED and skips the
    // rest, so importing a module that happens to declare one crate-built kind
    // must not refuse a packaging of an app that never uses it.
    expect(
      unportableKinds(
        closure(
          definition("Unused", ["pkg:cargo/demo?local_path=./rust#unused"]),
          definition("Used", ["pkg:telo/local/js?path=./nodejs/demo.mjs#Used"]),
          resource("Used"),
        ),
      ),
    ).toEqual([]);
  });
});

describe("the carrier's platform", () => {
  it("derives the release-asset name from the install vocabulary", () => {
    expect(carrierTarget({ os: "linux", arch: "amd64" })).toBe("linux-amd64-gnu");
    expect(carrierTarget({ os: "linux", arch: "amd64", libc: "musl" })).toBe("linux-amd64-musl");
    expect(carrierTarget({ os: "darwin", arch: "arm64" })).toBe("darwin-arm64");
    expect(carrierExtension({ os: "windows", arch: "amd64" })).toBe(".exe");
  });

  it("refuses a platform no runtime is published for, before any download", () => {
    expect(() => assertCarrierExists({ os: "linux", arch: "arm64", libc: "musl" })).toThrow(
      /no musl runtime/,
    );
    expect(() => assertCarrierExists({ os: "plan9", arch: "amd64" })).toThrow(/Published platforms/);
  });
});

describe("who may stand a DOWNLOADED carrier around an application", () => {
  // A version number is not an identity for an unreleased tree: a working copy
  // and the release of the same number are different code, so a downloaded
  // carrier would carry the RELEASE while claiming to carry what built it, with
  // every local change silently absent. Only a released telo may download one.
  it("knows a released distribution from a working copy", () => {
    expect(distributionKind({ dependencies: { "@telorun/kernel": "0.94.0" } }, undefined)).toBe(
      "release",
    );
    expect(distributionKind({ dependencies: { "@telorun/kernel": "workspace:*" } }, undefined)).toBe(
      "checkout",
    );
    // A binary says which build it is rather than being inferred from a file it
    // does not have.
    expect(distributionKind(null, "release")).toBe("release");
    expect(distributionKind(null, "local")).toBe("checkout");
    // A binary that says nothing cannot claim to be the release.
    expect(distributionKind(null, undefined)).toBe("unknown");
  });

  it("refuses the download for anything but a release, and says what to run", () => {
    expect(() => assertMayDownloadCarrier("release", "linux-amd64-gnu", "1.0.0")).not.toThrow();
    for (const kind of ["checkout", "unknown"] as const) {
      expect(() => assertMayDownloadCarrier(kind, "linux-amd64-gnu", "1.0.0")).toThrow(
        /build:standalone/,
      );
    }
  });

  it("does not tell a binary to build the binary it already is", () => {
    // From a locally built binary the only thing left to say is that it can
    // carry its own platform and that another platform needs a release.
    expect(() =>
      assertMayDownloadCarrier("checkout", "linux-arm64-gnu", "1.0.0", {
        isBinary: true,
        hostTarget: "linux-amd64-gnu",
      }),
    ).toThrow(/its own platform \(linux-amd64-gnu\)[\s\S]*installed telo release/);
    expect(() =>
      assertMayDownloadCarrier("checkout", "linux-arm64-gnu", "1.0.0", {
        isBinary: true,
        hostTarget: "linux-amd64-gnu",
      }),
    ).not.toThrow(/build:standalone/);
  });
});

describe("a carrier that cannot read a payload", () => {
  // The carrier is always this CLI's own version, so this has exactly one
  // window: a checkout whose version is already published WITHOUT `telo
  // package`. Appending to that binary produces a file that runs the CLI —
  // packaged to look at, not packaged to run. Probed on the bytes that will do
  // the reading rather than gated on a version floor someone has to move.
  it("is recognised by the absence of the reader's own magic", async () => {
    const without = path.join(dir, "old-carrier");
    await fs.writeFile(without, Buffer.alloc(3 * 1024 * 1024, 0x41));
    expect(await carrierReadsPayloads(without)).toBe(false);

    const withReader = path.join(dir, "new-carrier");
    await fs.writeFile(
      withReader,
      Buffer.concat([Buffer.alloc(1024 * 1024, 0x41), Buffer.from("TELOAPP1"), Buffer.alloc(16, 0)]),
    );
    expect(await carrierReadsPayloads(withReader)).toBe(true);
  });

  it("finds a magic straddling the scan's chunk boundary", async () => {
    const straddling = path.join(dir, "straddling");
    const chunk = 1024 * 1024;
    const bytes = Buffer.alloc(chunk + 64, 0x41);
    Buffer.from("TELOAPP1").copy(bytes, chunk - 4);
    await fs.writeFile(straddling, bytes);
    expect(await carrierReadsPayloads(straddling)).toBe(true);
  });
});

describe("where a packaged app unpacks", () => {
  it("prefers TELO_APP_DIR, then the platform's user cache", () => {
    expect(userCacheRoot({ TELO_APP_DIR: "/somewhere" })).toBe(path.resolve("/somewhere"));
    if (process.platform === "linux") {
      expect(userCacheRoot({ XDG_CACHE_HOME: "/x" })).toBe(path.join("/x", "telo"));
      expect(userCacheRoot({ HOME: "/home/u" })).toBe(path.join("/home/u", ".cache", "telo"));
      // No HOME is an ordinary deployment, not an error — the caller falls back
      // to a temporary directory and, failing that, refuses naming TELO_APP_DIR.
      expect(userCacheRoot({})).toBeNull();
    }
  });

  it("falls back to a temporary directory when the cache root is unusable", () => {
    const root = appsRoot({ TELO_APP_DIR: path.join(dir, "denied", "\0bad") });
    expect(root).not.toBeNull();
    // Compared against the RESOLVED temp directory, because that is what the
    // fallback uses: on macOS `os.tmpdir()` is `/var/folders/…`, a symlink to
    // `/private/var/folders/…`, so asserting the unresolved prefix failed there
    // while the code was doing the right thing.
    expect(root!.startsWith(realpathSync(os.tmpdir()))).toBe(true);
  });
});

/** A 64-bit little-endian Mach-O carrying `data` in a `TELO_APP` segment's
 *  `TELO_APP_PAYLOAD` section — the shape postject produces on a darwin
 *  carrier, reduced to what the reader walks. */
function machoCarrying(data: Buffer): Buffer {
  const HEADER = 32;
  const SEGMENT = 72;
  const SECTION = 80;
  const commands = Buffer.alloc(SEGMENT + SECTION);
  commands.writeUInt32LE(0x19, 0); // LC_SEGMENT_64
  commands.writeUInt32LE(commands.length, 4);
  commands.write(MACHO_SEGMENT, 8, "ascii");
  commands.writeUInt32LE(1, 64); // nsects
  const section = SEGMENT;
  commands.write(MACHO_SECTION, section, "ascii");
  commands.write(MACHO_SEGMENT, section + 16, "ascii");
  commands.writeBigUInt64LE(BigInt(data.length), section + 40);
  const offset = HEADER + commands.length;
  commands.writeUInt32LE(offset, section + 48);

  const header = Buffer.alloc(HEADER);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(1, 16); // ncmds
  header.writeUInt32LE(commands.length, 20); // sizeofcmds
  // `__LINKEDIT` and the code signature follow the payload in a real carrier —
  // which is the whole reason darwin cannot take an appended one, and what this
  // stands in for: the trailer is NOT at the end of the file here.
  return Buffer.concat([header, commands, data, Buffer.alloc(1024, 9)]);
}

describe("reading a Windows carrier", () => {
  // The release publishes Windows as a `.zip` holding `telo.exe` at its root and
  // every other platform as a `.tar.gz` whose binary sits in a directory —
  // assuming one shape asked the release for an asset that does not exist.
  it("takes a named entry out of a zip, stored or deflated", () => {
    const contents = Buffer.from("MZ".padEnd(4096, "\0"));
    for (const method of ["store", "deflate"] as const) {
      const archive = makeZip([{ name: "telo.exe", contents, method }]);
      expect(readZipEntry(archive, "telo.exe")?.contents.equals(contents)).toBe(true);
      expect(zipEntryNames(archive)).toEqual(["telo.exe"]);
      expect(readZipEntry(archive, "telo")).toBeUndefined();
    }
  });

  it("refuses something that is not a zip rather than reading nonsense", () => {
    expect(() => readZipEntry(Buffer.alloc(1024, 7), "telo.exe")).toThrow(/not a zip archive/);
  });
});

/** A zip in the shape `Compress-Archive` writes: local headers, then a central
 *  directory, then the end record. */
function makeZip(
  files: readonly { name: string; contents: Buffer; method: "store" | "deflate" }[],
): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const body = file.method === "store" ? file.contents : deflateRawSync(file.contents);
    const crc = crc32(file.contents);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(file.method === "store" ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(file.method === "store" ? 0 : 8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(file.contents.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The zip checksum, written so an unpacker that checks it is satisfied. */
function crc32(bytes: Buffer): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
