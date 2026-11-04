/** Whether a message holds raw bytes, which a JSON transcript cannot keep
 *  (media is stored by URI). */
export function holdsBytes(value: unknown): boolean {
  if (value instanceof Uint8Array) return true;
  if (Array.isArray(value)) return value.some(holdsBytes);
  if (typeof value === "object" && value !== null) return Object.values(value).some(holdsBytes);
  return false;
}
