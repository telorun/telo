/**
 * Write `key` on `target` as an own data property, whatever the key is: a plain
 * assignment of a `__proto__` key would replace the prototype instead, and a
 * manifest key may be written `__proto__`.
 */
export function setOwnProperty(target: object, key: string | number, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}
