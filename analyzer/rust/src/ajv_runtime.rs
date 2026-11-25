//! What a compiled AJV validator does when it runs: a twin of the code ajv 8.20.0
//! generates (`compile/validate/*`, `compile/errors.js` and each vocabulary keyword's
//! `code`), as a tree of compiled nodes (`ajv_keywords` builds it) walked over the
//! validator's view of a value (`schema_opaque_value`).
//!
//! The generated code's control flow is kept exactly, because it is what decides which
//! errors a validation records, in which order, and what it writes into the value:
//!
//! - an error is pushed in a composite place (inside `anyOf`, `oneOf`, `not`, `if`,
//!   `contains`, `propertyNames`) or with `allErrors`; anywhere else the function returns at
//!   once holding that one error (`returnErrors`), or — for a keyword that reports on top
//!   of its subschemas' errors (`anyOf`, `oneOf`, `if`, `propertyNames`) — every error so far;
//! - without `allErrors` each keyword runs only while the ones before it in its group
//!   passed, and each group only while the schema has recorded no error;
//! - a referenced schema compiled as a function of its own runs as one: its errors are
//!   its own until it returns, and it starts outside every composite place;
//! - a tuple's `valid` is one variable for the function's whole call, as the generated
//!   `var` is, so an element a short array skips reads what an earlier pass left.
//!
//! Nothing here recurses on its input. The walk is one loop over a heap stack of node
//! activations — each holding its keyword's loop variables at the subschema it waits on —
//! beside a stack of the values they judge (a member or item is taken out of its holder
//! while its subschema runs and put back when it returns) and a stack of running calls.
//! [`MAX_NESTING`], counted on that stack, is the only bound on depth; an error's
//! parameters and message text are built on work lists too.

use std::sync::Arc;

use serde_json::Value as Json;
use telorun_cel::{JsonValue, Re2Program};
use telorun_cel_value::{es_number, PropertyMap};

use crate::ajv_equal::{deep_equal, strict_equal};
use crate::schema_opaque_value::{JsObject, JsValue};
use crate::value_type_keyword::TeloTypeCheck;

/// The JSON types a schema's `type` names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JsonType {
    String,
    Number,
    Integer,
    Boolean,
    Null,
    Object,
    Array,
}

impl JsonType {
    pub fn read(name: &str) -> Option<JsonType> {
        Some(match name {
            "string" => JsonType::String,
            "number" => JsonType::Number,
            "integer" => JsonType::Integer,
            "boolean" => JsonType::Boolean,
            "null" => JsonType::Null,
            "object" => JsonType::Object,
            "array" => JsonType::Array,
            _ => return None,
        })
    }

    /// AJV's `checkDataType`, with `strictNumbers` off.
    pub fn holds(self, data: &JsValue) -> bool {
        match (self, data) {
            (JsonType::Null, JsValue::Null) => true,
            (JsonType::Array, JsValue::Array(_)) => true,
            (JsonType::Object, JsValue::Object(_) | JsValue::Opaque(_)) => true,
            (JsonType::Integer, JsValue::Number(n)) => {
                let remainder = n.value % 1.0;
                (remainder == 0.0 || remainder.is_nan()) && !n.value.is_nan()
            }
            (JsonType::Number, JsValue::Number(_)) => true,
            (JsonType::String, JsValue::String(_)) => true,
            (JsonType::Boolean, JsValue::Bool(_)) => true,
            _ => false,
        }
    }
}

/// One error a validation records — AJV's error object.
#[derive(Clone, Debug)]
pub struct SchemaError {
    pub keyword: String,
    pub instance_path: String,
    pub schema_path: String,
    pub params: Json,
    pub message: String,
    /// The property name a `propertyNames` subschema was judging.
    pub property_name: Option<String>,
    /// The keyword's value — a verbose configuration's `schema`.
    pub schema: Option<Arc<JsonValue>>,
    /// The schema node holding the keyword — a verbose configuration's `parentSchema`.
    pub parent_schema: Option<Arc<JsonValue>>,
    /// The value judged — a verbose configuration's `data`.
    pub data: Option<JsValue>,
}

/// The mode a node was compiled in.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Flags {
    pub all_errors: bool,
    pub composite: bool,
    pub create_errors: bool,
}

pub(crate) struct Node {
    pub schema: Arc<JsonValue>,
    pub body: Body,
}

pub(crate) enum Body {
    Valid,
    False { err_path: Arc<str>, top: bool, flags: Flags },
    Rules(Box<Rules>),
}

pub(crate) struct TypeCheck {
    pub types: Vec<JsonType>,
    pub value: Arc<JsonValue>,
}

pub(crate) enum DefaultAt {
    Key(String),
    Index(usize),
}

pub(crate) struct Group {
    pub ty: Option<JsonType>,
    pub defaults: Vec<(DefaultAt, JsValue)>,
    pub keywords: Vec<Keyword>,
    pub else_type: Option<TypeCheck>,
}

pub(crate) struct Rules {
    pub flags: Flags,
    pub err_path: Arc<str>,
    pub top_type: Option<TypeCheck>,
    /// A `$ref` with no other rule beside it runs alone.
    pub ref_only: Option<Keyword>,
    pub groups: Vec<Group>,
}

pub(crate) struct Keyword {
    pub name: &'static str,
    pub value: Arc<JsonValue>,
    pub code: Code,
}

pub(crate) enum RefCall {
    Inline(Box<Node>),
    Function(usize),
}

#[derive(Clone, Copy)]
pub(crate) enum Limit {
    Maximum,
    Minimum,
    ExclusiveMaximum,
    ExclusiveMinimum,
}

impl Limit {
    pub fn ok_text(self) -> &'static str {
        match self {
            Limit::Maximum => "<=",
            Limit::Minimum => ">=",
            Limit::ExclusiveMaximum => "<",
            Limit::ExclusiveMinimum => ">",
        }
    }
}

pub(crate) enum FormatRun {
    Text(Box<dyn Fn(&str) -> bool + Send + Sync>),
    Number(fn(f64) -> bool),
}

pub(crate) enum AdditionalItemsCode {
    False,
    Schema(Box<Node>),
}

pub(crate) enum AdditionalCode {
    Remove,
    False,
    Schema(Box<Node>),
}

pub(crate) enum Code {
    Ref(RefCall),
    Const { value: JsValue, deep: bool },
    Enum(Vec<(JsValue, bool)>),
    NotAlways,
    Not(Box<Node>),
    AnyOf(Vec<Node>),
    OneOf(Vec<Option<Node>>),
    AllOf(Vec<Node>),
    If { condition: Box<Node>, then: Option<Box<Node>>, otherwise: Option<Box<Node>> },
    TeloType { message: String, params: Json, check: TeloTypeCheck, members: Vec<(String, Node)> },
    LimitNumber { limit: Limit, bound: f64 },
    MultipleOf(f64),
    Format { name: String, run: FormatRun },
    Length { max: bool, limit: f64 },
    Pattern { source: String, program: Arc<Re2Program> },
    FormatLimit { limit: Limit, bound: String, compare: fn(&str, &str) -> Option<f64> },
    Items { max: bool, limit: f64 },
    AdditionalItems { length: usize, code: AdditionalItemsCode },
    ItemsAll(Box<Node>),
    Tuple { elements: Vec<Option<Node>>, slot: usize },
    ContainsAny,
    Contains(Box<Node>),
    UniqueItems { item_types: Vec<JsonType>, optimize: bool },
    LimitProperties { max: bool, limit: f64 },
    Required(Vec<String>),
    PropertyNames(Box<Node>),
    Additional { names: Vec<String>, own_proto: bool, many: bool, patterns: Vec<Arc<Re2Program>>, code: AdditionalCode },
    Dependencies { property: Vec<(String, Vec<String>)>, schema: Vec<(String, Node)> },
    Properties(Vec<(String, Node, bool)>),
    PatternProperties { entries: Vec<(Arc<Re2Program>, Option<Node>)> },
}

/// A compiled function: a schema compiled on its own, and how many tuple `valid`
/// variables its code holds.
pub(crate) struct Function {
    pub root: Node,
    pub slots: usize,
}

enum Stop {
    /// The function returns holding this one error.
    One(SchemaError),
    /// The function returns holding every error recorded so far.
    All,
}

/// How deep a validation's subschemas may nest — a schema referencing itself over the
/// same value nests without end, which overflows JavaScript's stack as a `RangeError`.
/// Counted on the walk's own stack of node activations.
pub(crate) const MAX_NESTING: usize = 1000;

/// The message a validation nesting past [`MAX_NESTING`] fails with: V8's `RangeError`.
pub const NESTING_OVERFLOW: &str = "Maximum call stack size exceeded";

struct Location {
    path: String,
    property_name: Option<Arc<str>>,
}

impl Location {
    fn enter(&mut self, segment: &str) -> usize {
        let length = self.path.len();
        self.path.push('/');
        self.path.push_str(&segment.replace('~', "~0").replace('/', "~1"));
        length
    }
}

/// One running compiled function: its errors, its tuple `valid` variables, and where in
/// the value it is.
struct Call {
    errors: Vec<SchemaError>,
    slots: Vec<Option<bool>>,
    location: Location,
}

/// A member key, as the compiled schema names it or as the value holds it.
#[derive(Clone)]
enum Key<'p> {
    Name(&'p str),
    Shared(Arc<str>),
}

impl Key<'_> {
    fn as_str(&self) -> &str {
        match self {
            Key::Name(name) => name,
            Key::Shared(name) => name,
        }
    }
}

/// Where a held value came from, and so where it goes back when its node returns.
enum Origin<'p> {
    /// The value validated.
    Root,
    /// An own member of the value held beneath, taken out while its subschema runs.
    Member(Key<'p>),
    /// An item of the array held beneath, taken out while its subschema runs.
    Item(usize),
    /// A value of the walk's own — an inherited member, a property name, a value type's
    /// member — dropped when its node returns.
    Own,
}

/// A value some node on the walk judges. A node judging the value its parent judges
/// shares the parent's; only a member, an item or a value of the walk's own is held anew.
struct Held<'p> {
    value: JsValue,
    origin: Origin<'p>,
}

/// What a subschema runs over.
enum Target<'p> {
    /// The value its parent judges.
    Same,
    /// The member `key` of that value — its own, or the one it inherits.
    Member(Key<'p>),
    /// The item `index` of that array.
    Item(usize),
    /// A value of its own.
    Value(JsValue),
}

/// A subschema a keyword runs before it can go on.
struct Child<'p> {
    node: &'p Node,
    target: Target<'p>,
    /// The property name a `propertyNames` subschema judges, set while it runs.
    property_name: Option<Arc<str>>,
}

/// What a node's activation asks of the walk next.
enum Step<'p> {
    /// Run a subschema; its answer resumes this activation.
    Child(Child<'p>),
    /// Run a compiled function over this activation's value; whether it recorded no
    /// error resumes this activation.
    Call(usize),
    /// The node returned this answer.
    Done(bool),
}

/// Where a node's rules are.
#[derive(Clone, Copy)]
enum At {
    RefOnly,
    Keyword { group: usize, index: usize },
}

/// A keyword in progress: the generated code's local variables at the subschema it waits on.
struct Running<'p> {
    keyword: &'p Keyword,
    /// `errors.length` when the keyword began.
    count: usize,
    /// The subschema, item, branch, entry or key being judged.
    i: usize,
    /// The key being judged within an entry.
    j: usize,
    valid: bool,
    /// The keyword's stage: `if`'s condition or the clause it chose, `patternProperties`' entry or its keys.
    phase: u8,
    /// The array's length, read when the keyword began.
    length: usize,
    /// The own keys of the value, read when the keyword (or an entry) began.
    keys: Vec<Arc<str>>,
    /// `oneOf`'s `passing`.
    passing: Json,
}

/// One node on the walk: what generated code's activation of a schema function holds.
struct Activation<'p> {
    node: &'p Node,
    /// The held value it judges.
    data: usize,
    /// `errors.length` when it began.
    count: usize,
    at: At,
    running: Option<Running<'p>>,
    /// The root node of a compiled function: its return ends the call.
    call_root: bool,
    /// Whether it holds a value of its own on the held stack.
    holds_data: bool,
    /// The length of the instance path before its segment.
    path_mark: Option<usize>,
    /// The property name in force before it set its own.
    outer_name: Option<Option<Arc<str>>>,
}

/// The walk's state beneath its activations: the held values and the running calls.
struct Walk<'p> {
    held: Vec<Held<'p>>,
    calls: Vec<Call>,
}

impl<'p> Walk<'p> {
    fn call(&mut self) -> &mut Call {
        self.calls.last_mut().expect("a node runs inside a call")
    }

    /// Undo what entering `activation` did: its held value returned where it came from,
    /// its path segment and property name removed.
    fn leave(&mut self, activation: &Activation<'p>) {
        if activation.holds_data {
            let Held { value, origin } = self.held.pop().expect("an activation's held value");
            let beneath = &mut self.held.last_mut().expect("a held value beneath").value;
            // The value beneath is the parent's, untouched while its child ran.
            match origin {
                Origin::Member(key) => {
                    let slot = beneath.own_members_mut().and_then(|own| own.get_mut(key.as_str()));
                    *slot.expect("the member taken out is still held") = value;
                }
                Origin::Item(index) => {
                    let JsValue::Array(items) = beneath else { unreachable!("an item taken out of an array") };
                    items[index] = value;
                }
                Origin::Own | Origin::Root => {}
            }
        }
        let call = self.call();
        if let Some(mark) = activation.path_mark {
            call.location.path.truncate(mark);
        }
        if let Some(outer) = &activation.outer_name {
            call.location.property_name = outer.clone();
        }
    }
}

/// What the walk does next.
enum Signal<'p> {
    /// Open a call of a compiled function over the top activation's value (the validated
    /// value when there is none).
    Open(usize),
    /// Enter a subschema of the top activation.
    Enter(Child<'p>),
    /// Hand the top activation the answer it waits on.
    Resume(bool),
    /// What the top activation asked.
    Asked(Result<Step<'p>, Stop>),
}

fn same(node: &Node) -> Step<'_> {
    Step::Child(Child { node, target: Target::Same, property_name: None })
}

fn member<'p>(node: &'p Node, key: Key<'p>) -> Step<'p> {
    Step::Child(Child { node, target: Target::Member(key), property_name: None })
}

fn item(node: &Node, index: usize) -> Step<'_> {
    Step::Child(Child { node, target: Target::Item(index), property_name: None })
}

pub(crate) struct Runner<'p> {
    pub functions: &'p [Arc<Function>],
    pub verbose: bool,
}

impl<'p> Runner<'p> {
    /// Run function `id` over `data`: the errors it returns, none when valid, or the
    /// overflow a walk nesting without end raises. The walk holds its activations on the
    /// heap, so no depth of nesting reaches the native stack.
    pub fn call(&self, id: usize, data: &mut JsValue, instance_path: &str) -> Result<Vec<SchemaError>, &'static str> {
        let value = std::mem::replace(data, JsValue::Undefined);
        let mut walk = Walk { held: vec![Held { value, origin: Origin::Root }], calls: Vec::new() };
        let answer = self.walk(&mut walk, id, instance_path);
        *data = walk.held.pop().expect("the validated value").value;
        answer
    }

    fn walk(&self, walk: &mut Walk<'p>, id: usize, instance_path: &str) -> Result<Vec<SchemaError>, &'static str> {
        let functions: &'p [Arc<Function>] = self.functions;
        let mut activations: Vec<Activation<'p>> = Vec::new();
        let mut signal = Signal::Open(id);
        loop {
            signal = match signal {
                Signal::Open(id) => {
                    if activations.len() >= MAX_NESTING {
                        return Err(self.overflow(walk, &mut activations));
                    }
                    let function = &functions[id];
                    let path = walk.calls.last().map_or_else(|| instance_path.to_string(), |call| call.location.path.clone());
                    walk.calls.push(Call { errors: Vec::new(), slots: vec![None; function.slots], location: Location { path, property_name: None } });
                    let data = activations.last().map_or(0, |activation| activation.data);
                    activations.push(Activation::new(&function.root, data, true));
                    let top = activations.last_mut().expect("the activation just entered");
                    Signal::Asked(self.step(walk, top, None))
                }
                Signal::Enter(child) => {
                    if activations.len() >= MAX_NESTING {
                        return Err(self.overflow(walk, &mut activations));
                    }
                    let parent = activations.last().expect("a subschema has a parent").data;
                    match self.enter(walk, child, parent) {
                        Some(activation) => {
                            activations.push(activation);
                            let top = activations.last_mut().expect("the activation just entered");
                            Signal::Asked(self.step(walk, top, None))
                        }
                        None => Signal::Resume(true),
                    }
                }
                Signal::Resume(answer) => {
                    let top = activations.last_mut().expect("an activation waits on the answer");
                    Signal::Asked(self.step(walk, top, Some(answer)))
                }
                Signal::Asked(Ok(Step::Child(child))) => Signal::Enter(child),
                Signal::Asked(Ok(Step::Call(id))) => Signal::Open(id),
                Signal::Asked(Ok(Step::Done(answer))) => {
                    let done = activations.pop().expect("the activation answering");
                    walk.leave(&done);
                    if done.call_root {
                        match self.close(walk, None) {
                            Some(valid) => Signal::Resume(valid),
                            None => return Ok(walk.calls.pop().expect("the outermost call").errors),
                        }
                    } else {
                        Signal::Resume(answer)
                    }
                }
                Signal::Asked(Err(stop)) => {
                    // A function returns at once: every activation of its call ends.
                    loop {
                        let done = activations.pop().expect("a call's root activation");
                        walk.leave(&done);
                        if done.call_root {
                            break;
                        }
                    }
                    match self.close(walk, Some(stop)) {
                        Some(valid) => Signal::Resume(valid),
                        None => return Ok(walk.calls.pop().expect("the outermost call").errors),
                    }
                }
            }
        }
    }

    /// End the innermost call, its errors those it returns. An inner call's errors join
    /// its caller's, which is handed whether it recorded none; the outermost call stays for
    /// the walk to answer with, and `None` says so.
    fn close(&self, walk: &mut Walk<'p>, stop: Option<Stop>) -> Option<bool> {
        if let Some(Stop::One(error)) = stop {
            let call = walk.call();
            call.errors.clear();
            call.errors.push(error);
        }
        if walk.calls.len() == 1 {
            return None;
        }
        let errors = walk.calls.pop().expect("the call closing").errors;
        let valid = errors.is_empty();
        walk.call().errors.extend(errors);
        Some(valid)
    }

    /// End every activation, each held value returned where it came from: the overflow a
    /// walk nesting without end raises.
    fn overflow(&self, walk: &mut Walk<'p>, activations: &mut Vec<Activation<'p>>) -> &'static str {
        while let Some(done) = activations.pop() {
            walk.leave(&done);
            if done.call_root {
                walk.calls.pop();
            }
        }
        NESTING_OVERFLOW
    }

    /// The activation of `child`, its value held — or `None` where the subschema does not
    /// run (an item of a value that is no array).
    fn enter(&self, walk: &mut Walk<'p>, child: Child<'p>, parent: usize) -> Option<Activation<'p>> {
        debug_assert_eq!(parent, walk.held.len() - 1, "a subschema's parent judges the value held last");
        let mut activation = Activation::new(child.node, parent, false);
        let held = match child.target {
            Target::Same => None,
            Target::Member(key) => {
                activation.path_mark = Some(walk.call().location.enter(key.as_str()));
                let beneath = &mut walk.held[parent].value;
                Some(match beneath.own_members_mut().and_then(|own| own.get_mut(key.as_str())) {
                    Some(own) => Held { value: std::mem::replace(own, JsValue::Undefined), origin: Origin::Member(key) },
                    None => Held { value: beneath.member(key.as_str()).cloned().unwrap_or(JsValue::Undefined), origin: Origin::Own },
                })
            }
            Target::Item(index) => {
                let JsValue::Array(items) = &mut walk.held[parent].value else { return None };
                let value = std::mem::replace(&mut items[index], JsValue::Undefined);
                let path = &mut walk.call().location.path;
                activation.path_mark = Some(path.len());
                path.push_str(&format!("/{index}"));
                Some(Held { value, origin: Origin::Item(index) })
            }
            Target::Value(value) => Some(Held { value, origin: Origin::Own }),
        };
        if let Some(held) = held {
            walk.held.push(held);
            activation.data = walk.held.len() - 1;
            activation.holds_data = true;
        }
        if let Some(name) = child.property_name {
            activation.outer_name = Some(walk.call().location.property_name.replace(name));
        }
        Some(activation)
    }
}

impl<'p> Activation<'p> {
    fn new(node: &'p Node, data: usize, call_root: bool) -> Self {
        Activation {
            node,
            data,
            count: 0,
            at: At::RefOnly,
            running: None,
            call_root,
            holds_data: false,
            path_mark: None,
            outer_name: None,
        }
    }
}

impl<'p> Running<'p> {
    fn new(keyword: &'p Keyword) -> Self {
        Running { keyword, count: 0, i: 0, j: 0, valid: false, phase: 0, length: 0, keys: Vec::new(), passing: Json::Null }
    }
}

/// Where a node's rules go next.
enum Cursor<'p> {
    Begin(At, &'p Keyword),
    Run(Option<bool>),
    Passed(bool),
    EnterGroup(usize),
    AfterGroup(usize),
    Finish,
}

/// `escapeFragment`: a JSON Pointer token, then `encodeURIComponent`.
pub fn escape_fragment(token: &str) -> String {
    let escaped = token.replace('~', "~0").replace('/', "~1");
    let mut out = String::new();
    for c in escaped.chars() {
        if c.is_ascii_alphanumeric() || "-_.!~*'()".contains(c) {
            out.push(c);
        } else {
            let mut buffer = [0u8; 4];
            for byte in c.encode_utf8(&mut buffer).bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    out
}

/// A JSON value as an error's `params` hold it, built without recursion.
pub(crate) fn json_of(value: &JsonValue) -> Json {
    enum Step<'v> {
        Enter(&'v JsonValue),
        Array(usize),
        Object(&'v PropertyMap<Arc<JsonValue>>),
    }
    let mut work = vec![Step::Enter(value)];
    let mut done: Vec<Json> = Vec::new();
    while let Some(step) = work.pop() {
        match step {
            Step::Enter(JsonValue::Array(items)) => {
                work.push(Step::Array(items.len()));
                work.extend(items.iter().rev().map(|item| Step::Enter(item)));
            }
            Step::Enter(JsonValue::Object(map)) => {
                work.push(Step::Object(map));
                work.extend(map.values().collect::<Vec<_>>().into_iter().rev().map(|item| Step::Enter(item)));
            }
            Step::Enter(JsonValue::Null) => done.push(Json::Null),
            Step::Enter(JsonValue::Bool(b)) => done.push(Json::Bool(*b)),
            Step::Enter(JsonValue::Number(n)) => done.push(number_json(*n)),
            Step::Enter(JsonValue::String(s)) => done.push(Json::String(s.clone())),
            Step::Array(len) => {
                let items = done.split_off(done.len() - len);
                done.push(Json::Array(items));
            }
            Step::Object(map) => {
                let items = done.split_off(done.len() - map.len());
                done.push(Json::Object(map.keys().map(str::to_string).zip(items).collect()));
            }
        }
    }
    done.pop().expect("one value was built")
}

pub(crate) fn number_json(value: f64) -> Json {
    serde_json::Number::from_f64(value).map_or(Json::Null, Json::Number)
}

/// JavaScript's `String(value)` of a schema value a message template interpolates,
/// written without recursion.
pub(crate) fn template_text(value: &JsonValue) -> String {
    enum Step<'v> {
        Enter(&'v JsonValue),
        Comma,
    }
    let mut work = vec![Step::Enter(value)];
    let mut out = String::new();
    while let Some(step) = work.pop() {
        match step {
            Step::Comma => out.push(','),
            Step::Enter(JsonValue::Null) => out.push_str("null"),
            Step::Enter(JsonValue::Bool(b)) => out.push_str(if *b { "true" } else { "false" }),
            Step::Enter(JsonValue::Number(n)) => out.push_str(&es_number(*n)),
            Step::Enter(JsonValue::String(s)) => out.push_str(s),
            Step::Enter(JsonValue::Array(items)) => {
                for (i, item) in items.iter().enumerate().rev() {
                    work.push(Step::Enter(item));
                    if i > 0 {
                        work.push(Step::Comma);
                    }
                }
            }
            Step::Enter(JsonValue::Object(_)) => out.push_str("[object Object]"),
        }
    }
    out
}

/// `parseInt(String(value))`, as `multipleOf` reads a quotient.
fn parse_int_of(value: f64) -> f64 {
    let text = es_number(value);
    let (sign, digits) = match text.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, text.as_str()),
    };
    let leading: String = digits.chars().take_while(char::is_ascii_digit).collect();
    if leading.is_empty() {
        return f64::NAN;
    }
    sign * leading.parse::<f64>().unwrap_or(f64::NAN)
}

/// A JavaScript property key of a `uniqueItems` item (`String(item)`).
fn key_of(item: &JsValue) -> String {
    match item {
        JsValue::Null => "null".into(),
        JsValue::Bool(b) => b.to_string(),
        JsValue::Number(n) => es_number(n.value),
        JsValue::String(s) => s.to_string(),
        JsValue::Undefined => "undefined".into(),
        _ => "[object Object]".into(),
    }
}

impl<'p> Runner<'p> {
    #[inline(never)]
    fn error(&self, flags: Flags, keyword: &str, err_path: &str, keyword_value: Option<&Arc<JsonValue>>, parent: &Arc<JsonValue>, params: Json, message: String, data: &JsValue, location: &Location) -> SchemaError {
        if !flags.create_errors {
            return SchemaError {
                keyword: String::new(),
                instance_path: String::new(),
                schema_path: String::new(),
                params: Json::Null,
                message: String::new(),
                property_name: None,
                schema: None,
                parent_schema: None,
                data: None,
            };
        }
        SchemaError {
            keyword: keyword.to_string(),
            instance_path: location.path.clone(),
            schema_path: format!("{err_path}/{keyword}"),
            params,
            message,
            property_name: location.property_name.as_ref().map(|name| name.to_string()),
            schema: if self.verbose { keyword_value.cloned() } else { None },
            parent_schema: if self.verbose { Some(parent.clone()) } else { None },
            data: if self.verbose { Some(data.clone()) } else { None },
        }
    }

    /// `reportError` (`extra: false`) or `reportExtraError` (`extra: true`).
    #[inline(never)]
    fn report(&self, flags: Flags, errors: &mut Vec<SchemaError>, error: SchemaError, extra: bool) -> Result<(), Stop> {
        if extra {
            errors.push(error);
            return if flags.composite || flags.all_errors { Ok(()) } else { Err(Stop::All) };
        }
        if flags.composite || flags.all_errors {
            errors.push(error);
            Ok(())
        } else {
            Err(Stop::One(error))
        }
    }

    #[inline(never)]
    fn false_schema(&self, node: &Node, err_path: &str, top: bool, flags: Flags, data: &JsValue, call: &mut Call) -> Result<(), Stop> {
        let error = self.error(flags, "false schema", err_path, Some(&node.schema), &node.schema, Json::Object(Default::default()), "boolean schema is false".into(), data, &call.location);
        if top {
            return Err(Stop::One(error));
        }
        self.report(flags, &mut call.errors, error, false)
    }

    #[inline(never)]
    fn type_error(&self, rules: &Rules, node: &Node, check: &TypeCheck, data: &JsValue, call: &mut Call) -> Result<(), Stop> {
        let error = self.error(
            rules.flags,
            "type",
            &rules.err_path,
            Some(&check.value),
            &node.schema,
            serde_json::json!({ "type": json_of(&check.value) }),
            format!("must be {}", template_text(&check.value)),
            data,
            &call.location,
        );
        self.report(rules.flags, &mut call.errors, error, false)
    }

    #[inline(never)]
    fn fail(&self, node: &Node, rules: &Rules, keyword: &Keyword, params: Json, message: String, data: &JsValue, call: &mut Call, extra: bool) -> Result<(), Stop> {
        let error = self.error(rules.flags, keyword.name, &rules.err_path, Some(&keyword.value), &node.schema, params, message, data, &call.location);
        self.report(rules.flags, &mut call.errors, error, extra)
    }

    /// Run `activation` until it waits on a subschema or returns: one schema node's
    /// generated body — its type check, then each rule group's keywords in order — resumed
    /// with `answer`, the subschema's answer it waited on, or begun when there is none.
    fn step(&self, walk: &mut Walk<'p>, activation: &mut Activation<'p>, answer: Option<bool>) -> Result<Step<'p>, Stop> {
        let node: &'p Node = activation.node;
        let rules: &'p Rules = match &node.body {
            Body::Valid => return Ok(Step::Done(true)),
            Body::False { err_path, top, flags } => {
                let Walk { held, calls } = walk;
                let call = calls.last_mut().expect("a node runs inside a call");
                let count = call.errors.len();
                self.false_schema(node, err_path, *top, *flags, &held[activation.data].value, call)?;
                return Ok(Step::Done(call.errors.len() == count));
            }
            Body::Rules(rules) => rules,
        };
        let all = rules.flags.all_errors;
        let mut cursor = match answer {
            Some(answer) => Cursor::Run(Some(answer)),
            None => {
                let Walk { held, calls } = &mut *walk;
                let call = calls.last_mut().expect("a node runs inside a call");
                let data = &held[activation.data].value;
                activation.count = call.errors.len();
                if let Some(check) = &rules.top_type {
                    if !check.types.iter().any(|ty| ty.holds(data)) {
                        self.type_error(rules, node, check, data, call)?;
                    }
                }
                match &rules.ref_only {
                    Some(keyword) => Cursor::Begin(At::RefOnly, keyword),
                    None => Cursor::EnterGroup(0),
                }
            }
        };
        loop {
            cursor = match cursor {
                Cursor::Begin(at, keyword) => {
                    activation.at = at;
                    activation.running = Some(Running::new(keyword));
                    Cursor::Run(None)
                }
                Cursor::Run(answer) => {
                    let data = activation.data;
                    let running = activation.running.as_mut().expect("a keyword is running");
                    match self.keyword(walk, data, node, rules, running, answer)? {
                        Step::Done(passed) => {
                            activation.running = None;
                            Cursor::Passed(passed)
                        }
                        step => return Ok(step),
                    }
                }
                Cursor::Passed(passed) => match activation.at {
                    At::RefOnly => Cursor::Finish,
                    At::Keyword { group, index } => {
                        let keywords = &rules.groups[group].keywords;
                        if (!all && !passed) || index + 1 == keywords.len() {
                            Cursor::AfterGroup(group)
                        } else {
                            Cursor::Begin(At::Keyword { group, index: index + 1 }, &keywords[index + 1])
                        }
                    }
                },
                Cursor::EnterGroup(group) => match rules.groups.get(group) {
                    None => Cursor::Finish,
                    Some(rule_group) => {
                        let Walk { held, calls } = &mut *walk;
                        let call = calls.last_mut().expect("a node runs inside a call");
                        let data = &mut held[activation.data].value;
                        match rule_group.ty {
                            Some(ty) if !ty.holds(data) => {
                                if let Some(check) = &rule_group.else_type {
                                    self.type_error(rules, node, check, data, call)?;
                                }
                                Cursor::AfterGroup(group)
                            }
                            _ => {
                                assign_defaults(&rule_group.defaults, data);
                                match rule_group.keywords.first() {
                                    Some(first) => Cursor::Begin(At::Keyword { group, index: 0 }, first),
                                    None => Cursor::AfterGroup(group),
                                }
                            }
                        }
                    }
                },
                Cursor::AfterGroup(group) => {
                    if !all && walk.call().errors.len() != activation.count {
                        Cursor::Finish
                    } else {
                        Cursor::EnterGroup(group + 1)
                    }
                }
                Cursor::Finish => return Ok(Step::Done(walk.call().errors.len() == activation.count)),
            };
        }
    }

    /// Run the keyword `run` holds until it waits on a subschema or answers whether it
    /// passed: its generated code's loop over its subschemas, resumed with `answer`, the
    /// answer of the subschema it waited on, or begun when there is none.
    #[inline(never)]
    fn keyword(&self, walk: &mut Walk<'p>, data: usize, node: &'p Node, rules: &'p Rules, run: &mut Running<'p>, answer: Option<bool>) -> Result<Step<'p>, Stop> {
        let keyword: &'p Keyword = run.keyword;
        let all = rules.flags.all_errors;
        let Walk { held, calls } = walk;
        let call = calls.last_mut().expect("a keyword runs inside a call");
        let data = &mut held[data].value;
        if answer.is_none() {
            run.count = call.errors.len();
        }
        let count = run.count;
        match &keyword.code {
            Code::Ref(RefCall::Inline(child)) => Ok(match answer {
                None => same(child),
                Some(valid) => Step::Done(valid),
            }),
            Code::Ref(RefCall::Function(id)) => Ok(match answer {
                None => Step::Call(*id),
                Some(valid) => Step::Done(valid),
            }),
            Code::Not(child) => {
                let Some(valid) = answer else { return Ok(same(child)) };
                if valid {
                    self.fail(node, rules, keyword, Json::Object(Default::default()), "must NOT be valid".into(), data, call, false)?;
                } else {
                    call.errors.truncate(count);
                }
                Ok(Step::Done(!valid))
            }
            Code::AnyOf(branches) => {
                if let Some(passed) = answer {
                    run.valid = passed || run.valid;
                    run.i += 1;
                }
                if !run.valid {
                    if let Some(branch) = branches.get(run.i) {
                        return Ok(same(branch));
                    }
                }
                if run.valid {
                    call.errors.truncate(count);
                } else {
                    self.fail(node, rules, keyword, Json::Object(Default::default()), "must match a schema in anyOf".into(), data, call, true)?;
                }
                Ok(Step::Done(run.valid))
            }
            Code::OneOf(branches) => {
                let mut answer = answer;
                while let Some(branch) = branches.get(run.i) {
                    let passed = match (answer.take(), branch) {
                        (Some(passed), _) => passed,
                        (None, None) => true,
                        (None, Some(child)) => return Ok(same(child)),
                    };
                    let i = run.i;
                    if i > 0 && passed && run.valid {
                        run.valid = false;
                        run.passing = Json::Array(vec![std::mem::take(&mut run.passing), Json::from(i)]);
                        break;
                    }
                    if passed {
                        run.valid = true;
                        run.passing = Json::from(i);
                    }
                    run.i += 1;
                }
                if run.valid {
                    call.errors.truncate(count);
                } else {
                    let params = serde_json::json!({ "passingSchemas": std::mem::take(&mut run.passing) });
                    self.fail(node, rules, keyword, params, "must match exactly one schema in oneOf".into(), data, call, true)?;
                }
                Ok(Step::Done(run.valid))
            }
            Code::AllOf(branches) => {
                match answer {
                    None => run.valid = true,
                    Some(passed) => {
                        run.valid = passed;
                        if !all && !passed {
                            return Ok(Step::Done(false));
                        }
                        run.i += 1;
                    }
                }
                Ok(match branches.get(run.i) {
                    Some(branch) => same(branch),
                    None => Step::Done(run.valid),
                })
            }
            Code::If { condition, then, otherwise } => {
                let Some(answer) = answer else { return Ok(same(condition)) };
                if run.phase == 0 {
                    call.errors.truncate(count);
                    let branch = if answer { then.as_deref().map(|then| (then, 1)) } else { otherwise.as_deref().map(|otherwise| (otherwise, 2)) };
                    return Ok(match branch {
                        Some((child, clause)) => {
                            run.phase = clause;
                            same(child)
                        }
                        None => Step::Done(true),
                    });
                }
                if !answer {
                    let clause = if run.phase == 1 { "then" } else { "else" };
                    let params = serde_json::json!({ "failingKeyword": clause });
                    self.fail(node, rules, keyword, params, format!("must match \"{clause}\" schema"), data, call, true)?;
                }
                Ok(Step::Done(answer))
            }
            Code::TeloType { message, params, check, members } => {
                match answer {
                    None => run.valid = check.holds(data),
                    Some(accepted) => {
                        if !accepted {
                            run.valid = false;
                        }
                        run.i += 1;
                    }
                }
                while run.valid {
                    let Some((member, child)) = members.get(run.i) else { break };
                    if let Some(held) = crate::value_type_keyword::held_member(data, member) {
                        return Ok(Step::Child(Child { node: child, target: Target::Value(held), property_name: None }));
                    }
                    run.i += 1;
                }
                call.errors.truncate(count);
                if !run.valid {
                    self.fail(node, rules, keyword, params.clone(), message.clone(), data, call, false)?;
                }
                Ok(Step::Done(run.valid))
            }
            Code::AdditionalItems { length: tuple, code } => {
                let JsValue::Array(items) = &*data else { return Ok(Step::Done(true)) };
                let length = items.len();
                match code {
                    AdditionalItemsCode::False => {
                        let valid = length <= *tuple;
                        if !valid {
                            let params = serde_json::json!({ "limit": tuple });
                            self.fail(node, rules, keyword, params, format!("must NOT have more than {tuple} items"), data, call, false)?;
                        }
                        Ok(Step::Done(valid))
                    }
                    AdditionalItemsCode::Schema(child) => {
                        match answer {
                            None => {
                                if length <= *tuple {
                                    return Ok(Step::Done(true));
                                }
                                run.i = *tuple;
                            }
                            Some(valid) => {
                                if (!all && !valid) || run.i + 1 >= length {
                                    return Ok(Step::Done(valid));
                                }
                                run.i += 1;
                            }
                        }
                        Ok(item(child, run.i))
                    }
                }
            }
            Code::ItemsAll(child) => {
                let JsValue::Array(items) = &*data else { return Ok(Step::Done(true)) };
                match answer {
                    None => {
                        run.valid = true;
                        run.length = items.len();
                    }
                    Some(passed) => {
                        if !passed {
                            run.valid = false;
                            if !all {
                                return Ok(Step::Done(false));
                            }
                        }
                        run.i += 1;
                    }
                }
                Ok(if run.i < run.length { item(child, run.i) } else { Step::Done(run.valid) })
            }
            Code::Tuple { elements, slot } => {
                let JsValue::Array(items) = &*data else { return Ok(Step::Done(true)) };
                match answer {
                    None => run.length = items.len(),
                    Some(passed) => {
                        call.slots[*slot] = Some(passed);
                        if !all && call.slots[*slot] != Some(true) {
                            return Ok(Step::Done(false));
                        }
                        run.i += 1;
                    }
                }
                while let Some(element) = elements.get(run.i) {
                    if let Some(child) = element {
                        if run.length > run.i {
                            return Ok(item(child, run.i));
                        }
                        if !all && call.slots[*slot] != Some(true) {
                            return Ok(Step::Done(false));
                        }
                    }
                    run.i += 1;
                }
                Ok(Step::Done(true))
            }
            Code::Contains(child) => {
                let JsValue::Array(items) = &*data else { return Ok(Step::Done(true)) };
                match answer {
                    None => run.length = items.len(),
                    Some(valid) => {
                        run.valid = valid;
                        run.i += 1;
                    }
                }
                if !run.valid && run.i < run.length {
                    return Ok(item(child, run.i));
                }
                if run.valid {
                    call.errors.truncate(count);
                } else {
                    let params = serde_json::json!({ "minContains": 1 });
                    self.fail(node, rules, keyword, params, "must contain at least 1 valid item(s)".into(), data, call, false)?;
                }
                Ok(Step::Done(run.valid))
            }
            Code::PropertyNames(child) => {
                match answer {
                    None => {
                        run.keys = data.own_members().map(JsObject::keys).unwrap_or_default();
                        run.valid = true;
                    }
                    Some(valid) => {
                        run.valid = valid;
                        if !valid {
                            let params = serde_json::json!({ "propertyName": &*run.keys[run.i] });
                            self.fail(node, rules, keyword, params, "property name must be valid".into(), data, call, true)?;
                            if !all {
                                return Ok(Step::Done(false));
                            }
                        }
                        run.i += 1;
                    }
                }
                Ok(match run.keys.get(run.i) {
                    Some(key) => Step::Child(Child { node: child, target: Target::Value(JsValue::String(key.clone())), property_name: Some(key.clone()) }),
                    None => Step::Done(run.valid),
                })
            }
            Code::Additional { names, own_proto, many, patterns, code } => {
                match answer {
                    None => run.keys = data.own_members().map(JsObject::keys).unwrap_or_default(),
                    Some(valid) => {
                        if !all && !valid {
                            return Ok(Step::Done(call.errors.len() == count));
                        }
                        run.i += 1;
                    }
                }
                while let Some(key) = run.keys.get(run.i) {
                    let defined = (if *many { names.iter().any(|n| **n == **key) || (*own_proto && &**key == "__proto__") } else { names.iter().any(|n| **n == **key) })
                        || patterns.iter().any(|pattern| pattern.is_match(key));
                    if !defined {
                        match code {
                            AdditionalCode::Remove => {
                                if let Some(own) = data.own_members_mut() {
                                    own.remove(key);
                                }
                            }
                            AdditionalCode::False => {
                                let params = serde_json::json!({ "additionalProperty": &**key });
                                self.fail(node, rules, keyword, params, "must NOT have additional properties".into(), data, call, false)?;
                                if !all {
                                    break;
                                }
                            }
                            AdditionalCode::Schema(child) => return Ok(member(child, Key::Shared(key.clone()))),
                        }
                    }
                    run.i += 1;
                }
                Ok(Step::Done(call.errors.len() == count))
            }
            Code::Dependencies { property, schema } => {
                match answer {
                    None => {
                        for (name, deps) in property {
                            if !data.has_member(name) {
                                continue;
                            }
                            let params = |missing: &str| {
                                serde_json::json!({ "property": name, "missingProperty": missing, "depsCount": deps.len(), "deps": deps.join(", ") })
                            };
                            let message = format!(
                                "must have {} {} when property {name} is present",
                                if deps.len() == 1 { "property" } else { "properties" },
                                deps.join(", ")
                            );
                            if all {
                                for dep in deps {
                                    if !data.has_member(dep) {
                                        self.fail(node, rules, keyword, params(dep), message.clone(), data, call, false)?;
                                    }
                                }
                            } else if let Some(missing) = deps.iter().find(|dep| !data.has_member(dep)) {
                                self.fail(node, rules, keyword, params(missing), message, data, call, false)?;
                                return Ok(Step::Done(false));
                            }
                        }
                    }
                    Some(valid) => {
                        if !all && !valid {
                            return Ok(Step::Done(false));
                        }
                        run.i += 1;
                    }
                }
                while let Some((name, child)) = schema.get(run.i) {
                    if data.has_member(name) {
                        return Ok(same(child));
                    }
                    run.i += 1;
                }
                Ok(Step::Done(true))
            }
            Code::Properties(entries) => {
                match answer {
                    None => run.valid = true,
                    Some(valid) => {
                        run.valid = valid;
                        if !all && !valid {
                            return Ok(Step::Done(false));
                        }
                        run.i += 1;
                    }
                }
                while let Some((name, child, has_default)) = entries.get(run.i) {
                    if *has_default || data.has_member(name) {
                        return Ok(member(child, Key::Name(name)));
                    }
                    run.valid = true;
                    run.i += 1;
                }
                Ok(Step::Done(run.valid))
            }
            Code::PatternProperties { entries } => {
                let mut answer = answer;
                if answer.is_none() {
                    run.valid = true;
                }
                while let Some((pattern, child)) = entries.get(run.i) {
                    if run.phase == 0 {
                        run.valid = true;
                        run.keys = data.own_members().map(JsObject::keys).unwrap_or_default();
                        run.j = 0;
                        run.phase = 1;
                    }
                    let mut stopped = false;
                    if let Some(valid) = answer.take() {
                        run.valid = valid;
                        if !all && !valid {
                            stopped = true;
                        } else {
                            run.j += 1;
                        }
                    }
                    if !stopped {
                        while let Some(key) = run.keys.get(run.j) {
                            if let (true, Some(child)) = (pattern.is_match(key), child) {
                                return Ok(member(child, Key::Shared(key.clone())));
                            }
                            run.j += 1;
                        }
                    }
                    if !all && !run.valid {
                        return Ok(Step::Done(false));
                    }
                    run.i += 1;
                    run.phase = 0;
                }
                Ok(Step::Done(run.valid))
            }
            _ => self.leaf(node, rules, keyword, data, call).map(Step::Done),
        }
    }

    /// A keyword holding no subschema.
    #[inline(never)]
    fn leaf(&self, node: &Node, rules: &Rules, keyword: &Keyword, data: &JsValue, call: &mut Call) -> Result<bool, Stop> {
        let all = rules.flags.all_errors;
        match &keyword.code {
            Code::Const { value, deep } => {
                let equal = if *deep { deep_equal(data, value) } else { strict_equal(value, data) };
                if !equal {
                    let params = serde_json::json!({ "allowedValue": json_of(&keyword.value) });
                    self.fail(node, rules, keyword, params, "must be equal to constant".into(), data, call, false)?;
                }
                Ok(equal)
            }
            Code::Enum(entries) => {
                let equal = entries.iter().any(|(entry, deep)| if *deep { deep_equal(data, entry) } else { strict_equal(data, entry) });
                if !equal {
                    let params = serde_json::json!({ "allowedValues": json_of(&keyword.value) });
                    self.fail(node, rules, keyword, params, "must be equal to one of the allowed values".into(), data, call, false)?;
                }
                Ok(equal)
            }
            Code::NotAlways => {
                self.fail(node, rules, keyword, Json::Object(Default::default()), "must NOT be valid".into(), data, call, false)?;
                Ok(false)
            }
            Code::LimitNumber { limit, bound } => {
                let JsValue::Number(n) = data else { return Ok(true) };
                let value = n.value;
                let failed = value.is_nan()
                    || match limit {
                        Limit::Maximum => value > *bound,
                        Limit::Minimum => value < *bound,
                        Limit::ExclusiveMaximum => value >= *bound,
                        Limit::ExclusiveMinimum => value <= *bound,
                    };
                if failed {
                    let params = serde_json::json!({ "comparison": limit.ok_text(), "limit": number_json(*bound) });
                    self.fail(node, rules, keyword, params, format!("must be {} {}", limit.ok_text(), es_number(*bound)), data, call, false)?;
                }
                Ok(!failed)
            }
            Code::MultipleOf(divisor) => {
                let JsValue::Number(n) = data else { return Ok(true) };
                let failed = *divisor == 0.0 || {
                    let quotient = n.value / divisor;
                    let parsed = parse_int_of(quotient);
                    quotient != parsed
                };
                if failed {
                    let params = serde_json::json!({ "multipleOf": number_json(*divisor) });
                    self.fail(node, rules, keyword, params, format!("must be multiple of {}", es_number(*divisor)), data, call, false)?;
                }
                Ok(!failed)
            }
            Code::Format { name, run } => {
                let valid = match (run, &*data) {
                    (FormatRun::Text(check), JsValue::String(s)) => check(s),
                    (FormatRun::Number(check), JsValue::Number(n)) => check(n.value),
                    _ => true,
                };
                if !valid {
                    let params = serde_json::json!({ "format": name });
                    self.fail(node, rules, keyword, params, format!("must match format \"{name}\""), data, call, false)?;
                }
                Ok(valid)
            }
            Code::Length { max, limit } => {
                let JsValue::String(s) = data else { return Ok(true) };
                let length = s.chars().count() as f64;
                let failed = if *max { length > *limit } else { length < *limit };
                if failed {
                    let params = serde_json::json!({ "limit": number_json(*limit) });
                    let comparison = if *max { "more" } else { "fewer" };
                    self.fail(node, rules, keyword, params, format!("must NOT have {comparison} than {} characters", es_number(*limit)), data, call, false)?;
                }
                Ok(!failed)
            }
            Code::Pattern { source, program } => {
                let JsValue::String(s) = data else { return Ok(true) };
                let matched = program.is_match(s);
                if !matched {
                    let params = serde_json::json!({ "pattern": source });
                    self.fail(node, rules, keyword, params, format!("must match pattern \"{source}\""), data, call, false)?;
                }
                Ok(matched)
            }
            Code::FormatLimit { limit, bound, compare } => {
                let JsValue::String(s) = data else { return Ok(true) };
                let failed = compare(s, bound).is_some_and(|order| match limit {
                    Limit::Maximum => order > 0.0,
                    Limit::Minimum => order < 0.0,
                    Limit::ExclusiveMaximum => order >= 0.0,
                    Limit::ExclusiveMinimum => order <= 0.0,
                });
                if failed {
                    let params = serde_json::json!({ "comparison": limit.ok_text(), "limit": bound });
                    self.fail(node, rules, keyword, params, format!("should be {} {bound}", limit.ok_text()), data, call, false)?;
                }
                Ok(!failed)
            }
            Code::Items { max, limit } => {
                let JsValue::Array(items) = data else { return Ok(true) };
                let length = items.len() as f64;
                let failed = if *max { length > *limit } else { length < *limit };
                if failed {
                    let params = serde_json::json!({ "limit": number_json(*limit) });
                    let comparison = if *max { "more" } else { "fewer" };
                    self.fail(node, rules, keyword, params, format!("must NOT have {comparison} than {} items", es_number(*limit)), data, call, false)?;
                }
                Ok(!failed)
            }
            Code::ContainsAny => {
                let JsValue::Array(items) = data else { return Ok(true) };
                let valid = !items.is_empty();
                if !valid {
                    let params = serde_json::json!({ "minContains": 1 });
                    self.fail(node, rules, keyword, params, "must contain at least 1 valid item(s)".into(), data, call, false)?;
                }
                Ok(valid)
            }
            Code::UniqueItems { item_types, optimize } => {
                let JsValue::Array(items) = data else { return Ok(true) };
                let mut duplicate = None;
                if items.len() > 1 {
                    if *optimize {
                        let mut indices: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
                        for i in (0..items.len()).rev() {
                            let item = &items[i];
                            if !item_types.iter().any(|ty| ty.holds(item)) {
                                continue;
                            }
                            let mut key = key_of(item);
                            if item_types.len() > 1 && matches!(item, JsValue::String(_)) {
                                key.push('_');
                            }
                            if let Some(j) = indices.get(&key) {
                                duplicate = Some((i, *j));
                                break;
                            }
                            // An `__proto__` key sets the object's prototype and records nothing.
                            if key != "__proto__" {
                                indices.insert(key, i);
                            }
                        }
                    } else {
                        'outer: for i in (0..items.len()).rev() {
                            for j in (0..i).rev() {
                                if deep_equal(&items[i], &items[j]) {
                                    duplicate = Some((i, j));
                                    break 'outer;
                                }
                            }
                        }
                    }
                }
                if let Some((i, j)) = duplicate {
                    let params = serde_json::json!({ "i": i, "j": j });
                    self.fail(node, rules, keyword, params, format!("must NOT have duplicate items (items ## {j} and {i} are identical)"), data, call, false)?;
                }
                Ok(duplicate.is_none())
            }
            Code::LimitProperties { max, limit } => {
                let length = data.own_members().map_or(0, JsObject::len) as f64;
                let failed = if *max { length > *limit } else { length < *limit };
                if failed {
                    let params = serde_json::json!({ "limit": number_json(*limit) });
                    let comparison = if *max { "more" } else { "fewer" };
                    self.fail(node, rules, keyword, params, format!("must NOT have {comparison} than {} properties", es_number(*limit)), data, call, false)?;
                }
                Ok(!failed)
            }
            Code::Required(names) => {
                if all {
                    for name in names {
                        if !data.has_member(name) {
                            let params = serde_json::json!({ "missingProperty": name });
                            self.fail(node, rules, keyword, params, format!("must have required property '{name}'"), data, call, false)?;
                        }
                    }
                    return Ok(true);
                }
                match names.iter().find(|name| !data.has_member(name)) {
                    Some(name) => {
                        let params = serde_json::json!({ "missingProperty": name });
                        self.fail(node, rules, keyword, params, format!("must have required property '{name}'"), data, call, false)?;
                        Ok(false)
                    }
                    None => Ok(true),
                }
            }
            _ => unreachable!("a keyword holding a subschema"),
        }
    }
}

fn assign_defaults(defaults: &[(DefaultAt, JsValue)], data: &mut JsValue) {
    for (at, value) in defaults {
        match at {
            DefaultAt::Key(key) => {
                if data.is_object() && !data.has_member(key) {
                    if let Some(own) = data.own_members_mut() {
                        own.insert(key, value.clone());
                    }
                }
            }
            DefaultAt::Index(i) => {
                if let JsValue::Array(items) = data {
                    if items.get(*i).is_none_or(|held| matches!(held, JsValue::Undefined)) {
                        if items.len() <= *i {
                            items.resize(*i + 1, JsValue::Undefined);
                        }
                        items[*i] = value.clone();
                    }
                }
            }
        }
    }
}
