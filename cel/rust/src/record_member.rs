//! How a record reads one member named by a literal — `record-member.ts`: the one answer
//! the checker's select, literal index, `.?`, `[?'k']`, `has()` and placement each ask of a
//! record.
//!
//! A declared field is its own type (already met with every pattern matching it). A name
//! declared absent is absent. A name some part's pattern matches is the meet over the parts
//! of each part's matching entries, else that part's own undeclared members — absent where a
//! matching entry admits no value or the meet cannot hold, placed at the one entry or part
//! that applies and nowhere where several do. Any other name is the record's undeclared
//! members, or none where it is closed.

use crate::cel_type::{CelType, RecordType};
use crate::json_schema_type::meet_types;
use crate::schema_dependencies::EdgeKey;

pub(crate) struct RecordMemberReading {
    /// The member's type; none where the record holds no such member.
    pub(crate) ty: Option<CelType>,
    /// Whether the record declares the member to hold no value, rather than not declaring it.
    pub(crate) absent: bool,
    /// The member edges the read descends into.
    pub(crate) edges: Vec<EdgeKey>,
    /// The edge the member is placed at, where one alone applies.
    pub(crate) placed: Option<EdgeKey>,
    /// Types a meet built at the read stands on, read whole: no conversion placed what is
    /// beneath them.
    pub(crate) whole: Vec<CelType>,
}

/// What a record's pattern parts give a member no field declares, part by part: each matching
/// entry (none: it admits no value), else the part's own undeclared members where it carries
/// them. Nothing where no part's pattern matches the name.
pub(crate) fn pattern_standing<'t>(record: &'t RecordType, name: &str) -> Option<Vec<(EdgeKey, Option<&'t CelType>)>> {
    let matched = record.part_matches(name)?;
    let mut standing = Vec::new();
    for (part, entries) in matched.into_iter().enumerate() {
        if entries.is_empty() {
            if let Some(additional) = record.part_additional(part) {
                standing.push((EdgeKey::PartAdditional(part), Some(additional)));
            }
            continue;
        }
        standing.extend(entries.into_iter().map(|at| (EdgeKey::Pattern(at), record.pattern_at(at).1)));
    }
    Some(standing)
}

pub(crate) fn read_record_member(record: &RecordType, name: &str) -> RecordMemberReading {
    let reading = |ty: Option<CelType>, absent: bool, edges: Vec<EdgeKey>, placed: Option<EdgeKey>| RecordMemberReading {
        ty,
        absent,
        edges,
        placed,
        whole: Vec::new(),
    };
    if let Some(field) = record.fields.get(name) {
        return reading(Some(field.clone()), false, vec![EdgeKey::member(name)], Some(EdgeKey::member(name)));
    }
    if record.is_absent(name) {
        return reading(None, true, vec![EdgeKey::member(name)], Some(EdgeKey::member(name)));
    }
    let Some(standing) = pattern_standing(record, name) else {
        return match record.additional_fields() {
            None => reading(None, false, vec![EdgeKey::Additional], None),
            Some(additional) => reading(Some(additional.clone()), false, vec![EdgeKey::Additional], Some(EdgeKey::Additional)),
        };
    };
    let edges: Vec<EdgeKey> = standing.iter().map(|(edge, _)| edge.clone()).collect();
    if let Some((empty, _)) = standing.iter().find(|(_, ty)| ty.is_none()) {
        let placed = empty.clone();
        return reading(None, true, edges, Some(placed));
    }
    let types: Vec<CelType> = standing.into_iter().filter_map(|(_, ty)| ty).cloned().collect();
    if let [only] = types.as_slice() {
        let placed = edges[0].clone();
        return reading(Some(only.clone()), false, edges, Some(placed));
    }
    let mut met = Some(types[0].clone());
    for ty in &types[1..] {
        met = met.and_then(|held| meet_types(&held, ty));
    }
    RecordMemberReading { absent: met.is_none(), ty: met, edges, placed: None, whole: types }
}

/// Every member a record may hold, with its edge: each field, each part's entries and
/// undeclared members, then its own undeclared members.
pub(crate) fn record_members(record: &RecordType) -> Vec<(EdgeKey, &CelType)> {
    let mut members: Vec<(EdgeKey, &CelType)> = record.fields.iter().map(|(name, ty)| (EdgeKey::member(name), ty)).collect();
    for part in 0..record.pattern_part_count() {
        members.extend(record.part_entries(part).filter_map(|at| record.pattern_at(at).1.map(|ty| (EdgeKey::Pattern(at), ty))));
        members.extend(record.part_additional(part).map(|ty| (EdgeKey::PartAdditional(part), ty)));
    }
    members.extend(record.additional_fields().map(|ty| (EdgeKey::Additional, ty)));
    members
}

/// Every member edge a record holds, for a read naming no member: each field, each part's
/// entries and undeclared members, its undeclared members.
pub(crate) fn record_member_edges(record: &RecordType) -> Vec<EdgeKey> {
    let mut edges: Vec<EdgeKey> = record.fields.keys().map(EdgeKey::member).collect();
    for part in 0..record.pattern_part_count() {
        edges.extend(record.part_entries(part).map(EdgeKey::Pattern));
        if record.part_additional(part).is_some() {
            edges.push(EdgeKey::PartAdditional(part));
        }
    }
    edges.push(EdgeKey::Additional);
    edges
}
