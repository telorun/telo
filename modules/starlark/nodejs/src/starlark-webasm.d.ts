declare module "starlark-webasm" {
  export function initialize(): Promise<void>;
  export function exec(code: string, context?: Record<string, any>): Record<string, any>;
}
