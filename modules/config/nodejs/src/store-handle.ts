export interface ConfigStoreHandle {
  get(key: string): string | undefined;
  getAll(): Record<string, string | undefined>;
}
