import { Environment } from "@marcbachmann/cel-js";

export const celEnvironment = new Environment({ unlistedVariablesAreDyn: true })
  .registerFunction("join(list, string): string", (list: unknown[], sep: string) =>
    list.map(String).join(sep),
  )
  .registerFunction("keys(map): list", (map: unknown) => {
    if (map instanceof Map) return [...map.keys()];
    return Object.keys(map as Record<string, unknown>);
  })
  .registerFunction("values(map): list", (map: unknown) => {
    if (map instanceof Map) return [...map.values()];
    return Object.values(map as Record<string, unknown>);
  });
