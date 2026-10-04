/**
 * The emitted module itself: what its text may contain, what its key covers, and what
 * happens when a stored copy is not the one that was asked for.
 *
 * These are the properties no answer-comparison can see. Two backends can agree on every
 * value and the emitter can still write a module that imports a specifier nothing resolves,
 * that reads a host property for a CEL field, that is served from a stale cache after a
 * standard function was replaced, or that differs byte for byte between two runs so nothing
 * can ever be cached at all.
 */
import { describe, expect, it } from "vitest";
import {
  CelEngineError,
  CelEnvironment,
  EMITTER_FORMAT_GENERATION,
  ENGINE_VERSION,
  emittedModuleRefusal,
  programsFromEmittedModule,
  readEmittedHeader,
  RUNTIME_BINDINGS,
  type EmittedModuleStore,
} from "../src/index.js";
import { environmentListing } from "../src/environment-digest.js";
import { CALL_SITE_DIRECT_ARITY } from "../src/runtime-library.js";
import { sha256OfText } from "../src/sha256.js";

const SOURCES = [
  "1 + 2",
  "x.y",
  "x['k']",
  "x.?maybe",
  "x[?'maybe']",
  "x[q]",
  "has(x.present)",
  "x.`content-type`",
  "x.__proto__",
  "x['constructor']",
  "xs.map(e, e * 2)",
  "xs.all(e, e > 0)",
  "cel.bind(n, 2, n * n)",
  "optional.of(1).optMap(v, v + 1)",
  "{'a': 1, ?'b': optional.none()}",
  "[1, ?optional.of(2)]",
  "duration('1s') + duration('2s')",
  "b'ab' + b'cd'",
  "'ab'.substring(1)",
  "size(x)",
];

function base(): CelEnvironment {
  return new CelEnvironment({ unlistedVariablesAreDyn: true, enableOptionalTypes: true });
}

/** A store in memory, which is all the engine's seam asks for. */
function memoryStore(held: Map<string, string> = new Map()): EmittedModuleStore & {
  readonly held: Map<string, string>;
  readonly reads: string[];
} {
  const reads: string[] = [];
  return {
    held,
    reads,
    read: (key) => {
      reads.push(key);
      return held.get(key);
    },
    write: (key, text) => {
      held.set(key, text);
    },
  };
}

describe("an emitted module's text", () => {
  const text = base().emit(SOURCES).text;

  it("imports nothing: the runtime is the factory's argument", () => {
    // A module naming a bare specifier is loadable only where that specifier resolves,
    // which rules out a `data:` URL, a relocated cache directory and a host whose resolver
    // is not Node's — and it would accept a runtime of another version silently.
    expect(text).not.toMatch(/(^|\n)\s*import\b/);
    expect(text).not.toMatch(/\bfrom\s*["']/);
    expect(text).not.toMatch(/\brequire\s*\(/);
    expect(text).toMatch(/export default function \(runtime\) \{/);
  });

  it("evaluates synchronously, and generates no code of its own", () => {
    expect(text).not.toMatch(/\basync\b/);
    expect(text).not.toMatch(/\bawait\b/);
    expect(text).not.toMatch(/\bnew Function\b/);
    expect(text).not.toMatch(/[^.\w]eval\(/);
  });

  it("reads no host property for a CEL member, in any form a read is written", () => {
    // **The guarantee, checked over the whole text rather than over the names of a probe.**
    // Every property the emitted code reads must be one of the engine's own structural
    // fields; a CEL field name — `y`, `maybe`, `content-type`, `__proto__`, `constructor` —
    // can therefore never be among them, however it was computed. A key from a request
    // (`x[q]`) is the form a word list could never have protected.
    // The call entry points are generated from the arity bound rather than listed, so a
    // wider bound cannot quietly let a new name through this gate.
    const structural = new Set([
      "activation",
      "namespaceFunction",
      "present",
      "held",
      "push",
      "call",
      ...Array.from({ length: CALL_SITE_DIRECT_ARITY + 1 }, (unused, at) => `call${at}`),
    ]);
    // The factory's body, with every string literal emptied: a comment and an expression's
    // own text are prose, and the question is what the CODE reads.
    const code = text.slice(text.indexOf("export default")).replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const read = new Set<string>();
    for (const found of code.matchAll(/\.([A-Za-z_$][\w$]*)/g)) read.add(found[1]!);
    expect([...read].filter((name) => !structural.has(name)).sort()).toEqual([]);
    // And the seam IS what it calls instead.
    expect(text).toMatch(/readThrough\(/);
    expect(text).toMatch(/hasMember\(/);
  });

  it("carries five fields in its header line and four in its export, and says why", () => {
    const module = base().emit(SOURCES);
    const identity = {
      format: EMITTER_FORMAT_GENERATION,
      engine: ENGINE_VERSION,
      environment: base().digest(),
      key: module.key,
    };
    // The LINE carries the body digest as well, because that digest covers the export and
    // so cannot live in it.
    expect(readEmittedHeader(text)).toEqual({ ...identity, body: module.header.body });
    expect(text).toContain(`export const integrity = ${JSON.stringify(identity)};`);
    // The export carries four fields and not the fifth: a digest cannot cover itself.
    const exported = text.split("\n").find((line) => line.startsWith("export const integrity"))!;
    expect(exported).not.toContain('"body"');
    // And the digest is over exactly the bytes after the header line.
    const after = text.slice(text.indexOf("\n", text.indexOf("//@telo.cel")) + 1);
    expect(sha256OfText(after)).toBe(module.header.body);
  });

  it("destructures exactly the bindings the runtime supplies", () => {
    // One table, so a binding the emitter writes and the runtime does not hold cannot ship:
    // it would be `undefined` at the first call rather than a refusal anyone could read.
    expect(Object.keys(base().emitterRuntime()).sort()).toEqual([...RUNTIME_BINDINGS].sort());
    expect(text).toContain(`const { ${RUNTIME_BINDINGS.join(", ")} } = runtime;`);
  });
});

describe("emission is deterministic", () => {
  it("writes byte-identical text for the same expressions against the same environment", () => {
    const first = base().emit(SOURCES);
    const second = base().emit(SOURCES);
    expect(second.text).toBe(first.text);
    expect(second.key).toBe(first.key);
    // And on one environment asked twice, which is the path a host actually takes.
    const one = base();
    expect(one.emit(SOURCES).text).toBe(one.emit(SOURCES).text);
  });

  it("depends on the order of the expressions and on nothing else about the request", () => {
    const forward = base().emit(["1 + 1", "2 + 2"]);
    const backward = base().emit(["2 + 2", "1 + 1"]);
    // The order is part of the identity: the factory answers one function per expression, by
    // position, so a host asking in another order is asking for another module.
    expect(backward.key).not.toBe(forward.key);
    expect(backward.sources).toEqual(["2 + 2", "1 + 1"]);
  });
});

describe("the cache key", () => {
  const sources = ["size('ab') + 1"];
  const key = (environment: CelEnvironment): string => environment.emit(sources).key;

  it("changes when a standard function is replaced", () => {
    // The capability this package exists for, and the reason the key is not over the source
    // text: the expression is identical and the environment is not.
    const replaced = base().registerFunction("size(string): int", { implementation: () => 99n });
    expect(key(replaced)).not.toBe(key(base()));
  });

  it("changes when a function is removed, by signature or by name", () => {
    const bySignature = base();
    bySignature.removeFunction("size(string): int");
    const byName = base();
    byName.removeFunctionsNamed("size");
    expect(key(bySignature)).not.toBe(key(base()));
    expect(key(byName)).not.toBe(key(base()));
    expect(key(byName)).not.toBe(key(bySignature));
  });

  it("changes when a variable, a type, a namespace or an option changes", () => {
    expect(key(base().registerVariable("a.b", "int"))).not.toBe(key(base()));
    expect(key(base().registerNamespace("Billing", ["total(int): int"]))).not.toBe(key(base()));
    expect(
      key(base().registerType({ name: "Money", base: "int", members: ["Self.cents(): int"] })),
    ).not.toBe(key(base()));
    expect(key(new CelEnvironment({ unlistedVariablesAreDyn: true }))).not.toBe(key(base()));
  });

  it("is the SAME for two environments built by different registration orders", () => {
    // The digest is over the resolved listing, never over the history: two ways of arriving
    // at one environment are one environment, or the cache fragments by nothing.
    const forward = base()
      .registerVariable("a", "int")
      .registerVariable("b", "string")
      .registerFunction("spend(int): int")
      .registerFunction("earn(int): int");
    const backward = base()
      .registerFunction("earn(int): int")
      .registerVariable("b", "string")
      .registerFunction("spend(int): int")
      .registerVariable("a", "int");
    expect(backward.digest()).toBe(forward.digest());
    expect(key(backward)).toBe(key(forward));
    // A registration REPLACED leaves one entry, so replacing and then restoring is the
    // environment it started as.
    const restored = base().registerFunction("size(string): int", { implementation: () => 1n });
    restored.registerFunction("size(string): int", { deterministic: true, origin: "standard-library" });
    expect(key(restored)).toBe(key(base()));
  });

  it("covers the emitter's format generation and the engine version", () => {
    const digest = base().digest();
    const listing = environmentListing(base());
    expect(listing).toEqual([...listing].sort());
    expect(digest).toBe(sha256OfText(listing.join("\n")));
    // The two components the environment cannot reach, named in the key's own text.
    expect(base().emit(sources).key).toBe(
      sha256OfText(
        [
          `format ${EMITTER_FORMAT_GENERATION}`,
          `engine ${ENGINE_VERSION}`,
          `environment ${digest}`,
          `expression ${JSON.stringify(sources[0])}`,
        ].join("\n"),
      ),
    );
  });
});

describe("a stored module", () => {
  it("is reused when its header matches", () => {
    const store = memoryStore();
    const environment = base();
    const first = environment.emittedModule(SOURCES, store);
    expect(first.emitted).toBe(true);
    expect(store.held.size).toBe(1);
    const second = environment.emittedModule(SOURCES, store);
    expect(second.emitted).toBe(false);
    expect(second.text).toBe(first.text);
    expect(second.refused).toBeUndefined();
  });

  it("causes a recompile, never a run, when its header is corrupted", () => {
    // **The failure the header exists for.** A key makes a hit likely; a header makes a
    // wrong hit impossible — and this is the one failure here that retrying does not undo,
    // which is why the guard ships with the first version rather than after an incident.
    const environment = base();
    const good = environment.emit(SOURCES);
    for (const [why, broken] of [
      ["another format generation", good.text.replace(/"format":\d+/, '"format":99')],
      ["another engine", good.text.replace(/"engine":"[^"]*"/, '"engine":"0.0.1"')],
      ["another environment", good.text.replace(/"environment":"[^"]*"/, '"environment":"beef"')],
      ["no header at all", good.text.split("\n").filter((line) => !line.startsWith("//@telo.cel")).join("\n")],
      ["a header that is not JSON", good.text.replace(/\/\/@telo\.cel .*/, "//@telo.cel {oops")],
      ["a header missing the body digest", good.text.replace(/,"body":"[^"]*"/, "")],
    ] as const) {
      const store = memoryStore(new Map([[good.key, broken]]));
      const held = environment.emittedModule(SOURCES, store);
      expect(held.emitted, why).toBe(true);
      expect(held.refused, why).toBeTruthy();
      expect(held.text, why).toBe(good.text);
      expect(store.held.get(good.key), why).toBe(good.text);
    }
  });

  it("causes a recompile when its body does not match the digest its header declares", () => {
    // **The three the provenance fields cannot see.** `format`, `engine` and `environment`
    // are byte-identical for every module one engine writes against one environment, so a
    // truncated text, an edited one and another key's text all carry a header that passes
    // them — and a text with an intact header, an exported factory and a matching function
    // count RUNS. Each of these is a recompile naming itself, never a load refusal and never
    // a run.
    const environment = base();
    const good = environment.emit(SOURCES);
    const edited = good.text.replace("h0 = [0, 5]", "h0 = [0, 6]");
    expect(edited).not.toBe(good.text);
    for (const [why, broken] of [
      // What a half-written file leaves behind: the header is there and the body is not.
      ["truncated after its header", good.text.slice(0, good.text.indexOf("export default"))],
      // The banner says "edit the expression, not this", which is evidence someone will.
      ["edited after it was written", edited],
      // And an edit that only adds: a line a reviewer would never notice.
      ["with a line appended", `${good.text}// and one more thing\n`],
    ] as const) {
      const store = memoryStore(new Map([[good.key, broken]]));
      const held = environment.emittedModule(SOURCES, store);
      expect(held.emitted, why).toBe(true);
      expect(held.refused, why).toContain("body does not match the digest its header declares");
      expect(held.text, why).toBe(good.text);
      expect(store.held.get(good.key), why).toBe(good.text);
    }
  });

  it("causes a recompile when the store answers one key's lookup with another key's text", () => {
    // **The case an expression count can only catch by luck**, so the pair below is chosen
    // to have the SAME number of expressions: nothing but the key tells them apart.
    const environment = base();
    const asked = ["1 + 1", "2 + 2"];
    const other = ["3 + 3", "4 + 4"];
    const good = environment.emit(asked);
    const foreign = environment.emit(other);
    expect(foreign.sources.length).toBe(good.sources.length);
    expect(foreign.key).not.toBe(good.key);

    const store = memoryStore(new Map([[good.key, foreign.text]]));
    const held = environment.emittedModule(asked, store);
    expect(held.emitted).toBe(true);
    expect(held.refused).toContain(`declares key ${foreign.key}`);
    expect(held.refused).toContain(`asked for is ${good.key}`);
    expect(held.text).toBe(good.text);

    // And the same mismatch on the LOAD path, where the bytes are gone and the export is
    // all there is: `emitted_module_rejected`, not a recompile.
    let code: string | undefined;
    try {
      programsFromEmittedModule(
        { integrity: foreign.header, default: () => asked.map(() => () => 1n) },
        good,
        environment.emitterRuntime(),
      );
    } catch (cause) {
      code = cause instanceof CelEngineError ? cause.code : (cause as Error).name;
    }
    expect(code).toBe("emitted_module_rejected");
  });

  it("names what differed, so a host can tell a stale cache from two engines", () => {
    const good = base().emit(SOURCES);
    expect(emittedModuleRefusal(good.text, good.header)).toBeUndefined();
    expect(
      emittedModuleRefusal(good.text.replace(/"engine":"[^"]*"/, '"engine":"0.0.1"'), good.header),
    ).toContain("emitted by engine 0.0.1");
  });
});

describe("a loaded module is verified before it runs", () => {
  const environment = base();
  const module = environment.emit(SOURCES);
  const factory = () => SOURCES.map(() => () => 1n);

  it("refuses a module that declares nothing, another environment, or the wrong arity", () => {
    const runtime = environment.emitterRuntime();
    const refusals = [
      { integrity: undefined, default: factory },
      { integrity: { ...module.header, environment: "beef" }, default: factory },
      { integrity: module.header, default: undefined },
      { integrity: module.header, default: () => [] },
    ];
    for (const loaded of refusals) {
      let code: string | undefined;
      try {
        programsFromEmittedModule(loaded, module, runtime);
      } catch (cause) {
        code = cause instanceof CelEngineError ? cause.code : `${(cause as Error).name}`;
      }
      expect(code).toBe("emitted_module_rejected");
    }
  });
});

describe("the digest's own hash", () => {
  it("is SHA-256, held to its published vectors", () => {
    // Including the 56-character case: a padding rule that is one block out passes every
    // short input and fails exactly there.
    expect(sha256OfText("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256OfText("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256OfText("a".repeat(55))).toBe(
      "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318",
    );
    expect(sha256OfText("a".repeat(56))).toBe(
      "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a",
    );
    expect(sha256OfText("héllo ✓")).toBe(
      "5657cdef8a85a584e0e961e6f8247cf5d3f8ed21496ed6fdbcfd43a761e94245",
    );
  });
});
