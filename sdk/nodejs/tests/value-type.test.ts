import { describe, expect, it } from "vitest";
import { celDurationFromNanos, celTimestamp, celUint } from "../src/cel-value-identity.js";
import { PLAIN_ENCODINGS } from "../src/plain-encoding.js";
import {
  CEL_SCALAR_FORMS,
  holdsSensitiveMember,
  hostEntryOf,
  hostAnchorOf,
  isAbsoluteHostPath,
  markExactRendering,
  parseValueTypeEntry,
  redactedTextsOf,
  sensitiveMembersOf,
  VALUE_TYPES,
} from "../src/value-type.js";
import { composeUrl } from "../src/url-text.js";

describe("value-type vocabulary", () => {
  it("reads every entry, with an encoding on each non-live instance and none elsewhere", () => {
    const encodings = Object.fromEntries(
      [...VALUE_TYPES.values()].map((entry) => [entry.name, entry.encoding]),
    );
    expect(encodings).toEqual({
      "Telo.Bytes": "base64url",
      "Telo.Duration": "cel-duration",
      "Telo.Stream": undefined,
      "Telo.TcpPort": undefined,
      "Telo.Timestamp": "rfc3339",
      "Telo.UdpPort": undefined,
      "Telo.Uint64": undefined,
      "Telo.Url": "url-text",
    });
    expect(VALUE_TYPES.get("Telo.Uint64")?.celType).toBe("uint");
  });

  it("accepts an unsigned integer at the top of its range, in every representation", () => {
    const accepts = CEL_SCALAR_FORMS.uint!.range!.accepts;
    const max = 2n ** 64n - 1n;
    expect(accepts(celUint(max))).toBe(true);
    expect(accepts(max)).toBe(true);
    // A number is exact only up to 2^53 - 1; the literal of the top of the range
    // already reads as 2^64, so written as a number it is refused…
    expect(accepts(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(accepts(Number(max))).toBe(false);
    // …unless a validator's view rendered it, as a double, from the exact value.
    const view = { quota: Number(max) };
    markExactRendering(view, "quota");
    expect(accepts(view.quota, view, "quota")).toBe(true);
    expect(accepts(0)).toBe(true);
    expect(accepts(-1)).toBe(false);
    expect(accepts(2n ** 64n)).toBe(false);
    expect(accepts(1.5)).toBe(false);
  });

  it("refuses a `celType` its base cannot carry, and one on an instance", () => {
    expect(() =>
      parseValueTypeEntry("wrong-base.json", {
        name: "Telo.Wrong",
        representation: "json",
        base: "number",
        celType: "uint",
        description: "x",
      }),
    ).toThrow(/is not a CEL type a 'number' base carries beyond its own/);
    expect(() =>
      parseValueTypeEntry("instance-cel.json", {
        name: "Telo.WrongInstance",
        representation: "instance",
        binding: "bytes",
        encoding: "base64url",
        celType: "uint",
        description: "x",
      }),
    ).toThrow(/takes no 'base' or 'celType'/);
  });

  it("reads a host path: a brand over string anchored at the working directory", () => {
    const entry = VALUE_TYPES.get("Telo.HostPath")!;
    expect(entry).toMatchObject({ base: "string", fromHost: "working-directory" });
    expect(entry.celType).toBeUndefined();
    expect(hostAnchorOf({ "x-telo-type": "Telo.HostPath" })).toBe("working-directory");
    expect(hostAnchorOf({ "x-telo-type": "Telo.TcpPort" })).toBeUndefined();
  });

  it("refuses an anchor on anything but a string, and one no runtime knows", () => {
    const hostPath = (fields: Record<string, unknown>) => () =>
      parseValueTypeEntry("anchor.json", {
        name: "Telo.Anchored",
        representation: "json",
        base: "string",
        description: "x",
        ...fields,
      });
    expect(hostPath({ base: "integer", fromHost: "working-directory" })).toThrow(/needs a 'string' base/);
    expect(hostPath({ fromHost: "home-directory" })).toThrow(/is not an anchor this runtime knows/);
  });
});

describe("a value type with members", () => {
  const instance = (fields: Record<string, unknown>) => () =>
    parseValueTypeEntry("members.json", {
      name: "Telo.Members",
      representation: "instance",
      binding: "url",
      encoding: "url-text",
      description: "x",
      ...fields,
    });

  it("reads members, a text refusal code and a member-bound parameter", () => {
    const entry = VALUE_TYPES.get("Telo.Url")!;
    expect(Object.keys(entry.members!)).toEqual(["scheme", "host", "port", "user", "password", "path", "query"]);
    expect(entry.acceptsText).toEqual({ code: "URL_INVALID" });
    expect(entry.parameters).toMatchObject([
      { name: "scheme", member: "scheme" },
      { name: "user", member: "user" },
      { name: "password", member: "password" },
      { name: "path", member: "path" },
      { name: "query", member: "query" },
    ]);
    expect(sensitiveMembersOf(entry)).toEqual(["password"]);
  });

  it("refuses members anywhere but a non-live instance whose encoding builds from them", () => {
    expect(instance({ members: {} })).toThrow(/non-empty mapping/);
    expect(instance({ members: { "a-b": {} } })).toThrow(/is not spelled as a name/);
    expect(() =>
      parseValueTypeEntry("json-members.json", {
        name: "Telo.JsonMembers",
        representation: "json",
        base: "string",
        members: { a: {} },
        description: "x",
      }),
    ).toThrow(/belongs to a non-live 'instance'/);
    expect(instance({ encoding: "rfc3339", members: { a: {} } })).toThrow(/builds no value from members/);
  });

  it("refuses a text refusal code that is no code, and a parameter bound to no member", () => {
    expect(instance({ acceptsText: { code: "url-invalid" } })).toThrow(/is not spelled as a diagnostic code/);
    expect(instance({ acceptsText: { code: "X", extra: 1 } })).toThrow(/holding exactly 'code'/);
    expect(instance({ members: { a: {} }, parameters: [{ name: "p", member: "b" }] })).toThrow(
      /binds 'member: b', which is not one of its 'members'/,
    );
  });

  it("names the texts a URL holding a password must never print, and none for one without", () => {
    const secret = (composeUrl({ scheme: "postgres", host: "db", user: "app", password: "p@ss" }) as { value: unknown }).value;
    expect(redactedTextsOf(secret)).toEqual(["postgres://app:p%40ss@db", "p@ss"]);
    const open = (composeUrl({ scheme: "postgres", host: "db" }) as { value: unknown }).value;
    expect(redactedTextsOf(open)).toEqual([]);
    expect(redactedTextsOf("postgres://app:p@db")).toEqual([]);
  });

  it("answers from the entry whether a value holds a sensitive member", () => {
    const secret = (composeUrl({ scheme: "postgres", host: "db", user: "app", password: "p@ss" }) as { value: unknown }).value;
    const open = (composeUrl({ scheme: "postgres", host: "db", user: "app" }) as { value: unknown }).value;
    expect([secret, open, "postgres://app:p@db", { password: "p" }].map(holdsSensitiveMember)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });
});

describe("isAbsoluteHostPath", () => {
  it("judges POSIX, drive-letter and UNC paths absolute on every host", () => {
    for (const path of ["/srv/www", "C:\\data", "c:/data", "\\\\server\\share"]) {
      expect(isAbsoluteHostPath(path)).toBe(true);
    }
    for (const path of ["./public", "public", "../up", "C:relative", ""]) {
      expect(isAbsoluteHostPath(path)).toBe(false);
    }
  });
});

describe("plain encodings", () => {
  const { base64url, rfc3339 } = PLAIN_ENCODINGS;
  const celDuration = PLAIN_ENCODINGS["cel-duration"]!;

  it("write the canonical form and read it back", () => {
    const bytes = new Uint8Array([251, 255, 0]);
    expect(base64url!.encode(bytes)).toBe("-_8A");
    expect(base64url!.decode("-_8A")).toEqual(bytes);

    // The fraction is written to the precision it carries, with no trailing zero, and
    // is absent when the instant is whole — CEL's own `string(timestamp)`.
    expect(rfc3339!.encode(rfc3339!.decode("2026-01-15T09:30:00.25+02:00"))).toBe(
      "2026-01-15T07:30:00.25Z",
    );
    expect(rfc3339!.encode(rfc3339!.decode("2026-01-15T07:30:00.000Z"))).toBe(
      "2026-01-15T07:30:00Z",
    );
    // A nanosecond instant is representable, which no host date type makes it.
    expect(rfc3339!.decode("2026-01-15T07:30:00.000000001Z")).toEqual(
      celTimestamp(1768462200n, 1),
    );
    expect(rfc3339!.encode(celTimestamp(1768462200n, 1))).toBe("2026-01-15T07:30:00.000000001Z");
    // A year below 100 is that year, as CEL's `timestamp()` reads it.
    expect(rfc3339!.decode("0050-01-01T00:00:00Z")).toEqual(celTimestamp(-60589296000n, 0));

    expect(celDuration.encode(celDuration.decode("1h30m"))).toBe("5400s");
    expect(celDuration.encode(celDurationFromNanos(-1_500_000_000n))).toBe("-1.5s");
  });

  it("read nothing outside the encoding", () => {
    expect(base64url!.decode("-_8A=")).toBeUndefined();
    expect(rfc3339!.decode("2026-02-30T00:00:00Z")).toBeUndefined();
    expect(rfc3339!.decode("2026-01-15T09:30:00+24:00")).toBeUndefined();
    expect(rfc3339!.decode("2026-01-15 09:30")).toBeUndefined();
    // A tenth fractional digit is refused rather than rounded: rounding would read a
    // precision this domain does not hold as one it does.
    expect(rfc3339!.decode("2026-01-15T07:30:00.0000000001Z")).toBeUndefined();
    expect(rfc3339!.decode("10000-01-01T00:00:00Z")).toBeUndefined();
    expect(celDuration.decode("90 minutes")).toBeUndefined();
    // **This encoding's range is protobuf's, which is WIDER than CEL's own.** A duration
    // here reaches ±10,000 years, because a journal entry, a transport's payload and a
    // controller's value all do; CEL's duration is one int64 of nanoseconds (~±292
    // years) and a value past it is refused where it enters the engine rather than
    // where it is read. Both bounds are pinned, so the one that moves is the one that
    // fails: protobuf's edge decodes, and so does a duration past CEL's own.
    expect(celDuration.encode(celDuration.decode("-315576000000.999999999s"))).toBe(
      "-315576000000.999999999s",
    );
    expect(celDuration.encode(celDuration.decode("20000000000s"))).toBe("20000000000s");
    expect(celDuration.decode("315576000001s")).toBeUndefined();
    expect(celDuration.decode(`1${"0".repeat(40)}h`)).toBeUndefined();
  });
});

describe("a host path's entry parameter", () => {
  const hostPath = (parameters: unknown[], extra: Record<string, unknown> = {}) => ({
    name: "Telo.Path2",
    representation: "json",
    base: "string",
    description: "x",
    parameters,
    ...extra,
  });

  it("is read as a token, found by its flag", () => {
    expect(hostEntryOf({ "x-telo-type": { name: "Telo.HostPath", entry: "directory" } })).toBe("directory");
    expect(hostEntryOf({ "x-telo-type": { name: "Telo.HostPath", entry: "file" } })).toBe("file");
    expect(hostEntryOf({ "x-telo-type": "Telo.HostPath" })).toBeUndefined();
    expect(hostEntryOf({ "x-telo-type": { name: "Telo.HostPath", entry: "folder" } })).toBeUndefined();
  });

  it("belongs to a type declaring fromHost, at most once", () => {
    expect(() => parseValueTypeEntry("no-anchor.json", hostPath([{ name: "entry", hostEntry: true }]))).toThrow(
      /'hostEntry' belongs to a parameter of a type declaring 'fromHost'/,
    );
    expect(() =>
      parseValueTypeEntry(
        "two.json",
        hostPath(
          [
            { name: "a", hostEntry: true },
            { name: "b", hostEntry: true },
          ],
          { fromHost: "working-directory" },
        ),
      ),
    ).toThrow(/at most one parameter may declare 'hostEntry'/);
  });
});
