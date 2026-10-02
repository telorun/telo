import type { Environment } from "@marcbachmann/cel-js";
import { VALUE_TYPES, valueBrandBases } from "@telorun/sdk";

/**
 * Register every nominal value brand on an analysis environment, with what a
 * brand may do: convert to its base with the base's own conversion
 * (`int(ports.http)`, `string(variables.dataDir)`), render as text
 * (`string(ports.http)`), and — for a host path — be
 * extended with `.joinPath(relative)` and stay one.
 *
 * Static only: at runtime a branded value IS its base (an int, a string), so the
 * catalog's own overloads — `string.joinPath` among them — are what evaluate. The
 * implementations below exist because registration requires one; a brand's
 * values never reach them. `buildCelEnvironment` registers none of this: a
 * caller typing a site registers the brands on its own clone.
 */
export function registerValueBrands(env: Environment): void {
  for (const [brand, base] of Object.entries(valueBrandBases())) {
    (env as any).registerType(brand, { fields: {} });
    (env as any).registerFunction(`${base}(${brand}): ${base}`, (value: unknown) => value);
    // Every base CEL can render as text renders its brand too — the runtime
    // value IS the base — so `string(ports.http)` and a port in an
    // `!interpolate` hole convert as the integer they are.
    if (base !== "string") {
      (env as any).registerFunction(`string(${brand}): string`, (value: unknown) => String(value));
    }
    if (VALUE_TYPES.get(brand)?.fromHost !== undefined) {
      (env as any).registerFunction(`${brand}.joinPath(string): ${brand}`, () => {
        throw new Error("joinPath() is evaluated by the runtime, not the analyzer.");
      });
    }
  }
}
