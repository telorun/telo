import { demandingEvery } from "./input-demand.js";
import { describe, expect, it } from "vitest";
import { resolveApplicationEnv } from "../src/application-env.js";
import { normalizeModuleInputs } from "../src/declared-module-inputs.js";
import { SchemaValidator } from "../src/schema-validator.js";

describe("declared module inputs", () => {
  it("binds an integer supplied on the command line as an int64", () => {
    const app = {
      kind: "Telo.Application",
      metadata: { name: "Sweep" },
      variables: {
        boost: { type: "integer", arg: "boost", default: 1 },
        label: { type: "string", arg: "label", default: "none" },
      },
    };
    const { variables } = resolveApplicationEnv(app, {}, new SchemaValidator(), demandingEvery(), undefined, [
      "--boost",
      "3",
    ]);
    expect(normalizeModuleInputs(variables, app.variables)).toEqual({ boost: 3n, label: "none" });
  });
});
