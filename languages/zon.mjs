// ZON, in JavaScript: the twin of fig's compiled `zon` format, row for row.
//
// `fig lang check js-zon --against zon <files…>` holds this module to the
// compiled parser's node table on every file given, and this module is
// written against `fig lang table -i zon`, which prints that table. The
// compiled parser hand-rolls nothing: ZON is a subset of Zig, so it hands
// the source to `std.zig.Ast.parse(.zon)` and walks the tree Zig's own
// parser built (fig's `src/languages/zon/parser.zig`). This module is
// therefore three things in one: as much of Zig's tokenizer and expression
// parser as decides what ZON is, that walk, and the printer.
//
// The shape, as the compiled walk builds it:
//
//   * one expression, then the end of the input; `.{ .a = 1 }` is a
//     mapping, `.{ 1, 2 }` a sequence, `.{}` an empty mapping; a container
//     spans `.{` through `}`, an entry its field name (without the dot)
//     through its value;
//   * a number keeps its lexeme (`0xFF`, `1_000`, `- 1` with the space —
//     Zig's `-` is a prefix operator) and is a float when it has a `.` or
//     an exponent; `inf`, `-inf` and `nan` are floats; `true`, `false` and
//     `null` are what they say; a string decodes Zig's escapes, and a `\\`
//     multiline string joins its lines with `\n`, spanning the first `\\`
//     to the last line's end; `.name` is an `enum_literal` string, `'c'` a
//     `char_literal` int whose text is the decimal codepoint; `.@"quoted"`
//     names decode as strings;
//   * comments are recovered from the gaps between nodes — `std.zig.Ast`
//     drops them — so one on the line of the value just finished trails it
//     (or dangles on a container whose `}` that line closes), one on its
//     own line leads the next key or element, or dangles on the container
//     it ends; a `// head` after a `.{` trails the container; what follows
//     the document on later lines is dropped, and so is a comment inside
//     parentheses.
//
// The refusals are the compiled parser's two: `InvalidZon` for what Zig's
// parser refuses (its warnings included — a missing comma, `1 +2`), a
// string or char literal that does not decode, or a document that is not
// one expression; `UnsupportedZon` for Zig that ZON is not — an
// identifier, an operator, a call, a typed `T{…}`. Neither carries an
// offset. Zig's whole expression grammar is not here: what lies outside
// ZON is skipped by shape (operators, suffixes, calls, balanced brackets,
// a keyword-led expression to its terminator) and called unsupported when
// the shape closes; where that skip would need the rest of Zig to know
// better, this may say `UnsupportedZon` for what Zig would refuse.
//
// Everything is checked in document order, as the walk meets it, so the
// first of an unsupported node and an undecodable literal is what a file
// with both is refused for.
//
// Every offset is a byte offset: the tokenizer walks the scanner's
// one-char-per-byte shadow of the input (`sc.bin`) and decodes text from
// the bytes a token covers.
import * as fig from "fig";

const INVALID = "InvalidZon";
const UNSUPPORTED = "UnsupportedZon";

const invalid = () => fig.fail(INVALID);
const unsupported = () => fig.fail(UNSUPPORTED);

// ── Zig's tokenizer, the part that matters ────────────────────────────────
// Tokens are `{ tag, s, e }` over 0-based byte offsets. Zig's tokenizer
// never fails: an `invalid` token is what a byte it cannot place becomes,
// and Zig's parser then refuses it. So does this one, as `InvalidZon`.

const KEYWORDS = new Set(
  `addrspace align allowzero and anyframe anytype asm break callconv catch comptime const continue
  defer else enum errdefer error export extern fn for if inline noalias noinline nosuspend opaque or orelse
  packed pub resume return linksection struct suspend switch test threadlocal try union unreachable var
  volatile while`.split(/\s+/),
);

const isIdentStart = (b) => (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95;
const isIdentByte = (b) => isIdentStart(b) || (b >= 48 && b <= 57);
// What continues a number after its first digit: letters other than the
// exponent ones, digits and `_`.
const isNumberByte = (b) =>
  (b >= 48 && b <= 57) || b === 95 || (b >= 65 && b <= 90 && b !== 69 && b !== 80) || (b >= 97 && b <= 122 && b !== 101 && b !== 112);
const isExponent = (b) => b === 101 || b === 69 || b === 112 || b === 80;
// A control byte Zig refuses inside a literal or comment.
const isControl = (b) => (b >= 1 && b <= 9) || (b >= 11 && b <= 31) || b === 127;

// The operators, longest spelling first, as Zig lexes them.
const OPERATORS = [
  "<<=", ">>=", "<<|", "<<|=", "...", "*%=", "*|=", "+%=", "+|=", "-%=", "-|=",
  "==", "!=", "<=", ">=", "<<", ">>", "&=", "*=", "*%", "*|", "**", "%=", "+=", "+%", "+|", "++",
  "-=", "-%", "-|", "->", "/=", "|=", "||", "^=", "..", ".*", ".?", "=>",
  "(", ")", "[", "]", "{", "}", ";", ",", "?", ":", "%", "*", "+", "<", ">", "^", "~", ".", "-", "/", "&", "|", "=", "!",
].sort((a, b) => b.length - a.length);

function tokenize(bin) {
  const n = bin.length;
  let i = 0;
  const tokens = [];
  const at = (k) => (k < n ? bin.charCodeAt(k) : 0);
  const emit = (tag, s, e) => tokens.push({ tag, s, e });
  // An invalid token runs to the end of its line, as Zig's does; what it
  // covers no longer matters, since the parser refuses it.
  const invalidToken = (s) => {
    while (i < n && at(i) !== 10) i += 1;
    emit("invalid", s, i);
  };
  // The body of a `"…"` or `'…'` literal after its opener; the closing
  // quote is consumed. A newline or a control byte inside is invalid.
  const quotedBody = (q) => {
    for (;;) {
      if (i >= n) return false;
      const c = at(i);
      if (c === 10) return false;
      if (c === 92) {
        i += 1;
        if (i >= n || at(i) === 10) return false;
        if (isControl(at(i))) return false;
        i += 1;
      } else if (c === q) {
        i += 1;
        return true;
      } else if (isControl(c)) {
        return false;
      } else {
        i += 1;
      }
    }
  };
  // A run to the line's end that a control byte or a bare `\r` spoils.
  const lineRest = () => {
    while (i < n) {
      const d = at(i);
      if (d === 10) return true;
      if (d === 13) return at(i + 1) === 10;
      if (isControl(d)) return false;
      i += 1;
    }
    return true;
  };
  while (i < n) {
    const c = at(i);
    const s = i;
    if (c === 32 || c === 10 || c === 9 || c === 13) {
      i += 1;
    } else if (c === 34) {
      i += 1;
      if (quotedBody(34)) emit("string_literal", s, i);
      else invalidToken(s);
    } else if (c === 39) {
      i += 1;
      if (quotedBody(39)) emit("char_literal", s, i);
      else invalidToken(s);
    } else if (isIdentStart(c)) {
      while (i < n && isIdentByte(at(i))) i += 1;
      const word = bin.slice(s, i);
      emit(KEYWORDS.has(word) ? "keyword_" + word : "identifier", s, i);
    } else if (c === 64) {
      // @
      i += 1;
      const d = at(i);
      if (d === 34) {
        i += 1;
        if (quotedBody(34)) emit("identifier", s, i);
        else invalidToken(s);
      } else if (isIdentStart(d)) {
        while (i < n && isIdentByte(at(i))) i += 1;
        emit("builtin", s, i);
      } else {
        invalidToken(s);
      }
    } else if (c === 92) {
      // `\\` multiline string line
      i += 1;
      if (at(i) !== 92) {
        invalidToken(s);
      } else if (lineRest()) {
        emit("multiline_string_literal_line", s, i);
      } else {
        invalidToken(s);
      }
    } else if (c === 47 && at(i + 1) === 47) {
      // `//`
      i += 2;
      let tag = "comment";
      if (at(i) === 33) tag = "container_doc_comment";
      else if (at(i) === 47 && at(i + 1) !== 47) tag = "doc_comment";
      if (!lineRest()) invalidToken(s);
      else if (tag !== "comment") emit(tag, s, i);
    } else if (c >= 48 && c <= 57) {
      i += 1;
      // `int`: digits, letters and `_`; an exponent letter may take a sign;
      // a `.` followed by any of those turns it into a float.
      let state = "int";
      while (i < n) {
        const d = at(i);
        if (isNumberByte(d)) {
          i += 1;
        } else if (isExponent(d)) {
          i += 1;
          if (at(i) === 45 || at(i) === 43) {
            i += 1;
            state = "float";
          }
        } else if (d === 46 && state === "int") {
          const e = at(i + 1);
          if (isNumberByte(e)) {
            i += 2;
            state = "float";
          } else if (isExponent(e)) {
            i += 1;
            state = "float";
          } else break;
        } else break;
      }
      emit("number_literal", s, i);
    } else if (c === 46 && at(i + 1) === 42 && at(i + 2) === 42) {
      i += 3;
      invalidToken(s); // `.**`, which Zig lexes as its own invalid token
    } else {
      const matched = OPERATORS.find((op) => bin.startsWith(op, i));
      if (matched !== undefined) {
        i += matched.length;
        emit(matched, s, i);
      } else {
        invalidToken(s);
      }
    }
  }
  emit("eof", n, n);
  return tokens;
}

// ── Zig's parser, the ZON of it ───────────────────────────────────────────
// Builds an intermediate tree of `{ kind, first, span, … }`: `first` is
// where the node's first token begins (a `(` or `-` included), `span` what
// the compiled walk reports. What Zig would parse and the walk refuse is
// an `unsupported` node, kept so that the walk meets it in order.

const BINARY = new Set([
  "keyword_or", "keyword_and", "==", "!=", "<", ">", "<=", ">=", "&", "^", "|", "keyword_orelse", "keyword_catch",
  "<<", "<<|", ">>", "+", "-", "++", "+%", "-%", "+|", "-|", "||", "*", "/", "%", "**", "*%", "*|",
]);
const PREFIX = new Set(["!", "-", "~", "-%", "&", "keyword_try"]);
const CLOSERS = { "(": ")", "[": "]", "{": "}" };
const isWsByte = (b) => b === 32 || b === 10 || b === 9 || b === 13 || b === 11 || b === 12;

class Parser {
  constructor(bin, tokens) {
    this.bin = bin;
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(k = 0) {
    return this.tokens[this.pos + k];
  }
  tag(k = 0) {
    return this.peek(k).tag;
  }
  next() {
    const t = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return t;
  }
  eat(tag) {
    return this.tag() === tag ? this.next() : null;
  }
  expect(tag) {
    if (this.tag() !== tag) invalid();
    return this.next();
  }

  // Skip a balanced bracket run starting at the opener under the cursor.
  skipBalanced() {
    const open = this.next();
    const close = CLOSERS[open.tag];
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (t.tag === "eof" || t.tag === "invalid") invalid();
      if (t.tag in CLOSERS) depth += 1;
      else if (t.tag === close) depth -= 1;
    }
  }

  // An expression outside ZON, skipped by shape: prefix operators, a
  // primary, suffixes, then binary operators with their right-hand sides.
  // The cursor ends where the expression does; the caller makes it an
  // `unsupported` node.
  skipExpr() {
    while (PREFIX.has(this.tag())) this.next();
    const tag = this.tag();
    if (
      tag === "number_literal" || tag === "string_literal" || tag === "char_literal" || tag === "identifier" ||
      tag === "keyword_unreachable" || tag === "keyword_anytype"
    ) {
      this.next();
    } else if (tag === "multiline_string_literal_line") {
      while (this.tag() === "multiline_string_literal_line") this.next();
    } else if (tag === "builtin") {
      this.next();
      if (this.tag() !== "(") invalid();
      this.skipBalanced();
    } else if (tag === ".") {
      if (this.tag(1) === "identifier") {
        this.next();
        this.next();
      } else if (this.tag(1) === "{") {
        this.next();
        this.skipBalanced();
      } else invalid();
    } else if (tag === "(" || tag === "[" || tag === "{") {
      this.skipBalanced();
      if (tag === "[") this.skipExpr(); // the element type
    } else if (tag === "*" || tag === "**" || tag === "?") {
      this.next();
      this.skipExpr();
    } else if (tag === "keyword_error") {
      this.next();
      if (this.tag() === ".") {
        this.next();
        this.expect("identifier");
      } else if (this.tag() === "{") {
        this.skipBalanced();
      } else invalid();
    } else if (tag.startsWith("keyword_")) {
      // `if`, `switch`, `struct`, `fn`, `comptime`, a labelled block…: to
      // the terminator that ends this expression at its own level.
      this.next();
      for (;;) {
        const k = this.tag();
        if (k === "eof" || k === "," || k === ")" || k === "]" || k === "}") break;
        if (k === "invalid") invalid();
        if (k in CLOSERS) this.skipBalanced();
        else this.next();
      }
      return;
    } else {
      invalid();
    }
    this.skipSuffixesAndBinary();
  }

  // Whether a suffix or a binary operator follows the primary just parsed.
  continues() {
    const k = this.tag();
    return (k === "." && this.tag(1) === "identifier") || k === ".*" || k === ".?" || k === "[" || k === "(" || k === "{" || BINARY.has(k);
  }

  // After a primary: its suffixes, then a binary operator and its
  // right-hand side. Zig's whitespace rule around an operator is a
  // warning, and a warning is a refusal.
  skipSuffixesAndBinary() {
    for (;;) {
      const k = this.tag();
      if (k === "." && this.tag(1) === "identifier") {
        this.next();
        this.next();
      } else if (k === ".*" || k === ".?") {
        this.next();
      } else if (k === "[" || k === "(" || k === "{") {
        this.skipBalanced();
      } else break;
    }
    if (BINARY.has(this.tag())) {
      const op = this.next();
      const before = op.s > 0 ? this.bin.charCodeAt(op.s - 1) : 32;
      const after = op.e < this.bin.length ? this.bin.charCodeAt(op.e) : 32;
      if (op.tag === "&" && after === 38) invalid();
      if (isWsByte(before) !== isWsByte(after)) invalid();
      if (op.tag === "keyword_catch" && this.tag() === "|") {
        this.next();
        this.expect("identifier");
        this.expect("|");
      }
      this.skipExpr();
    }
  }

  // The expression under the cursor: a ZON node, or `unsupported`.
  expr() {
    const t = this.peek();
    const tag = t.tag;
    const first = t.s;
    if (tag === "-") {
      // Negation: Zig's prefix `-`. The walk keeps a number's lexeme with
      // the sign, `-inf` as a float, and refuses anything else — a second
      // negation, a parenthesis, an identifier.
      this.next();
      const operand = this.expr();
      if (operand.kind === "number" && !operand.negated && !operand.grouped) {
        return { kind: "number", first, span: [first, operand.span[1]], negated: true };
      } else if (operand.kind === "ident" && operand.name === "inf" && !operand.grouped) {
        return { kind: "number", first, span: [first, operand.span[1]], text: "-inf", float: true, negated: true };
      }
      return { kind: "unsupported", first };
    }
    let node;
    if (tag === "number_literal") {
      this.next();
      node = { kind: "number", first, span: [t.s, t.e] };
    } else if (tag === "string_literal") {
      this.next();
      node = { kind: "string", first, span: [t.s, t.e] };
    } else if (tag === "multiline_string_literal_line") {
      const lines = [];
      while (this.tag() === "multiline_string_literal_line") lines.push(this.next());
      node = { kind: "multiline", first, span: [t.s, lines[lines.length - 1].e], lines };
    } else if (tag === "char_literal") {
      this.next();
      node = { kind: "char", first, span: [t.s, t.e] };
    } else if (tag === "identifier") {
      this.next();
      node = { kind: "ident", first, span: [t.s, t.e], name: this.bin.slice(t.s, t.e) };
    } else if (tag === "(") {
      this.next();
      const inner = this.expr();
      this.expect(")");
      // Grouped: the walk descends transparently; the span is the inner
      // node's, but the comment scan starts at the `(`.
      node = inner;
      node.first = first;
      node.grouped = true;
    } else if (tag === "." && this.tag(1) === "identifier") {
      this.next();
      const name = this.next();
      node = { kind: "enum", first, span: [name.s, name.e] };
    } else if (tag === "." && this.tag(1) === "{") {
      node = this.initList();
    } else if (
      tag === "eof" || tag === "invalid" || tag === "doc_comment" || tag === "container_doc_comment" ||
      tag === ")" || tag === "]" || tag === "}" || tag === ","
    ) {
      invalid();
    } else {
      this.skipExpr();
      return { kind: "unsupported", first };
    }
    // A suffix or an operator after a ZON primary is Zig, not ZON.
    if (this.continues()) {
      this.skipSuffixesAndBinary();
      return { kind: "unsupported", first };
    }
    return node;
  }

  // `.{ … }`: field inits make a mapping, expressions a sequence, nothing
  // an empty mapping. A `.name = ` after an expression, or an expression
  // after a field, is Zig's error.
  initList() {
    const dot = this.next();
    const brace = this.next();
    const node = { kind: "container", first: dot.s, brace: brace.s, items: [] };
    const closed = () => {
      node.span = [dot.s, this.tokens[this.pos - 1].e];
      return node;
    };
    const isFieldInit = () => this.tag() === "." && this.tag(1) === "identifier" && this.tag(2) === "=";
    if (isFieldInit()) {
      node.mapping = true;
      for (;;) {
        this.next(); // .
        const name = this.next();
        this.next(); // =
        node.items.push({ name, value: this.expr() });
        const k = this.tag();
        if (k === ",") {
          this.next();
        } else if (k === "}") {
          this.next();
          return closed();
        } else {
          invalid(); // a missing comma is Zig's warning, and a warning refuses
        }
        if (this.eat("}")) return closed();
        if (!isFieldInit()) invalid();
      }
    }
    node.mapping = this.tag() === "}";
    for (;;) {
      if (this.eat("}")) return closed();
      node.items.push({ value: this.expr() });
      const k = this.tag();
      if (k === ",") {
        this.next();
      } else if (k === "}") {
        this.next();
        return closed();
      } else {
        invalid();
      }
    }
  }
}

function parseTree(bin) {
  const tokens = tokenize(bin);
  for (const t of tokens) if (t.tag === "invalid") invalid();
  const p = new Parser(bin, tokens);
  const root = p.expr();
  if (p.tag() !== "eof") invalid();
  return root;
}

// ── decoding, as `std.zig.string_literal` does it ─────────────────────────
// Over `bin`, one char per byte: an escape yields bytes (`\xNN` a raw one),
// and the text is the bytes decoded at the end.

const isHex = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

function utf8Bytes(cp) {
  if (cp < 0x80) return [cp];
  if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
  if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
  return [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
}

// The escape at `raw[i]` (a `\`): `{ byte }` or `{ cp }` (a `\u`) and the
// index after it, or null when it does not decode.
function escapeAt(raw, i) {
  const ch = raw[i + 1];
  const simple = { n: 10, r: 13, t: 9, "\\": 92, "'": 39, '"': 34 };
  if (ch in simple) return { byte: simple[ch], next: i + 2 };
  if (ch === "x") {
    if (!(isHex(raw.charCodeAt(i + 2)) && isHex(raw.charCodeAt(i + 3)))) return null;
    return { byte: parseInt(raw.slice(i + 2, i + 4), 16), next: i + 4 };
  }
  if (ch === "u") {
    if (raw[i + 2] !== "{") return null;
    let j = i + 3;
    const start = j;
    while (j < raw.length && isHex(raw.charCodeAt(j))) j += 1;
    if (j === start || raw[j] !== "}") return null;
    const cp = parseInt(raw.slice(start, j), 16);
    if (cp > 0x10ffff) return null;
    return { cp, next: j + 1 };
  }
  return null;
}

// A `"…"` literal (over `bin`, quotes included), decoded; null when Zig
// would refuse it.
function decodeString(raw) {
  const out = [];
  let i = 1;
  const n = raw.length - 1;
  while (i < n) {
    const c = raw.charCodeAt(i);
    if (c === 92) {
      const e = escapeAt(raw, i);
      if (e === null) return null;
      if (e.cp !== undefined) {
        if (e.cp >= 0xd800 && e.cp <= 0xdfff) return null;
        out.push(...utf8Bytes(e.cp));
      } else {
        out.push(e.byte);
      }
      i = e.next;
    } else {
      out.push(c);
      i += 1;
    }
  }
  return fig.textOf(new Uint8Array(out));
}

// A `'…'` literal (over `bin`): its codepoint, or null.
function decodeChar(raw) {
  if (raw.length < 3) return null;
  const inner = raw.slice(1, -1);
  if (inner[0] === "\\") {
    const e = escapeAt(inner, 0);
    if (e === null || e.next !== inner.length) return null;
    // A `\u{…}` here is any codepoint up to 0x10FFFF, a surrogate
    // included: nothing encodes it, so nothing refuses it.
    return e.cp !== undefined ? e.cp : e.byte;
  }
  const b = inner.charCodeAt(0);
  const len = b < 0x80 ? 1 : b >= 0xc0 && b < 0xe0 ? 2 : b >= 0xe0 && b < 0xf0 ? 3 : b >= 0xf0 && b < 0xf8 ? 4 : 0;
  if (len === 0 || inner.length !== len) return null;
  if (len === 1) return b;
  let cp = b & (0xff >> (len + 1));
  for (let k = 1; k < len; k++) {
    const d = inner.charCodeAt(k);
    if ((d & 0xc0) !== 0x80) return null;
    cp = (cp << 6) | (d & 0x3f);
  }
  const min = [0, 0, 0x80, 0x800, 0x10000][len];
  if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
  return cp;
}

// ── the walk, as `parser.zig` does it ─────────────────────────────────────
// Comments come from the source gaps between nodes: `absorb(pos)` scans
// `[scanPos, pos)`, which holds only punctuation, whitespace and comments.

const trimComment = (s) => s.replace(/^[ \t\r]+|[ \t\r]+$/g, "");

function isFloatLexeme(raw) {
  if (raw.includes(".")) return true;
  const body = raw.startsWith("-") ? raw.slice(1) : raw;
  if (/^0[xX]/.test(body)) return /[pP]/.test(body);
  return /[eE]/.test(raw);
}

class Walk {
  constructor(sc) {
    this.sc = sc;
    this.bin = sc.bin;
    this.scanPos = 0;
    this.pending = [];
    this.lastValue = null;
  }

  absorb(pos) {
    const { bin } = this;
    let i = this.scanPos;
    while (i < pos) {
      const c = bin.charCodeAt(i);
      if (c === 10) {
        this.lastValue = null;
        i += 1;
      } else if (c === 47 && bin.charCodeAt(i + 1) === 47) {
        const s = i + 2;
        let j = s;
        while (j < bin.length && bin.charCodeAt(j) !== 10) j += 1;
        const text = trimComment(this.sc.slice(s, j));
        if (this.lastValue !== null) {
          const last = this.lastValue;
          if ((last.kind === "mapping" || last.kind === "sequence") && last.span[0] < i && bin.slice(last.span[0], i).includes("\n")) {
            last.comment("dangling", text);
          } else {
            last.comment("trailing", text);
          }
          this.lastValue = null;
        } else {
          this.pending.push(text);
        }
        i = j;
      } else {
        i += 1;
      }
    }
    if (i > this.scanPos) this.scanPos = i;
  }

  claim(node, slot) {
    if (this.pending.length === 0) return;
    for (const t of this.pending) node.comment(slot, t);
    this.pending = [];
  }

  // A `// head` right after a container's `.{`, ending its line.
  openTrailing(built, node) {
    const { bin } = this;
    let i = node.brace + 1;
    while (i < bin.length) {
      const c = bin.charCodeAt(i);
      if (c === 10) return;
      if (c === 32 || c === 9 || c === 13) {
        i += 1;
      } else if (c === 47) {
        if (bin.charCodeAt(i + 1) !== 47) return;
        const s = i + 2;
        let j = s;
        while (j < bin.length && bin.charCodeAt(j) !== 10) j += 1;
        built.comment("trailing", trimComment(this.sc.slice(s, j)));
        if (j > this.scanPos) this.scanPos = j;
        return;
      } else {
        return;
      }
    }
  }

  walk(node) {
    const { kind } = node;
    if (kind === "unsupported") unsupported();
    if (kind === "container") {
      let built;
      if (node.mapping) {
        built = fig.mapping(node.span, { duplicates: "keep" });
        this.openTrailing(built, node);
        for (const item of node.items) {
          this.absorb(item.name.s);
          const raw = this.bin.slice(item.name.s, item.name.e);
          let name;
          if (raw.startsWith('@"')) {
            name = decodeString(raw.slice(1));
            if (name === null) invalid();
          } else {
            name = raw;
          }
          const key = fig.scalar("string", [item.name.s, item.name.e], name);
          this.claim(key, "leading");
          this.scanPos = item.name.e;
          const value = this.walk(item.value);
          this.lastValue = value;
          this.scanPos = value.span[1];
          built.put(fig.entry(key, value, [item.name.s, value.span[1]]));
        }
      } else {
        built = fig.sequence(node.span);
        this.openTrailing(built, node);
        for (const item of node.items) {
          this.absorb(item.value.first);
          const value = this.walk(item.value);
          this.claim(value, "leading");
          this.lastValue = value;
          this.scanPos = value.span[1];
          built.add(value);
        }
      }
      this.absorb(node.span[1]);
      this.claim(built, "dangling");
      return built;
    }
    const { span } = node;
    if (kind === "number") {
      const text = node.text ?? this.sc.slice(span[0], span[1]);
      const float = node.float || isFloatLexeme(text);
      return fig.scalar(float ? "float" : "int", span, text);
    } else if (kind === "ident") {
      const { name } = node;
      if (name === "true" || name === "false") return fig.scalar("bool", span, name);
      if (name === "null") return fig.scalar("null", span);
      if (name === "inf" || name === "nan") return fig.scalar("float", span, name);
      unsupported();
    } else if (kind === "string") {
      const text = decodeString(this.bin.slice(span[0], span[1]));
      if (text === null) invalid();
      return fig.scalar("string", span, text);
    } else if (kind === "multiline") {
      return fig.scalar("string", span, node.lines.map((line) => this.sc.slice(line.s + 2, line.e)).join("\n"));
    } else if (kind === "char") {
      const cp = decodeChar(this.bin.slice(span[0], span[1]));
      if (cp === null) invalid();
      return fig.scalar("int", span, String(cp), { ext_kind: "char_literal" });
    } else if (kind === "enum") {
      const raw = this.bin.slice(span[0], span[1]);
      let name;
      if (raw.startsWith('@"')) {
        name = decodeString(raw.slice(1));
        if (name === null) invalid();
      } else {
        name = raw;
      }
      return fig.scalar("string", span, name, { ext_kind: "enum_literal" });
    }
    unsupported();
  }
}

function parse(_dialect, input) {
  const sc = fig.scanner(input);
  const tree = parseTree(sc.bin);
  const w = new Walk(sc);
  w.absorb(tree.first);
  const root = w.walk(tree);
  w.claim(root, "leading");
  w.lastValue = root;
  w.scanPos = root.span[1];
  w.absorb(sc.n);
  return fig.rows(root);
}

// ── the printer ───────────────────────────────────────────────────────────
// The compiled printer's layout: every container broken one member per
// line at four spaces a level with a trailing comma, `.{}` when empty;
// comments where they were bound — a container's own trailing comment
// after its `.{`, a member's leading above it, trailing after its comma,
// dangling before the `}`. Without `pretty`, everything inline and no
// comments at all.

const INDENT = "    ";

function isBareIdentifier(name) {
  if (name === "") return false;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
  return !KEYWORDS.has(name);
}

const STRING_ESCAPES = { '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t" };

// The bytes of `value`, escaped as the compiled printer escapes them: a
// control byte other than `\n \r \t` as `\xNN`; anything else as itself.
function stringInner(value) {
  let out = "";
  for (const c of value) {
    if (c in STRING_ESCAPES) {
      out += STRING_ESCAPES[c];
    } else {
      const b = c.codePointAt(0);
      if (b < 0x20) out += "\\x" + b.toString(16).padStart(2, "0");
      else out += c;
    }
  }
  return out;
}

function writeString(w, value) {
  w.put('"', stringInner(value), '"');
}

function writeDotName(w, name) {
  w.put(".");
  if (isBareIdentifier(name)) w.put(name);
  else w.put('@"', stringInner(name), '"');
}

function writeCharLiteral(w, text) {
  if (!/^\d+$/.test(text)) return w.put(text);
  const cp = Number(text);
  w.put("'");
  if (cp === 39) w.put("\\'");
  else if (cp === 92) w.put("\\\\");
  else if (cp === 10) w.put("\\n");
  else if (cp === 13) w.put("\\r");
  else if (cp === 9) w.put("\\t");
  else if ((cp >= 0x20 && cp <= 0x26) || (cp >= 0x28 && cp <= 0x5b) || (cp >= 0x5d && cp <= 0x7e)) w.put(String.fromCharCode(cp));
  else w.put("\\u{" + cp.toString(16) + "}");
  w.put("'");
}

const isContainer = (row) => row.kind === "mapping" || row.kind === "sequence";

class Printer {
  constructor(w, pretty) {
    this.w = w;
    this.pretty = pretty;
  }

  commentsOn() {
    return this.pretty;
  }

  indent(depth) {
    for (let i = 0; i < depth; i++) this.w.put(INDENT);
  }

  slashLines(text, depth) {
    for (const line of text.split("\n")) {
      this.indent(depth);
      const t = line.replace(/^[ \t]+|[ \t]+$/g, "");
      this.w.put(t === "" ? "//" : "// " + t, "\n");
    }
  }

  leading(row, depth) {
    if (!this.commentsOn()) return;
    for (const c of row.leading) this.slashLines(c.text, depth);
  }

  trailing(row) {
    if (!this.commentsOn()) return;
    const c = row.trailing[0];
    if (!c) return;
    this.w.put(" //");
    if (c.text !== "") this.w.put(" ", c.text.replace(/\n/g, " "));
  }

  node(row, depth) {
    const { w } = this;
    const k = row.kind;
    if (k === "null") w.put("null");
    else if (k === "bool") w.put(row.text);
    else if (k === "int" || k === "float") {
      if (row.ext_kind === "char_literal") writeCharLiteral(w, row.text);
      else w.put(row.text);
    } else if (k === "string") {
      if (row.ext_kind === "enum_literal") writeDotName(w, row.text ?? "");
      else writeString(w, row.text ?? "");
    } else if (k === "mapping" || k === "sequence") {
      this.container(row, depth);
    } else if (k === "keyvalue") {
      if (row.key.kind !== "string") throw new Error("a ZON field name must be a string");
      writeDotName(w, row.key.text ?? "");
      w.put(" = ");
      this.node(row.value, depth);
    } else if (k === "alias") {
      throw new Error("an alias must be resolved before it is written as ZON");
    } else {
      throw new Error("a " + k + " is not a value");
    }
  }

  container(row, depth) {
    const { w } = this;
    const dangling = this.commentsOn() ? row.dangling : [];
    if (row.items.length === 0 && dangling.length === 0) {
      w.put(".{}");
      this.trailing(row);
      return;
    }
    if (!this.pretty) {
      w.put(".{ ");
      row.items.forEach((item, i) => {
        if (i > 0) w.put(", ");
        this.node(item, depth + 1);
      });
      w.put(" }");
      return;
    }
    w.put(".{");
    this.trailing(row);
    w.put("\n");
    for (const item of row.items) {
      const lead = item.kind === "keyvalue" ? item.key : item;
      const trail = item.kind === "keyvalue" ? item.value : item;
      this.leading(lead, depth + 1);
      this.indent(depth + 1);
      this.node(item, depth + 1);
      w.put(",");
      if (!isContainer(trail)) this.trailing(trail);
      w.put("\n");
    }
    for (const c of dangling) this.slashLines(c.text, depth + 1);
    this.indent(depth);
    w.put("}");
  }
}

function print(_dialect, t, options) {
  const w = fig.writer(options);
  const pretty = !(options && options.pretty === false);
  const p = new Printer(w, pretty);
  const root = fig.index(t).byid(0);
  p.leading(root, 0);
  p.node(root, 0);
  if (!isContainer(root)) p.trailing(root);
  w.put("\n");
  return w.string();
}

export default {
  name: "js-zon",
  caps: { read: true, edit: true, serialize: true },
  lossless: { null: true, enum_literal: true, char_literal: true },
  syntax: {
    comments: { style: "slashes", line: { open: "//" }, trailing: { open: "//" } },
    kv_sep: " = ",
    key_style: "zon_field",
    // The byte before every key, which the editor removes with the key:
    // `.` (the wire carries a sigil as its byte).
    key_sigil: 46,
    empty_map_literal: ".{}",
    bare_document_mapping: false,
    flow_map_open: ".{",
    flow_map_close: "}",
  },
  // The compiled format owns `.zon`, and a compiled format's extension
  // wins, so this is reached by `--lang js-zon`.
  dialects: [{ name: "js-zon", extensions: ["zon"], splice: "literal", empty_doc_seed: ".{}\n" }],
  samples: ['.{ .a = 1, .b = .{ .c = "d" }, .e = .{ 1, 2 } }\n'],
  renderers: [],
  parse,
  print,
};
