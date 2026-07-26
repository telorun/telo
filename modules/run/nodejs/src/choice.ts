import { InvokeError, type DataValidator, type ResourceContext } from "@telorun/sdk";

interface ChoiceRow {
  when: unknown;
  value: unknown;
}

interface RunChoiceManifest {
  metadata: { name: string };
  inputs?: Record<string, unknown>;
  choices: ChoiceRow[];
  default?: { value: unknown };
  outputType?: string | Record<string, unknown>;
}

/**
 * First-match decision: walk `choices` in manifest order, evaluate each `when`
 * against the caller's `inputs`, and return the first matching row's `value`.
 * Falls back to `default.value`; with no default and no match the call throws
 * rather than returning a silent null.
 */
class RunChoice {
  constructor(
    private readonly ctx: ResourceContext,
    private readonly resource: RunChoiceManifest,
    private readonly outputValidator: DataValidator,
  ) {}

  async invoke(inputs: Record<string, unknown>): Promise<unknown> {
    const scope = { inputs: inputs ?? {} };

    for (let i = 0; i < this.resource.choices.length; i++) {
      const row = this.resource.choices[i]!;
      if (!this.matches(row.when, i, scope)) continue;
      return this.produce(row.value, scope, `choices[${i}].value`);
    }

    if (this.resource.default) {
      return this.produce(this.resource.default.value, scope, "default.value");
    }

    throw new InvokeError(
      "ERR_NO_MATCH",
      `Run.Choice "${this.resource.metadata.name}": no choice matched and no \`default\` is declared. ` +
        `Add a \`default:\` row, or widen a \`when\` predicate so the input is covered.`,
    );
  }

  /** A `when` must evaluate to a real boolean — a truthy string or number is an
   *  authoring mistake in a decision table, not a match. */
  private matches(when: unknown, index: number, scope: Record<string, unknown>): boolean {
    const verdict = this.ctx.expandValue(when, scope);
    if (typeof verdict !== "boolean") {
      throw new InvokeError(
        "ERR_INVALID_PREDICATE",
        `Run.Choice "${this.resource.metadata.name}": \`choices[${index}].when\` evaluated to ` +
          `${typeof verdict}, expected a boolean.`,
      );
    }
    return verdict;
  }

  /** `origin` is the manifest path of the row that won, so a contract violation
   *  names the branch to fix rather than the resource as a whole — the rows are
   *  what disagree, and only one of them produced this value. */
  private produce(value: unknown, scope: Record<string, unknown>, origin: string): unknown {
    const produced = this.ctx.expandValue(value, scope);
    try {
      this.outputValidator.validate(produced);
    } catch (err) {
      throw new InvokeError(
        "ERR_OUTPUT_INVALID",
        `Run.Choice "${this.resource.metadata.name}": \`${origin}\` does not satisfy the declared ` +
          `\`outputType\`. ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        { cause: err },
      );
    }
    return produced;
  }
}

export function register(): void {}

export async function create(
  resource: RunChoiceManifest,
  ctx: ResourceContext,
): Promise<RunChoice> {
  return new RunChoice(ctx, resource, ctx.createTypeValidator(resource.outputType));
}
