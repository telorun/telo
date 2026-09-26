import { SEMANTIC_TOKEN_LEGEND } from "@telorun/ide-support";
import { expect, it } from "vitest";
import { TELO_ENGINE_VERSION } from "../src/engine-version.js";
import { HarnessHost } from "./harness.js";

// A host picks and routes engines by what `initialize` answers, so the engine
// names itself as telo with its identity and states the protocol generation.
it("answers initialize with its identity and protocol generation", async () => {
  const result = await new HarnessHost().start();
  expect(result.serverInfo).toEqual({ name: "telo", version: TELO_ENGINE_VERSION });
  expect(result.capabilities.experimental).toEqual({ telo: { protocol: 1 } });
  expect(result.capabilities.semanticTokensProvider.legend.tokenTypes).toEqual([
    ...SEMANTIC_TOKEN_LEGEND,
  ]);
});
