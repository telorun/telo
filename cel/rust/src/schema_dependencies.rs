//! Which schema nodes a check read — the twin of `schema-dependencies.ts`, whose header
//! states the reading: a node is read for its own type, a subschema the answer depends on
//! is listed as a node of its own, a descent lists the member's node alone and any other use
//! of a type lists everything beneath it.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};

use crate::cel_type::CelType;
use crate::json_schema_type::Pointer;
use crate::json_value::JsonValue;
use crate::schema_nodes::SchemaNodeAt;

/// A schema node a check read: the document its pointer is relative to — always one the host
/// handed over, a registration's node or root or a resolver answer's, matched back by
/// [`Arc::ptr_eq`] — and the pointer.
#[derive(Clone, Debug)]
pub struct SchemaDependency {
    pub document: Arc<JsonValue>,
    pub pointer: String,
}

impl PartialEq for SchemaDependency {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.document, &other.document) && self.pointer == other.pointer
    }
}

impl Eq for SchemaDependency {}

/// A schema node, and what reading it continues into.
pub(crate) struct SchemaNodeRead {
    pub(crate) document: Arc<JsonValue>,
    pub(crate) pointer: Pointer,
    pub(crate) reads: Arc<SchemaReads>,
}

/// What reading a type reads: nodes read for their own type, and types read whole — its own,
/// then each part's in turn, every node before any whole type. A reading joined out of
/// several holds them as its parts rather than a copy, so a reading shared by many is one
/// entry wherever it is held.
#[derive(Default)]
pub(crate) struct SchemaReads {
    pub(crate) nodes: Vec<SchemaNodeRead>,
    pub(crate) whole: Vec<(CelType, Arc<SchemaReads>)>,
    /// The readings a joined one holds, in order; empty on one read at one place.
    pub(crate) parts: Vec<Arc<SchemaReads>>,
}

impl Drop for SchemaReads {
    /// A reading nests as deep as the references and unions it follows, so it is taken
    /// apart without recursion.
    fn drop(&mut self) {
        let mut pending: Vec<Arc<SchemaReads>> = Vec::new();
        pending.extend(self.nodes.drain(..).map(|node| node.reads));
        pending.extend(self.whole.drain(..).map(|(_, reads)| reads));
        pending.append(&mut self.parts);
        while let Some(reads) = pending.pop() {
            if let Ok(mut owned) = Arc::try_unwrap(reads) {
                pending.extend(owned.nodes.drain(..).map(|node| node.reads));
                pending.extend(owned.whole.drain(..).map(|(_, reads)| reads));
                pending.append(&mut owned.parts);
            }
        }
    }
}

/// The reading that reads nothing.
pub(crate) fn no_schema_reads() -> Arc<SchemaReads> {
    static EMPTY: OnceLock<Arc<SchemaReads>> = OnceLock::new();
    Arc::clone(EMPTY.get_or_init(|| Arc::new(SchemaReads::default())))
}

/// A node's own position, then what reading it continues into.
pub(crate) fn node_read(document: &Arc<JsonValue>, pointer: &Pointer, reads: Arc<SchemaReads>) -> Arc<SchemaReads> {
    Arc::new(SchemaReads {
        nodes: vec![SchemaNodeRead { document: Arc::clone(document), pointer: pointer.clone(), reads }],
        whole: Vec::new(),
        parts: Vec::new(),
    })
}

fn is_empty(reads: &SchemaReads) -> bool {
    reads.nodes.is_empty() && reads.whole.is_empty() && reads.parts.is_empty()
}

/// One reading holding several as its parts, each once, read as every node and whole type of
/// each in turn.
pub(crate) fn joined_reads(parts: Vec<Arc<SchemaReads>>) -> Arc<SchemaReads> {
    let mut seen: HashSet<*const SchemaReads> = HashSet::with_capacity(parts.len());
    let mut filled: Vec<Arc<SchemaReads>> = Vec::with_capacity(parts.len());
    for part in parts {
        if !is_empty(&part) && seen.insert(Arc::as_ptr(&part)) {
            filled.push(part);
        }
    }
    match filled.len() {
        0 => no_schema_reads(),
        1 => filled.pop().expect("one reading"),
        _ => Arc::new(SchemaReads { nodes: Vec::new(), whole: Vec::new(), parts: filled }),
    }
}

/// The key of a list's element and of a map's value among a container's member reads.
pub(crate) const ELEMENT_EDGE: &str = "*";

/// How a container's member is keyed: a field name, a tuple position's index, or
/// [`ELEMENT_EDGE`] — or a record's undeclared members and a tuple's rest, and a record's
/// `patternProperties` entry by its position, which no property name can stand for.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) enum EdgeKey {
    Member(String),
    Additional,
    /// A `patternProperties` entry, by its position among every part's entries.
    Pattern(usize),
    /// The type a pattern part gives a member another part's pattern matches.
    PartAdditional(usize),
}

impl EdgeKey {
    pub(crate) fn member(key: &str) -> EdgeKey {
        EdgeKey::Member(key.into())
    }
}

/// The members of one container type, by their [`EdgeKey`].
pub(crate) type MemberReads = HashMap<EdgeKey, Arc<SchemaReads>>;

/// What one registration's schema conversion knows about where its types came from.
pub(crate) struct SchemaProvenance {
    pub(crate) root: Arc<SchemaReads>,
    /// The node the registered type was read from (`schema_nodes.rs`).
    pub(crate) root_node: SchemaNodeAt,
    /// Per container type the conversion built, by its identity, the type held so its
    /// address is never reused; a container an intersection built holds each member's reads:
    /// the placed part's, or every part's typing it.
    pub(crate) edges: HashMap<(u8, usize), (CelType, MemberReads)>,
    /// Per container type in `edges`: the node each member was read from.
    pub(crate) member_nodes: HashMap<(u8, usize), HashMap<EdgeKey, SchemaNodeAt>>,
    /// Per union type the conversion built, the type held: the node each member was read
    /// from, in member order.
    pub(crate) union_nodes: HashMap<(u8, usize), (CelType, Vec<SchemaNodeAt>)>,
}

/// A container type's identity — its kind and the address of what it shares — or nothing
/// for a type with no identity of its own.
pub(crate) fn type_identity(ty: &CelType) -> Option<(u8, usize)> {
    match ty {
        CelType::Record(record) => Some((0, record.fields.identity())),
        CelType::List(list) => Some((1, Arc::as_ptr(&list.element) as usize)),
        CelType::Map(map) => Some((2, Arc::as_ptr(&map.value) as usize)),
        CelType::Optional(optional) => Some((3, Arc::as_ptr(&optional.value) as usize)),
        CelType::Union(union) => Some((4, union.members().as_ptr() as usize)),
        _ => None,
    }
}

/// Whether a union kept a branch's type as one of its members: a type with no identity of
/// its own says all it says at its node, so it counts as kept.
pub(crate) fn kept_in(combined: &CelType, branch: &CelType) -> bool {
    if let CelType::Union(union) = branch {
        return union.members().iter().all(|member| kept_in(combined, member));
    }
    let Some(identity) = type_identity(branch) else { return true };
    match combined {
        CelType::Union(union) => union.members().iter().any(|member| type_identity(member) == Some(identity)),
        other => type_identity(other) == Some(identity),
    }
}

enum Pending {
    Reads(Arc<SchemaReads>),
    Type(CelType),
    /// A joined reading's parts, read on from where the reading's cursor of that kind —
    /// nodes' readings, or whole types — has got to.
    Parts(Arc<SchemaReads>, bool),
}

/// The dependencies one check collects, each listed once in the order first read; every
/// reading and every type is walked at most once, and a joined reading's parts are listed and
/// read once however many readings hold it — in the order a copy of every part would be read.
#[derive(Default)]
pub(crate) struct SchemaDependencyRecorder {
    listed: Vec<SchemaDependency>,
    seen: HashSet<(usize, String)>,
    recorded: HashSet<usize>,
    walked: HashSet<(u8, usize)>,
    /// Every type walked, held so an address it was walked at is never reused.
    held: Vec<CelType>,
    touched: Vec<Arc<SchemaProvenance>>,
    /// Joined readings whose every node is listed, held so their addresses are never reused.
    joined_listed: HashMap<usize, Arc<SchemaReads>>,
    /// Per joined reading, how far its parts have been read for nodes' readings and for whole
    /// types: one cursor pair per reading and check, so a reading reached again goes on from there.
    cursors: HashMap<usize, (Arc<SchemaReads>, [usize; 2])>,
    /// How many reading entries — nodes, whole types, parts — this check has stepped through.
    pub(crate) visited: usize,
}

impl SchemaDependencyRecorder {
    /// A registration read: a variable by name, or a namespaced function's result at a
    /// call. Its type is read where its root is.
    pub(crate) fn read_registration(&mut self, provenance: Option<&Arc<SchemaProvenance>>) {
        let Some(provenance) = provenance else { return };
        if !self.touched.iter().any(|held| Arc::ptr_eq(held, provenance)) {
            self.touched.push(Arc::clone(provenance));
        }
        self.run(vec![Pending::Reads(Arc::clone(&provenance.root))]);
    }

    /// A descent from a container into one member: that member's node alone.
    pub(crate) fn read_member(&mut self, container: &CelType, key: &EdgeKey) {
        if let Some(reads) = self.edge(container, key) {
            self.run(vec![Pending::Reads(reads)]);
        }
    }

    /// A use of a type: everything beneath it.
    pub(crate) fn read_whole(&mut self, ty: &CelType) {
        match type_identity(ty) {
            Some(identity) if !self.walked.contains(&identity) => self.run(vec![Pending::Type(ty.clone())]),
            _ => {}
        }
    }

    pub(crate) fn dependencies(self) -> Vec<SchemaDependency> {
        self.listed
    }

    fn edge(&self, container: &CelType, key: &EdgeKey) -> Option<Arc<SchemaReads>> {
        self.edges_of(container)?.get(key).cloned()
    }

    fn edges_of(&self, container: &CelType) -> Option<&MemberReads> {
        let identity = type_identity(container)?;
        self.touched.iter().find_map(|provenance| provenance.edges.get(&identity).map(|(_, members)| members))
    }

    /// Pre-order over an explicit stack: a node before what it continues into.
    fn run(&mut self, mut stack: Vec<Pending>) {
        stack.reverse();
        while let Some(next) = stack.pop() {
            let mut children: Vec<Pending> = Vec::new();
            match next {
                Pending::Parts(joined, whole) => {
                    let address = Arc::as_ptr(&joined) as usize;
                    let (_, cursor) = self.cursors.entry(address).or_insert_with(|| (Arc::clone(&joined), [0, 0]));
                    let at = &mut cursor[usize::from(whole)];
                    let Some(part) = joined.parts.get(*at).cloned() else { continue };
                    *at += 1;
                    self.visited += 1;
                    stack.push(Pending::Parts(joined, whole));
                    if !part.parts.is_empty() {
                        children.push(Pending::Parts(part, whole));
                    } else if whole {
                        self.whole_children(&part, &mut children);
                    } else {
                        self.node_children(&part, &mut children);
                    }
                }
                Pending::Reads(reads) => {
                    if !self.recorded.insert(Arc::as_ptr(&reads) as usize) {
                        continue;
                    }
                    self.list_all(&reads);
                    self.node_children(&reads, &mut children);
                    if !reads.parts.is_empty() {
                        children.push(Pending::Parts(Arc::clone(&reads), false));
                    }
                    self.whole_children(&reads, &mut children);
                    if !reads.parts.is_empty() {
                        children.push(Pending::Parts(Arc::clone(&reads), true));
                    }
                }
                Pending::Type(ty) => {
                    if let Some(identity) = type_identity(&ty) {
                        if !self.walked.insert(identity) {
                            continue;
                        }
                        self.held.push(ty.clone());
                    }
                    self.type_children(&ty, &mut children);
                }
            }
            stack.extend(children.into_iter().rev());
        }
    }

    fn node_children(&mut self, reads: &SchemaReads, children: &mut Vec<Pending>) {
        self.visited += reads.nodes.len();
        children.extend(reads.nodes.iter().map(|node| Pending::Reads(Arc::clone(&node.reads))));
    }

    fn whole_children(&mut self, reads: &SchemaReads, children: &mut Vec<Pending>) {
        self.visited += reads.whole.len();
        for (ty, part) in &reads.whole {
            children.push(Pending::Reads(Arc::clone(part)));
            children.push(Pending::Type(ty.clone()));
        }
    }

    /// Every node a reading holds, its own then each part's in turn, a joined part already
    /// listed skipped.
    fn list_all(&mut self, reads: &Arc<SchemaReads>) {
        if !reads.parts.is_empty() && self.joined_listed.insert(Arc::as_ptr(reads) as usize, Arc::clone(reads)).is_some() {
            return;
        }
        let mut pending = vec![Arc::clone(reads)];
        while let Some(next) = pending.pop() {
            self.visited += next.nodes.len() + next.parts.len();
            for node in &next.nodes {
                self.list(node);
            }
            for part in next.parts.iter().rev() {
                if !part.parts.is_empty() {
                    let address = Arc::as_ptr(part) as usize;
                    if self.joined_listed.contains_key(&address) {
                        continue;
                    }
                    self.joined_listed.insert(address, Arc::clone(part));
                }
                pending.push(Arc::clone(part));
            }
        }
    }

    fn type_children(&self, ty: &CelType, children: &mut Vec<Pending>) {
        match ty {
            CelType::Record(record) => {
                // Every member edge, an absent member's, the undeclared members' and each
                // pattern's included, in the order the conversion recorded them.
                let edges = self.edges_of(ty);
                for (name, field) in record.fields.iter() {
                    if let Some(reads) = edges.and_then(|edges| edges.get(&EdgeKey::member(name))) {
                        children.push(Pending::Reads(Arc::clone(reads)));
                    }
                    children.push(Pending::Type(field.clone()));
                }
                for name in record.absent_fields() {
                    if let Some(reads) = edges.and_then(|edges| edges.get(&EdgeKey::member(name))) {
                        children.push(Pending::Reads(Arc::clone(reads)));
                    }
                }
                if let Some(reads) = edges.and_then(|edges| edges.get(&EdgeKey::Additional)) {
                    children.push(Pending::Reads(Arc::clone(reads)));
                }
                for at in 0..record.pattern_count() {
                    if let Some(reads) = edges.and_then(|edges| edges.get(&EdgeKey::Pattern(at))) {
                        children.push(Pending::Reads(Arc::clone(reads)));
                    }
                }
                for part in 0..record.pattern_part_count() {
                    if let Some(reads) = edges.and_then(|edges| edges.get(&EdgeKey::PartAdditional(part))) {
                        children.push(Pending::Reads(Arc::clone(reads)));
                    }
                }
                children.extend(record.pattern_fields().filter_map(|(_, ty)| ty).map(|ty| Pending::Type(ty.clone())));
                children.extend((0..record.pattern_part_count()).filter_map(|part| record.part_additional(part)).map(|ty| Pending::Type(ty.clone())));
                if let Some(additional) = record.additional_fields() {
                    children.push(Pending::Type(additional.clone()));
                }
            }
            CelType::List(list) => {
                if let Some(reads) = self.edge(ty, &EdgeKey::member(ELEMENT_EDGE)) {
                    children.push(Pending::Reads(reads));
                }
                children.push(Pending::Type((*list.element).clone()));
            }
            CelType::Map(map) => {
                if let Some(reads) = self.edge(ty, &EdgeKey::member(ELEMENT_EDGE)) {
                    children.push(Pending::Reads(reads));
                }
                children.push(Pending::Type((*map.key).clone()));
                children.push(Pending::Type((*map.value).clone()));
            }
            CelType::Optional(optional) => children.push(Pending::Type((*optional.value).clone())),
            CelType::Union(union) => children.extend(union.members().iter().cloned().map(Pending::Type)),
            _ => {}
        }
    }

    fn list(&mut self, node: &SchemaNodeRead) {
        let pointer = node.pointer.text();
        if self.seen.insert((Arc::as_ptr(&node.document) as usize, pointer.clone())) {
            self.listed.push(SchemaDependency { document: Arc::clone(&node.document), pointer });
        }
    }
}
