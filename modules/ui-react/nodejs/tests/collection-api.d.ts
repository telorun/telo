declare module "*/collection-api/collection.mjs" {
  export function createCollection(
    rows: Record<string, unknown>[],
    required?: string[],
  ): {
    handle(request: { method: string; path: string; query: URLSearchParams; body?: unknown }): { status: number; body: unknown };
  };
}
