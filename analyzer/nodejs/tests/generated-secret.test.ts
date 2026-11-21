import { describe, expect, it } from "vitest";
import { BUILTIN_DOCUMENT_FILES } from "../src/builtin-entries/index.js";
import { GENERATED_PASSWORD_TYPE, GENERATED_SECRET_KEY_TYPE } from "../src/generated-secret.js";
import {
  resolveNeedTable,
  type NeedGraph,
  type NeedGraphDeclaration,
  type NeedGraphImport,
  type NeedGraphModule,
  type NeedGraphNeed,
} from "../src/need-table.js";
import { needParametersWithDefaults, readNeedTypeShape, type NeedTypeShape } from "../src/need-type.js";
import { PUBLIC_URL_TYPE } from "../src/public-address.js";

const shapeOf = (file: string): NeedTypeShape =>
  readNeedTypeShape(BUILTIN_DOCUMENT_FILES.find(([name]) => name === file)![1]);
const SHAPES: Record<string, NeedTypeShape> = {
  [GENERATED_SECRET_KEY_TYPE]: shapeOf("GeneratedSecretKey.json"),
  [GENERATED_PASSWORD_TYPE]: shapeOf("GeneratedPassword.json"),
  [PUBLIC_URL_TYPE]: shapeOf("PublicUrl.json"),
};

function module(key: string, overrides: Partial<NeedGraphModule>): NeedGraphModule {
  return {
    key,
    name: key,
    application: false,
    shared: false,
    needs: [],
    resourceInputs: [],
    declarations: [],
    references: [],
    needTypes: [],
    otherNames: new Map(),
    imports: [],
    checked: true,
    ...overrides,
  };
}

const need = (name: string, type: string, parameters?: unknown): NeedGraphNeed => ({
  name,
  kind: type,
  type,
  optional: false,
  declaresEnv: false,
  ...(parameters !== undefined ? { parameters } : {}),
});

const ref = (name: string) => ({ __tagged: true, engine: "ref", source: name });

const imported = (alias: string, target: string, supplied: Record<string, unknown>): NeedGraphImport => ({
  alias,
  manifest: { kind: "Telo.Import", metadata: { name: alias } } as never,
  target,
  supplied,
});

const ROOT_DOC = { kind: "Telo.Application", metadata: { name: "app" }, ports: { http: { env: "PORT" } } };

function problems(
  root: Partial<NeedGraphModule>,
  libraries: Record<string, Partial<NeedGraphModule>> = {},
): Array<{ code: string; path: string; message: string }> {
  const graph: NeedGraph = {
    root: "app",
    modules: new Map([
      ["app", module("app", { application: true, doc: ROOT_DOC as never, ...root })],
      ...Object.entries(libraries).map(([key, overrides]) => [key, module(key, overrides)] as const),
    ]),
    needType: (kind) => SHAPES[kind],
    isKind: () => true,
  };
  return resolveNeedTable(graph).problems.map((p) => ({ code: p.code, path: p.path, message: p.message }));
}

const KEY_32 = { bytes: 32, encoding: "base64url" };
const PASSWORD = {
  length: 4,
  characterSets: [
    { characters: "abc", minimum: 1 },
    { characters: "012", minimum: 1 },
  ],
};

describe("a generated need's parameters", () => {
  it("are refused where the type's schema refuses them", () => {
    for (const parameters of [
      { bytes: 8, encoding: "base64url" },
      { bytes: 32, encoding: "base32" },
      { length: 4, characterSets: [{ characters: "ab c" }] },
      undefined,
    ]) {
      const type = parameters && "length" in parameters ? GENERATED_PASSWORD_TYPE : GENERATED_SECRET_KEY_TYPE;
      const found = problems({ needs: [need("secret", type, parameters)] });
      expect(found.map((p) => p.code), JSON.stringify(parameters)).toEqual(["NEED_PARAMETERS_INVALID"]);
    }
  });

  it("refuse a character twice, within one set or across two, and minimums past the length", () => {
    const found = problems({
      needs: [
        need("secret", GENERATED_PASSWORD_TYPE, {
          length: 2,
          characterSets: [
            { characters: "aab", minimum: 2 },
            { characters: "b1", minimum: 1 },
          ],
        }),
      ],
    });
    expect(found).toEqual([
      {
        code: "NEED_PARAMETERS_INVALID",
        path: "needs.secret.parameters.characterSets[0].characters",
        message: "Need 'secret': characterSets[0] holds 'a' twice.",
      },
      {
        code: "NEED_PARAMETERS_INVALID",
        path: "needs.secret.parameters.characterSets[1].characters",
        message: "Need 'secret': characterSets[0] and characterSets[1] both hold 'b'.",
      },
      {
        code: "NEED_PARAMETERS_INVALID",
        path: "needs.secret.parameters.characterSets",
        message: "Need 'secret': the minimums of characterSets add up to 3, more than 'length: 2'.",
      },
    ]);
  });

  it("fill each set's minimum from the type's default", () => {
    expect(
      needParametersWithDefaults(SHAPES[GENERATED_PASSWORD_TYPE], { length: 3, characterSets: [{ characters: "ab" }] }),
    ).toEqual({ length: 3, characterSets: [{ characters: "ab", minimum: 0 }] });
  });
});

describe("a need forwarded whole", () => {
  const library = (parameters: unknown) => ({
    needs: [need("sessionKey", GENERATED_SECRET_KEY_TYPE, parameters)],
  });

  it("is refused when the need it supplies states a parameter with another value, naming both sets", () => {
    const found = problems(
      { needs: [need("sessionKey", GENERATED_SECRET_KEY_TYPE, KEY_32)], imports: [imported("Auth", "auth", { sessionKey: ref("sessionKey") })] },
      { auth: library({ bytes: 64, encoding: "base64url" }) },
    );
    expect(found).toEqual([
      {
        code: "NEED_FORWARD_INCOMPATIBLE",
        path: "needs.sessionKey",
        message:
          `Import 'Auth': need 'sessionKey' of module 'auth' states the parameters ` +
          `{"bytes":64,"encoding":"base64url"}, and 'sessionKey' states {"bytes":32,"encoding":"base64url"}, ` +
          `which differ at 'bytes'. A need forwarded whole states every parameter of the need it supplies ` +
          `with an equal value — give 'sessionKey' the same parameters, or supply 'sessionKey' another way.`,
      },
    ]);
  });

  it("is accepted with equal parameters, a password's defaults filled on both sides", () => {
    const written = { length: 4, characterSets: [{ characters: "abc", minimum: 0 }] };
    const defaulted = { length: 4, characterSets: [{ characters: "abc" }] };
    expect(
      problems(
        { needs: [need("pw", GENERATED_PASSWORD_TYPE, written)], imports: [imported("Db", "db", { pw: ref("pw") })] },
        { db: { needs: [need("pw", GENERATED_PASSWORD_TYPE, defaulted)] } },
      ),
    ).toEqual([]);
  });

  it("states nothing to a library's parameterless need", () => {
    expect(
      problems(
        {
          needs: [need("site", PUBLIC_URL_TYPE, { port: "http" })],
          imports: [imported("Web", "web", { site: ref("site") })],
        },
        { web: { needs: [need("site", PUBLIC_URL_TYPE)] } },
      ),
    ).toEqual([]);
  });
});

describe("a value supplied for a generated need", () => {
  const fulfilment = (key: string): NeedGraphDeclaration => ({
    name: "fixedKey",
    kind: GENERATED_SECRET_KEY_TYPE,
    type: GENERATED_SECRET_KEY_TYPE,
    manifest: { kind: GENERATED_SECRET_KEY_TYPE, metadata: { name: "fixedKey" }, fields: { key } } as never,
  });
  const library = { needs: [need("sessionKey", GENERATED_SECRET_KEY_TYPE, KEY_32)] };

  it("is NEED_VALUE_INVALID as a literal at an import's field-by-field supply", () => {
    const found = problems(
      { imports: [imported("Auth", "auth", { sessionKey: { key: "abc" } })] },
      { auth: library },
    );
    expect(found).toEqual([
      {
        code: "NEED_VALUE_INVALID",
        path: "needs.sessionKey.key",
        message:
          "Import 'Auth': need 'sessionKey' (type 'Telo.GeneratedSecretKey'): field 'key' does not decode as " +
          "base64url to 32 bytes.",
      },
    ]);
  });

  it("is NEED_VALUE_INVALID in a fulfilment's fields handed over whole, reported at the supply", () => {
    const found = problems(
      {
        declarations: [fulfilment(Buffer.alloc(32, 1).toString("base64url") + "=")],
        imports: [imported("Auth", "auth", { sessionKey: ref("fixedKey") })],
      },
      { auth: library },
    );
    expect(found.map((p) => [p.code, p.path])).toEqual([["NEED_VALUE_INVALID", "needs.sessionKey"]]);
    expect(found[0]!.message).toContain("'fixedKey' field 'key' decodes as base64url to 32 bytes but is not");
  });

  it("is accepted when it holds the need's parameters", () => {
    expect(
      problems(
        {
          declarations: [fulfilment(Buffer.alloc(32, 1).toString("base64url"))],
          imports: [imported("Auth", "auth", { sessionKey: ref("fixedKey") })],
        },
        { auth: library },
      ),
    ).toEqual([]);
  });

  it("holds a password to its length, its sets and their minimums", () => {
    const supply = (password: string) =>
      problems(
        { imports: [imported("Db", "db", { pw: { password } })] },
        { db: { needs: [need("pw", GENERATED_PASSWORD_TYPE, PASSWORD)] } },
      ).map((p) => p.message);
    expect(supply("a0b1")).toEqual([]);
    expect(supply("abc")[0]).toContain("field 'password' is not exactly 4 characters.");
    expect(supply("abca")[0]).toContain("field 'password' holds fewer than 1 character of characterSets[1].");
  });
});
