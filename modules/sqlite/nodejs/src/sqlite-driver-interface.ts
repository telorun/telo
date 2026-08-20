export interface SqliteStatement {
  readonly reader: boolean;
  all(params: ReadonlyArray<unknown>): unknown[];
  run(params: ReadonlyArray<unknown>): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  iterate(params: ReadonlyArray<unknown>): IterableIterator<unknown>;
}

export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
