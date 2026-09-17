/** Returns a map keyed by integers — a CEL value with no manifest literal.
 *
 *  A `Map` with `bigint` keys is what a CEL `map` with `int` keys IS in this
 *  runtime, and it is the case a journal flattens invisibly: written as plain
 *  JSON the keys come back as text, so `m[2]` stops resolving and `m['2']`
 *  starts. Nothing reports that, which is why the value is produced here rather
 *  than assumed. */
import type { ResourceContext, ResourceManifest } from "@telorun/sdk";

export class TallyController {
  constructor(
    private readonly resource: ResourceManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(): Promise<Map<bigint, string>> {
    return new Map([
      [1n, "one"],
      [2n, "two"],
    ]);
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
