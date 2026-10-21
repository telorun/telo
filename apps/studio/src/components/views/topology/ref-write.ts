/** A single reference write the canvas asks the host to apply: set (or, when
 *  `target` is null, clear / splice) the ref slot at `concretePath` on the
 *  source resource. Drag-to-wire, edge deletion, and picker changes all emit
 *  these — the one generic mutation the module canvas performs. */
export interface RefWrite {
  source: { kind: string; name: string };
  concretePath: string;
  target: string | null;
  /** When set, create a new resource of this kind, then link the slot to it
   *  (instead of `target`). */
  createKind?: string;
  /** The name to give it. Absent, the host generates a unique one — right for
   *  a one-click create; a picker that ASKED for a name must be able to honour
   *  the answer, or the field it showed was decoration. */
  createName?: string;
}
