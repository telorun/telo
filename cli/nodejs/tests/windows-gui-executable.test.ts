import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readEmbeddedPayload } from "../src/package/app-trailer.js";
import { buildWindowsGuiExecutable } from "../src/package/windows-gui-executable.js";
import {
  CARRIER_RESOURCES,
  DEBUG_DATA,
  FILE_ALIGNMENT,
  fabricatePe,
  independentChecksum,
  parsePe,
  parseResources,
  versionStrings,
} from "./__fixtures__/pe/pe-fixture.js";

/**
 * The Windows desktop executable, proven on fabricated PE images: no Windows
 * loader, signtool or Explorer runs here, so each property is read back by a
 * second, independent parser of the format.
 */

let dir: string;
let icon: Buffer;
const payload = Buffer.from("a payload standing in for the gzipped tar ".repeat(500));
const version = { productName: "Hello", version: "1.2.3-rc.1" };

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-windows-exe-"));
  const png = new PNG({ width: 1024, height: 1024 });
  for (let i = 0; i < png.data.length; i += 4) png.data.writeUInt32BE(0x3366ccff, i);
  icon = PNG.sync.write(png, { colorType: 6 });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function written(bytes: Buffer, name: string): Promise<string> {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

const find = (resources: ReturnType<typeof parseResources>, type: number, name: number | string) =>
  resources.filter((r) => r.type === type && r.name === name);

describe("a carrier whose resource section is followed by another", () => {
  let carrier: Buffer;
  let exe: Buffer;
  beforeAll(async () => {
    carrier = fabricatePe();
    exe = await buildWindowsGuiExecutable({ carrier, payload, icon, version });
  });

  it("is a GUI-subsystem image whose checksum is the PE checksum of its bytes", () => {
    const pe = parsePe(exe);
    expect(parsePe(carrier).subsystem).toBe(3);
    expect(pe.subsystem).toBe(2);
    expect(pe.checksum).toBe(independentChecksum(exe, pe.optional + 64));
  });

  it("keeps every section's bytes at their offset and address, and adds the resources as a new last section", () => {
    const before = parsePe(carrier);
    const after = parsePe(exe);
    for (const section of before.sections) {
      const kept = after.sections.find((s) => s.virtualAddress === section.virtualAddress)!;
      expect(kept.rawAt).toBe(section.rawAt);
      expect(exe.subarray(kept.rawAt, kept.rawAt + kept.rawSize).equals(carrier.subarray(section.rawAt, section.rawAt + section.rawSize))).toBe(true);
    }
    expect(after.sections.map((s) => s.name)).toEqual([".text", ".rsrc0", ".reloc", ".rsrc"]);
    const added = after.sections[3]!;
    expect(after.directory(2).rva).toBe(added.virtualAddress);
    expect(added.rawAt % FILE_ALIGNMENT).toBe(0);
    expect(after.sizeOfImage).toBe(added.virtualAddress + Math.ceil(added.virtualSize / 0x1000) * 0x1000);
  });

  it("keeps the carrier's own resources and replaces its icon and version", () => {
    const resources = parseResources(exe);
    for (const kept of CARRIER_RESOURCES.filter((r) => r.type === 10 || r.type === 24)) {
      expect(find(resources, kept.type as number, kept.name).map((r) => r.data)).toEqual([kept.data]);
    }
    expect(resources.some((r) => r.data.equals(Buffer.from("old icon image")) || r.data.equals(Buffer.from("old version")))).toBe(false);
  });

  it("carries the payload as an RT_RCDATA resource that a start finds and verifies", async () => {
    const [resource] = find(parseResources(exe), 10, "TELO_APP_PAYLOAD");
    expect(resource!.language).toBe(0);
    expect(resource!.data.subarray(0, payload.length).equals(payload)).toBe(true);
    const found = await readEmbeddedPayload(await written(exe, "Hello.exe"));
    expect(found?.placement).toBe("pe-resource");
    expect(found?.bytes.equals(payload)).toBe(true);
  });

  it("names the icon in an icon group: a 256 px PNG and smaller 32-bit bitmaps", () => {
    const resources = parseResources(exe);
    const [group] = find(resources, 14, 1);
    const count = group!.data.readUInt16LE(4);
    const entries = Array.from({ length: count }, (unused, i) => {
      const at = 6 + i * 14;
      return { width: group!.data[at] || 256, bytes: group!.data.readUInt32LE(at + 8), id: group!.data.readUInt16LE(at + 12) };
    });
    expect(entries.map((e) => e.width)).toEqual([256, 64, 48, 32, 24, 16]);
    for (const entry of entries) {
      const [image] = find(resources, 3, entry.id);
      expect(image!.data.length).toBe(entry.bytes);
      if (entry.width === 256) {
        const png = PNG.sync.read(image!.data);
        expect([png.width, png.height, png.data.readUInt32BE(0)]).toEqual([256, 256, 0x3366ccff]);
      } else {
        expect([image!.data.readUInt32LE(0), image!.data.readInt32LE(4), image!.data.readInt32LE(8), image!.data.readUInt16LE(14)]).toEqual([40, entry.width, entry.width * 2, 32]);
        expect(image!.data.readUInt32LE(40)).toBe(0xff3366cc);
      }
    }
  });

  it("states the product and its version in the version resource", () => {
    const [info] = find(parseResources(exe), 16, 1);
    expect(versionStrings(info!.data)).toEqual({
      FileDescription: "Hello",
      FileVersion: "1.2.3-rc.1",
      ProductName: "Hello",
      ProductVersion: "1.2.3-rc.1",
    });
    const fixed = info!.data.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe]));
    expect([info!.data.readUInt32LE(fixed + 8), info!.data.readUInt32LE(fixed + 12)]).toEqual([0x00010002, 0x00030000]);
  });

  it("still finds its payload once signed: a certificate table after the image, the security directory naming it", async () => {
    const certificate = Buffer.alloc(0x320, 0x5c);
    certificate.writeUInt32LE(certificate.length, 0);
    const signed = Buffer.concat([exe, certificate]);
    const pe = parsePe(signed);
    signed.writeUInt32LE(exe.length, pe.optional + 112 + 4 * 8);
    signed.writeUInt32LE(certificate.length, pe.optional + 116 + 4 * 8);
    const found = await readEmbeddedPayload(await written(signed, "Signed.exe"));
    expect(found?.placement).toBe("pe-resource");
    expect(found?.bytes.equals(payload)).toBe(true);
  });
});

describe("other carriers", () => {
  it("rewrites a resource section that ends the image in place", async () => {
    const carrier = fabricatePe({ resourceLast: true });
    const exe = await buildWindowsGuiExecutable({ carrier, payload, icon, version });
    const before = parsePe(carrier);
    const after = parsePe(exe);
    expect(after.sections.map((s) => [s.name, s.virtualAddress, s.rawAt])).toEqual(before.sections.map((s) => [s.name, s.virtualAddress, s.rawAt]));
    expect(after.directory(2).rva).toBe(before.directory(2).rva);
    expect((await readEmbeddedPayload(await written(exe, "InPlace.exe")))?.bytes.equals(payload)).toBe(true);
  });

  it("grows headers that have no room for a section, moving section bytes and the offsets that name them", async () => {
    const carrier = fabricatePe({ fullHeaders: true });
    const exe = await buildWindowsGuiExecutable({ carrier, payload, icon, version });
    const before = parsePe(carrier);
    const after = parsePe(exe);
    expect(after.sizeOfHeaders).toBe(before.sizeOfHeaders + FILE_ALIGNMENT);
    const debug = after.offset(after.directory(6).rva);
    const pointer = exe.readUInt32LE(debug + 24);
    expect(exe.subarray(pointer, pointer + DEBUG_DATA.length).equals(DEBUG_DATA)).toBe(true);
    // Moved whole, the debug entry's file offset being the one field rewritten.
    const expected = Buffer.from(carrier);
    expected.writeUInt32LE(pointer, before.offset(before.directory(6).rva) + 24);
    for (const section of before.sections) {
      const moved = after.sections.find((s) => s.virtualAddress === section.virtualAddress)!;
      expect(moved.rawAt).toBe(section.rawAt + FILE_ALIGNMENT);
      expect(exe.subarray(moved.rawAt, moved.rawAt + moved.rawSize).equals(expected.subarray(section.rawAt, section.rawAt + section.rawSize))).toBe(true);
    }
    expect(after.checksum).toBe(independentChecksum(exe, after.optional + 64));
    expect((await readEmbeddedPayload(await written(exe, "Grown.exe")))?.bytes.equals(payload)).toBe(true);
  });

  it("drops a signed carrier's certificate, which the edit invalidates", async () => {
    const certificate = Buffer.alloc(0x100, 0x77);
    const exe = await buildWindowsGuiExecutable({ carrier: fabricatePe({ certificate }), payload, icon, version });
    expect(parsePe(exe).directory(4)).toEqual({ rva: 0, size: 0 });
    expect(exe.includes(certificate)).toBe(false);
  });

  it("clears a stale security directory naming bytes inside the sections, keeping those bytes", async () => {
    // What the released carrier holds: postject rebuilt `.rsrc` over node.exe's certificate table.
    const carrier = fabricatePe({ resourceLast: true });
    const pe = parsePe(carrier);
    const rsrc = pe.sections.find((s) => s.name === ".rsrc")!;
    carrier.writeUInt32LE(rsrc.rawAt, pe.optional + 112 + 4 * 8);
    carrier.writeUInt32LE(0x100, pe.optional + 116 + 4 * 8);
    const exe = await buildWindowsGuiExecutable({ carrier, payload, icon, version });
    expect(parsePe(exe).directory(4)).toEqual({ rva: 0, size: 0 });
    expect(find(parseResources(exe), 10, "NODE_SEA_BLOB")[0]!.data.equals(CARRIER_RESOURCES[0]!.data)).toBe(true);
  });

  it("keeps the carrier's icon when the app names none", async () => {
    const exe = await buildWindowsGuiExecutable({ carrier: fabricatePe(), payload, version: { productName: "Hello" } });
    const resources = parseResources(exe);
    expect(find(resources, 3, 1).map((r) => r.data.toString())).toEqual(["old icon image"]);
    expect(versionStrings(find(resources, 16, 1)[0]!.data)).toEqual({ FileDescription: "Hello", ProductName: "Hello" });
  });

  it("is a carrier with no payload before it is written", async () => {
    expect(await readEmbeddedPayload(await written(fabricatePe(), "carrier.exe"))).toBeUndefined();
  });
});
