/**
 * What one load has already made ready for a bundle to be imported: a current
 * build of a source entry, a sibling library's entry file, a bundle directory
 * whose `node_modules/` is written.
 *
 * A module is ONE bundle and every kind of it selects its export out of that
 * bundle, so without this each kind's first instantiation repeated the whole
 * module's preparation — the build index read, a stat of every input esbuild
 * reported, every shim checked — once per kind, each an event-loop turn.
 *
 * Owned by the kernel and cleared with the rest of a load's artifact state, so
 * an edit is seen by the next load exactly as before. A rejected preparation is
 * dropped, so the next resolution tries again.
 */
export class BundlePreparations {
  private readonly pending = new Map<string, Promise<unknown>>();

  once<T>(key: string, prepare: () => Promise<T>): Promise<T> {
    const known = this.pending.get(key) as Promise<T> | undefined;
    if (known) return known;
    const work = prepare();
    this.pending.set(key, work);
    work.catch(() => {
      if (this.pending.get(key) === work) this.pending.delete(key);
    });
    return work;
  }

  clear(): void {
    this.pending.clear();
  }
}
