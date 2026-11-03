import type { InvokeContext } from "@telorun/sdk";
import { durationSetting } from "./duration-setting.js";
import { isJoseKeys } from "./key-set-contract.js";
import { operationController, type Named } from "./operation-controller.js";
import { verifyToken, type VerifyPolicy } from "./token-verification.js";

interface VerifyResource extends Named {
  keys: unknown;
  algorithms: string[];
  issuer?: string | string[];
  audience?: string | string[];
  type?: string;
  clockTolerance?: unknown;
  maxTokenAge?: unknown;
  requiredClaims?: string[];
}

interface VerifyInputs {
  token: string;
  audience?: string | string[];
}

export const { register, create } = operationController<VerifyResource, VerifyInputs, unknown>(
  "Jose.Verify",
  (config, ctx, describe) => {
    const clockToleranceMs = durationSetting(config.clockTolerance, 0, () => `${describe}: 'clockTolerance'`);
    const maxTokenAgeMs = durationSetting(config.maxTokenAge, 0, () => `${describe}: 'maxTokenAge'`);
    const policy: VerifyPolicy = {
      algorithms: config.algorithms,
      issuer: config.issuer,
      audience: config.audience,
      type: config.type,
      clockToleranceSeconds: clockToleranceMs / 1000,
      maxTokenAgeSeconds: maxTokenAgeMs > 0 ? maxTokenAgeMs / 1000 : undefined,
      requiredClaims: config.requiredClaims,
    };
    return async (inputs: VerifyInputs, invokeCtx?: InvokeContext) => {
      const keys = ctx.resolveRef(config.keys, isJoseKeys, () => `${describe}: 'keys'`, "Jose.Keys");
      return verifyToken(
        keys,
        inputs.token,
        { ...policy, audience: inputs.audience ?? policy.audience },
        invokeCtx?.cancellation.signal,
      );
    };
  },
);
