//! Builds the concrete syntax tree from the lexer's tokens — a twin of `yaml@2.8.3`'s
//! `dist/parse/parser.js` (with its `LineCounter`, `dist/parse/line-counter.js`, as the
//! newline callback it is handed).
//!
//! No Telo twin (see `yaml_cst.rs`). Every method is the one of the same name. Where the
//! original pops and steps again at a method's end — once per collection the token closes —
//! the method returns `true` and `step` loops, and `pop`'s fallback of popping the top before
//! the token is a work list, so nothing here recurses on the input's depth.

use crate::yaml_cst::{
    is_flow_kind, token_type, BlockScalarProp, CollectionItem, FlowScalarType, Kind, SourceToken, Src, Token,
    TokenId, TokenType, Units,
};

fn includes_token(list: &[SourceToken], ty: TokenType) -> bool {
    list.iter().any(|token| token.ty == ty)
}

fn find_non_empty_index(list: &[SourceToken]) -> Option<usize> {
    list.iter().position(|token| !matches!(token.ty, TokenType::Space | TokenType::Comment | TokenType::Newline))
}

/// `getFirstKeyStartProps`: the props after the last indicator or line break of `prev`,
/// spliced out of it.
fn first_key_start_props(prev: &mut Vec<SourceToken>) -> Vec<SourceToken> {
    if prev.is_empty() {
        return Vec::new();
    }
    let mut i = prev.len() as i64;
    loop {
        i -= 1;
        if i < 0 {
            break;
        }
        if matches!(
            prev[i as usize].ty,
            TokenType::DocStart | TokenType::ExplicitKeyInd | TokenType::MapValueInd | TokenType::SeqItemInd | TokenType::Newline
        ) {
            break;
        }
    }
    loop {
        i += 1;
        if prev.get(i as usize).map(|token| token.ty) != Some(TokenType::Space) {
            break;
        }
    }
    let at = (i as usize).min(prev.len());
    prev.split_off(at)
}

pub struct Parser<'s> {
    units: Units<'s>,
    pub arena: Vec<Token>,
    at_new_line: bool,
    at_scalar: bool,
    indent: usize,
    offset: usize,
    on_key_line: bool,
    stack: Vec<TokenId>,
    source: Src,
    ty: TokenType,
    /// The offset each line starts at, as the `LineCounter` records them.
    pub line_starts: Vec<usize>,
}

impl<'s> Parser<'s> {
    pub fn new(text: &'s [u16]) -> Self {
        Self {
            units: Units { text },
            arena: Vec::new(),
            at_new_line: true,
            at_scalar: false,
            indent: 0,
            offset: 0,
            on_key_line: false,
            stack: Vec::new(),
            source: Src::EMPTY,
            ty: TokenType::Newline,
            // `parse()` reports the start of the input before any token.
            line_starts: vec![0],
        }
    }

    /// Whether every token the parser built has been yielded: the arena may be cleared once
    /// they are read.
    pub fn is_idle(&self) -> bool {
        self.stack.is_empty()
    }

    fn push(&mut self, token: Token) -> TokenId {
        self.arena.push(token);
        self.arena.len() - 1
    }

    fn on_new_line(&mut self, offset: usize) {
        self.line_starts.push(offset);
    }

    fn source_token(&self) -> SourceToken {
        SourceToken { ty: self.ty, offset: self.offset, indent: self.indent, source: self.source }
    }

    fn error(&mut self, message: String) -> TokenId {
        self.push(Token::Error { offset: self.offset, message, source: self.source })
    }

    /// Advance by one lexical token, pushing every top-level token it completes.
    pub fn next(&mut self, source: Src, out: &mut Vec<TokenId>) {
        self.source = source;
        if self.at_scalar {
            self.at_scalar = false;
            self.step(out);
            self.offset += source.len();
            return;
        }
        match token_type(self.units.of(source)) {
            None => {
                let message = format!("Not a YAML token: {}", self.units.string(source));
                let error = self.error(message);
                self.pop(Some(error), out);
                self.offset += source.len();
            }
            Some(TokenType::Scalar) => {
                self.at_new_line = false;
                self.at_scalar = true;
                self.ty = TokenType::Scalar;
            }
            Some(ty) => {
                self.ty = ty;
                self.step(out);
                match ty {
                    TokenType::Newline => {
                        self.at_new_line = true;
                        self.indent = 0;
                        self.on_new_line(self.offset + source.len());
                    }
                    TokenType::Space => {
                        if self.at_new_line && self.units.of(source).first() == Some(&(b' ' as u16)) {
                            self.indent += source.len();
                        }
                    }
                    TokenType::ExplicitKeyInd | TokenType::MapValueInd | TokenType::SeqItemInd => {
                        if self.at_new_line {
                            self.indent += source.len();
                        }
                    }
                    TokenType::DocMode | TokenType::FlowErrorEnd => return,
                    _ => self.at_new_line = false,
                }
                self.offset += source.len();
            }
        }
    }

    /// Push out what remains at the end of the input.
    pub fn end(&mut self, out: &mut Vec<TokenId>) {
        while !self.stack.is_empty() {
            self.pop(None, out);
        }
    }

    fn kind(&self, id: TokenId) -> Kind {
        self.arena[id].kind()
    }

    fn step(&mut self, out: &mut Vec<TokenId>) {
        loop {
            let top = self.stack.last().copied();
            if self.ty == TokenType::DocEnd && top.map(|top| self.kind(top)) != Some(Kind::DocEnd) {
                while !self.stack.is_empty() {
                    self.pop(None, out);
                }
                let doc_end = self.push(Token::DocEnd { offset: self.offset, source: self.source, end: None });
                self.stack.push(doc_end);
                return;
            }
            let Some(top) = top else {
                self.stream(out);
                return;
            };
            let again = match self.kind(top) {
                Kind::Document => self.document(top, out),
                Kind::FlowScalar(_) => self.scalar(top, out),
                Kind::BlockScalar => self.block_scalar(top, out),
                Kind::BlockMap => self.block_map(top, out),
                Kind::BlockSeq => self.block_sequence(top, out),
                Kind::FlowCollection => self.flow_collection(top, out),
                Kind::DocEnd => self.document_end(top, out),
                _ => {
                    self.pop(None, out);
                    return;
                }
            };
            if !again {
                return;
            }
            self.pop(None, out);
        }
    }

    fn peek(&self, n: usize) -> Option<TokenId> {
        self.stack.len().checked_sub(n).map(|i| self.stack[i])
    }

    fn pop(&mut self, error: Option<TokenId>, out: &mut Vec<TokenId>) {
        let first = match error {
            Some(error) => error,
            None => match self.stack.pop() {
                Some(token) => token,
                None => {
                    let error = self.push(Token::Error {
                        offset: self.offset,
                        message: "Tried to pop an empty stack".to_string(),
                        source: Src::EMPTY,
                    });
                    out.push(error);
                    return;
                }
            },
        };
        let mut pending = vec![first];
        while let Some(token) = pending.pop() {
            let Some(top) = self.stack.last().copied() else {
                out.push(token);
                continue;
            };
            let top_kind = self.kind(top);
            let token_kind = self.kind(token);
            if token_kind == Kind::BlockScalar {
                // Block scalars use their parent rather than header indent.
                let indent = self.arena[top].indent().unwrap_or(0);
                if let Token::BlockScalar { indent: own, .. } = &mut self.arena[token] {
                    *own = indent;
                }
            } else if token_kind == Kind::FlowCollection && top_kind == Kind::Document {
                // Ignore all indent for top-level flow collections.
                if let Token::FlowCollection { indent, .. } = &mut self.arena[token] {
                    *indent = 0;
                }
            }
            if token_kind == Kind::FlowCollection {
                self.fix_flow_seq_items(token);
            }
            match &mut self.arena[top] {
                Token::Document { value, .. } => *value = Some(token),
                Token::BlockScalar { props, .. } => props.push(BlockScalarProp::Token(token)),
                Token::BlockMap { items, .. } => {
                    let it = items.last_mut().expect("a block map holds an item");
                    if it.value.is_some() {
                        items.push(CollectionItem { key: Some(token), sep: Some(Vec::new()), ..Default::default() });
                        self.on_key_line = true;
                        continue;
                    } else if it.sep.is_some() {
                        it.value = Some(token);
                    } else {
                        it.key = Some(token);
                        it.sep = Some(Vec::new());
                        self.on_key_line = !it.explicit_key;
                        continue;
                    }
                }
                Token::BlockSeq { items, .. } => {
                    let it = items.last_mut().expect("a block sequence holds an item");
                    if it.value.is_some() {
                        items.push(CollectionItem { value: Some(token), ..Default::default() });
                    } else {
                        it.value = Some(token);
                    }
                }
                Token::FlowCollection { items, .. } => {
                    match items.last_mut() {
                        Some(it) if it.value.is_none() => {
                            if it.sep.is_some() {
                                it.value = Some(token);
                            } else {
                                it.key = Some(token);
                                it.sep = Some(Vec::new());
                            }
                        }
                        _ => items.push(CollectionItem { key: Some(token), sep: Some(Vec::new()), ..Default::default() }),
                    }
                    continue;
                }
                _ => {
                    let popped = self.stack.pop().expect("the top");
                    pending.push(token);
                    pending.push(popped);
                    continue;
                }
            }
            if matches!(top_kind, Kind::Document | Kind::BlockMap | Kind::BlockSeq)
                && matches!(token_kind, Kind::BlockMap | Kind::BlockSeq)
            {
                let token_indent = self.arena[token].indent().unwrap_or(0);
                let moved = {
                    let items = self.arena[token].items().expect("a collection");
                    match items.last() {
                        Some(last)
                            if last.sep.is_none()
                                && last.value.is_none()
                                && !last.start.is_empty()
                                && find_non_empty_index(&last.start).is_none()
                                && (token_indent == 0
                                    || last.start.iter().all(|st| st.ty != TokenType::Comment || st.indent < token_indent)) =>
                        {
                            true
                        }
                        _ => false,
                    }
                };
                if moved {
                    let last = self.arena[token].items_mut().expect("a collection").pop().expect("an item");
                    match &mut self.arena[top] {
                        Token::Document { end, .. } => *end = Some(last.start),
                        other => other
                            .items_mut()
                            .expect("a collection")
                            .push(CollectionItem { start: last.start, ..Default::default() }),
                    }
                }
            }
        }
    }

    fn stream(&mut self, out: &mut Vec<TokenId>) {
        match self.ty {
            TokenType::DirectiveLine => {
                let directive = self.push(Token::Directive { offset: self.offset, source: self.source });
                out.push(directive);
            }
            TokenType::ByteOrderMark | TokenType::Space | TokenType::Comment | TokenType::Newline => {
                let token = self.push(Token::Source(self.source_token()));
                out.push(token);
            }
            TokenType::DocMode | TokenType::DocStart => {
                let mut start = Vec::new();
                if self.ty == TokenType::DocStart {
                    start.push(self.source_token());
                }
                let doc = self.push(Token::Document { offset: self.offset, start, value: None, end: None });
                self.stack.push(doc);
            }
            _ => {
                let error = self.error(format!("Unexpected {} token in YAML stream", self.ty.name()));
                out.push(error);
            }
        }
    }

    fn document(&mut self, doc: TokenId, out: &mut Vec<TokenId>) -> bool {
        let Token::Document { value, start, .. } = &self.arena[doc] else { unreachable!("a document") };
        if value.is_some() {
            return self.line_end(doc, out);
        }
        match self.ty {
            TokenType::DocStart => {
                if find_non_empty_index(start).is_some() {
                    return true;
                }
                let token = self.source_token();
                if let Token::Document { start, .. } = &mut self.arena[doc] {
                    start.push(token);
                }
                return false;
            }
            TokenType::Anchor | TokenType::Tag | TokenType::Space | TokenType::Comment | TokenType::Newline => {
                let token = self.source_token();
                if let Token::Document { start, .. } = &mut self.arena[doc] {
                    start.push(token);
                }
                return false;
            }
            _ => {}
        }
        match self.start_block_value(doc) {
            Some(value) => self.stack.push(value),
            None => {
                let error = self.error(format!("Unexpected {} token in YAML document", self.ty.name()));
                out.push(error);
            }
        }
        false
    }

    fn scalar(&mut self, scalar: TokenId, out: &mut Vec<TokenId>) -> bool {
        if self.ty != TokenType::MapValueInd {
            return self.line_end(scalar, out);
        }
        let parent = self.peek(2).expect("a scalar has a parent");
        let start = self.take_prev_first_key_start_props(parent);
        let token = self.source_token();
        let Token::FlowScalar { end, offset, indent, .. } = &mut self.arena[scalar] else { unreachable!("a scalar") };
        let sep = match end.take() {
            Some(mut sep) => {
                sep.push(token);
                sep
            }
            None => vec![token],
        };
        let map = Token::BlockMap {
            offset: *offset,
            indent: *indent,
            items: vec![CollectionItem { start, key: Some(scalar), sep: Some(sep), ..Default::default() }],
        };
        self.on_key_line = true;
        let map = self.push(map);
        *self.stack.last_mut().expect("the scalar") = map;
        false
    }

    fn block_scalar(&mut self, scalar: TokenId, out: &mut Vec<TokenId>) -> bool {
        match self.ty {
            TokenType::Space | TokenType::Comment | TokenType::Newline => {
                let token = self.source_token();
                if let Token::BlockScalar { props, .. } = &mut self.arena[scalar] {
                    props.push(BlockScalarProp::Source(token));
                }
                false
            }
            TokenType::Scalar => {
                let source = self.source;
                if let Token::BlockScalar { source: own, .. } = &mut self.arena[scalar] {
                    *own = source;
                }
                // A block scalar's source includes its trailing newline.
                self.at_new_line = true;
                self.indent = 0;
                self.report_newlines(source);
                self.pop(None, out);
                false
            }
            _ => true,
        }
    }

    fn report_newlines(&mut self, source: Src) {
        let units = self.units.of(source);
        for (i, unit) in units.iter().enumerate() {
            if *unit == b'\n' as u16 {
                self.line_starts.push(self.offset + i + 1);
            }
        }
    }

    /// `'end' in token ? token.end : undefined`, as an array.
    fn end_list(&mut self, id: TokenId) -> Option<&mut Vec<SourceToken>> {
        match &mut self.arena[id] {
            Token::FlowScalar { end, .. } => end.as_mut(),
            Token::FlowCollection { end, .. } => Some(end),
            _ => None,
        }
    }

    /// `getFirstKeyStartProps(getPrevProps(parent))`.
    fn take_prev_first_key_start_props(&mut self, parent: TokenId) -> Vec<SourceToken> {
        match &mut self.arena[parent] {
            Token::Document { start, .. } => first_key_start_props(start),
            Token::BlockMap { items, .. } => match items.last_mut() {
                Some(it) => match it.sep.as_mut() {
                    Some(sep) => first_key_start_props(sep),
                    None => first_key_start_props(&mut it.start),
                },
                None => Vec::new(),
            },
            Token::BlockSeq { items, .. } => match items.last_mut() {
                Some(it) => first_key_start_props(&mut it.start),
                None => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    fn block_map(&mut self, map: TokenId, out: &mut Vec<TokenId>) -> bool {
        let st = self.source_token();
        let map_indent = self.arena[map].indent().unwrap_or(0);
        let li = self.arena[map].items().expect("a map").len() - 1;
        let (it_value, it_has_sep, it_explicit) = {
            let it = &self.arena[map].items().expect("a map")[li];
            (it.value, it.sep.is_some(), it.explicit_key)
        };
        macro_rules! items {
            () => {
                self.arena[map].items_mut().expect("a map")
            };
        }
        match self.ty {
            TokenType::Newline => {
                self.on_key_line = false;
                if let Some(value) = it_value {
                    let pushed = match self.end_list(value) {
                        Some(end) if end.last().map(|t| t.ty) == Some(TokenType::Comment) => {
                            end.push(st);
                            true
                        }
                        _ => false,
                    };
                    if !pushed {
                        items!().push(CollectionItem { start: vec![st], ..Default::default() });
                    }
                } else if it_has_sep {
                    items!()[li].sep.as_mut().expect("a sep").push(st);
                } else {
                    items!()[li].start.push(st);
                }
                return false;
            }
            TokenType::Space | TokenType::Comment => {
                if it_value.is_some() {
                    items!().push(CollectionItem { start: vec![st], ..Default::default() });
                } else if it_has_sep {
                    items!()[li].sep.as_mut().expect("a sep").push(st);
                } else {
                    let start = items!()[li].start.clone();
                    if self.at_indented_comment(&start, map_indent) {
                        let prev_value = if li >= 1 { items!()[li - 1].value } else { None };
                        if let Some(prev_value) = prev_value {
                            let start = items!()[li].start.clone();
                            if let Some(end) = self.end_list(prev_value) {
                                end.extend(start);
                                end.push(st);
                                items!().pop();
                                return false;
                            }
                        }
                    }
                    items!()[li].start.push(st);
                }
                return false;
            }
            _ => {}
        }
        if self.indent >= map_indent {
            let at_map_indent = !self.on_key_line && self.indent == map_indent;
            let at_next_item = at_map_indent && (it_has_sep || it_explicit) && self.ty != TokenType::SeqItemInd;
            // For empty nodes, newline-separated, not indented empty tokens go to the next node.
            let mut start: Vec<SourceToken> = Vec::new();
            if at_next_item && it_has_sep && it_value.is_none() {
                let sep = items!()[li].sep.as_mut().expect("a sep");
                let mut nl: Vec<usize> = Vec::new();
                for (i, token) in sep.iter().enumerate() {
                    match token.ty {
                        TokenType::Newline => nl.push(i),
                        TokenType::Space => {}
                        TokenType::Comment => {
                            if token.indent > map_indent {
                                nl.clear();
                            }
                        }
                        _ => nl.clear(),
                    }
                }
                if nl.len() >= 2 {
                    start = sep.split_off(nl[1]);
                }
            }
            match self.ty {
                TokenType::Anchor | TokenType::Tag => {
                    if at_next_item || it_value.is_some() {
                        start.push(st);
                        items!().push(CollectionItem { start, ..Default::default() });
                        self.on_key_line = true;
                    } else if it_has_sep {
                        items!()[li].sep.as_mut().expect("a sep").push(st);
                    } else {
                        items!()[li].start.push(st);
                    }
                    return false;
                }
                TokenType::ExplicitKeyInd => {
                    if !it_has_sep && !it_explicit {
                        let it = &mut items!()[li];
                        it.start.push(st);
                        it.explicit_key = true;
                    } else if at_next_item || it_value.is_some() {
                        start.push(st);
                        items!().push(CollectionItem { start, explicit_key: true, ..Default::default() });
                    } else {
                        let nested = self.push(Token::BlockMap {
                            offset: self.offset,
                            indent: self.indent,
                            items: vec![CollectionItem { start: vec![st], explicit_key: true, ..Default::default() }],
                        });
                        self.stack.push(nested);
                    }
                    self.on_key_line = true;
                    return false;
                }
                TokenType::MapValueInd => {
                    if it_explicit {
                        if !it_has_sep {
                            if includes_token(&items!()[li].start, TokenType::Newline) {
                                let it = &mut items!()[li];
                                it.key = None;
                                it.sep = Some(vec![st]);
                            } else {
                                let start = first_key_start_props(&mut items!()[li].start);
                                let nested = self.push(Token::BlockMap {
                                    offset: self.offset,
                                    indent: self.indent,
                                    items: vec![CollectionItem { start, key: None, sep: Some(vec![st]), ..Default::default() }],
                                });
                                self.stack.push(nested);
                            }
                        } else if it_value.is_some() {
                            items!().push(CollectionItem { key: None, sep: Some(vec![st]), ..Default::default() });
                        } else if includes_token(items!()[li].sep.as_ref().expect("a sep"), TokenType::MapValueInd) {
                            let nested = self.push(Token::BlockMap {
                                offset: self.offset,
                                indent: self.indent,
                                items: vec![CollectionItem { start, key: None, sep: Some(vec![st]), ..Default::default() }],
                            });
                            self.stack.push(nested);
                        } else if is_flow_kind(items!()[li].key.map(|key| self.kind(key)))
                            && !includes_token(items!()[li].sep.as_ref().expect("a sep"), TokenType::Newline)
                        {
                            let it = &mut items!()[li];
                            let start = first_key_start_props(&mut it.start);
                            let key = it.key.take();
                            let mut sep = it.sep.take().expect("a sep");
                            sep.push(st);
                            let nested = self.push(Token::BlockMap {
                                offset: self.offset,
                                indent: self.indent,
                                items: vec![CollectionItem { start, key, sep: Some(sep), ..Default::default() }],
                            });
                            self.stack.push(nested);
                        } else if !start.is_empty() {
                            // Not actually at the next item.
                            let sep = items!()[li].sep.as_mut().expect("a sep");
                            sep.extend(start);
                            sep.push(st);
                        } else {
                            items!()[li].sep.as_mut().expect("a sep").push(st);
                        }
                    } else if !it_has_sep {
                        let it = &mut items!()[li];
                        it.key = None;
                        it.sep = Some(vec![st]);
                    } else if it_value.is_some() || at_next_item {
                        items!().push(CollectionItem { start, key: None, sep: Some(vec![st]), ..Default::default() });
                    } else if includes_token(items!()[li].sep.as_ref().expect("a sep"), TokenType::MapValueInd) {
                        let nested = self.push(Token::BlockMap {
                            offset: self.offset,
                            indent: self.indent,
                            items: vec![CollectionItem { key: None, sep: Some(vec![st]), ..Default::default() }],
                        });
                        self.stack.push(nested);
                    } else {
                        items!()[li].sep.as_mut().expect("a sep").push(st);
                    }
                    self.on_key_line = true;
                    return false;
                }
                TokenType::Alias | TokenType::Scalar | TokenType::SingleQuotedScalar | TokenType::DoubleQuotedScalar => {
                    let fs = self.flow_scalar();
                    if at_next_item || it_value.is_some() {
                        items!().push(CollectionItem { start, key: Some(fs), sep: Some(Vec::new()), ..Default::default() });
                        self.on_key_line = true;
                    } else if it_has_sep {
                        self.stack.push(fs);
                    } else {
                        let it = &mut items!()[li];
                        it.key = Some(fs);
                        it.sep = Some(Vec::new());
                        self.on_key_line = true;
                    }
                    return false;
                }
                _ => {
                    if let Some(bv) = self.start_block_value(map) {
                        if self.kind(bv) == Kind::BlockSeq {
                            let it = &self.arena[map].items().expect("a map")[li];
                            if !it.explicit_key
                                && it.sep.as_ref().is_some_and(|sep| !includes_token(sep, TokenType::Newline))
                            {
                                let error = self.error("Unexpected block-seq-ind on same line with key".to_string());
                                self.pop(Some(error), out);
                                return false;
                            }
                        } else if at_map_indent {
                            items!().push(CollectionItem { start, ..Default::default() });
                        }
                        self.stack.push(bv);
                        return false;
                    }
                }
            }
        }
        true
    }

    fn block_sequence(&mut self, seq: TokenId, _out: &mut Vec<TokenId>) -> bool {
        let st = self.source_token();
        let seq_indent = self.arena[seq].indent().unwrap_or(0);
        let li = self.arena[seq].items().expect("a sequence").len() - 1;
        let it_value = self.arena[seq].items().expect("a sequence")[li].value;
        macro_rules! items {
            () => {
                self.arena[seq].items_mut().expect("a sequence")
            };
        }
        match self.ty {
            TokenType::Newline => {
                if let Some(value) = it_value {
                    let pushed = match self.end_list(value) {
                        Some(end) if end.last().map(|t| t.ty) == Some(TokenType::Comment) => {
                            end.push(st);
                            true
                        }
                        _ => false,
                    };
                    if !pushed {
                        items!().push(CollectionItem { start: vec![st], ..Default::default() });
                    }
                } else {
                    items!()[li].start.push(st);
                }
                return false;
            }
            TokenType::Space | TokenType::Comment => {
                if it_value.is_some() {
                    items!().push(CollectionItem { start: vec![st], ..Default::default() });
                } else {
                    let start = items!()[li].start.clone();
                    if self.at_indented_comment(&start, seq_indent) {
                        let prev_value = if li >= 1 { items!()[li - 1].value } else { None };
                        if let Some(prev_value) = prev_value {
                            let start = items!()[li].start.clone();
                            if let Some(end) = self.end_list(prev_value) {
                                end.extend(start);
                                end.push(st);
                                items!().pop();
                                return false;
                            }
                        }
                    }
                    items!()[li].start.push(st);
                }
                return false;
            }
            TokenType::Anchor | TokenType::Tag => {
                if !(it_value.is_some() || self.indent <= seq_indent) {
                    items!()[li].start.push(st);
                    return false;
                }
            }
            TokenType::SeqItemInd => {
                if self.indent == seq_indent {
                    if it_value.is_some() || includes_token(&items!()[li].start, TokenType::SeqItemInd) {
                        items!().push(CollectionItem { start: vec![st], ..Default::default() });
                    } else {
                        items!()[li].start.push(st);
                    }
                    return false;
                }
            }
            _ => {}
        }
        if self.indent > seq_indent {
            if let Some(bv) = self.start_block_value(seq) {
                self.stack.push(bv);
                return false;
            }
        }
        true
    }

    fn flow_collection(&mut self, fc: TokenId, out: &mut Vec<TokenId>) -> bool {
        let st = self.source_token();
        if self.ty == TokenType::FlowErrorEnd {
            loop {
                self.pop(None, out);
                match self.peek(1) {
                    Some(top) if self.kind(top) == Kind::FlowCollection => {}
                    _ => break,
                }
            }
            return false;
        }
        let Token::FlowCollection { end, .. } = &self.arena[fc] else { unreachable!("a flow collection") };
        if end.is_empty() {
            let (has_it, it_value, it_has_sep) = match self.arena[fc].items().expect("items").last() {
                Some(it) => (true, it.value.is_some(), it.sep.is_some()),
                None => (false, false, false),
            };
            macro_rules! items {
                () => {
                    self.arena[fc].items_mut().expect("items")
                };
            }
            match self.ty {
                TokenType::Comma | TokenType::ExplicitKeyInd => {
                    if !has_it || it_has_sep {
                        items!().push(CollectionItem { start: vec![st], ..Default::default() });
                    } else {
                        items!().last_mut().expect("an item").start.push(st);
                    }
                    return false;
                }
                TokenType::MapValueInd => {
                    if !has_it || it_value {
                        items!().push(CollectionItem { key: None, sep: Some(vec![st]), ..Default::default() });
                    } else if it_has_sep {
                        items!().last_mut().expect("an item").sep.as_mut().expect("a sep").push(st);
                    } else {
                        let it = items!().last_mut().expect("an item");
                        it.key = None;
                        it.sep = Some(vec![st]);
                    }
                    return false;
                }
                TokenType::Space | TokenType::Comment | TokenType::Newline | TokenType::Anchor | TokenType::Tag => {
                    if !has_it || it_value {
                        items!().push(CollectionItem { start: vec![st], ..Default::default() });
                    } else if it_has_sep {
                        items!().last_mut().expect("an item").sep.as_mut().expect("a sep").push(st);
                    } else {
                        items!().last_mut().expect("an item").start.push(st);
                    }
                    return false;
                }
                TokenType::Alias | TokenType::Scalar | TokenType::SingleQuotedScalar | TokenType::DoubleQuotedScalar => {
                    let fs = self.flow_scalar();
                    if !has_it || it_value {
                        items!().push(CollectionItem { key: Some(fs), sep: Some(Vec::new()), ..Default::default() });
                    } else if it_has_sep {
                        self.stack.push(fs);
                    } else {
                        let it = items!().last_mut().expect("an item");
                        it.key = Some(fs);
                        it.sep = Some(Vec::new());
                    }
                    return false;
                }
                TokenType::FlowMapEnd | TokenType::FlowSeqEnd => {
                    if let Token::FlowCollection { end, .. } = &mut self.arena[fc] {
                        end.push(st);
                    }
                    return false;
                }
                _ => {}
            }
            return match self.start_block_value(fc) {
                Some(bv) => {
                    self.stack.push(bv);
                    false
                }
                None => true,
            };
        }
        let parent = self.peek(2).expect("a flow collection has a parent");
        let fc_indent = self.arena[fc].indent().unwrap_or(0);
        let parent_is_map = self.kind(parent) == Kind::BlockMap;
        let parent_last_has_sep = parent_is_map
            && self.arena[parent].items().and_then(|items| items.last()).is_some_and(|it| it.sep.is_some());
        if parent_is_map
            && ((self.ty == TokenType::MapValueInd && self.arena[parent].indent() == Some(fc_indent))
                || (self.ty == TokenType::Newline && !parent_last_has_sep))
        {
            return true;
        }
        if self.ty == TokenType::MapValueInd && self.kind(parent) != Kind::FlowCollection {
            let start = self.take_prev_first_key_start_props(parent);
            self.fix_flow_seq_items(fc);
            let Token::FlowCollection { end, offset, indent, .. } = &mut self.arena[fc] else { unreachable!() };
            let mut sep = if end.len() > 1 { end.split_off(1) } else { Vec::new() };
            sep.push(st);
            let map = Token::BlockMap {
                offset: *offset,
                indent: *indent,
                items: vec![CollectionItem { start, key: Some(fc), sep: Some(sep), ..Default::default() }],
            };
            self.on_key_line = true;
            let map = self.push(map);
            *self.stack.last_mut().expect("the collection") = map;
            return false;
        }
        self.line_end(fc, out)
    }

    fn fix_flow_seq_items(&mut self, fc: TokenId) {
        let Token::FlowCollection { start, items, .. } = &mut self.arena[fc] else { return };
        if start.ty != TokenType::FlowSeqStart {
            return;
        }
        let mut moves: Vec<(usize, Option<TokenId>, Vec<SourceToken>)> = Vec::new();
        for (i, it) in items.iter_mut().enumerate() {
            if it.sep.is_some()
                && it.value.is_none()
                && !includes_token(&it.start, TokenType::ExplicitKeyInd)
                && !includes_token(it.sep.as_ref().expect("a sep"), TokenType::MapValueInd)
            {
                if it.key.is_some() {
                    it.value = it.key;
                }
                it.key = None;
                let sep = it.sep.take().expect("a sep");
                moves.push((i, it.value, sep));
            }
        }
        for (i, value, sep) in moves {
            let flow_value = value.filter(|value| is_flow_kind(Some(self.arena[*value].kind())));
            match flow_value {
                Some(value) => match &mut self.arena[value] {
                    Token::FlowScalar { end, .. } => match end {
                        Some(end) => end.extend(sep),
                        None => *end = Some(sep),
                    },
                    Token::FlowCollection { end, .. } => end.extend(sep),
                    _ => {}
                },
                None => {
                    if let Some(items) = self.arena[fc].items_mut() {
                        items[i].start.extend(sep);
                    }
                }
            }
        }
    }

    fn flow_scalar(&mut self) -> TokenId {
        let ty = FlowScalarType::from_type(self.ty).expect("a flow scalar type");
        self.report_newlines(self.source);
        self.push(Token::FlowScalar { ty, offset: self.offset, indent: self.indent, source: self.source, end: None })
    }

    fn start_block_value(&mut self, parent: TokenId) -> Option<TokenId> {
        match self.ty {
            TokenType::Alias | TokenType::Scalar | TokenType::SingleQuotedScalar | TokenType::DoubleQuotedScalar => {
                Some(self.flow_scalar())
            }
            TokenType::BlockScalarHeader => {
                let st = self.source_token();
                Some(self.push(Token::BlockScalar {
                    offset: self.offset,
                    indent: self.indent,
                    props: vec![BlockScalarProp::Source(st)],
                    source: Src::EMPTY,
                }))
            }
            TokenType::FlowMapStart | TokenType::FlowSeqStart => {
                let st = self.source_token();
                Some(self.push(Token::FlowCollection {
                    offset: self.offset,
                    indent: self.indent,
                    start: st,
                    items: Vec::new(),
                    end: Vec::new(),
                }))
            }
            TokenType::SeqItemInd => {
                let st = self.source_token();
                Some(self.push(Token::BlockSeq {
                    offset: self.offset,
                    indent: self.indent,
                    items: vec![CollectionItem { start: vec![st], ..Default::default() }],
                }))
            }
            TokenType::ExplicitKeyInd => {
                self.on_key_line = true;
                let mut start = self.take_prev_first_key_start_props(parent);
                start.push(self.source_token());
                Some(self.push(Token::BlockMap {
                    offset: self.offset,
                    indent: self.indent,
                    items: vec![CollectionItem { start, explicit_key: true, ..Default::default() }],
                }))
            }
            TokenType::MapValueInd => {
                self.on_key_line = true;
                let start = self.take_prev_first_key_start_props(parent);
                let st = self.source_token();
                Some(self.push(Token::BlockMap {
                    offset: self.offset,
                    indent: self.indent,
                    items: vec![CollectionItem { start, key: None, sep: Some(vec![st]), ..Default::default() }],
                }))
            }
            _ => None,
        }
    }

    fn at_indented_comment(&self, start: &[SourceToken], indent: usize) -> bool {
        if self.ty != TokenType::Comment {
            return false;
        }
        if self.indent <= indent {
            return false;
        }
        start.iter().all(|st| matches!(st.ty, TokenType::Newline | TokenType::Space))
    }

    fn document_end(&mut self, doc_end: TokenId, out: &mut Vec<TokenId>) -> bool {
        if self.ty != TokenType::DocMode {
            let st = self.source_token();
            if let Token::DocEnd { end, .. } = &mut self.arena[doc_end] {
                end.get_or_insert_with(Vec::new).push(st);
            }
            if self.ty == TokenType::Newline {
                self.pop(None, out);
            }
        }
        false
    }

    fn line_end(&mut self, token: TokenId, out: &mut Vec<TokenId>) -> bool {
        match self.ty {
            TokenType::Comma
            | TokenType::DocStart
            | TokenType::DocEnd
            | TokenType::FlowSeqEnd
            | TokenType::FlowMapEnd
            | TokenType::MapValueInd => true,
            ty => {
                if ty == TokenType::Newline {
                    self.on_key_line = false;
                }
                // Every other value is an error.
                let st = self.source_token();
                match &mut self.arena[token] {
                    Token::Document { end, .. } | Token::FlowScalar { end, .. } => {
                        end.get_or_insert_with(Vec::new).push(st)
                    }
                    Token::FlowCollection { end, .. } => end.push(st),
                    _ => {}
                }
                if ty == TokenType::Newline {
                    self.pop(None, out);
                }
                false
            }
        }
    }
}
