//! Which schema node each verdict and the result was read from — the twin of
//! `schema-nodes.ts`, whose header states the reading: a type is read from the node that
//! built it, a subexpression is located where its type came straight from a schema node, a
//! result lists every place it may have come from — `cel.bind` and `optFlatMap` contribute
//! those of the expression they answer; `optional.of`, `optional.ofNonZeroValue` and
//! `optMap` are one origin with the wrapping's own type and range; an origin typed
//! `optional<…>` carries no schema node, since no optional is an instance of one — and every
//! node named is one the same check lists among its dependencies.
//!
//! Declared here and not in the Node file: [`SchemaNodeAt`], a node whose pointer is written
//! out only when a verdict names it, and [`node_key`], since a tree node is identified by its
//! address.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::cel_type::{format_type, record_children, union_of, without_parameters, CelType};
use crate::json_schema_type::Pointer;
use crate::json_value::JsonValue;
use crate::schema_dependencies::{type_identity, EdgeKey, SchemaDependency, SchemaProvenance};
use crate::syntax_tree::{CelNode, SourceRange};
use crate::type_visits::count_type_visit;

/// One place a check's result may have come from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResultOrigin {
    /// The subexpression the value comes from.
    pub range: SourceRange,
    /// Its type, every unresolved type parameter `dyn`.
    pub ty: CelType,
    /// How that type is written.
    pub type_name: String,
    /// The schema node it was read straight from, where it was.
    pub schema_node: Option<SchemaDependency>,
}

/// What one branch of a read over a union answered, and the node it was read from.
pub(crate) struct BranchRead {
    pub(crate) ty: CelType,
    pub(crate) schema_node: Option<SchemaNodeAt>,
}

/// A subexpression whose value is another's: its key, its range, and the type it was
/// checked as.
pub(crate) type Relayed = (usize, SourceRange, CelType);

/// A schema node a type was read from: the document its pointer is relative to, and the
/// pointer, shared with the conversion's own.
#[derive(Clone)]
pub(crate) struct SchemaNodeAt {
    pub(crate) document: Arc<JsonValue>,
    pub(crate) pointer: Pointer,
}

impl SchemaNodeAt {
    pub(crate) fn dependency(&self) -> SchemaDependency {
        SchemaDependency { document: Arc::clone(&self.document), pointer: self.pointer.text() }
    }
}

/// A tree node's identity: the address of what its variant holds, so a node is found
/// whether the walk holds it as a node or as its variant.
pub(crate) fn node_key(node: &CelNode) -> usize {
    match node {
        CelNode::Ident(held) => address(held),
        CelNode::Select(held) => address(held),
        CelNode::Index(held) => address(held),
        CelNode::ReceiverCall(held) => address(held),
        CelNode::QualifiedCall(held) => address(held),
        CelNode::Conditional(held) => address(held),
        other => address(other),
    }
}

/// The same type: one with an identity of its own by that identity, any other by equality —
/// which is Node's identity of a type a union kept, since a union keeps the first of equal
/// members.
pub(crate) fn same_type(left: &CelType, right: &CelType) -> bool {
    match (type_identity(left), type_identity(right)) {
        (Some(left), Some(right)) => left == right,
        (None, None) => left == right,
        _ => false,
    }
}

pub(crate) fn address<T>(value: &T) -> usize {
    value as *const T as usize
}

/// The nodes one check has located, and the registrations it read them through.
#[derive(Default)]
pub(crate) struct SchemaNodeLocator {
    touched: Vec<Arc<SchemaProvenance>>,
    located: HashMap<usize, SchemaNodeAt>,
    relays: HashMap<usize, Vec<Relayed>>,
    union_reads: HashMap<usize, Vec<BranchRead>>,
}

impl SchemaNodeLocator {
    /// A registration read: the node its type was read from.
    pub(crate) fn registration(&mut self, provenance: Option<&Arc<SchemaProvenance>>) -> Option<SchemaNodeAt> {
        let provenance = provenance?;
        if !self.touched.iter().any(|held| Arc::ptr_eq(held, provenance)) {
            self.touched.push(Arc::clone(provenance));
        }
        Some(provenance.root_node.clone())
    }

    /// The node a container's member was read from, by its edge key.
    pub(crate) fn member(&self, container: &CelType, key: &EdgeKey) -> Option<SchemaNodeAt> {
        let identity = type_identity(container)?;
        self.touched
            .iter()
            .find_map(|provenance| provenance.member_nodes.get(&identity).and_then(|members| members.get(key)).cloned())
    }

    /// The node a union's member at `at` was read from.
    pub(crate) fn union_member(&self, union: &CelType, at: usize) -> Option<SchemaNodeAt> {
        let identity = type_identity(union)?;
        self.touched
            .iter()
            .find_map(|provenance| provenance.union_nodes.get(&identity).and_then(|(_, nodes)| nodes.get(at)).cloned())
    }

    pub(crate) fn locate(&mut self, key: usize, at: Option<SchemaNodeAt>) {
        if let Some(at) = at {
            self.located.insert(key, at);
        }
    }

    pub(crate) fn at(&self, key: usize) -> Option<SchemaNodeAt> {
        self.located.get(&key).cloned()
    }

    /// Says the node at `key`'s value is one of `answers`', each checked as its type, in
    /// written order.
    pub(crate) fn relay(&mut self, key: usize, answers: Vec<Relayed>) {
        self.relays.insert(key, answers);
    }

    /// Says the node at `key` read a member of each branch of a union, in member order.
    pub(crate) fn union_read(&mut self, key: usize, branches: Vec<BranchRead>) {
        if !branches.is_empty() {
            self.union_reads.insert(key, branches);
        }
    }

    /// Every place a node's value, checked as `ty`, may have come from, in written order.
    pub(crate) fn origins(&self, key: usize, range: SourceRange, ty: CelType) -> Vec<ResultOrigin> {
        let mut origins = Vec::new();
        let mut pending: Vec<Relayed> = vec![(key, range, ty)];
        while let Some((at, range, checked)) = pending.pop() {
            if let Some(relayed) = self.relays.get(&at) {
                pending.extend(relayed.iter().rev().cloned());
                continue;
            }
            if let Some(branches) = self.union_reads.get(&at) {
                for (ty, node) in grouped_by_node(branches) {
                    origins.push(origin(range, &ty, node));
                }
                continue;
            }
            origins.push(origin(range, &checked, self.located.get(&at)));
        }
        origins
    }
}

fn origin(range: SourceRange, ty: &CelType, node: Option<&SchemaNodeAt>) -> ResultOrigin {
    let ty = without_parameters(ty);
    // An origin names a node only where its value is an instance of it.
    let schema_node = node.filter(|_| !holds_optional(&ty)).map(SchemaNodeAt::dependency);
    ResultOrigin { range, type_name: format_type(&ty, true), ty, schema_node }
}

/// Whether a type holds an optional at any depth, each shared part walked once.
fn holds_optional(ty: &CelType) -> bool {
    let mut pending = vec![ty];
    let mut seen = HashSet::new();
    while let Some(at) = pending.pop() {
        count_type_visit();
        if type_identity(at).is_some_and(|identity| !seen.insert(identity)) {
            continue;
        }
        match at {
            CelType::Optional(_) => return true,
            CelType::List(list) => pending.push(&list.element),
            CelType::Map(map) => pending.extend([&*map.key, &*map.value]),
            CelType::Union(union) => pending.extend(union.members()),
            CelType::Record(record) => pending.extend(record_children(record)),
            CelType::Nominal(nominal) => pending.extend(nominal.args.iter()),
            _ => {}
        }
    }
    false
}

/// A union read's branches, one per distinct node in member order, those located nowhere
/// as one.
fn grouped_by_node(branches: &[BranchRead]) -> Vec<(CelType, Option<&SchemaNodeAt>)> {
    let mut groups: Vec<(Option<&SchemaNodeAt>, Vec<CelType>)> = Vec::new();
    for branch in branches {
        let node = branch.schema_node.as_ref();
        match groups.iter_mut().find(|(held, _)| same_node(*held, node)) {
            Some((_, types)) => types.push(branch.ty.clone()),
            None => groups.push((node, vec![branch.ty.clone()])),
        }
    }
    groups.into_iter().map(|(node, types)| (union_of(types), node)).collect()
}

fn same_node(left: Option<&SchemaNodeAt>, right: Option<&SchemaNodeAt>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => Arc::ptr_eq(&left.document, &right.document) && left.pointer.text() == right.pointer.text(),
        (None, None) => true,
        _ => false,
    }
}
