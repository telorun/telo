import type { CatalogCache, ResolutionStore, StoredCatalog, StoredResolutions } from "@telorun/language-host";
import { LOCAL_KEYS, LOCAL_PREFIXES } from "../storage-keys";

/** `telo.version`: `"auto"`, or the exact telo version every module of the
 *  workspace is edited against. */
export type TeloVersionSetting = "auto" | (string & {});

function readJson<T>(storage: Storage, key: string): T | undefined {
  const raw = storage.getItem(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(
      `studio's stored value under '${key}' is not JSON (${error instanceof Error ? error.message : String(error)}); remove that key from this site's storage to reset it.`,
    );
  }
}

/** The last engine catalog, shared by every workspace — it describes the
 *  registry, not a workspace. */
export function localCatalogCache(storage: Storage = window.localStorage): CatalogCache {
  return {
    read: async () => readJson<StoredCatalog>(storage, LOCAL_KEYS.engineCatalog),
    write: async (catalog) => storage.setItem(LOCAL_KEYS.engineCatalog, JSON.stringify(catalog)),
  };
}

/** The Auto resolutions of one workspace's modules. */
export function localResolutionStore(rootDir: string, storage: Storage = window.localStorage): ResolutionStore {
  const key = LOCAL_PREFIXES.engineResolutions + rootDir;
  return {
    read: async () => readJson<StoredResolutions>(storage, key),
    write: async (resolutions) => storage.setItem(key, JSON.stringify(resolutions)),
  };
}

export function readTeloVersionSetting(rootDir: string, storage: Storage = window.localStorage): TeloVersionSetting {
  return storage.getItem(LOCAL_PREFIXES.teloVersion + rootDir) ?? "auto";
}

export function writeTeloVersionSetting(
  rootDir: string,
  setting: TeloVersionSetting,
  storage: Storage = window.localStorage,
): void {
  if (setting === "auto") storage.removeItem(LOCAL_PREFIXES.teloVersion + rootDir);
  else storage.setItem(LOCAL_PREFIXES.teloVersion + rootDir, setting);
}

/** The router's pin for a setting: `undefined` is Auto. */
export function pinOf(setting: TeloVersionSetting): string | undefined {
  return setting === "auto" ? undefined : setting;
}
