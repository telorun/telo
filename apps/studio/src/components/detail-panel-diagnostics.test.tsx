import { DiagnosticSeverity, type NormalizedDiagnostic } from "@telorun/ide-support";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceDiagnostics } from "../analysis";
import type { ModuleViewData, Selection } from "../model";
import { DetailPanel } from "./DetailPanel";
import { DiagnosticsProvider } from "./diagnostics/DiagnosticsContext";

/**
 * A diagnostic inside an array reached the YAML pane and never the form: the
 * analyzer writes its path with a BRACKETED index (`mounts[0].when`), which the
 * form's segment split read as one opaque segment, so it matched neither the
 * panel's scope nor any field.
 */

const serverSchema = {
  type: "object",
  properties: {
    mounts: {
      title: "Mounts",
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { title: "Path", type: "string" },
          when: { title: "When", type: "boolean" },
        },
      },
    },
  },
};

const viewData = {
  manifest: {
    kind: "Application",
    metadata: { name: "app" },
    resources: [
      {
        kind: "Http.Server",
        name: "server",
        fields: { mounts: [{ path: "/api/todos", when: true }] },
        sourceFile: "/t.yaml",
      },
    ],
    targets: [],
    imports: [],
  },
  kinds: new Map([
    ["Http.Server", { fullKind: "Http.Server", schema: serverSchema, capability: "Telo.Service" }],
  ]),
  importedConfig: new Map(),
  sourceFiles: [],
} as unknown as ModuleViewData;

const server = { kind: "Http.Server", name: "server" };

const diagnostic: NormalizedDiagnostic = {
  range: { start: { line: 15, character: 8 }, end: { line: 15, character: 50 } },
  severity: DiagnosticSeverity.Error,
  code: "OBSERVED_STATE_IN_STARTUP_FIELD",
  source: "telo",
  message: "'mounts[0].when' is resolved once at startup",
  data: { resource: server, path: "mounts[0].when", filePath: "/t.yaml" },
};

function workspaceDiagnostics(): WorkspaceDiagnostics {
  return {
    byResource: new Map([["/t.yaml", new Map([["server", [diagnostic]]])]]),
    byFile: new Map(),
    registryByFile: new Map(),
    graphByFile: new Map(),
    analysisByFile: new Map(),
  } as unknown as WorkspaceDiagnostics;
}

const selection: Selection = {
  resource: server,
  pointer: "/mounts/0",
  schema: serverSchema.properties.mounts.items,
};

afterEach(cleanup);

describe("a diagnostic inside an array, in the form view", () => {
  it("reaches the field it names", () => {
    render(
      <DiagnosticsProvider
        navigate={() => undefined}
        diagnostics={workspaceDiagnostics()}
        activeFilePaths={["/t.yaml"]}
      >
        <DetailPanel
          selectedResource={server}
          canvasResource={null}
          selection={selection}
          viewData={viewData}
          registry={null}
          readOnly={false}
          onSourceEdit={() => undefined}
          onExtractInline={() => undefined}
      onInlineReference={() => undefined}
          onUpdateResource={() => undefined}
          onSelectResource={() => undefined}
          onSelect={() => undefined}
          onCreateAndLink={() => undefined}
        />
      </DiagnosticsProvider>,
    );
    expect(screen.getByText(diagnostic.message)).toBeInTheDocument();
  });
});
