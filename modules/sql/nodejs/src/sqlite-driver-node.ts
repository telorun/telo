import Database from "better-sqlite3";
import type { SqliteDb } from "./sqlite-driver-interface.js";

export function openDatabase(file: string): SqliteDb {
  return new Database(file);
}
