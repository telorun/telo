//! Which calls bind a name, and where that name is in scope — `comprehension-bindings.ts`.
//!
//! The comprehension macros and `cel.bind` introduce an identifier that is written as
//! an ordinary argument: in `xs.map(i, i + 1)` the first `i` declares a name and the
//! second reads it. Nothing expands these calls in the front end, so the names an
//! expression reads from its environment cannot be found without knowing this.
//!
//! It is data, so every consumer accounts for exactly the same forms. An arity not
//! listed binds nothing: `xs.all(k, v, p)` is not a form the language has.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ComprehensionBinding {
    /// The argument that is the bound name.
    pub variable_argument: usize,
    /// The arguments evaluated with that name in scope.
    pub scoped_arguments: &'static [usize],
}

const ONE_BODY: ComprehensionBinding = ComprehensionBinding { variable_argument: 0, scoped_arguments: &[1] };

/// Keyed by `<name>/<arity>` for a call on a value.
const RECEIVER_MACROS: [(&str, ComprehensionBinding); 8] = [
    ("all/2", ONE_BODY),
    ("exists/2", ONE_BODY),
    ("exists_one/2", ONE_BODY),
    ("filter/2", ONE_BODY),
    ("map/2", ONE_BODY),
    ("map/3", ComprehensionBinding { variable_argument: 0, scoped_arguments: &[1, 2] }),
    // The optional library's two: each binds the held value under a name, for the one
    // expression that reads it.
    ("optMap/2", ONE_BODY),
    ("optFlatMap/2", ONE_BODY),
];

/// Keyed by `<namespace>.<name>/<arity>` for a call on a reserved namespace.
const NAMESPACE_MACROS: [(&str, ComprehensionBinding); 1] =
    [("cel.bind/3", ComprehensionBinding { variable_argument: 0, scoped_arguments: &[2] })];

/// Every form that binds a value into a body, as the table keys them — the receiver
/// macros, then `cel.bind`. The table is the only enumeration of them there is.
pub const BINDING_FORMS: [&str; RECEIVER_MACROS.len() + NAMESPACE_MACROS.len()] = {
    let mut forms = [""; RECEIVER_MACROS.len() + NAMESPACE_MACROS.len()];
    let mut at = 0;
    while at < RECEIVER_MACROS.len() {
        forms[at] = RECEIVER_MACROS[at].0;
        at += 1;
    }
    while at < forms.len() {
        forms[at] = NAMESPACE_MACROS[at - RECEIVER_MACROS.len()].0;
        at += 1;
    }
    forms
};

/// Whether `key` is `<arity>` in decimal after its `/`.
fn arity_is(key_arity: &str, arity: usize) -> bool {
    key_arity.parse() == Ok(arity)
}

pub fn receiver_macro_binding(name: &str, arity: usize) -> Option<ComprehensionBinding> {
    RECEIVER_MACROS.iter().find_map(|(key, binding)| {
        let key_arity = key.strip_prefix(name)?.strip_prefix('/')?;
        arity_is(key_arity, arity).then_some(*binding)
    })
}

pub fn namespace_macro_binding(namespace: &str, name: &str, arity: usize) -> Option<ComprehensionBinding> {
    NAMESPACE_MACROS.iter().find_map(|(key, binding)| {
        let key_arity = key.strip_prefix(namespace)?.strip_prefix('.')?.strip_prefix(name)?.strip_prefix('/')?;
        arity_is(key_arity, arity).then_some(*binding)
    })
}
