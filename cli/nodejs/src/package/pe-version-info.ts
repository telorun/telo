/**
 * A Windows version resource (`VS_VERSIONINFO`): the fixed file information and
 * one string table, US English in UTF-16, which Explorer's Details tab and the
 * Task Manager read the product's name and version from.
 */

export interface VersionInfo {
  /** `ProductName` and `FileDescription`, the name Task Manager shows. */
  readonly productName: string;
  /** `ProductVersion` and `FileVersion` as written; absent leaves both strings out and the numbers `0.0.0.0`. */
  readonly version?: string;
}

const LANGUAGE_EN_US = 0x0409;
const CODE_PAGE_UNICODE = 0x04b0;
const VS_FFI_SIGNATURE = 0xfeef04bd;
const VS_FFI_STRUCVERSION = 0x00010000;
const VS_FFI_FILEFLAGSMASK = 0x3f;
const VS_FF_PRERELEASE = 0x2;
const VOS_NT_WINDOWS32 = 0x00040004;
const VFT_APP = 0x1;

/** The numeric parts of a version (`1.2.3-rc.1` → `[1, 2, 3, 0]`), each a 16-bit word. */
export function numericVersion(version: string): [number, number, number, number] {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
  if (!match) throw new Error(`metadata.version '${version}' does not begin with a number, so it cannot be a Windows file version.`);
  const parts = match.slice(1, 5).map((part) => Number(part ?? 0)) as [number, number, number, number];
  if (parts.some((part) => part > 0xffff)) {
    throw new Error(`metadata.version '${version}' cannot be a Windows file version: each of its numbers must be at most 65535.`);
  }
  return parts;
}

interface VersionNode {
  readonly key: string;
  /** Text values are written in UTF-16 with a terminator; binary as given. */
  readonly value?: { readonly text: string } | { readonly binary: Buffer };
  readonly children?: readonly VersionNode[];
}

const pad4 = (bytes: Buffer) => (bytes.length % 4 ? Buffer.concat([bytes, Buffer.alloc(4 - (bytes.length % 4))]) : bytes);

/** One node: `wLength`, `wValueLength`, `wType`, the key, its value, its children, each on a 32-bit boundary. */
function encodeNode(node: VersionNode): Buffer {
  const key = Buffer.from(`${node.key}\0`, "utf16le");
  const value = node.value === undefined ? Buffer.alloc(0) : "text" in node.value ? Buffer.from(`${node.value.text}\0`, "utf16le") : node.value.binary;
  const valueLength = node.value === undefined ? 0 : "text" in node.value ? node.value.text.length + 1 : value.length;
  const type = node.value !== undefined && "binary" in node.value ? 0 : 1;
  let body = pad4(Buffer.concat([Buffer.alloc(6), key]));
  body = Buffer.concat([body, value]);
  for (const child of node.children ?? []) body = Buffer.concat([pad4(body), encodeNode(child)]);
  body.writeUInt16LE(body.length, 0);
  body.writeUInt16LE(valueLength, 2);
  body.writeUInt16LE(type, 4);
  return body;
}

export function encodeVersionInfo(info: VersionInfo): Buffer {
  const [major, minor, patch, build] = info.version ? numericVersion(info.version) : [0, 0, 0, 0];
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(VS_FFI_SIGNATURE, 0);
  fixed.writeUInt32LE(VS_FFI_STRUCVERSION, 4);
  for (const at of [8, 16]) {
    fixed.writeUInt32LE(((major << 16) | minor) >>> 0, at);
    fixed.writeUInt32LE(((patch << 16) | build) >>> 0, at + 4);
  }
  fixed.writeUInt32LE(VS_FFI_FILEFLAGSMASK, 24);
  fixed.writeUInt32LE(info.version?.includes("-") ? VS_FF_PRERELEASE : 0, 28);
  fixed.writeUInt32LE(VOS_NT_WINDOWS32, 32);
  fixed.writeUInt32LE(VFT_APP, 36);

  const strings: Array<[string, string]> = [
    ["FileDescription", info.productName],
    ...(info.version ? ([["FileVersion", info.version]] as Array<[string, string]>) : []),
    ["ProductName", info.productName],
    ...(info.version ? ([["ProductVersion", info.version]] as Array<[string, string]>) : []),
  ];
  const translation = Buffer.alloc(4);
  translation.writeUInt16LE(LANGUAGE_EN_US, 0);
  translation.writeUInt16LE(CODE_PAGE_UNICODE, 2);
  const table = `${LANGUAGE_EN_US.toString(16).padStart(4, "0")}${CODE_PAGE_UNICODE.toString(16).padStart(4, "0")}`.toUpperCase();
  return encodeNode({
    key: "VS_VERSION_INFO",
    value: { binary: fixed },
    children: [
      {
        key: "StringFileInfo",
        children: [{ key: table, children: strings.map(([key, text]) => ({ key, value: { text } })) }],
      },
      { key: "VarFileInfo", children: [{ key: "Translation", value: { binary: translation } }] },
    ],
  });
}

/** The language the version resource is filed under. */
export const VERSION_LANGUAGE = LANGUAGE_EN_US;
