import { DiagnosticSeverity } from "@telorun/ide-support";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { diagnosticsAt, diagnosticsUnder, toSegments, worstUnder } from "./field-diagnostics";
import { ResourceSchemaForm } from "./index";

afterEach(cleanup);

/**
 * A diagnostic belongs at the field it is ABOUT. It used to render under
 * whichever top-level field happened to contain it, which for anything nested
 * is a message pointing at a section rather than at the input that is wrong.
 */

function diagnostic(
  path: string,
  message: string,
  severity: DiagnosticSeverity = DiagnosticSeverity.Error,
) {
  return {
    segments: toSegments(path),
    diagnostic: {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity,
      code: "TEST",
      source: "telo",
      message,
    },
  };
}

const schema = {
  type: "object",
  properties: {
    routes: {
      title: "Routes",
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { title: "Path", type: "string" },
          status: { title: "Status", type: "integer" },
        },
      },
    },
    variables: {
      title: "Variables",
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { env: { title: "Env", type: "string" } },
      },
    },
  },
};

const values = {
  routes: [{ path: "/a", status: 200 }],
  variables: { dbUrl: { env: "DB_URL" } },
};

describe("where a nested diagnostic renders", () => {
  it("puts the message beside the input it names", () => {
    render(
      <ResourceSchemaForm
        schema={schema}
        values={values}
        onChange={() => undefined}
        fieldDiagnostics={[diagnostic("routes.0.status", "status must be 100-599")]}
      />,
    );
    // The nearest input to the message is the one it names — `status`, holding
    // 200. Rendered under the top-level field instead, the nearest would be the
    // first input in `routes`, which is `path`.
    let node = screen.getByText("status must be 100-599").parentElement;
    while (node && !node.querySelector("input")) node = node.parentElement;
    expect(node?.querySelector("input")).toHaveValue(200);
  });

  it("marks the ancestor whose section the field is inside", () => {
    const { container } = render(
      <ResourceSchemaForm
        schema={schema}
        values={values}
        onChange={() => undefined}
        fieldDiagnostics={[diagnostic("routes.0.status", "status must be 100-599")]}
      />,
    );
    // The dot is what says "something below here" once the message has moved
    // down to the field it is about.
    const routesLabel = [...container.querySelectorAll("label")].find((l) =>
      l.textContent?.startsWith("Routes"),
    );
    expect(routesLabel?.textContent).toContain("●");
  });

  it("addresses a map entry by its KEY, not the row's render id", () => {
    // The row id exists so renaming a key does not remount the row; the
    // manifest addresses the entry by the key, and matching on the id meant a
    // diagnostic inside a map never found its field.
    render(
      <ResourceSchemaForm
        schema={schema}
        values={values}
        onChange={() => undefined}
        fieldDiagnostics={[diagnostic("variables.dbUrl.env", "DB_URL is not set")]}
      />,
    );
    expect(screen.getByText("DB_URL is not set")).toBeInTheDocument();
  });

  it("shows a message once, not at every ancestor", () => {
    render(
      <ResourceSchemaForm
        schema={schema}
        values={values}
        onChange={() => undefined}
        fieldDiagnostics={[diagnostic("routes.0.status", "only here")]}
      />,
    );
    expect(screen.getAllByText("only here")).toHaveLength(1);
  });

  it("keeps a message visible when the path goes deeper than the form renders", () => {
    // A leaf claims everything below it — a path continuing into a value the
    // form draws as one widget would otherwise vanish.
    render(
      <ResourceSchemaForm
        schema={schema}
        values={values}
        onChange={() => undefined}
        fieldDiagnostics={[diagnostic("routes.0.path.deeper.still", "unreachable path")]}
      />,
    );
    expect(screen.getByText("unreachable path")).toBeInTheDocument();
  });
});

describe("how a field's diagnostic reads", () => {
  function renderWithError() {
    return render(
      <ResourceSchemaForm
        schema={{
          type: "object",
          properties: {
            when: {
              title: "When",
              type: "boolean",
              description: "Attach this mount only when the condition holds.",
            },
          },
        }}
        values={{ when: true }}
        onChange={() => undefined}
        fieldDiagnostics={[
          {
            segments: ["when"],
            diagnostic: {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: DiagnosticSeverity.Error,
              code: "CEL_SYNTAX_ERROR",
              source: "telo-analyzer",
              message: "CEL syntax error at mounts[0].when: Unexpected token: EOF",
            },
          },
        ]}
      />,
    );
  }

  it("shows the severity, the code and the message", () => {
    renderWithError();
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("CEL_SYNTAX_ERROR")).toBeInTheDocument();
    expect(screen.getByText(/Unexpected token: EOF/)).toBeInTheDocument();
    // The popover's other two facts answer "where is this", which the note
    // does not have to: it is already beside the field.
    expect(screen.queryByText("telo-analyzer")).not.toBeInTheDocument();
  });

  it("puts the message ahead of the help text", () => {
    const { container } = renderWithError();
    const text = container.textContent ?? "";
    expect(text.indexOf("CEL_SYNTAX_ERROR")).toBeLessThan(
      text.indexOf("Attach this mount only"),
    );
  });

  it("colours the control the diagnostic is about", () => {
    const { container } = renderWithError();
    const field = container.querySelector("[class*='[&_input]:bg-red-50']");
    expect(field).not.toBeNull();
  });
});

describe("the spelling an analyzer path arrives in", () => {
  it("matches a bracketed array index against the form's own dotted path", () => {
    // What the analyzer actually writes for a CEL diagnostic inside an array.
    // Read as one segment (`mounts[0]`), it matched no scope and no field, so
    // the message was dropped on the way in — visible in the YAML pane, absent
    // from the form.
    expect(toSegments("mounts[0].when")).toEqual(["mounts", "0", "when"]);
    expect(toSegments("/mounts/0")).toEqual(["mounts", "0"]);
    expect(toSegments("variables.dbUrl.env")).toEqual(["variables", "dbUrl", "env"]);
    expect(toSegments("exports.resources/0")).toEqual(["exports", "resources", "0"]);
  });

  it("renders one written in bracket notation at its field", () => {
    render(
      <ResourceSchemaForm
        schema={schema}
        values={values}
        onChange={() => undefined}
        fieldDiagnostics={[diagnostic("routes[0].status", "reads observed state")]}
      />,
    );
    expect(screen.getByText("reads observed state")).toBeInTheDocument();
  });
});

describe("matching a diagnostic to a field", () => {
  const all = [
    diagnostic("routes.0.status", "a"),
    diagnostic("routes.0", "b"),
    diagnostic("variables.dbUrl.env", "c", DiagnosticSeverity.Warning),
  ];

  it("separates what a node says from what it marks", () => {
    expect(diagnosticsAt(all, "routes.0").map((d) => d.diagnostic.message)).toEqual(["b"]);
    expect(diagnosticsUnder(all, "routes.0").map((d) => d.diagnostic.message)).toEqual([
      "a",
      "b",
    ]);
  });

  it("reports the worst severity below a node", () => {
    expect(worstUnder(all, "routes")).toBe(DiagnosticSeverity.Error);
    expect(worstUnder(all, "variables")).toBe(DiagnosticSeverity.Warning);
    expect(worstUnder(all, "absent")).toBeNull();
  });
});
