import type { FunctionController, ResourceManifest } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import { ruleProblems, scan, type DetectionRule, type Finding } from "./detection-rules.js";

interface DetectorResource extends ResourceManifest {
  rules: DetectionRule[];
}

export const Detector: FunctionController<DetectorResource, { text: string }, Finding[]> = {
  create(resource) {
    const problems = ruleProblems(resource.rules);
    if (problems.length > 0) {
      throw new InvokeError(
        "ERR_SECRET_SCAN_RULES_INVALID",
        `SecretScan.Detector "${resource.metadata.name}": the rule set is refused — ${problems.join("; ")}.`,
        { problems },
      );
    }
    const rules = resource.rules;
    return { call: ({ text }) => scan(text, rules) };
  },
};
