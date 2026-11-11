/**
 * An application bundle's `Info.plist`: an XML property list of one dictionary
 * whose values are strings and booleans, which is all a bundle's identity needs.
 */

export type PlistValue = string | boolean;

const XML_INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/;

function escapeXml(text: string, what: string): string {
  if (XML_INVALID.test(text)) {
    throw new Error(`${what} holds a control character, which a property list cannot carry.`);
  }
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function encodeInfoPlist(entries: ReadonlyArray<readonly [key: string, value: PlistValue]>): string {
  const lines = entries.flatMap(([key, value]) => [
    `\t<key>${escapeXml(key, key)}</key>`,
    typeof value === "boolean" ? `\t<${value}/>` : `\t<string>${escapeXml(value, key)}</string>`,
  ]);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    ...lines,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * One string value of a property list's top-level dictionary, or `undefined`.
 * Read in the XML form only, which every bundle `telo package` writes is in.
 */
export function readPlistString(xml: string, key: string): string | undefined {
  for (const match of xml.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|apos);/g, (entity: string, name: string) => ENTITIES[name] ?? entity);
    if (decode(match[1]!) === key) return decode(match[2]!);
  }
  return undefined;
}
