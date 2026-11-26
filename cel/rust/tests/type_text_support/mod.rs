//! A nested type as a check prints it: whole up to `TYPE_TEXT_NODE_LIMIT` type nodes, then
//! cut with `...`, every open bracket closed — the limit read from the data both engines read.

#![allow(dead_code)]

/// The limit, as `cel/nodejs/src/type-text.json` declares it.
pub fn type_text_node_limit() -> usize {
    let data = include_str!("../../../nodejs/src/type-text.json");
    let digits: String = data.chars().skip_while(|c| !c.is_ascii_digit()).take_while(char::is_ascii_digit).collect();
    digits.parse().expect("the limit's data holds a number")
}

/// `open` repeated `depth` times around `inner`, each level writing `per_level` type nodes and
/// `inner` writing `inner_nodes`, as printed: whole within the limit, else cut where the node
/// past it falls at a level's start.
pub fn printed_nested(open: &str, per_level: usize, inner: &str, inner_nodes: usize, close: &str, depth: usize) -> String {
    let limit = type_text_node_limit();
    if per_level * depth + inner_nodes <= limit {
        return format!("{}{inner}{}", open.repeat(depth), close.repeat(depth));
    }
    assert!(limit % per_level == 0 && per_level * depth >= limit, "the cut falls at a level's start");
    let levels = limit / per_level;
    format!("{}...{}", open.repeat(levels), close.repeat(levels))
}
