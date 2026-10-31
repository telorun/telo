import type { ApplicationDimension } from "@/api";

/**
 * The configurations `requiredWhen` names, as the sentence `telo run --help`
 * prints after "required when": each value spelled through the environment
 * variables its dimension is read from (`OPENAI_API_KEY is unset`, `none of A,
 * B is set`, `AI_PROVIDER is openai`), conjuncts joined by "and", alternatives
 * by "or", a dimension naming no variable by its key.
 */
export function requirementSentence(
  requiredWhen: readonly Record<string, unknown>[],
  dimensions: readonly ApplicationDimension[],
): string {
  const byKey = new Map(dimensions.map((d) => [d.key, d]));
  const spell = (key: string, value: unknown): string => {
    const dimension = byKey.get(key);
    const env = dimension?.env ?? [];
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const unset = value === "absent" || value === null;
    if (env.length === 0) return `${key} is ${unset ? "absent" : text}`;
    if (value === "present") return env.length === 1 ? `${env[0]} is set` : `${env.join(", ")} are set`;
    if (unset) return env.length === 1 ? `${env[0]} is unset` : `none of ${env.join(", ")} is set`;
    const member = dimension?.member;
    if (member !== undefined) return `the ${member} of ${env.join(", ")} is ${text}`;
    return `${env.join(", ")} is ${text}`;
  };
  return requiredWhen
    .map((assignment) =>
      Object.entries(assignment)
        .map(([key, value]) => spell(key, value))
        .join(" and "),
    )
    .join(" or ");
}
