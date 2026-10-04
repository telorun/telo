import type { CelEnvironment } from "@telorun/cel";
import { VALUE_TYPES, valueBrandBases } from "@telorun/sdk";

/**
 * Register every nominal value brand on an analysis environment, with what a brand may do:
 * convert to its base with the base's own conversion (`int(ports.http)`,
 * `string(variables.dataDir)`), render as text (`string(ports.http)`), and — for a host
 * path — be extended with `.joinPath(relative)` and stay one.
 *
 * **Declared, not implemented.** A nominal type is a checking concept: the engine takes the
 * conversions and members as signatures over `Self` and needs no function body for any of
 * them, because at runtime a branded value IS its base (an int, a string) and the standard
 * library's own overloads are what evaluate. The previous engine required an implementation
 * per registration, so this file carried three stubs a brand's values never reached.
 *
 * `buildCelEnvironment` registers none of it: a caller typing a site registers the brands on
 * its own clone.
 */
export function registerValueBrands(environment: CelEnvironment): void {
  for (const [brand, base] of Object.entries(valueBrandBases())) {
    const conversions = [`${base}(Self): ${base}`];
    // Every base CEL can render as text renders its brand too — the runtime value IS the
    // base — so `string(ports.http)` and a port in an `!interpolate` hole convert as the
    // integer they are.
    if (base !== "string") conversions.push("string(Self): string");
    const fromHost = VALUE_TYPES.get(brand)?.fromHost !== undefined;
    environment.registerType({
      name: brand,
      base,
      conversions,
      ...(fromHost ? { members: ["Self.joinPath(string): Self"] } : {}),
    });
  }
}
