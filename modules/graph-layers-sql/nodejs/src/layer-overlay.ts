import { selectList, type CompiledColumn, type CompiledTable } from "./compiled-types.js";
import { DRAFT, PUBLISHED, RETRACTED, STATED } from "./declared-table.js";
import { SqlFragments } from "@telorun/sql";

/**
 * Overlay by precedence, in the one SQL both engines speak.
 *
 * A stack is an ordered list of layer names, highest precedence first. For one
 * identity — a node key, or a relationship's source and target — the statement
 * of the first layer in the stack that states it WINS; a winner whose effect is
 * `removed` makes the identity absent. Every form below decides the winner by
 * probing the layers above a row through the table's unique
 * `(layer, identity…)` index and never by resolving the whole stack first.
 *
 * Every such probe has ONE shape: a scalar subquery, `(SELECT … LIMIT 1) IS
 * NULL`. Never `NOT EXISTS`, and never a join: a planner is free to answer an
 * anti-join by hashing the whole range it probes, and on a table of a few
 * thousand rows it does — a page then costs the table, not its `limit`.
 *
 * A table that keeps a draft row beside the published one is indexed
 * `(layer, state, identity…)`, so a layer is two contiguous ranges. Every
 * statement over one therefore names the state it reads: a probe is an
 * equality on all three, and a range never crosses from one state's rows into
 * the other's.
 *
 * A table that keeps every VERSION of a statement has no state column: which
 * rows are a layer's published statement depends on the revision the layer is
 * read at, and a draft's rows are those of its changeset. Such a table is never
 * named bare in a statement here. It is read through {@link rowsOf} — the
 * table once per layer of the view and once more for the draft, each scan
 * tagging its rows with its state and its PLACE in the stack — and every alias
 * over it is narrowed by {@link inView} to the rows the view can see.
 * Everything below then holds for it as for a table with the column, with the
 * place tag standing where a rank computed from the layer would.
 *
 * The scans carry no predicate of their own, and that is deliberate: a planner
 * joins through a `UNION ALL` only when its arms are bare scans, so the
 * narrowing is written beside the alias, where each arm's two tags fold it to
 * exactly one alternative — that arm's own index condition: the changeset's
 * range, or one layer's published range as of the revision it is read at.
 *
 * On such a table, the conditions of one row that each probe an index are
 * written as ONE expression, {@link inOrder}. Written as separate conditions, a
 * planner prices each probe as all but excluding the row and so expects a
 * page's `LIMIT` never to be reached — it then reads a layer's whole remaining
 * range and sorts it — and it evaluates the probes in an order it picks from
 * statistics, so what a statement reads changes with the table's size. As one
 * expression they are evaluated in the order written, and priced as a
 * condition of unknown outcome.
 *
 * Layer names are bound values, never statement text; a place is a position in
 * the view the statement is built for, written as a literal.
 */
export type LayerStack = readonly string[];

/**
 * A store's stack: its own layer, then each base in order followed by that
 * base's stack. A layer reached more than once — two bases built on the same
 * layer — has one place, the lowest of them, so every layer outranks the
 * layers it is built on.
 */
export function stackOver(layer: string, bases: readonly LayerStack[]): LayerStack {
  const reached = [layer, ...bases.flat()];
  return reached.filter((name, index) => reached.lastIndexOf(name) === index);
}

/** How a statement refers to one row's layer bookkeeping and identity: a table
 *  alias's own columns, or the aliases a derived table gave them. */
export interface RowRef {
  readonly layer: string;
  readonly effect: string;
  readonly identity: readonly string[];
  /** Whether the row is a draft's or published — only on a table that keeps both. */
  readonly state?: string;
  /** The row's version columns — only on a table that keeps every version. */
  readonly versions?: { readonly changeset: string; readonly from: string; readonly to: string };
  /** The row's place in the stack — only on a table that keeps every version. */
  readonly place?: string;
}

export function rowRef(table: CompiledTable, alias: string): RowRef {
  return {
    layer: `${alias}.${table.layer.sql}`,
    effect: `${alias}.${table.effect.sql}`,
    identity: table.identity.map((c) => `${alias}.${c.sql}`),
    ...(table.state ? { state: `${alias}.${table.state.sql}` } : {}),
    ...(table.versions
      ? {
          versions: {
            changeset: `${alias}.${table.versions.changeset.sql}`,
            from: `${alias}.${table.versions.from.sql}`,
            to: `${alias}.${table.versions.to.sql}`,
          },
        }
      : {}),
    ...(table.versions && table.place ? { place: `${alias}.${table.place.sql}` } : {}),
  };
}

/**
 * What a read sees of a stack. On a table that keeps a draft row beside the
 * published one, every layer is read by its published rows — and, when `draft`
 * is set, the TOP layer by its open draft's rows over them: the draft's row
 * for an identity replaces the layer's published one, and a `retracted` draft
 * row makes the layer say nothing, so whatever lies beneath shows. A table
 * with no state column has one row per layer and identity, and `draft` means
 * nothing there.
 */
export interface StackView {
  readonly layers: LayerStack;
  readonly draft?: boolean;
  /** For a table that keeps every version: the revision each layer is read
   *  at, in the order of `layers`. */
  readonly asOf?: readonly bigint[];
  /** For a table that keeps every version, with `draft`: the open changeset
   *  whose rows lie over the top layer. */
  readonly changeset?: string;
}

/** The layers beneath the top one, read as the view reads them. */
export function viewBeneath(view: StackView): StackView {
  return {
    layers: view.layers.slice(1),
    ...(view.asOf ? { asOf: view.asOf.slice(1) } : {}),
  };
}

type RowState = typeof DRAFT | typeof PUBLISHED;

function versionedView(table: CompiledTable, view: StackView): readonly bigint[] {
  const { asOf } = view;
  if (!asOf || asOf.length !== view.layers.length) {
    throw new Error(
      `Table '${table.name}' keeps every version of a statement, so a read of it names the ` +
        `revision each layer is read at.`,
    );
  }
  if (view.draft && view.changeset === undefined) {
    throw new Error(`Table '${table.name}' is read through a draft that names no changeset.`);
  }
  return asOf;
}

/** The states a view reads of a table that keeps every version, narrowed to
 *  one when the caller knows which rows it wants. */
function viewStates(view: StackView, state?: RowState): RowState[] {
  const states: RowState[] = [];
  if (view.draft && state !== PUBLISHED) states.push(DRAFT);
  if (state !== DRAFT) states.push(PUBLISHED);
  return states;
}

/** One scan of the rows a view reads from a table. */
export interface ViewArm {
  /** What a statement writes for the row's state: the table's own column, or a
   *  literal where the table keeps every version and is scanned once per
   *  state and layer. Absent on a table with one row per layer and identity. */
  readonly state?: string;
  /** The literal place of the scan's layer in the view — only where the table
   *  keeps every version. The draft's scan shares the top layer's. */
  readonly place?: string;
}

interface VersionedArm {
  readonly state: RowState;
  readonly place: number;
}

/** The (state, layer) pairs a view reads of a table that keeps every version,
 *  narrowed to one state or one layer when the caller knows which it wants. */
function versionedArms(view: StackView, state?: RowState, layer?: number): VersionedArm[] {
  const arms: VersionedArm[] = [];
  for (const each of viewStates(view, state)) {
    if (each === DRAFT) {
      if (layer === undefined || layer === 0) arms.push({ state: DRAFT, place: 0 });
      continue;
    }
    view.layers.forEach((name, index) => {
      if (layer === undefined || layer === index) arms.push({ state: PUBLISHED, place: index });
    });
  }
  return arms;
}

/**
 * The scans a view reads `table` through: the table itself where its rows
 * carry their own state, and — where it keeps every version — one scan per
 * layer of the view plus one for the draft, each tagging its rows. No scan
 * carries a predicate; see {@link inView}.
 */
export function viewArms(
  table: CompiledTable,
  view: StackView,
  state?: RowState,
  layer?: number,
): ViewArm[] {
  if (!table.versions) return [table.state ? { state: table.state.sql } : {}];
  versionedView(table, view);
  return versionedArms(view, state, layer).map((arm) => ({
    state: `'${arm.state}'`,
    place: String(arm.place),
  }));
}

/**
 * What a statement reads `table`'s rows from, to be followed by an alias: the
 * table itself, or — where it keeps every version — a derived table of one
 * bare scan per layer and one for the draft, each row carrying the table's own
 * columns, its layer, its effect, its version columns and the state and place
 * that scan stands for. An alias over it is narrowed with {@link inView}, given
 * the same `state` and `layer`.
 */
export function rowsOf(
  table: CompiledTable,
  view: StackView,
  state?: RowState,
  layer?: number,
): SqlFragments {
  const sql = new SqlFragments();
  const versions = table.versions;
  if (!versions) return sql.text(table.table);
  const columns = [
    ...table.columns,
    table.layer,
    table.effect,
    versions.row,
    versions.changeset,
    versions.from,
    versions.to,
  ]
    .map((c) => c.sql)
    .join(", ");
  const scans = viewArms(table, view, state, layer).map(
    (arm) =>
      `SELECT ${columns}, ${arm.state} AS ${table.state!.sql}, ${arm.place} AS ${table.place!.sql} ` +
      `FROM ${table.table}`,
  );
  if (scans.length === 0) {
    throw new Error(`Table '${table.name}' is read through a view that selects no row of it.`);
  }
  return sql.text(`(${scans.join(" UNION ALL ")})`);
}

/**
 * `row` — a row read through {@link rowsOf} — is one the view can see: a row
 * of the open changeset under the draft tag, or, under a layer's published
 * tag, that layer's statement current at the revision the layer is read at.
 * Undefined for a table whose rows carry their own state, where every row is.
 *
 * Each alternative leads with the state and place tags it belongs to, so under
 * every other scan it folds away and what is left is one index condition: the
 * changeset's range, or one layer's published range.
 */
export function inView(
  table: CompiledTable,
  row: RowRef,
  view: StackView,
  state?: RowState,
  layer?: number,
): SqlFragments | undefined {
  if (!table.versions || !row.versions || !row.state || !row.place) return undefined;
  const asOf = versionedView(table, view);
  const { changeset, from, to } = row.versions;
  const alternatives = versionedArms(view, state, layer).map((arm) =>
    arm.state === DRAFT
      ? new SqlFragments()
          .text(`${row.state} = '${DRAFT}' AND ${row.place} = 0 AND ${changeset} = `)
          .value(view.changeset)
      : new SqlFragments()
          .text(`${row.state} = '${PUBLISHED}' AND ${row.place} = ${arm.place} AND ${row.layer} = `)
          .value(view.layers[arm.place])
          .text(` AND ${from} IS NOT NULL AND ${from} <= `)
          .value(asOf[arm.place])
          .text(` AND (${to} IS NULL OR ${to} > `)
          .value(asOf[arm.place])
          .text(")"),
  );
  if (alternatives.length === 0) return new SqlFragments().text("1 = 0");
  if (alternatives.length === 1) return alternatives[0];
  const sql = new SqlFragments().text("(");
  alternatives.forEach((each, index) => {
    sql.text(index === 0 ? "(" : " OR (").append(each).text(")");
  });
  return sql.text(")");
}

/** ` AND <inView>` for an alias over {@link rowsOf}; nothing where the table's
 *  rows carry their own state. */
function andInView(
  sql: SqlFragments,
  table: CompiledTable,
  alias: string,
  view: StackView,
  state?: RowState,
  layer?: number,
): SqlFragments {
  const within = inView(table, rowRef(table, alias), view, state, layer);
  return within ? sql.text(" AND ").append(within) : sql;
}

/**
 * `row` is what its layer says for its identity in `view`, and it says
 * something. Absent for a table with one row per layer and identity, where
 * every row is.
 */
function speaksIn(
  table: CompiledTable,
  row: RowRef,
  view: StackView,
  probeAlias: string,
): SqlFragments | undefined {
  if (!table.state || !row.state) return undefined;
  if (!view.draft) return new SqlFragments().text(`${row.state} = '${PUBLISHED}'`);
  const top = view.layers[0];
  const probe = rowRef(table, probeAlias);
  if (row.place) {
    // A table that keeps every version: the top layer is the place its scans
    // were tagged with, so under every other scan the draft probe folds away.
    const sql = new SqlFragments()
      .text(`((${row.state} = '${PUBLISHED}' AND (${row.place} <> 0 OR (SELECT 1 FROM `)
      .append(rowsOf(table, view, DRAFT, 0))
      .text(` ${probeAlias} WHERE `);
    probe.identity.forEach((column, index) => {
      sql.text(`${index === 0 ? "" : " AND "}${column} = ${row.identity[index]}`);
    });
    return andInView(sql, table, probeAlias, view, DRAFT, 0).text(
      ` LIMIT 1) IS NULL)) OR (${row.state} = '${DRAFT}' AND ${row.effect} <> '${RETRACTED}'))`,
    );
  }
  // Both states are named outright, so the index is entered once per state
  // rather than ranged over; which of the two rows speaks is decided after.
  const sql = new SqlFragments()
    .text(`${row.state} IN ('${DRAFT}', '${PUBLISHED}') AND `)
    .text(`((${row.state} = '${PUBLISHED}' AND (${row.layer} <> `)
    .value(top)
    .text(" OR (SELECT 1 FROM ")
    .append(rowsOf(table, view, DRAFT))
    .text(` ${probeAlias} WHERE ${probe.layer} = `)
    .value(top)
    .text(` AND ${probe.state} = '${DRAFT}'`);
  probe.identity.forEach((column, index) => sql.text(` AND ${column} = ${row.identity[index]}`));
  return sql
    .text(` LIMIT 1) IS NULL)) OR (${row.state} = '${DRAFT}' AND ${row.layer} = `)
    .value(top)
    .text(` AND ${row.effect} <> '${RETRACTED}'))`);
}

/**
 * Several conditions as one expression, each evaluated only when every one
 * before it held: `CASE WHEN a THEN CASE WHEN b THEN TRUE ELSE FALSE END ELSE
 * FALSE END`. A condition that is unknown counts as not holding.
 */
export function inOrder(conditions: readonly SqlFragments[]): SqlFragments {
  const sql = new SqlFragments();
  for (const condition of conditions) sql.text("CASE WHEN ").append(condition).text(" THEN ");
  sql.text("TRUE");
  for (let index = 0; index < conditions.length; index++) sql.text(" ELSE FALSE END");
  return sql;
}

/** `<layer> = ?`, or `<layer> IN (?, …)` for several. */
export function inLayers(layer: string, layers: LayerStack): SqlFragments {
  return layers.length === 1
    ? new SqlFragments().text(`${layer} = `).value(layers[0])
    : new SqlFragments().text(`${layer} IN (`).valueList(layers, ", ").text(")");
}

/** A layer's place in the stack: 0 for the highest. */
function rank(layer: string, layers: LayerStack): SqlFragments {
  const sql = new SqlFragments().text(`CASE ${layer}`);
  layers.forEach((name, index) => sql.text(" WHEN ").value(name).text(` THEN ${index}`));
  return sql.text(" END");
}

/**
 * `row` is the winning statement for its identity among `layers`: it is in the
 * stack, and no layer above its own states the same identity.
 */
export function winsAmong(
  table: CompiledTable,
  row: RowRef,
  view: StackView,
  shadowAlias: string,
): SqlFragments {
  const { layers } = view;
  const speaks = speaksIn(table, row, view, `${shadowAlias}d`);
  const shadow = rowRef(table, shadowAlias);
  if (row.place) return inOrder(winProbes(table, row, view, shadowAlias));
  const sql = inLayers(row.layer, layers);
  if (speaks) sql.text(" AND ").append(speaks);
  if (layers.length === 1) return sql;
  sql.text(" AND (SELECT 1 FROM ").append(rowsOf(table, view)).text(` ${shadowAlias} WHERE `);
  shadow.identity.forEach((column, index) => {
    sql.text(`${index === 0 ? "" : " AND "}${column} = ${row.identity[index]}`);
  });
  sql.text(" AND ").append(inLayers(shadow.layer, layers));
  const shadowSpeaks = speaksIn(table, shadow, view, `${shadowAlias}e`);
  if (shadowSpeaks) sql.text(" AND ").append(shadowSpeaks);
  return sql
    .text(" AND ")
    .append(rank(shadow.layer, layers))
    .text(" < ")
    .append(rank(row.layer, layers))
    .text(" LIMIT 1) IS NULL");
}

/**
 * For a table that keeps every version, what {@link winsAmong} asks of a row
 * already narrowed to the view, as the conditions it is made of, in order: the
 * row is what its layer says, and no layer above states the same identity. A
 * row's place is the tag of the scan it was read through.
 */
function winProbes(
  table: CompiledTable,
  row: RowRef,
  view: StackView,
  shadowAlias: string,
): SqlFragments[] {
  const probes: SqlFragments[] = [];
  const speaks = speaksIn(table, row, view, `${shadowAlias}d`);
  if (speaks) probes.push(speaks);
  if (view.layers.length === 1) return probes;
  const shadow = rowRef(table, shadowAlias);
  const sql = new SqlFragments()
    .text("(SELECT 1 FROM ")
    .append(rowsOf(table, view))
    .text(` ${shadowAlias} WHERE `);
  shadow.identity.forEach((column, index) => {
    sql.text(`${index === 0 ? "" : " AND "}${column} = ${row.identity[index]}`);
  });
  andInView(sql, table, shadowAlias, view);
  probes.push(
    sql
      .text(" AND ")
      .append(speaksIn(table, shadow, view, `${shadowAlias}e`)!)
      .text(` AND ${shadow.place} < ${row.place} LIMIT 1) IS NULL`),
  );
  return probes;
}

/**
 * `row` is one the view reads, the visible winner for its identity, and every
 * condition of `also` holds for it — conditions that each probe an index, such
 * as an endpoint resolving. On a table that keeps every version the probes are
 * one expression, evaluated in order; see {@link inOrder}.
 */
export function seenInView(
  table: CompiledTable,
  row: RowRef,
  view: StackView,
  shadowAlias: string,
  also: readonly SqlFragments[] = [],
): SqlFragments {
  const within = inView(table, row, view);
  if (within && row.place) {
    return within
      .text(` AND ${row.effect} = '${STATED}' AND `)
      .append(inOrder([...winProbes(table, row, view, shadowAlias), ...also]));
  }
  const sql = visibleAmong(table, row, view, shadowAlias);
  for (const condition of also) sql.text(" AND ").append(condition);
  return sql;
}

/** `row` wins among `layers` and states a value: it is in the resolved view. */
export function visibleAmong(
  table: CompiledTable,
  row: RowRef,
  view: StackView,
  shadowAlias: string,
): SqlFragments {
  return winsAmong(table, row, view, shadowAlias).text(` AND ${row.effect} = '${STATED}'`);
}

/**
 * `key` — an expression holding a node key — names a node the stack resolves:
 * the first statement for it among `layers` is `stated`. One probe of the node
 * table's unique `(layer, key)` index per layer, whatever else the table holds.
 * This is what keeps a relationship in a view only while both its endpoints are.
 */
export function resolvesAmong(
  node: CompiledTable,
  key: string,
  view: StackView,
  alias: string,
): SqlFragments {
  return winningEffect(node, key, view, alias).text(` = '${STATED}'`);
}

/** The negation of {@link resolvesAmong}, true also when no layer states the
 *  key — which a bare `NOT` over it would leave unknown. */
export function unresolvedAmong(
  node: CompiledTable,
  key: string,
  view: StackView,
  alias: string,
): SqlFragments {
  return new SqlFragments()
    .text("COALESCE(")
    .append(winningEffect(node, key, view, alias))
    .text(`, '${RETRACTED}') <> '${STATED}'`);
}

/**
 * The effect of the winning statement for a node key, as a scalar expression.
 *
 * With a draft on the top layer, what that layer says is its draft row's
 * effect when it has one, else its published row's — the draft probe, then the
 * published one — and a `retracted` draft row says nothing, so the answer is
 * then the winner among the layers beneath.
 */
function winningEffect(
  node: CompiledTable,
  key: string,
  view: StackView,
  alias: string,
): SqlFragments {
  const row = rowRef(node, alias);
  /** One layer's published statement for the key, on a table that keeps every
   *  version: one probe of that layer's published range. */
  const layerSays = (published: StackView, index: number): SqlFragments => {
    const sql = new SqlFragments()
      .text(`(SELECT ${row.effect} FROM `)
      .append(rowsOf(node, published, PUBLISHED, index))
      .text(` ${alias} WHERE ${row.identity[0]} = ${key}`);
    return andInView(sql, node, alias, published, PUBLISHED, index).text(")");
  };
  const among = (published: StackView): SqlFragments => {
    const { layers } = published;
    if (node.versions) {
      // The first layer, in stack order, that states the key: each probed only
      // when every layer above it stated nothing.
      if (layers.length === 1) return layerSays(published, 0);
      const chain = new SqlFragments().text("COALESCE(");
      layers.forEach((name, index) => {
        chain.text(index === 0 ? "" : ", ").append(layerSays(published, index));
      });
      return chain.text(")");
    }
    const sql = new SqlFragments()
      .text(`(SELECT ${row.effect} FROM `)
      .append(rowsOf(node, published, PUBLISHED))
      .text(` ${alias} WHERE ${row.identity[0]} = ${key} AND `)
      .append(inLayers(row.layer, layers));
    if (row.state) sql.text(` AND ${row.state} = '${PUBLISHED}'`);
    andInView(sql, node, alias, published, PUBLISHED);
    if (layers.length > 1) sql.text(" ORDER BY ").append(rank(row.layer, layers));
    return sql.text(" LIMIT 1)");
  };
  if (!row.state || !view.draft) return among(view);

  const [top, ...beneath] = view.layers;
  const says = (state: RowState, probeAlias: string): SqlFragments => {
    const probe = rowRef(node, probeAlias);
    const sql = new SqlFragments()
      .text(`(SELECT ${probe.effect} FROM `)
      .append(rowsOf(node, view, state, 0))
      .text(` ${probeAlias} WHERE ${probe.layer} = `)
      .value(top)
      .text(` AND ${probe.state} = '${state}' AND ${probe.identity[0]} = ${key}`);
    return andInView(sql, node, probeAlias, view, state, 0).text(")");
  };
  const topSays = new SqlFragments()
    .text("NULLIF(COALESCE(")
    .append(says(DRAFT, `${alias}d`))
    .text(", ")
    .append(says(PUBLISHED, `${alias}p`))
    .text(`), '${RETRACTED}')`);
  if (beneath.length === 0) return topSays;
  return new SqlFragments()
    .text("COALESCE(")
    .append(topSays)
    .text(", ")
    .append(among(viewBeneath(view)))
    .text(")");
}

/** `a = ? AND b = ?` over the table's identity columns. */
export function matchIdentity(
  table: CompiledTable,
  qualifier: string,
  identity: readonly unknown[],
): SqlFragments {
  const sql = new SqlFragments();
  table.identity.forEach((column, index) => {
    sql.text(`${index === 0 ? "" : " AND "}${qualifier}${column.sql} = `).value(identity[index]);
  });
  return sql;
}

/**
 * The winning statement for one identity, whatever its effect: at most one row,
 * carrying its layer and effect. One index probe per layer of the stack.
 */
export function selectWinner(
  table: CompiledTable,
  identity: readonly unknown[],
  view: StackView,
): SqlFragments {
  const { layers } = view;
  const row = rowRef(table, "w");
  // A table that keeps every version also answers the winning row's own id.
  const id = table.versions ? `, w.${table.versions.row.sql}` : "";
  const sql = new SqlFragments()
    .text(`SELECT ${selectList(table, "w")}, ${row.effect}${id} FROM `)
    .append(rowsOf(table, view))
    .text(" w WHERE ")
    .append(matchIdentity(table, "w.", identity));
  if (!row.place) sql.text(" AND ").append(inLayers(row.layer, layers));
  andInView(sql, table, "w", view);
  const speaks = speaksIn(table, row, view, "wd");
  if (speaks) sql.text(" AND ").append(speaks);
  if (layers.length > 1) {
    if (row.place) sql.text(` ORDER BY ${row.place}`);
    else sql.text(" ORDER BY ").append(rank(row.layer, layers));
  }
  return sql.text(" LIMIT 1");
}

/** What narrows a page: `seek` is the endpoint filter and the position past the
 *  cursor — statements about identity, so they hold for a shadowing row as for
 *  the row it shadows; `filter` is what judges the winner alone — the property
 *  filter, and for a relationship whether both its endpoints resolve. Each is
 *  asked per alias it must qualify with. */
export interface PageConditions {
  readonly seek: (qualifier: string) => SqlFragments[];
  readonly filter: (qualifier: string) => SqlFragments[];
  /** Further conditions on the winner that each probe an index — an endpoint
   *  resolving — kept apart so that, on a table that keeps every version, they
   *  are evaluated after the shadow probes and in the order given. */
  readonly probes?: (qualifier: string) => SqlFragments[];
}

/**
 * One page of the resolved view in `order`, at most `limit` rows.
 *
 * Each layer contributes its own first `limit` visible winners — an ordered
 * read of that layer's index, each row probing the layers above it — and the
 * page is cut from their union. So a page costs in proportion to `limit` times
 * the stack's depth (times the depth again for a relationship, whose endpoints
 * are each resolved in the stack), never to the table's size or to how far the
 * cursor has come: the seek is repeated inside every probe, so a probe never
 * reads a layer from its start.
 *
 * With a draft on the top layer that layer contributes TWO branches, one per
 * range of its index: its draft rows, and its published rows minus the
 * identities the draft holds. Neither reads the other's range, so a page costs
 * the same whatever the size of the draft or of the layer.
 */
export function selectPage(
  table: CompiledTable,
  view: StackView,
  conditions: PageConditions,
  order: readonly CompiledColumn[],
  limit: number,
): SqlFragments {
  const { layers } = view;
  const state = table.state?.sql;
  const drafted = state !== undefined && view.draft === true;
  const orderBy = (qualifier: string) => order.map((c) => `${qualifier}${c.sql}`).join(", ");
  const sameIdentity = (sql: SqlFragments, alias: string) => {
    for (const column of table.identity) sql.text(` AND ${alias}.${column.sql} = n.${column.sql}`);
    for (const condition of conditions.seek(`${alias}.`)) sql.text(" AND ").append(condition);
  };
  /** One row of the top layer for `n`'s identity, as a scalar subquery. */
  const topRow = (select: string, alias: string, rowState: RowState): SqlFragments => {
    const sql = new SqlFragments()
      .text(`(SELECT ${select} FROM `)
      .append(rowsOf(table, view, rowState, 0))
      .text(` ${alias} WHERE ${alias}.${table.layer.sql} = `)
      .value(layers[0])
      .text(` AND ${alias}.${state} = '${rowState}'`);
    andInView(sql, table, alias, view, rowState, 0);
    sameIdentity(sql, alias);
    return sql.text(" LIMIT 1)");
  };
  const published: RowState | undefined = state === undefined ? undefined : PUBLISHED;
  const branch = (index: number, rowState: RowState | undefined): SqlFragments => {
    const sql = new SqlFragments()
      .text(`SELECT ${selectList(table, "n")} FROM `)
      .append(rowsOf(table, view, rowState, index))
      .text(` n WHERE n.${table.layer.sql} = `)
      .value(layers[index]);
    if (rowState !== undefined) sql.text(` AND n.${state} = '${rowState}'`);
    andInView(sql, table, "n", view, rowState, index);
    sql.text(` AND n.${table.effect.sql} = '${STATED}'`);
    for (const condition of conditions.seek("n.")) sql.text(" AND ").append(condition);
    // On a table that keeps every version the probes are gathered and written
    // as one expression; elsewhere each is a condition of its own.
    const gathered: SqlFragments[] = [];
    const probe = (condition: SqlFragments) => {
      if (table.versions) gathered.push(condition);
      else sql.text(" AND ").append(condition);
    };
    if (drafted && index === 0 && rowState === PUBLISHED) {
      // The draft's row for an identity replaces the layer's published one.
      probe(topRow("1", "d", DRAFT).text(" IS NULL"));
    }
    for (let above = 0; above < index; above++) {
      if (drafted && above === 0) {
        // What the top layer says with its draft: the draft probe, then the
        // published one; a `retracted` draft row says nothing.
        probe(
          new SqlFragments()
            .text("COALESCE(")
            .append(topRow(`hd.${table.effect.sql}`, "hd", DRAFT))
            .text(", ")
            .append(topRow(`hp.${table.effect.sql}`, "hp", PUBLISHED))
            .text(`, '${RETRACTED}') = '${RETRACTED}'`),
        );
        continue;
      }
      const shadowed = new SqlFragments()
        .text("(SELECT 1 FROM ")
        .append(rowsOf(table, view, published, above))
        .text(` h WHERE h.${table.layer.sql} = `)
        .value(layers[above]);
      if (state !== undefined) shadowed.text(` AND h.${state} = '${PUBLISHED}'`);
      andInView(shadowed, table, "h", view, published, above);
      sameIdentity(shadowed, "h");
      probe(shadowed.text(" LIMIT 1) IS NULL"));
    }
    for (const condition of conditions.filter("n.")) sql.text(" AND ").append(condition);
    for (const condition of conditions.probes?.("n.") ?? []) probe(condition);
    if (gathered.length > 0) sql.text(" AND ").append(inOrder(gathered));
    return sql.text(` ORDER BY ${orderBy("n.")} LIMIT `).value(limit);
  };
  const branches = layers.map((layer, index) => branch(index, published));
  if (drafted) branches.unshift(branch(0, DRAFT));
  if (branches.length === 1) return branches[0];
  const sql = new SqlFragments().text("SELECT * FROM (");
  branches.forEach((each, index) => {
    sql
      .text(`${index === 0 ? "" : " UNION ALL "}SELECT * FROM (`)
      .append(each)
      .text(`) b${index}`);
  });
  return sql.text(`) v ORDER BY ${orderBy("v.")} LIMIT `).value(limit);
}
