/**
 * Which calls bind a name, and where that name is in scope.
 *
 * The comprehension macros and `cel.bind` introduce an identifier that is written
 * as an ordinary argument: in `xs.map(i, i + 1)` the first `i` declares a name and
 * the second reads it. Nothing expands these calls in the front end, so the free
 * variables of an expression cannot be found without knowing this — otherwise `i`
 * would be reported as a name the expression reads from its environment.
 *
 * It is DATA, so the checker and a backend lower exactly the forms the
 * free-variable query already accounts for. An arity not listed here binds nothing:
 * `xs.all(k, v, p)` is not a form the language has, and inventing a binding for it
 * would hide the name `k` from a reader of the query.
 */

export interface ComprehensionBinding {
  /** The argument that is the bound name. */
  readonly variableArgument: number;
  /** The arguments evaluated with that name in scope. */
  readonly scopedArguments: readonly number[];
}

/** Keyed by `<name>/<arity>` for a call on a value. */
const RECEIVER_MACROS = new Map<string, ComprehensionBinding>([
  ["all/2", { variableArgument: 0, scopedArguments: [1] }],
  ["exists/2", { variableArgument: 0, scopedArguments: [1] }],
  ["exists_one/2", { variableArgument: 0, scopedArguments: [1] }],
  ["filter/2", { variableArgument: 0, scopedArguments: [1] }],
  ["map/2", { variableArgument: 0, scopedArguments: [1] }],
  ["map/3", { variableArgument: 0, scopedArguments: [1, 2] }],
  // The optional library's two: each binds the held value under a name, for the one
  // expression that reads it.
  ["optMap/2", { variableArgument: 0, scopedArguments: [1] }],
  ["optFlatMap/2", { variableArgument: 0, scopedArguments: [1] }],
]);

/** Keyed by `<namespace>.<name>/<arity>` for a call on a reserved namespace. */
const NAMESPACE_MACROS = new Map<string, ComprehensionBinding>([
  ["cel.bind/3", { variableArgument: 0, scopedArguments: [2] }],
]);

/**
 * Every form that binds a value into a body, as the table keys them — the receiver macros and
 * `cel.bind`.
 *
 * It is here because the table is the only enumeration of them there is, and two places that
 * list the binding forms is how one of them comes to be missing a form: a value entering a
 * body is a door a host value comes through, and `tests/evaluate.test.ts` holds this list to a
 * probe per form, so a tenth form cannot be added without being guarded.
 */
export const BINDING_FORMS: readonly string[] = [
  ...RECEIVER_MACROS.keys(),
  ...NAMESPACE_MACROS.keys(),
];

export function receiverMacroBinding(name: string, arity: number): ComprehensionBinding | undefined {
  return RECEIVER_MACROS.get(`${name}/${arity}`);
}

export function namespaceMacroBinding(
  namespace: string,
  name: string,
  arity: number,
): ComprehensionBinding | undefined {
  return NAMESPACE_MACROS.get(`${namespace}.${name}/${arity}`);
}
