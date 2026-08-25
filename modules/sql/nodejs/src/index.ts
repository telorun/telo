export { SqlConnectionBase } from "./sql-connection-base.js";
export {
  quoteAnsiIdentifier,
  type PlaceholderStyle,
  type SqlConnection,
  type SqlDialect,
} from "./sql-connection.js";
export { isSqlConnection, resolveSqlConnection } from "./sql-connection-ref.js";

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as SqlCommandController from "./sql-command-controller.js";
export * as SqlQueryController from "./sql-query-controller.js";
export * as SqlSelectionController from "./sql-selection-controller.js";
export * as SqlTransactionController from "./sql-transaction-controller.js";

// Declarative schema. The shared half only — the diff, the ledger, the
// tombstones and the ordering. Every backend implements `SchemaDriver` and owns
// its own type vocabulary, DDL rendering, introspection and locking, so nothing
// here is a lowest-common-denominator type layer.
export type {
  DeclaredCheck,
  DeclaredColumn,
  DeclaredEnum,
  DeclaredEnumUse,
  DeclaredForeignKey,
  DeclaredIndex,
  DeclaredSeeds,
  DeclaredTable,
  SchemaObjectId,
  SchemaObjectKind,
} from "./schema/declared-schema.js";
export { describeObject, objectKey } from "./schema/declared-schema.js";
export type {
  ChangeSafety,
  LiveCheck,
  LiveColumn,
  LiveEnum,
  LiveForeignKey,
  LiveIndex,
  LiveTable,
  SchemaDriver,
} from "./schema/schema-driver.js";
export { ledgerTables, SchemaLedger } from "./schema/schema-ledger.js";
export type { LedgerTables, TombstoneRecord, VersionRecord } from "./schema/schema-ledger.js";
export { assessTombstone } from "./schema/reclaim-policy.js";
export type { Eligibility, ReclaimPolicy } from "./schema/reclaim-policy.js";
export { snapshotDeclaration, snapshotDigest } from "./schema/declaration-snapshot.js";
export type { DeclarationSnapshot } from "./schema/declaration-snapshot.js";
export { PLAN_PHASES, planReconciliation } from "./schema/schema-reconciler.js";
export type {
  PlanPhase,
  PlannedStatement,
  PlannedTombstone,
  ReconciliationInput,
  Refusal,
  SchemaPlan,
} from "./schema/schema-reconciler.js";
export { applyRenames, planRenames, renameSources } from "./schema/plan-renames.js";
export { planSeeds, seedRowId, seedRowKey } from "./schema/seed-rows.js";
export { deleteRowStatements, upsertRowStatements } from "./schema/row-statements.js";
export type { RowDialect } from "./schema/row-statements.js";
export type { SeedPlan } from "./schema/seed-rows.js";
export type { RenameInput, RenamePlan } from "./schema/plan-renames.js";
export { migrationStatements, pendingKeys } from "./schema/migration-runner.js";
export type { MigrationEntry, MigrationMap } from "./schema/migration-runner.js";
export { normalizeTable } from "./schema/normalize-table.js";
export { normalizeEnum } from "./schema/normalize-enum.js";
export type { RawEnum } from "./schema/normalize-enum.js";
export { tableReferenceResolver } from "./schema/table-reference.js";
export { enumReferenceResolver } from "./schema/enum-reference.js";
export type { ColumnEnumResolver } from "./schema/enum-reference.js";
export type {
  ColumnTypeResolver,
  RawCheck,
  RawColumn,
  RawForeignKey,
  RawIndex,
  RawTable,
  TableReferenceResolver,
} from "./schema/normalize-table.js";
export { runSchemaPass } from "./schema/schema-run.js";
export type { PendingReclamation, SchemaRunInput, SchemaRunStatus } from "./schema/schema-run.js";
