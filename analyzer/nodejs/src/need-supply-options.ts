import { expansionTagOf, isExpansionSentinel } from "@telorun/templating";

/**
 * The readings of an import's `needs:` that between them take every option it
 * writes — each a plain map of supplies, a key an option leaves out absent. A
 * key's options are read independently, so the readings number at most the
 * options of the key writing the most, never their product: what a need table
 * reads of one supply depends on that supply alone.
 *
 * A choice inside a field-by-field supply is left as written, since the supply
 * is a field map in every option. Browser-safe.
 */
export function suppliedNeedReadings(needs: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const whole of optionsOf(needs)) {
    if (whole === ABSENT || !whole || typeof whole !== "object" || Array.isArray(whole)) {
      out.push({});
      continue;
    }
    const keys = Object.entries(whole as Record<string, unknown>).map(([key, value]) => [key, optionsOf(value)] as const);
    const count = Math.max(1, ...keys.map(([, options]) => options.length));
    for (let i = 0; i < count; i++) {
      const reading: Record<string, unknown> = {};
      for (const [key, options] of keys) {
        const option = options[Math.min(i, options.length - 1)];
        if (option !== ABSENT) reading[key] = option;
      }
      out.push(reading);
    }
  }
  return out;
}

/** Whether `needs:` writes a choice at its top or at one of its supplies. */
export function needsWriteChoice(needs: unknown): boolean {
  if (isExpansionSentinel(needs)) return true;
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) return false;
  return Object.values(needs).some(isExpansionSentinel);
}

const ABSENT = Symbol("absent");

/** Every value `value` may take, `ABSENT` where an option writes nothing. */
function optionsOf(value: unknown): unknown[] {
  if (!isExpansionSentinel(value)) return [value];
  const body = value as Record<string, unknown>;
  const branch = (key: string): unknown[] => (Object.hasOwn(body, key) ? optionsOf(body[key]) : [ABSENT]);
  switch (expansionTagOf(value)) {
    case "if":
      return [...branch("then"), ...branch("else")];
    case "switch": {
      const cases = body.cases && typeof body.cases === "object" && !Array.isArray(body.cases) ? Object.values(body.cases) : [];
      return [...cases.flatMap(optionsOf), ...branch("default")];
    }
    default:
      return [value];
  }
}
