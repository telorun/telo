//! The one judge of a schema validation's findings: what a failed `anyOf` / `oneOf`
//! reports, and what the stand-ins in the value excuse. Mirrors
//! `../../nodejs/src/schema-findings-judge.ts`, but for the carve path — a value judged in
//! parts (`UnionPlan`, carve stand-ins, `CarveSummary`, the injected unions), which only
//! the choices-and-configurations analysis reads and which ships with it (build-order step
//! 3e-19).
//!
//! A flat error list cannot say which branch of a union raised a finding inside a
//! referenced shape, so each branch is VALIDATED ON ITS OWN, its findings judged by this
//! same judge, and given a branch state; `union_outcome` decides from the states alone
//! what the union reports. A finding is the union's only when a branch validated alone
//! reproduces it — counted, so a finding a sibling raises and a branch reproduces stays
//! once. A union whose node lies in no document the validator holds is kept with
//! everything raised around it: the reporting backstop, which `watch_union_backstop`
//! observes.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use telorun_cel::JsonValue;
use telorun_cel_value::CelValue;

use crate::ajv_runtime::SchemaError;
use crate::schema_error_report::{format_single_error, join_text, json_stringify, value_at, LISTED_ENUM_VALUES};
use crate::stand_in_findings::{is_ambiguous_one_of, StandInRule, StandIns};
use crate::union_outcome::{union_outcome, BranchState, UnionOutcome};
use crate::union_tags::{json_type_of, read_union, ReferenceReader, UnionReading};

/// Every finding a node of the judged schema raises against a value: the whole schema as
/// the host validates it (its defaults filled into the value), any other node on its own —
/// `None` for a node no held document holds, an error where the validator could not finish.
pub type SchemaNodeFindings<'a> = dyn Fn(&Arc<JsonValue>, &mut CelValue) -> Result<Option<Vec<SchemaError>>, String> + 'a;

/// What the judge decides over: one validated value, and the means to ask about a part of
/// its schema.
pub struct SchemaJudgment<'a> {
    /// The value that was validated, stand-ins in place — the whole schema's validation
    /// fills its defaults into it.
    pub value: CelValue,
    /// The schema it was validated against, as the host compiled it.
    pub schema: Arc<JsonValue>,
    /// Every stand-in in `value`, by JSON Pointer.
    pub stand_ins: StandIns,
    pub validate: &'a SchemaNodeFindings<'a>,
    /// What a `$ref` written in a node of `schema` names.
    pub reference: &'a ReferenceReader<'a>,
}

/// Why a union was kept with everything raised around it instead of decided.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnionBackstop {
    NodeUnheld,
    BranchUnheld,
    ReferenceUnreadable,
    NoLocatedTwin,
}

thread_local! {
    static BACKSTOP_LISTENERS: RefCell<Vec<(usize, Box<dyn Fn(UnionBackstop)>)>> = const { RefCell::new(Vec::new()) };
    static NEXT_LISTENER: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// What stops a [`watch_union_backstop`] listener when dropped.
pub struct BackstopWatch(usize);

impl Drop for BackstopWatch {
    fn drop(&mut self) {
        BACKSTOP_LISTENERS.with(|listeners| listeners.borrow_mut().retain(|(id, _)| *id != self.0));
    }
}

/// Calls `listener` whenever a union on this thread is kept undecided — the reporting
/// backstop, which a validator holding every document its instance holds never takes.
pub fn watch_union_backstop(listener: impl Fn(UnionBackstop) + 'static) -> BackstopWatch {
    let id = NEXT_LISTENER.with(|next| {
        let id = next.get();
        next.set(id + 1);
        id
    });
    BACKSTOP_LISTENERS.with(|listeners| listeners.borrow_mut().push((id, Box::new(listener))));
    BackstopWatch(id)
}

fn took_backstop(reason: UnionBackstop) {
    BACKSTOP_LISTENERS.with(|listeners| {
        for (_, listener) in listeners.borrow().iter() {
            listener(reason);
        }
    });
}

/// Keywords refusing the value's SHAPE when raised at the union's own node.
const SHAPE_KEYWORDS: [&str; 4] = ["required", "type", "additionalProperties", "false schema"];

/// Keywords that discriminate.
const TAG_KEYWORDS: [&str; 2] = ["const", "enum"];

fn is_union(finding: &SchemaError) -> bool {
    finding.keyword == "anyOf" || finding.keyword == "oneOf"
}

fn node_id(node: Option<&Arc<JsonValue>>) -> String {
    node.map_or("-".into(), |node| (Arc::as_ptr(node) as usize).to_string())
}

/// What an enclosing branch reads of a union that reported a finding.
#[derive(Clone, Debug)]
struct Via {
    place: String,
    outcome: &'static str,
    /// For `alternatives`, what each alternative was described as.
    phrases: Option<Vec<String>>,
}

#[derive(Clone, Debug)]
struct Judged {
    finding: SchemaError,
    via: Option<Via>,
}

#[derive(Clone, Debug)]
struct UnionVerdict {
    reproduced: HashMap<String, usize>,
    report: Vec<Judged>,
}

/// The findings `errors` stands by, each union decided and each stand-in excused. `errors`
/// is the host's own validation of the judgment's value against its schema, every error
/// or only the first. An error is a validation that could not finish, as AJV's code throws.
pub fn judge_schema_findings(errors: &[SchemaError], judgment: &mut SchemaJudgment<'_>) -> Result<Vec<SchemaError>, String> {
    if errors.is_empty() {
        return Ok(Vec::new());
    }
    let rule = StandInRule::new(judgment.stand_ins.clone());
    let any_union = errors.iter().any(is_union);
    let located = if any_union { located_findings(errors, judgment)? } else { Some(errors.to_vec()) };
    if located.is_none() && any_union {
        took_backstop(UnionBackstop::NoLocatedTwin);
    }
    let judged = match located {
        Some(located) => FindingsJudge::new(judgment, &rule).judge(&located)?,
        None => without_type_consequences(errors)
            .into_iter()
            .filter_map(|finding| rule.standing(&finding, &judgment.value).map(|finding| Judged { finding, via: None }))
            .collect(),
    };
    Ok(judged.into_iter().map(|entry| plain_finding(entry.finding)).collect())
}

/// What makes a host's finding and its located twin one finding.
fn twin_key(finding: &SchemaError) -> String {
    [finding.keyword.clone(), finding.instance_path.clone(), finding.schema_path.clone(), json_stringify(Some(&finding.params))].join("\u{0}")
}

/// `errors` with the schema node behind each union: as given when every union names its
/// node, otherwise the located twins from the whole schema's validation — or that
/// validation's own findings where it does not raise every one of `errors`.
fn located_findings(errors: &[SchemaError], judgment: &mut SchemaJudgment<'_>) -> Result<Option<Vec<SchemaError>>, String> {
    if errors.iter().all(|error| !is_union(error) || error.parent_schema.is_some()) {
        return Ok(Some(errors.to_vec()));
    }
    let Some(whole) = (judgment.validate)(&judgment.schema, &mut judgment.value)? else { return Ok(None) };
    if whole.is_empty() {
        return Ok(None);
    }
    let mut owed: HashMap<String, usize> = HashMap::new();
    for error in errors {
        *owed.entry(twin_key(error)).or_default() += 1;
    }
    let twins: Vec<SchemaError> = whole
        .iter()
        .filter(|finding| {
            let count = owed.entry(twin_key(finding)).or_default();
            if *count == 0 {
                return false;
            }
            *count -= 1;
            true
        })
        .cloned()
        .collect();
    Ok(Some(if twins.len() == errors.len() { twins } else { whole }))
}

/// The fields a finding is rendered and anchored from, without the validator's references
/// into its schema and data.
fn plain_finding(mut finding: SchemaError) -> SchemaError {
    finding.schema = None;
    finding.parent_schema = None;
    finding.data = None;
    finding.property_name = None;
    finding
}

/// The schema node a keyword error was raised by: its schemaPath minus the keyword.
fn schema_node_of(error: &SchemaError) -> Option<&str> {
    error.schema_path.rfind('/').map(|cut| &error.schema_path[..cut])
}

/// Where one schema node refused a value's JSON TYPE, every other keyword that node raised
/// against the same value is a consequence of it.
fn without_type_consequences(errors: &[SchemaError]) -> Vec<SchemaError> {
    let typed: std::collections::HashSet<String> = errors
        .iter()
        .filter(|e| e.keyword == "type")
        .filter_map(|e| schema_node_of(e).map(|node| format!("{}\u{0}{node}", e.instance_path)))
        .collect();
    if typed.is_empty() {
        return errors.to_vec();
    }
    errors
        .iter()
        .filter(|e| {
            e.keyword == "type" || schema_node_of(e).is_none_or(|node| !typed.contains(&format!("{}\u{0}{node}", e.instance_path)))
        })
        .cloned()
        .collect()
}

/// The state a branch's judged findings put it in, for a union at `place`.
fn branch_state(judged: &[Judged], place: &str, candidate: bool, tags: &[String], selectors: &[String]) -> BranchState {
    if !candidate {
        return BranchState::TypeRefused;
    }
    if judged.is_empty() {
        return BranchState::Valid;
    }
    let mut at: Vec<String> = Vec::new();
    let mut shape_refused = false;
    for Judged { finding, via } in judged {
        let path = finding.instance_path.as_str();
        let keyword = finding.keyword.as_str();
        if via.as_ref().is_some_and(|via| via.place != place) {
            continue;
        }
        if via.as_ref().is_some_and(|via| via.outcome == "alternatives") {
            shape_refused = true;
        } else if via.as_ref().is_some_and(|via| via.outcome != "tag") {
            continue;
        } else if TAG_KEYWORDS.contains(&keyword) && tags.iter().any(|t| t == path) {
            if !at.iter().any(|p| p == path) {
                at.push(path.to_string());
            }
        } else if path == place && SHAPE_KEYWORDS.contains(&keyword) {
            shape_refused = true;
        } else if via.is_none() && TAG_KEYWORDS.contains(&keyword) && selectors.iter().any(|s| s == path) {
            shape_refused = true;
        }
    }
    if !at.is_empty() {
        return BranchState::TagRefused(at);
    }
    if shape_refused {
        BranchState::ShapeRefused
    } else {
        BranchState::Failing
    }
}

fn allowed_text(allowed: &[Value]) -> String {
    if allowed.len() <= LISTED_ENUM_VALUES {
        join_text(allowed, " | ")
    } else {
        format!("{} allowed values", allowed.len())
    }
}

/// How the alternatives at a union node are described, one phrase each.
fn describe_alternatives(judged: &[&Judged], place: &str, selectors: &[String]) -> Vec<String> {
    let mut phrases: Vec<String> = Vec::new();
    let mut add = |phrase: String| {
        if !phrases.contains(&phrase) {
            phrases.push(phrase);
        }
    };
    for Judged { finding: e, via } in judged.iter().copied() {
        let path = e.instance_path.as_str();
        if via.is_none() && TAG_KEYWORDS.contains(&e.keyword.as_str()) && selectors.iter().any(|s| s == path) {
            let member = path.get(place.len() + 1..).unwrap_or("");
            if e.keyword == "const" {
                add(format!("one with '{member}' equal to {}", json_stringify(e.params.get("allowedValue"))));
            } else {
                let allowed: &[Value] = e.params.get("allowedValues").and_then(Value::as_array).map_or(&[], Vec::as_slice);
                add(format!("one with '{member}' one of {}", allowed_text(allowed)));
            }
            continue;
        }
        if path != place {
            continue;
        }
        if let Some(Via { place: at, phrases: Some(own), .. }) = via {
            if at == place {
                for phrase in own {
                    add(phrase.clone());
                }
                continue;
            }
        }
        match e.keyword.as_str() {
            "required" => add(format!("one with '{}'", e.params.get("missingProperty").map_or("undefined".into(), crate::schema_error_report::js_string))),
            "type" => add(format!("a {}", e.params.get("type").map_or("undefined".into(), crate::schema_error_report::js_string))),
            "enum" => {
                let allowed: &[Value] = e.params.get("allowedValues").and_then(Value::as_array).map_or(&[], Vec::as_slice);
                add(format!("one of {}", allowed_text(allowed)));
            }
            _ => {}
        }
    }
    if phrases.is_empty() {
        vec!["another shape".into()]
    } else {
        phrases
    }
}

/// `includes` over JSON values: primitives by value, containers never.
fn includes(values: &[Value], value: &Value) -> bool {
    values.iter().any(|held| match (held, value) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(_), _) | (Value::Object(_), _) => false,
        _ => held == value,
    })
}

struct FindingsJudge<'j, 'a> {
    judgment: &'j SchemaJudgment<'a>,
    rule: &'j StandInRule,
    verdicts: HashMap<String, Option<UnionVerdict>>,
    readings: HashMap<String, UnionReading>,
}

impl<'j, 'a> FindingsJudge<'j, 'a> {
    fn new(judgment: &'j SchemaJudgment<'a>, rule: &'j StandInRule) -> Self {
        Self { judgment, rule, verdicts: HashMap::new(), readings: HashMap::new() }
    }

    fn finding_key(finding: &SchemaError) -> String {
        [
            finding.instance_path.clone(),
            finding.keyword.clone(),
            node_id(finding.parent_schema.as_ref()),
            json_stringify(Some(&finding.params)),
        ]
        .join("\u{0}")
    }

    /// `findings` with every union replaced by what it reports and everything else held to
    /// the stand-in rule, in place.
    fn judge(&mut self, findings: &[SchemaError]) -> Result<Vec<Judged>, String> {
        let list = without_type_consequences(findings);
        let mut live: Vec<Option<&SchemaError>> = list.iter().map(Some).collect();
        let mut reports: HashMap<usize, Vec<Judged>> = HashMap::new();
        let mut positions: Option<HashMap<String, Vec<usize>>> = None;
        for k in (0..list.len()).rev() {
            let Some(union) = live[k] else { continue };
            if !is_union(union) {
                continue;
            }
            let Some(verdict) = self.verdict_of(union)? else { continue };
            live[k] = None;
            reports.insert(k, verdict.report);
            let positions = positions.get_or_insert_with(|| {
                let mut out: HashMap<String, Vec<usize>> = HashMap::new();
                for (index, finding) in list.iter().enumerate() {
                    out.entry(Self::finding_key(finding)).or_default().push(index);
                }
                out
            });
            for (key, count) in &verdict.reproduced {
                let Some(at) = positions.get_mut(key) else { continue };
                while at.last().is_some_and(|last| *last >= k) {
                    at.pop();
                }
                for _ in 0..*count {
                    let Some(position) = at.pop() else { break };
                    live[position] = None;
                }
            }
        }
        let mut out = Vec::new();
        for (index, finding) in live.into_iter().enumerate() {
            if let Some(report) = reports.remove(&index) {
                out.extend(report);
            } else if let Some(finding) = finding {
                if let Some(kept) = self.rule.standing(finding, &self.judgment.value) {
                    out.push(Judged { finding: kept, via: None });
                }
            }
        }
        Ok(out)
    }

    /// A union decided once per (union node, value location).
    fn verdict_of(&mut self, union: &SchemaError) -> Result<Option<UnionVerdict>, String> {
        let (Some(node), Some(branches)) = (&union.parent_schema, union.schema.as_ref().filter(|s| matches!(&***s, JsonValue::Array(_)))) else {
            took_backstop(UnionBackstop::NodeUnheld);
            return Ok(None);
        };
        let place = union.instance_path.clone();
        let key = [node_id(Some(node)), union.keyword.clone(), place.clone()].join("\u{0}");
        if let Some(verdict) = self.verdicts.get(&key) {
            return Ok(verdict.clone());
        }
        self.verdicts.insert(key.clone(), None);
        let JsonValue::Array(branches) = &**branches else { unreachable!("filtered to a list") };
        let verdict = self.decide(union, node, branches, &place)?;
        self.verdicts.insert(key, verdict.clone());
        Ok(verdict)
    }

    fn reading_of(&mut self, node: &Arc<JsonValue>, keyword: &str, branches: &[Arc<JsonValue>], value: Option<&CelValue>) -> Result<UnionReading, ()> {
        let json_type = json_type_of(value);
        let key = [node_id(Some(node)), keyword.to_string(), json_type.to_string()].join("\u{0}");
        if let Some(reading) = self.readings.get(&key) {
            return Ok(reading.clone());
        }
        let reading = read_union(branches, json_type, self.judgment.reference, Some(node)).map_err(|_| ())?;
        self.readings.insert(key, reading.clone());
        Ok(reading)
    }

    fn decide(&mut self, union: &SchemaError, node: &Arc<JsonValue>, branches: &[Arc<JsonValue>], place: &str) -> Result<Option<UnionVerdict>, String> {
        let value = value_at(&self.judgment.value, place).cloned();
        let Ok(reading) = self.reading_of(node, &union.keyword, branches, value.as_ref()) else {
            // A reference the reader cannot follow leaves the union undecided.
            took_backstop(UnionBackstop::ReferenceUnreadable);
            return Ok(None);
        };
        let tags: Vec<String> = reading.tags.iter().map(|tag| format!("{place}{tag}")).collect();
        let selectors: Vec<String> = reading.selectors.iter().map(|selector| format!("{place}{selector}")).collect();
        let mut reproduced: HashMap<String, usize> = HashMap::new();
        let mut judged: Vec<Vec<Judged>> = Vec::new();
        for branch in branches {
            let Some(raised) = self.branch_findings(branch, value.as_ref(), place)? else {
                took_backstop(UnionBackstop::BranchUnheld);
                return Ok(None);
            };
            for finding in &raised {
                *reproduced.entry(Self::finding_key(finding)).or_default() += 1;
            }
            judged.push(self.judge(&raised)?);
        }
        let states: Vec<BranchState> =
            judged.iter().enumerate().map(|(i, entries)| branch_state(entries, place, reading.candidate[i], &tags, &selectors)).collect();
        let outcome = union_outcome(union.keyword == "oneOf", &states);
        Ok(Some(UnionVerdict { reproduced, report: self.report(&outcome, union, &judged, place, &selectors) }))
    }

    /// What `branch` raises against `value` on its own, located at `place`.
    fn branch_findings(&self, branch: &Arc<JsonValue>, value: Option<&CelValue>, place: &str) -> Result<Option<Vec<SchemaError>>, String> {
        match &**branch {
            JsonValue::Bool(true) => return Ok(Some(Vec::new())),
            JsonValue::Bool(false) => {
                return Ok(Some(vec![SchemaError {
                    keyword: "false schema".into(),
                    instance_path: place.to_string(),
                    schema_path: String::new(),
                    params: serde_json::json!({}),
                    message: "boolean schema is false".into(),
                    property_name: None,
                    schema: None,
                    parent_schema: None,
                    data: None,
                }]));
            }
            JsonValue::Object(_) => {}
            _ => return Ok(None),
        }
        let mut held = value.cloned().unwrap_or(CelValue::Null);
        let Some(raised) = (self.judgment.validate)(branch, &mut held)? else { return Ok(None) };
        Ok(Some(
            raised
                .into_iter()
                .map(|mut finding| {
                    finding.instance_path = format!("{place}{}", finding.instance_path);
                    finding
                })
                .collect(),
        ))
    }

    /// The findings an outcome reports, each marked as a union's.
    fn report(&self, outcome: &UnionOutcome, union: &SchemaError, judged: &[Vec<Judged>], place: &str, selectors: &[String]) -> Vec<Judged> {
        let via = Via { place: place.to_string(), outcome: outcome.kind(), phrases: None };
        let reported = |finding: SchemaError| Judged { finding, via: Some(via.clone()) };
        match outcome {
            UnionOutcome::Pass => Vec::new(),
            UnionOutcome::Ambiguous => {
                if is_ambiguous_one_of(union) && !self.rule.excused(union) {
                    vec![reported(union.clone())]
                } else {
                    Vec::new()
                }
            }
            UnionOutcome::Branches(branches) => {
                let mut seen = std::collections::HashSet::new();
                let mut out = Vec::new();
                for index in branches {
                    for entry in &judged[*index] {
                        let text = format!("{}\u{0}{}", entry.finding.instance_path, format_single_error(&entry.finding));
                        if seen.insert(text) {
                            out.push(reported(entry.finding.clone()));
                        }
                    }
                }
                out
            }
            UnionOutcome::Tag { at, branches } => {
                let mut allowed: Vec<Value> = Vec::new();
                for index in branches {
                    for Judged { finding, via } in &judged[*index] {
                        if via.as_ref().is_some_and(|via| via.place != place || via.outcome != "tag") || finding.instance_path != *at {
                            continue;
                        }
                        let values: Vec<Value> = match finding.keyword.as_str() {
                            "const" => vec![finding.params.get("allowedValue").cloned().unwrap_or(Value::Null)],
                            "enum" => finding.params.get("allowedValues").and_then(Value::as_array).cloned().unwrap_or_default(),
                            _ => Vec::new(),
                        };
                        for value in values {
                            if !includes(&allowed, &value) {
                                allowed.push(value);
                            }
                        }
                    }
                }
                let mut finding = union.clone();
                finding.data = None;
                finding.keyword = "enum".into();
                finding.instance_path = at.clone();
                finding.params = serde_json::json!({ "allowedValues": allowed });
                finding.message = "must be equal to one of the allowed values".into();
                vec![reported(finding)]
            }
            UnionOutcome::Alternatives => {
                let flat: Vec<&Judged> = judged.iter().flatten().collect();
                let phrases = describe_alternatives(&flat, place, selectors);
                let mut finding = union.clone();
                finding.instance_path = place.to_string();
                finding.message = format!("matches no alternative — expected {}", phrases.join(", or "));
                vec![Judged { finding, via: Some(Via { phrases: Some(phrases), ..via }) }]
            }
        }
    }
}
