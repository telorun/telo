//! Console markup language — chalk-template-style `{style content}` syntax.
//!
//!   {red error}                      red text "error"
//!   {red.bold ERROR}                 red bold "ERROR"
//!   {red.bgWhite warning}            red on white "warning"
//!   {#ff8800 highlight}              hex foreground
//!   hi {red {bold WORLD}!}           nested
//!   literal: \{red\} not a tag       escaped braces
//!
//! Render modes: ANSI SGR for TTY, plain text (markup stripped) otherwise.
//!
//! Port of `../../nodejs/src/markup.ts`, carrying its limitations verbatim:
//! same-axis nesting reverts to the terminal default rather than the parent's
//! value, and an unknown style renders its whole tag as literal text.

enum Node {
    Literal(String),
    Styled {
        styles: Vec<String>,
        children: Vec<Node>,
        /// Verbatim source slice from `{` through the matching `}`, captured at
        /// parse time so the unknown-style fallback can emit the original tag
        /// without re-rendering children — which would honour known styles
        /// inside an unknown wrapper.
        raw: String,
    },
}

struct SgrPair {
    open: String,
    close: String,
}

fn color_fg(name: &str) -> Option<u8> {
    Some(match name {
        "black" => 30,
        "red" => 31,
        "green" => 32,
        "yellow" => 33,
        "blue" => 34,
        "magenta" => 35,
        "cyan" => 36,
        "white" => 37,
        "gray" | "grey" | "brightBlack" => 90,
        "brightRed" => 91,
        "brightGreen" => 92,
        "brightYellow" => 93,
        "brightBlue" => 94,
        "brightMagenta" => 95,
        "brightCyan" => 96,
        "brightWhite" => 97,
        _ => return None,
    })
}

fn color_bg(name: &str) -> Option<u8> {
    Some(match name {
        "black" => 40,
        "red" => 41,
        "green" => 42,
        "yellow" => 43,
        "blue" => 44,
        "magenta" => 45,
        "cyan" => 46,
        "white" => 47,
        "gray" | "grey" | "brightBlack" => 100,
        "brightRed" => 101,
        "brightGreen" => 102,
        "brightYellow" => 103,
        "brightBlue" => 104,
        "brightMagenta" => 105,
        "brightCyan" => 106,
        "brightWhite" => 107,
        _ => return None,
    })
}

fn attribute(name: &str) -> Option<(u8, u8)> {
    Some(match name {
        "bold" => (1, 22),
        "dim" => (2, 22),
        "italic" => (3, 23),
        "underline" => (4, 24),
        "reverse" => (7, 27),
        "strikethrough" => (9, 29),
        _ => return None,
    })
}

/// Parse `RRGGBB` into its three components. Any other length or a non-hex
/// digit yields `None`, which sends the tag down the literal path.
fn parse_hex(hex: &str) -> Option<(u8, u8, u8)> {
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let component = |range: std::ops::Range<usize>| u8::from_str_radix(&hex[range], 16).ok();
    Some((component(0..2)?, component(2..4)?, component(4..6)?))
}

fn style_to_sgr(style: &str) -> Option<SgrPair> {
    if let Some(hex) = style.strip_prefix('#') {
        let (r, g, b) = parse_hex(hex)?;
        return Some(SgrPair {
            open: format!("\x1b[38;2;{r};{g};{b}m"),
            close: "\x1b[39m".to_string(),
        });
    }

    if let Some(hex) = style.strip_prefix("bg#") {
        let (r, g, b) = parse_hex(hex)?;
        return Some(SgrPair {
            open: format!("\x1b[48;2;{r};{g};{b}m"),
            close: "\x1b[49m".to_string(),
        });
    }

    if let Some(rest) = style.strip_prefix("bg") {
        if !rest.is_empty() {
            let mut chars = rest.chars();
            let head: String = chars.next().unwrap().to_lowercase().collect();
            let color_name = format!("{head}{}", chars.as_str());
            if let Some(code) = color_bg(&color_name) {
                return Some(SgrPair {
                    open: format!("\x1b[{code}m"),
                    close: "\x1b[49m".to_string(),
                });
            }
        }
    }

    if let Some(code) = color_fg(style) {
        return Some(SgrPair {
            open: format!("\x1b[{code}m"),
            close: "\x1b[39m".to_string(),
        });
    }

    attribute(style).map(|(open, close)| SgrPair {
        open: format!("\x1b[{open}m"),
        close: format!("\x1b[{close}m"),
    })
}

fn is_style_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '#'
}

/// Character-indexed cursor. The TypeScript original indexes by UTF-16 code
/// unit; working over `char`s keeps multi-byte content from splitting mid-scalar
/// while preserving the same tag grammar.
struct ParseState {
    input: Vec<char>,
    pos: usize,
}

impl ParseState {
    fn slice(&self, start: usize, end: usize) -> String {
        self.input[start..end].iter().collect()
    }
}

fn append_literal(nodes: &mut Vec<Node>, text: &str) {
    if text.is_empty() {
        return;
    }
    if let Some(Node::Literal(last)) = nodes.last_mut() {
        last.push_str(text);
        return;
    }
    nodes.push(Node::Literal(text.to_string()));
}

fn try_parse_styles(state: &mut ParseState) -> Option<Vec<String>> {
    let start = state.pos;
    let mut styles: Vec<String> = Vec::new();
    let mut current = String::new();
    while state.pos < state.input.len() {
        let c = state.input[state.pos];
        if c == '.' {
            if current.is_empty() {
                state.pos = start;
                return None;
            }
            styles.push(std::mem::take(&mut current));
            state.pos += 1;
            continue;
        }
        if c == ' ' {
            if !current.is_empty() {
                styles.push(current);
            }
            return if styles.is_empty() { None } else { Some(styles) };
        }
        if is_style_char(c) {
            current.push(c);
            state.pos += 1;
            continue;
        }
        state.pos = start;
        return None;
    }
    state.pos = start;
    None
}

fn parse_nodes(state: &mut ParseState, stop_at_close_tag: bool) -> (Vec<Node>, bool) {
    let mut nodes: Vec<Node> = Vec::new();
    while state.pos < state.input.len() {
        let ch = state.input[state.pos];

        if stop_at_close_tag && ch == '}' {
            state.pos += 1;
            return (nodes, true);
        }

        if ch == '\\' && state.pos + 1 < state.input.len() {
            let next = state.input[state.pos + 1];
            if next == '{' || next == '}' || next == '\\' {
                append_literal(&mut nodes, &next.to_string());
                state.pos += 2;
                continue;
            }
        }

        if ch == '{' {
            let tag_start = state.pos;
            state.pos += 1;
            let styles = try_parse_styles(state);
            if let Some(styles) = styles {
                if state.pos < state.input.len() && state.input[state.pos] == ' ' {
                    state.pos += 1;
                    let (children, ok) = parse_nodes(state, true);
                    if ok {
                        let raw = state.slice(tag_start, state.pos);
                        nodes.push(Node::Styled {
                            styles,
                            children,
                            raw,
                        });
                        continue;
                    }
                }
            }
            // Malformed tag — fall back to literal.
            let literal = state.slice(tag_start, state.pos);
            append_literal(&mut nodes, &literal);
            continue;
        }

        append_literal(&mut nodes, &ch.to_string());
        state.pos += 1;
    }

    (nodes, !stop_at_close_tag)
}

fn parse(input: &str) -> Vec<Node> {
    let mut state = ParseState {
        input: input.chars().collect(),
        pos: 0,
    };
    parse_nodes(&mut state, false).0
}

fn render_nodes(nodes: &[Node], is_tty: bool) -> String {
    nodes.iter().map(|node| render_node(node, is_tty)).collect()
}

fn render_node(node: &Node, is_tty: bool) -> String {
    match node {
        Node::Literal(text) => text.clone(),
        Node::Styled {
            styles,
            children,
            raw,
        } => {
            let pairs: Vec<Option<SgrPair>> = styles.iter().map(|s| style_to_sgr(s)).collect();
            if pairs.iter().any(|p| p.is_none()) {
                return raw.clone();
            }
            if !is_tty {
                return render_nodes(children, is_tty);
            }
            let pairs: Vec<&SgrPair> = pairs.iter().map(|p| p.as_ref().unwrap()).collect();
            let opens: String = pairs.iter().map(|p| p.open.as_str()).collect();
            let closes: String = pairs.iter().rev().map(|p| p.close.as_str()).collect();
            format!("{opens}{}{closes}", render_nodes(children, is_tty))
        }
    }
}

/// Render a markup string. TTY → ANSI SGR codes; non-TTY → plain text.
pub fn render(input: &str, is_tty: bool) -> String {
    render_nodes(&parse(input), is_tty)
}

#[cfg(test)]
mod tests {
    use super::render;

    /// Cases mirrored from `modules/console/tests/markup-smoke.yaml`, which
    /// exercises the TypeScript controller against the same grammar.
    #[test]
    fn strips_markup_when_not_a_tty() {
        assert_eq!(render("{green hello}", false), "hello");
        assert_eq!(render("hi {red {bold WORLD}!}", false), "hi WORLD!");
        assert_eq!(render("{#ff8800 highlight}", false), "highlight");
    }

    #[test]
    fn emits_sgr_pairs_on_a_tty() {
        assert_eq!(render("{green hello}", true), "\x1b[32mhello\x1b[39m");
        assert_eq!(
            render("{red.bold ERROR}", true),
            "\x1b[31m\x1b[1mERROR\x1b[22m\x1b[39m"
        );
        assert_eq!(
            render("{bgWhite warning}", true),
            "\x1b[47mwarning\x1b[49m"
        );
        assert_eq!(
            render("{#ff8800 highlight}", true),
            "\x1b[38;2;255;136;0mhighlight\x1b[39m"
        );
    }

    #[test]
    fn escaped_braces_are_literal() {
        assert_eq!(render("literal: \\{red\\} not a tag", true), "literal: {red} not a tag");
    }

    /// A foreground+background chain is the case where the close sequence must
    /// be emitted in reverse order — the path most likely to regress.
    #[test]
    fn a_style_chain_closes_in_reverse_order() {
        assert_eq!(
            render("{red.bgWhite warning}", true),
            "\x1b[31m\x1b[47mwarning\x1b[49m\x1b[39m"
        );
    }

    #[test]
    fn unknown_style_renders_its_tag_verbatim() {
        assert_eq!(render("{notAStyle hi}", true), "{notAStyle hi}");
        // Known styles inside an unknown wrapper stay literal too.
        assert_eq!(render("{notAStyle {red hi}}", true), "{notAStyle {red hi}}");
        // One unknown entry poisons the whole chain, known siblings included.
        assert_eq!(
            render("{red.notARealAttr text}", true),
            "{red.notARealAttr text}"
        );
    }

    #[test]
    fn unterminated_tag_falls_back_to_literal() {
        assert_eq!(render("{red unterminated", true), "{red unterminated");
        assert_eq!(render("plain {} text", true), "plain {} text");
    }
}
