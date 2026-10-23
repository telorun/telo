import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";
import { observedStateRead } from "../src/validate-observed-state.js";

/** A listener kind that reports what it discovers while running. */
const LISTENER_DEF: any = {
  kind: "Telo.Definition",
  metadata: { name: "RedirectListener", module: "OAuthClient" },
  capability: "Telo.Service",
  schema: {
    type: "object",
    properties: { port: { type: "integer" } },
  },
  status: {
    type: "object",
    properties: {
      port: { type: "integer" },
      redirectUri: { type: "string" },
    },
  },
} as unknown as ResourceManifest;

/** A consumer kind with one startup-resolved field and one runtime one. */
const CONSUMER_DEF = {
  kind: "Telo.Definition",
  metadata: { name: "Client", module: "Consumer" },
  capability: "Telo.Service",
  schema: {
    type: "object",
    properties: {
      baseUrl: { type: "string", "x-telo-eval": "compile" },
      url: { type: "string", "x-telo-eval": "runtime" },
    },
  },
} as unknown as ResourceManifest;

/** An Application that starts `loopback`, so reachability is satisfied. */
function app(targets: unknown[] = [makeTaggedSentinel("ref", "loopback")]) {
  return {
    kind: "Telo.Application",
    metadata: { name: "TestApp" },
    targets,
  } as unknown as ResourceManifest;
}

const listener = {
  kind: "OAuthClient.RedirectListener",
  metadata: { name: "loopback" },
} as unknown as ResourceManifest;

function consumer(field: "baseUrl" | "url", expr: string): ResourceManifest {
  return {
    kind: "Consumer.Client",
    metadata: { name: "browser" },
    [field]: makeTaggedSentinel("cel", expr),
  } as unknown as ResourceManifest;
}

function analyze(manifests: ResourceManifest[], code: string) {
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions(manifests))
    .filter((d) => d.code === code);
}

describe("observedStateRead — the syntactic recogniser", () => {
  it("recognises a local read", () => {
    expect(observedStateRead(["resources", "loopback", "status", "redirectUri"])).toEqual({
      name: "loopback",
      field: "redirectUri",
    });
  });

  it("recognises a cross-module read through an import alias", () => {
    expect(observedStateRead(["resources", "Auth", "loopback", "status", "port"])).toEqual({
      alias: "Auth",
      name: "loopback",
      field: "port",
    });
  });

  it("ignores a flat read and a non-resources chain", () => {
    expect(observedStateRead(["resources", "loopback", "port"])).toBeUndefined();
    expect(observedStateRead(["steps", "call", "status"])).toBeUndefined();
  });
});

describe("reading observed state from a field that resolves at startup", () => {
  it("rejects it where it is written", () => {
    const diagnostics = analyze(
      [LISTENER_DEF, CONSUMER_DEF, app(), listener, consumer("baseUrl", "resources.loopback.status.redirectUri")],
      "OBSERVED_STATE_IN_STARTUP_FIELD",
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("resolved once at startup");
    expect(diagnostics[0].message).toContain("only while the application is running");
  });

  it("accepts it in a field that resolves while the application runs", () => {
    expect(
      analyze(
        [LISTENER_DEF, CONSUMER_DEF, app(), listener, consumer("url", "resources.loopback.status.redirectUri")],
        "OBSERVED_STATE_IN_STARTUP_FIELD",
      ),
    ).toEqual([]);
  });

  it("leaves a flat read alone — this plan neither types nor restricts it", () => {
    expect(
      analyze(
        [LISTENER_DEF, CONSUMER_DEF, app(), listener, consumer("baseUrl", "resources.loopback.port")],
        "OBSERVED_STATE_IN_STARTUP_FIELD",
      ),
    ).toEqual([]);
  });
});

describe("reading observed state of a resource nothing can start", () => {
  it("rejects it before the application starts", () => {
    const diagnostics = analyze(
      [LISTENER_DEF, CONSUMER_DEF, app([]), listener, consumer("url", "resources.loopback.status.redirectUri")],
      "OBSERVED_STATE_NEVER_RUN",
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("nothing starts it");
  });

  it("accepts a resource named in the application's targets", () => {
    expect(
      analyze(
        [LISTENER_DEF, CONSUMER_DEF, app(), listener, consumer("url", "resources.loopback.status.redirectUri")],
        "OBSERVED_STATE_NEVER_RUN",
      ),
    ).toEqual([]);
  });

  it("accepts a resource reached only through a step's invoke: slot", () => {
    // A pure Runnable in an `invoke:` slot is dispatched via run() — it starts
    // without ever appearing in a targets: list.
    const sequence = {
      kind: "Telo.Definition",
      metadata: { name: "Sequence", module: "Run" },
      capability: "Telo.Runnable",
      schema: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            "x-telo-step-context": { invoke: "invoke" },
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                invoke: { type: "object", anyOf: [{ "x-telo-ref": "Telo.Runnable" }] },
                inputs: { type: "object", additionalProperties: true, "x-telo-eval": "runtime" },
              },
            },
          },
        },
      },
    } as unknown as ResourceManifest;

    const login = {
      kind: "Run.Sequence",
      metadata: { name: "login" },
      steps: [
        { name: "listen", invoke: makeTaggedSentinel("ref", "loopback") },
        {
          name: "use",
          invoke: makeTaggedSentinel("ref", "browser"),
          inputs: { url: makeTaggedSentinel("cel", "resources.loopback.status.redirectUri") },
        },
      ],
    } as unknown as ResourceManifest;

    expect(
      analyze(
        [LISTENER_DEF, CONSUMER_DEF, sequence, app([makeTaggedSentinel("ref", "login")]), listener, login],
        "OBSERVED_STATE_NEVER_RUN",
      ),
    ).toEqual([]);
  });

  it("says nothing about a kind that declares no status:", () => {
    const plain = {
      kind: "Telo.Definition",
      metadata: { name: "Plain", module: "OAuthClient" },
      capability: "Telo.Service",
      schema: { type: "object", properties: {} },
    } as unknown as ResourceManifest;
    const instance = {
      kind: "OAuthClient.Plain",
      metadata: { name: "quiet" },
    } as unknown as ResourceManifest;

    expect(
      analyze(
        [plain, CONSUMER_DEF, app([]), instance, consumer("url", "resources.quiet.status.anything")],
        "OBSERVED_STATE_NEVER_RUN",
      ),
    ).toEqual([]);
  });
});

describe("typed observed state", () => {
  it("flags a typo under .status", () => {
    const diagnostics = analyze(
      [LISTENER_DEF, CONSUMER_DEF, app(), listener, consumer("url", "resources.loopback.status.redirectUrl")],
      "CEL_UNKNOWN_FIELD",
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("redirectUrl");
  });

  it("accepts a declared field", () => {
    expect(
      analyze(
        [LISTENER_DEF, CONSUMER_DEF, app(), listener, consumer("url", "resources.loopback.status.port")],
        "CEL_UNKNOWN_FIELD",
      ),
    ).toEqual([]);
  });

  it("keeps the flat half permissive", () => {
    expect(
      analyze(
        [LISTENER_DEF, CONSUMER_DEF, app(), listener, consumer("url", "resources.loopback.anythingAtAll")],
        "CEL_UNKNOWN_FIELD",
      ),
    ).toEqual([]);
  });
});

describe("a Provider's observed state, reported from init()", () => {
  // The capability is INHERITED: the implementation declares none, and the
  // abstract it extends lives in a library only the implementation imports.
  const contract = {
    kind: "Telo.Abstract",
    metadata: { name: "Endpoint", module: "contract" },
    capability: "Telo.Provider",
    status: { type: "object", properties: { host: { type: "string" } } },
  } as unknown as ResourceManifest;

  const backend = {
    kind: "Telo.Definition",
    metadata: { name: "Container", module: "backend" },
    extends: "Contract.Endpoint",
    schema: { type: "object", properties: {} },
  } as unknown as ResourceManifest;

  const backendImport = {
    kind: "Telo.Import",
    metadata: { name: "Contract", module: "backend", resolvedModuleName: "contract" },
    source: "./contract",
  } as unknown as ResourceManifest;

  const consumerImport = {
    kind: "Telo.Import",
    metadata: { name: "Backend", resolvedModuleName: "backend" },
    source: "./backend",
  } as unknown as ResourceManifest;

  const provider = {
    kind: "Backend.Container",
    metadata: { name: "db" },
  } as unknown as ResourceManifest;

  // Nothing starts `db`: a Provider is never in a targets: list.
  const manifests = [
    app([]),
    consumerImport,
    backendImport,
    contract,
    backend,
    provider,
    CONSUMER_DEF,
  ] as unknown as ResourceManifest[];

  it("is readable in a field that resolves at startup", () => {
    expect(
      analyze([...manifests, consumer("baseUrl", "resources.db.status.host")], "OBSERVED_STATE_IN_STARTUP_FIELD"),
    ).toEqual([]);
  });

  it("needs nothing to start it", () => {
    expect(
      analyze([...manifests, consumer("url", "resources.db.status.host")], "OBSERVED_STATE_NEVER_RUN"),
    ).toEqual([]);
  });

  it("is typed closed at startup", () => {
    const diagnostics = analyze(
      [...manifests, consumer("baseUrl", "resources.db.status.hots")],
      "CEL_UNKNOWN_FIELD",
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("hots");
  });

  it("does not excuse a read whose target resolves to nothing", () => {
    expect(
      analyze([...manifests, consumer("baseUrl", "resources.nowhere.status.host")], "OBSERVED_STATE_IN_STARTUP_FIELD"),
    ).toHaveLength(1);
  });

  describe("declared in a scope", () => {
    // Scoped resources are created when the scope opens, where a startup field
    // of a scoped sibling cannot see them.
    const scopeDef = {
      kind: "Telo.Definition",
      metadata: { name: "Scoped", module: "Run" },
      capability: "Telo.Runnable",
      schema: {
        type: "object",
        properties: {
          with: { "x-telo-scope": ["/targets"], type: "array", items: { type: "object" } },
          targets: { type: "array", items: { "x-telo-ref": { kind: "Telo.Runnable", use: "call" } } },
        },
      },
    } as unknown as ResourceManifest;

    function scoped(field: "baseUrl" | "url"): ResourceManifest[] {
      const sequence = {
        kind: "Run.Scoped",
        metadata: { name: "flow" },
        with: [
          { kind: "Backend.Container", metadata: { name: "db" } },
          {
            kind: "Consumer.Client",
            metadata: { name: "browser" },
            [field]: makeTaggedSentinel("cel", "resources.db.status.host"),
          },
        ],
      } as unknown as ResourceManifest;
      return [...manifests.filter((x) => x !== provider), scopeDef, sequence];
    }

    it("is refused in a scoped sibling's startup field, naming the scope", () => {
      const diagnostics = analyze(scoped("baseUrl"), "OBSERVED_STATE_IN_STARTUP_FIELD");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].message).toContain("'db' is declared in the 'with' scope of Run.Scoped/flow");
    });

    it("is readable in a scoped sibling's field that resolves while it runs", () => {
      expect(analyze(scoped("url"), "OBSERVED_STATE_IN_STARTUP_FIELD")).toEqual([]);
    });

    it("leaves a reader outside the scope to the scope's reach check", () => {
      const outside = {
        kind: "Consumer.Client",
        metadata: { name: "outside" },
        baseUrl: makeTaggedSentinel("cel", "resources.db.status.host"),
      } as unknown as ResourceManifest;
      expect(analyze([...scoped("url"), outside], "OBSERVED_STATE_IN_STARTUP_FIELD")).toEqual([]);
    });
  });
});

describe("status: inherited from a Telo.Abstract", () => {
  // The abstract lives in a library the CONSUMER never imports — the sanctioned
  // "one import instead of two". Its `extends` alias belongs to the backend's
  // own file, so folding the contract's `status:` has to resolve in that scope.
  const contract = {
    kind: "Telo.Abstract",
    metadata: { name: "Listener", module: "contract" },
    capability: "Telo.Service",
    status: { type: "object", properties: { endpoint: { type: "string" } } },
  } as unknown as ResourceManifest;

  const backend = {
    kind: "Telo.Definition",
    metadata: { name: "Loopback", module: "backend" },
    capability: "Telo.Service",
    // `Contract` is an alias declared by `backend`, not by the consumer.
    extends: "Contract.Listener",
    schema: { type: "object", properties: {} },
    status: { type: "object", properties: { port: { type: "integer" } } },
  } as unknown as ResourceManifest;

  const backendImport = {
    kind: "Telo.Import",
    metadata: { name: "Contract", module: "backend", resolvedModuleName: "contract" },
    source: "./contract",
  } as unknown as ResourceManifest;

  const instance = {
    kind: "Backend.Loopback",
    metadata: { name: "loopback" },
  } as unknown as ResourceManifest;

  const consumerImport = {
    kind: "Telo.Import",
    metadata: { name: "Backend", resolvedModuleName: "backend" },
    source: "./backend",
  } as unknown as ResourceManifest;

  const manifests = [
    { kind: "Telo.Application", metadata: { name: "App" }, targets: [makeTaggedSentinel("ref", "loopback")] },
    consumerImport,
    backendImport,
    contract,
    backend,
    instance,
    CONSUMER_DEF,
  ] as unknown as ResourceManifest[];

  it("types a field the abstract contributes", () => {
    expect(
      analyze(
        [...manifests, consumer("url", "resources.loopback.status.endpoint")],
        "CEL_UNKNOWN_FIELD",
      ),
    ).toEqual([]);
  });

  it("still types the implementation's own fields", () => {
    expect(
      analyze([...manifests, consumer("url", "resources.loopback.status.port")], "CEL_UNKNOWN_FIELD"),
    ).toEqual([]);
  });

  it("rejects a field neither declares", () => {
    const diagnostics = analyze(
      [...manifests, consumer("url", "resources.loopback.status.nope")],
      "CEL_UNKNOWN_FIELD",
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("nope");
  });
});

describe("status: on a cross-module exported instance", () => {
  const library = {
    kind: "Telo.Library",
    metadata: { name: "ObservedLib", module: "ObservedLib" },
    exports: { kinds: ["RedirectListener"], resources: ["exported"] },
  } as unknown as ResourceManifest;

  const libDef = {
    ...LISTENER_DEF,
    metadata: { name: "RedirectListener", module: "ObservedLib" },
  } as unknown as ResourceManifest;

  const exported = {
    kind: "ObservedLib.RedirectListener",
    metadata: { name: "exported", module: "ObservedLib" },
  } as unknown as ResourceManifest;

  const libImport = {
    kind: "Telo.Import",
    // `resolvedModuleName` is what the loader stamps once it has read the target
    // library doc; the alias→module mapping is what makes the exported names
    // reachable under `resources.Lib.…`.
    metadata: { name: "Lib", resolvedModuleName: "ObservedLib" },
    source: "./lib",
  } as unknown as ResourceManifest;

  const manifests = [
    {
      kind: "Telo.Application",
      metadata: { name: "App" },
      targets: [makeTaggedSentinel("ref", "Lib.exported")],
    },
    libImport,
    library,
    libDef,
    exported,
    CONSUMER_DEF,
  ] as unknown as ResourceManifest[];

  it("types a declared field two levels deep", () => {
    expect(
      analyze(
        [...manifests, consumer("url", "resources.Lib.exported.status.redirectUri")],
        "CEL_UNKNOWN_FIELD",
      ),
    ).toEqual([]);
  });

  it("flags a typo, exactly as it would for a local read", () => {
    const diagnostics = analyze(
      [...manifests, consumer("url", "resources.Lib.exported.status.redirectUrl")],
      "CEL_UNKNOWN_FIELD",
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("redirectUrl");
  });

  it("keeps every other key under the alias resolving", () => {
    expect(
      analyze([...manifests, consumer("url", "resources.Lib.variables")], "CEL_UNKNOWN_FIELD"),
    ).toEqual([]);
  });

  it("rejects the read in a startup-resolved field", () => {
    const diagnostics = analyze(
      [...manifests, consumer("baseUrl", "resources.Lib.exported.status.redirectUri")],
      "OBSERVED_STATE_IN_STARTUP_FIELD",
    );
    expect(diagnostics).toHaveLength(1);
  });
});

describe("required: inside status:", () => {
  it("names the rule and the fix instead of AJV's 'must NOT be valid'", () => {
    const def = {
      ...LISTENER_DEF,
      status: { ...LISTENER_DEF.status, required: ["port"] },
    } as unknown as ResourceManifest;

    const diagnostics = analyze([def, app(), listener], "OBSERVED_STATE_REQUIRED_FORBIDDEN");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("mandatory once the resource has run");
    expect(diagnostics[0].message).toContain("nullable type");
  });

  it("accepts a status: block without it", () => {
    expect(analyze([LISTENER_DEF, app(), listener], "OBSERVED_STATE_REQUIRED_FORBIDDEN")).toEqual([]);
  });
});
