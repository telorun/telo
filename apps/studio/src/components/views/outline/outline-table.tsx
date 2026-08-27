/**
 * The shared shape of an outline block.
 *
 * Its own module because the four tables and the view that composes them both
 * need it: exported from the view, the tables imported back from the module
 * that imports them — a cycle that held only because the bindings are
 * functions.
 */

/** One titled block of the outline. Renders nothing at all when the filter
 *  excluded everything in it — an empty section under a filter says "no such
 *  thing here", which is a claim about the filter, not about the module. */
export function OutlineSection({
  title,
  count,
  filtered,
  emptyText,
  children,
}: {
  title: string;
  count: number;
  /** True when a filter is in force, so an empty block is hidden rather than
   *  reported as empty. */
  filtered: boolean;
  emptyText: string;
  children: React.ReactNode;
}) {
  if (count === 0 && filtered) return null;
  return (
    <section className="mb-5">
      <h3 className="mb-1.5 flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        {title}
        <span className="text-[10px] font-normal tabular-nums text-zinc-300 dark:text-zinc-600">
          {count}
        </span>
      </h3>
      {count === 0 ? (
        <p className="text-xs italic text-zinc-400 dark:text-zinc-600">{emptyText}</p>
      ) : (
        children
      )}
    </section>
  );
}

/** The shared header row: every block is a table of the same shape. */
export function OutlineHead({ columns }: { columns: (string | null)[] }) {
  return (
    <thead>
      <tr className="border-b border-zinc-200 text-xs text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
        {columns.map((column, i) => (
          <th
            key={column ?? `spacer-${i}`}
            className={column === null ? "w-5 pb-1.5" : "pb-1.5 pr-3 font-medium"}
          >
            {column}
          </th>
        ))}
      </tr>
    </thead>
  );
}

export function matches(query: string, ...fields: (string | undefined | null)[]): boolean {
  if (!query) return true;
  return fields.some((field) => field?.toLowerCase().includes(query));
}
