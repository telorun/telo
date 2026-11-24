declare module "*/collection-api/collection.mjs" {
  export function createCollection(
    rows: Record<string, unknown>[],
    required?: string[],
    options?: { etags?: boolean },
  ): {
    handle(request: { method: string; path: string; query: URLSearchParams; body?: unknown; ifMatch?: string }): {
      status: number;
      body: unknown;
      headers?: Record<string, string>;
    };
  };
}
