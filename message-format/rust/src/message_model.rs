//! The message model: what a Message is once read. A pattern is a list of parts —
//! literal text (never empty, never two in a row) and placeholders; a plural selection
//! keeps its cases in the order they were written, `other` always among them.

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum PluralCategory {
    Zero,
    One,
    Two,
    Few,
    Many,
    Other,
}

pub const PLURAL_CATEGORIES: [PluralCategory; 6] = [
    PluralCategory::Zero,
    PluralCategory::One,
    PluralCategory::Two,
    PluralCategory::Few,
    PluralCategory::Many,
    PluralCategory::Other,
];

impl PluralCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            PluralCategory::Zero => "zero",
            PluralCategory::One => "one",
            PluralCategory::Two => "two",
            PluralCategory::Few => "few",
            PluralCategory::Many => "many",
            PluralCategory::Other => "other",
        }
    }

    pub fn from_key(key: &str) -> Option<PluralCategory> {
        PLURAL_CATEGORIES.into_iter().find(|category| category.as_str() == key)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PatternPart {
    Text(String),
    Placeholder(String),
}

pub type Pattern = Vec<PatternPart>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluralSelection {
    pub plural: String,
    /// Each case key — a category or a canonical `=N` — with its message, as written.
    pub cases: Vec<(String, Message)>,
}

impl PluralSelection {
    pub fn case(&self, key: &str) -> Option<&Message> {
        self.cases.iter().find(|(name, _)| name == key).map(|(_, message)| message)
    }

    pub fn other(&self) -> &Message {
        self.case("other").expect("a read selection has an other case")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Message {
    Pattern(Pattern),
    Selection(PluralSelection),
}

/// A Message with the context that tells it apart from the same words used elsewhere.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Text {
    pub message: Message,
    pub context: Option<String>,
}
