//! Which function each call in an expression resolved to — `resolved-call.ts`.
//!
//! A host needs this for policy the engine cannot know: whether a non-deterministic call
//! sits where a value is read once, whether a call reaches the host, which error codes it
//! can fail with. Each is a property of the resolved signature, not of the name written,
//! so the answer comes from the checker that resolved it.
//!
//! It is the checker's lowering, not the tree: a macro reaches no function and is not
//! listed, while the calls written inside it are, where they are written. Operators are not
//! listed either.
//!
//! Node items with no twin in this file: none.

use crate::signature::CallForm;
use crate::syntax_tree::SourceRange;

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ResolvedCall {
    /// The name as written — `<namespace>.<name>` for a namespaced call.
    pub name: String,
    /// `Receiver` for a namespaced call.
    pub form: CallForm,
    /// Set only for a namespaced call.
    pub namespace: Option<String>,
    pub arity: usize,
    pub range: SourceRange,
    /// The signature it resolved to, absent where nothing resolved or a namespaced
    /// declaration withholds its parameters.
    pub signature: Option<String>,
    /// The type the call answers here, with type parameters substituted.
    pub returns: Option<String>,
    /// Absent where nothing resolved.
    pub deterministic: Option<bool>,
    /// Absent where nothing resolved.
    pub host_backed: Option<bool>,
    pub throws: Option<Vec<String>>,
    /// Each argument's own type, for a namespaced call only: the host judges such a call
    /// against its own signature grammar and needs what was passed, typed in the scope the
    /// call stands in.
    pub argument_types: Option<Vec<String>>,
}
