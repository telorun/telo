/**
 * Which function each call in an expression resolved to.
 *
 * A host needs this for policy the engine cannot know: whether a non-deterministic call
 * sits in a field evaluated once at startup, whether a call reaches the host at all,
 * which error codes a call can fail with. All three are properties of the **resolved**
 * signature, not of the name written — two overloads of one name can differ in every
 * one of them — so the answer has to come from the checker, which is what resolved it.
 *
 * **It is the checker's lowering, not the tree.** A macro is not a dispatch and is not
 * listed: `xs.map(i, i)` becomes a comprehension and reaches no function, while the
 * calls written inside it are listed where they are written. A list read off the tree
 * would instead report whatever the reader's parser happened to expand.
 */

import type { CallForm } from "./signature.js";
import type { SourceRange } from "./syntax-tree.js";

export interface ResolvedCall {
  /** The name as written — `<namespace>.<name>` for a namespaced call. */
  readonly name: string;
  readonly form: CallForm;
  /** Set only for a namespaced call. */
  readonly namespace?: string;
  readonly arity: number;
  readonly range: SourceRange;
  /** The signature it resolved to, absent where nothing resolved. */
  readonly signature?: string;
  /** The type the call answers here, with type parameters substituted. */
  readonly returns?: string;
  readonly deterministic?: boolean;
  readonly hostBacked?: boolean;
  readonly throws?: readonly string[];
}
