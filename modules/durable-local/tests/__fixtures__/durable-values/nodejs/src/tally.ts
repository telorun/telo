/** Returns a map keyed by integers — a CEL value with no manifest literal.
 *
 *  A CEL `map` with `int` keys is a `CelMap`: its entries are keyed by each key's
 *  own typed value, which is what lets one container hold CEL's four key types.
 *  So it is BUILT with `celMapFromEntries`, never with a host `Map` — a `Map` with
 *  `bigint` keys was this value under the engine that has been replaced, and is
 *  now an ordinary host object the typed frame refuses by name.
 *
 *  It is the case a journal flattens invisibly: written as plain JSON the keys come
 *  back as text, so `m[2]` stops resolving and `m['2']` starts. Nothing reports
 *  that, which is why the value is produced here rather than assumed. */
import { celMapFromEntries, type CelValue, type ResourceContext, type ResourceManifest } from "@telorun/sdk";

export class TallyController {
  constructor(
    private readonly resource: ResourceManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(): Promise<CelValue> {
    return celMapFromEntries([1n, "one", 2n, "two"]);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: ResourceManifest,
  ctx: ResourceContext,
): Promise<TallyController> {
  return new TallyController(resource, ctx);
}
