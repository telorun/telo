import { stampRefIdentity } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { buildResolvedProperties } from "../src/evaluation-context.js";

/** A fake precompiled expression — the shape `isCompiledValue` recognizes. */
const compiled = (source: string) => ({ __compiled: true as const, source, call: () => undefined });

describe("buildResolvedProperties — resolved config for the debug stream", () => {
  it("passes concrete values through and omits kind/metadata", () => {
    const props = buildResolvedProperties(
      { kind: "Http.Server", metadata: { name: "api" }, host: "127.0.0.1", port: 8077, logger: true } as any,
      new Set(),
    );
    expect(props).toEqual({ host: "127.0.0.1", port: 8077, logger: true });
  });

  it("renders a resolved !ref as its {kind, name}", () => {
    const props = buildResolvedProperties(
      { kind: "Sql.Migrations", metadata: { name: "m" }, connection: { kind: "Sql.Connection", name: "Db", alias: "Sql" } } as any,
      new Set(),
    );
    expect(props.connection).toEqual({ kind: "Sql.Connection", name: "Db" });
  });

  it("renders a deferred runtime expression as its `${{ source }}` text", () => {
    const props = buildResolvedProperties(
      { kind: "X", metadata: { name: "x" }, body: compiled("request.body") } as any,
      new Set(),
    );
    expect(props.body).toBe("${{ request.body }}");
  });

  it("renders a live injected instance as its stamped identity, not its internals", () => {
    const connection: any = { driver: "sqlite", db: {}, sqlite: {} };
    stampRefIdentity(connection, "SqlSqlite.Connection", "Db");
    const props = buildResolvedProperties(
      { kind: "SqlRepo.Read", metadata: { name: "reader" }, connection, table: "todos" } as any,
      new Set(),
    );
    expect(props.connection).toEqual({ kind: "SqlSqlite.Connection", name: "Db" });
    expect(props.table).toBe("todos");
  });

  it("scrubs known secret values, including substrings", () => {
    const props = buildResolvedProperties(
      {
        kind: "Api",
        metadata: { name: "a" },
        token: "s3cret",
        header: "Bearer s3cret",
        nested: { auth: "s3cret" },
      } as any,
      new Set(["s3cret"]),
    );
    expect(props.token).toBe("[secret]");
    expect(props.header).toBe("Bearer [secret]");
    expect(props.nested).toEqual({ auth: "[secret]" });
  });

  it("redacts an exact secret of any length but does not substring-scrub a short one", () => {
    const props = buildResolvedProperties(
      { kind: "Api", metadata: { name: "a" }, exact: "ab", inline: "grab the cab" } as any,
      new Set(["ab"]),
    );
    expect(props.exact).toBe("[secret]"); // whole value equals the secret
    expect(props.inline).toBe("grab the cab"); // short secret never garbles surrounding text
  });

  it("omits `schema` for a Telo.Definition but walks it as config for an ordinary kind", () => {
    const schema = { type: "object", examples: [{ ref: { kind: "X.Y", name: "z" } }] };
    expect(
      buildResolvedProperties(
        { kind: "Telo.Definition", metadata: { name: "d" }, schema, capability: "Telo.Service" } as any,
        new Set(),
      ),
    ).toEqual({ capability: "Telo.Service" });
    // An ordinary kind's `schema` field is ordinary config — walked, not skipped.
    const props = buildResolvedProperties(
      { kind: "Codec.Json", metadata: { name: "c" }, schema } as any,
      new Set(),
    );
    expect(props.schema).toBeDefined();
  });
});
