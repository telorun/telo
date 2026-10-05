import { describe, expect, it } from "vitest";
import { readSnapshotTar } from "../snapshot-tar";

const encoder = new TextEncoder();

function header(name: string, size: number, type: string, mode = 0o644, link = ""): Uint8Array {
  const block = new Uint8Array(512);
  block.set(encoder.encode(name), 0);
  block.set(encoder.encode(mode.toString(8).padStart(7, "0")), 100);
  block.set(encoder.encode(size.toString(8).padStart(11, "0")), 124);
  block.set(encoder.encode(type), 156);
  block.set(encoder.encode(link), 157);
  block.set(encoder.encode("ustar"), 257);
  return block;
}

function entry(name: string, data: Uint8Array, type = "0", mode = 0o644, link = ""): Uint8Array[] {
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return [header(name, data.length, type, mode, link), padded];
}

function tar(...parts: Uint8Array[][]): Uint8Array {
  const blocks = [...parts.flat(), new Uint8Array(1024)];
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

describe("readSnapshotTar", () => {
  it("reads files with their mode, bytes intact, and links as links", () => {
    const binary = new Uint8Array([0, 255, 254, 10, 13, 128]);
    const entries = readSnapshotTar(
      tar(
        entry("apps/", new Uint8Array(0), "5"),
        entry("apps/shop/telo.yaml", encoder.encode("kind: Telo.Application\n")),
        entry("scripts/run.sh", encoder.encode("#!/bin/sh\n"), "0", 0o755),
        entry("logo.png", binary),
        entry("latest", new Uint8Array(0), "2", 0o777, "apps/shop"),
      ),
    );
    expect(entries.map((e) => e.path)).toEqual([
      "apps/shop/telo.yaml",
      "scripts/run.sh",
      "logo.png",
      "latest",
    ]);
    expect(entries[0]).toMatchObject({ kind: "file", executable: false });
    expect(entries[1]).toMatchObject({ kind: "file", executable: true });
    expect(entries[2]!.kind === "file" && [...entries[2]!.bytes]).toEqual([...binary]);
    expect(entries[3]).toEqual({ path: "latest", kind: "symlink", target: "apps/shop" });
  });

  it("takes a long name from a pax record", () => {
    const long = `${"deep/".repeat(40)}file.txt`;
    const record = `path=${long}\n`;
    let length = record.length + 3;
    while (`${length} ${record}`.length !== length) length = `${length} ${record}`.length;
    const entries = readSnapshotTar(
      tar(
        entry("pax", encoder.encode(`${length} ${record}`), "x"),
        entry("truncated-name", encoder.encode("x")),
        entry("next.txt", encoder.encode("y")),
      ),
    );
    expect(entries.map((e) => e.path)).toEqual([long, "next.txt"]);
  });

  it("refuses a path that leaves the repository", () => {
    expect(() => readSnapshotTar(tar(entry("../outside", encoder.encode("x"))))).toThrow(
      /outside the repository/,
    );
    expect(() => readSnapshotTar(tar(entry("/etc/passwd", encoder.encode("x"))))).toThrow(
      /outside the repository/,
    );
  });

  it("reports a snapshot cut short instead of a short file", () => {
    const whole = tar(entry("a.txt", encoder.encode("hello")));
    expect(() => readSnapshotTar(whole.subarray(0, 514))).toThrow(/ends in the middle/);
  });
});
