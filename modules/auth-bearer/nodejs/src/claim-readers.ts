/** A claim holding a list: an array of strings, or one whitespace-separated string. */
export function listClaim(claims: Record<string, unknown>, name: string): string[] | null {
  const value = claims[name];
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value.split(/\s+/).filter((entry) => entry !== "");
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
