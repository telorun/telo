/**
 * The typed CEL environments of one analysis, keyed by what each is built
 * from: the reader's typing (a parameter scope, an import's inputs, or the
 * kernel globals), the declaring module's blocks, the context schema in force
 * and the module namespaces with their callables. Two sites — in two keys or
 * one — whose inputs have equal content share one environment, so a build
 * happens once per distinct content.
 *
 * Browser-safe.
 */
import type { CelEnvironment } from "@telorun/cel";
import { reportKeyCost } from "./cel-site-judgements.js";

export class TypedEnvironments {
  private readonly built = new Map<string, CelEnvironment>();
  /** The text of every object already written, by identity: shared nodes (a
   *  registry's schema, a module's globals) are written once. */
  private readonly texts = new WeakMap<object, string>();
  private readonly open = new Set<object>();
  private nextIdentity = 0;
  /** Objects written by identity: a module's shared globals base, one object
   *  per declaring module for the whole analysis. */
  private readonly identities = new WeakMap<object, string>();

  /** Write `value` by its identity from now on — never by its content. */
  identify(value: object): void {
    if (!this.identities.has(value)) this.identities.set(value, `@${this.nextIdentity++}`);
  }

  identifies(value: unknown): boolean {
    return value !== null && typeof value === "object" && this.identities.has(value);
  }

  /** The environment built from `inputs`, building it on first request. */
  environmentFor(inputs: unknown, build: () => CelEnvironment): CelEnvironment {
    const content = this.textOf(inputs);
    const known = this.built.get(content);
    if (known) return known;
    const env = build();
    this.built.set(content, env);
    reportKeyCost({ kind: "typed-environment", content });
    return env;
  }

  /** The content of `value` as text: keys sorted, an object written once. */
  private textOf(value: unknown): string {
    if (value === undefined) return "u";
    if (typeof value === "bigint") return `n${value}`;
    if (value === null || typeof value !== "object") return String(JSON.stringify(value));
    const identity = this.identities.get(value);
    if (identity !== undefined) return identity;
    const known = this.texts.get(value);
    if (known !== undefined) return known;
    // A value holding itself is keyed by its identity: equal content is then
    // not shared, which costs a build and never a wrong environment.
    if (this.open.has(value)) return `#${this.nextIdentity++}`;
    this.open.add(value);
    let text: string;
    if (Array.isArray(value)) {
      text = `[${value.map((item) => this.textOf(item)).join(",")}]`;
    } else if (value instanceof Uint8Array) {
      text = `b${Array.from(value).join(".")}`;
    } else {
      const record = value as Record<string, unknown>;
      text = `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${this.textOf(record[key])}`)
        .join(",")}}`;
    }
    this.open.delete(value);
    this.texts.set(value, text);
    return text;
  }
}
