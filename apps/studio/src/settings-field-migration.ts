/** Carries renamed fields of the persisted `AppSettings` value over to their
 *  current names. `storage-key-migration.ts` renames whole storage keys; this
 *  renames fields INSIDE the settings value, and is applied on every settings
 *  load so every reader sees only the current spelling. A future settings
 *  field rename is one row in `RENAMED_SETTINGS_FIELDS`.
 */

/** A field rename inside the stored settings object. */
export type SettingsFieldRename = readonly [legacy: string, current: string];

export const RENAMED_SETTINGS_FIELDS: readonly SettingsFieldRename[] = [
  ["templatesBaseUrl", "startersBaseUrl"],
];

/** Returns `stored` with every legacy field moved to its current name. A value
 *  already under the current name was written by a newer build and wins. */
export function migrateSettingsFields<T extends object>(stored: T): T {
  const migrated = { ...stored } as Record<string, unknown>;
  for (const [legacy, current] of RENAMED_SETTINGS_FIELDS) {
    if (!(legacy in migrated)) continue;
    if (!(current in migrated)) migrated[current] = migrated[legacy];
    delete migrated[legacy];
  }
  return migrated as T;
}
