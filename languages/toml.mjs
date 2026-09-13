// TOML, in JavaScript: the twin of fig's compiled `toml` format — TOML
// 1.1, the default dialect — row for row, region for region, mention for
// mention.
//
// `fig lang check js-toml --against toml <files…>` holds this module to
// the compiled parser's node table on every file given, and this module is
// written against `fig lang table -i toml`, which prints that table. What
// the compiled format accepts is stated in fig's `src/languages/toml/`
// (`tokenizer.zig`, `parser.zig`, `printer.zig`), and this follows them
// function for function. Where the grammar module would do, it is not
// used: TOML is a section format, and what makes it one — the table a
// `[header]` opens, the regions and mentions the editor moves a table by,
// the rules for which line may extend which table — is exactly what the
// compiled parser states by hand, so this states it by hand too.
//
// The shape, as the compiled parser builds it:
//
//   * the root mapping spans the whole input; a `key = value` line is a
//     keyvalue from the key's start to the value's end; a string's span
//     includes its quotes, a container's its brackets;
//   * a `[a.b]` header, a `[[a]]` header and a dotted `a.b = 1` line each
//     make a *section* table per segment they create: a keyvalue and a
//     mapping whose span is just that segment's key text. An array of
//     tables is a sequence spanning its first header's key text, and so is
//     every element mapping in it. A header names the table again rather
//     than creating it when it exists;
//   * a table's *regions* are the header lines that created or reopened it
//     — `[a]`, `[[a]]`, and a dotted line for every table it passes
//     through — each the whole physical line; an element of an array of
//     tables carries its own `[[a]]` line, and the array every one;
//   * a table's *mentions* are every place its name is written: each
//     segment of a header (`header`) or of a dotted key (`entry`), on the
//     node that segment names — an array of tables, not its element;
//   * an integer's text is its decimal value (`0xff` → `255`, `1_000` →
//     `1000`, `+5` → `5`); a float keeps its lexeme minus underscores,
//     `+inf` is `inf`, every nan is `nan`; a datetime is a string with an
//     `ext_kind` and its lexeme as text;
//   * a comment on the line of a top-level `key = value` trails the value;
//     any other waits and leads the next key or header's key, whatever it
//     was inside — an array, a `[header]` line — and at the end of the
//     file dangles on the table the last header opened.
//
// The refusals are the compiled parser's, in its words and at its offsets,
// with one difference of order: the compiled tokenizer runs over the whole
// file before its parser, so a file with a lexical error after a
// grammatical one reports the lexical one; this reports the first.
//
// Every offset is a byte offset: the tokenizer walks the scanner's
// one-char-per-byte shadow of the input (`sc.bin`) and decodes text from
// the bytes a token covers. The same object `@diaryx/fig`'s
// `registerLanguage` takes, so it serves the browser and Node unchanged.
import * as fig from "fig";

// ── errors, as the compiled parser words them ─────────────────────────────

const MESSAGES = {
  UnexpectedToken: "unexpected token here; check for a missing `=`, `.`, `,`, or closing `]`/`}`",
  UnclosedString:
    "unclosed string; a single-line string cannot contain a literal newline — close the quote, or use a triple-quoted string (`\"\"\"`/`'''`) for multi-line text",
  BadEscape:
    "invalid escape; basic strings support \\b \\t \\n \\f \\r \\\" \\\\ \\uXXXX \\UXXXXXXXX — use a literal string ('...') for raw text with backslashes",
  InvalidUnicode: "invalid unicode escape; the hex digits do not form a valid Unicode codepoint",
  InvalidNumber:
    "not a valid TOML number; if this is text (a version, an id), quote it — TOML has no bare strings. Otherwise check the radix prefix, digit grouping (a single `_` between digits, none leading/trailing), and that there is no leading zero",
  UnquotedString:
    "TOML has no bare strings: a value that is not a number, boolean, date, array, or inline table must be quoted (`\"...\"`, or `'...'` for raw text)",
  InvalidDatetime: "not a valid RFC 3339 date/time",
  InvalidKey: "invalid key; a bare key allows only letters, digits, `-`, and `_` — quote it for anything else",
  DuplicateKey: "this key or table conflicts with one already defined; a TOML key or table may be defined only once",
  TrailingContent:
    "unexpected content after this line's value; each TOML statement must end its line (a `#` comment needs whitespace before it)",
  UnexpectedCarriageReturn: "a bare `\\r` must be followed by `\\n`; TOML line endings are `\\n` or `\\r\\n`",
  BadKey: "invalid key; expected a bare key, a quoted key, `.`, or `=` here",
  BadValue: "not a recognized value; TOML values are strings, numbers, booleans, datetimes, arrays, or inline tables",
  BadControlChar: "control characters are not allowed here (only tab is permitted outside a multi-line string)",
};

// ── the tokenizer ─────────────────────────────────────────────────────────
// Line-oriented and context-sensitive, as the compiled one: the same bytes
// are a bare key before `=` and a date after it, so a per-line key/value
// position is tracked, and a stack of open `[`/`{` says whether an inline
// table is at a key or a value.

const isBareKeyChar = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 45;
const forbiddenInline = (c) => (c < 32 && c !== 9) || c === 127;
const forbiddenMultiline = (c) => (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127;
const isValueTerminator = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 35 || c === 44 || c === 93 || c === 125 || c === 61;
const isDigit = (c) => c >= 48 && c <= 57;

class Tokenizer {
  constructor(bin, minutePrecision) {
    this.bin = bin;
    this.n = bin.length;
    this.i = 0;
    this.tokens = [];
    this.inValue = false;
    this.flow = [];
    this.minutePrecision = minutePrecision;
  }

  byte(k) {
    const i = this.i + (k ?? 0);
    return i < this.n ? this.bin.charCodeAt(i) : undefined;
  }

  emit(kind, s, e) {
    this.tokens.push({ kind, s, e });
  }

  run() {
    if (this.bin.startsWith("\xef\xbb\xbf")) this.i = 3;
    while (this.i < this.n) {
      const c = this.byte();
      if (c === 10) {
        this.emit("newline", this.i, this.i + 1);
        this.i += 1;
        if (this.flow.length === 0) this.inValue = false;
      } else if (c === 13) {
        if (this.byte(1) === 10) {
          this.emit("newline", this.i, this.i + 2);
          this.i += 2;
          if (this.flow.length === 0) this.inValue = false;
        } else {
          fig.fail(MESSAGES.UnexpectedCarriageReturn, this.i);
        }
      } else if (c === 32 || c === 9) {
        const s = this.i;
        while (this.i < this.n && (this.byte() === 32 || this.byte() === 9)) this.i += 1;
        this.emit("whitespace", s, this.i);
      } else if (c === 35) {
        const s = this.i;
        while (this.i < this.n && this.byte() !== 10 && this.byte() !== 13) {
          if (forbiddenInline(this.byte())) fig.fail(MESSAGES.BadControlChar, this.i);
          this.i += 1;
        }
        this.emit("comment", s, this.i);
      } else if (this.inValue || this.flow.length > 0) {
        this.lexValue();
      } else {
        this.lexKeyContext();
      }
    }
    this.emit("end_of_file", this.n, this.n);
    return this.tokens;
  }

  lexKeyContext() {
    const c = this.byte();
    if (c === 61) {
      this.emit("equals", this.i, this.i + 1);
      this.i += 1;
      this.inValue = true;
    } else if (c === 46) {
      this.emit("dot", this.i, this.i + 1);
      this.i += 1;
    } else if (c === 91) {
      if (this.byte(1) === 91) {
        this.emit("double_open_bracket", this.i, this.i + 2);
        this.i += 2;
      } else {
        this.emit("open_bracket", this.i, this.i + 1);
        this.i += 1;
      }
    } else if (c === 93) {
      if (this.byte(1) === 93) {
        this.emit("double_close_bracket", this.i, this.i + 2);
        this.i += 2;
      } else {
        this.emit("close_bracket", this.i, this.i + 1);
        this.i += 1;
      }
    } else if (c === 34 || c === 39) {
      const s = this.i;
      this.scanSingleLineString(c);
      this.emit("key", s, this.i);
    } else {
      this.lexBareKey();
    }
  }

  lexBareKey() {
    const s = this.i;
    while (this.i < this.n && isBareKeyChar(this.byte())) this.i += 1;
    if (this.i === s) fig.fail(MESSAGES.BadKey, this.i);
    this.emit("key", s, this.i);
  }

  atInlineKey() {
    const top = this.flow[this.flow.length - 1];
    return top !== undefined && top.table && top.expectKey;
  }

  lexValue() {
    const c = this.byte();
    const top = this.flow[this.flow.length - 1];
    if (c === 91) {
      this.emit("open_bracket", this.i, this.i + 1);
      this.i += 1;
      this.flow.push({ table: false });
    } else if (c === 93) {
      if (this.flow.length > 0) this.flow.pop();
      this.emit("close_bracket", this.i, this.i + 1);
      this.i += 1;
    } else if (c === 123) {
      this.emit("open_brace", this.i, this.i + 1);
      this.i += 1;
      this.flow.push({ table: true, expectKey: true });
    } else if (c === 125) {
      if (this.flow.length > 0) this.flow.pop();
      this.emit("close_brace", this.i, this.i + 1);
      this.i += 1;
    } else if (c === 44) {
      this.emit("comma", this.i, this.i + 1);
      this.i += 1;
      if (top && top.table) top.expectKey = true;
    } else if (c === 61) {
      this.emit("equals", this.i, this.i + 1);
      this.i += 1;
      if (top && top.table) top.expectKey = false;
    } else if (c === 46) {
      this.emit("dot", this.i, this.i + 1);
      this.i += 1;
    } else if (c === 34 || c === 39) {
      // A quoted key in inline-table key position, else a string value;
      // both lex the same and the parser reads them by position.
      const s = this.i;
      if (this.i + 2 < this.n && this.byte(1) === c && this.byte(2) === c) this.scanMultiLineString(c);
      else this.scanSingleLineString(c);
      this.emit("string", s, this.i);
    } else {
      if (this.atInlineKey()) return this.lexBareKey();
      const e = this.matchDatetime(this.i);
      if (e !== null) {
        this.emit("datetime", this.i, e);
        this.i = e;
        return;
      }
      const s = this.i;
      while (this.i < this.n && !isValueTerminator(this.byte())) this.i += 1;
      if (this.i === s) fig.fail(MESSAGES.BadValue, this.i);
      const word = this.bin.slice(s, this.i);
      this.emit(word === "true" || word === "false" ? "boolean" : "number", s, this.i);
    }
  }

  scanSingleLineString(q) {
    this.i += 1;
    const basic = q === 34;
    while (this.i < this.n) {
      const c = this.byte();
      if (c === 10 || c === 13) fig.fail(MESSAGES.UnclosedString, this.i);
      if (forbiddenInline(c)) fig.fail(MESSAGES.BadControlChar, this.i);
      if (basic && c === 92) {
        this.i += 2;
      } else if (c === q) {
        this.i += 1;
        return;
      } else {
        this.i += 1;
      }
    }
    fig.fail(MESSAGES.UnclosedString, this.i);
  }

  scanMultiLineString(q) {
    this.i += 3;
    const basic = q === 34;
    while (this.i < this.n) {
      const c = this.byte();
      if (forbiddenMultiline(c)) fig.fail(MESSAGES.BadControlChar, this.i);
      if (c === 13 && this.byte(1) !== 10) fig.fail(MESSAGES.BadControlChar, this.i);
      if (basic && c === 92) {
        this.i += 2;
      } else if (c === q && this.byte(1) === q && this.byte(2) === q) {
        this.i += 3;
        // Up to two more quotes may hug the close.
        let extra = 0;
        while (extra < 2 && this.i < this.n && this.byte() === q) {
          this.i += 1;
          extra += 1;
        }
        return;
      } else {
        this.i += 1;
      }
    }
    fig.fail(MESSAGES.UnclosedString, this.i);
  }

  digitsAt(at, k) {
    if (at + k > this.n) return false;
    for (let j = at; j < at + k; j++) if (!isDigit(this.bin.charCodeAt(j))) return false;
    return true;
  }

  charAt(at, ch) {
    return at < this.n && this.bin.charCodeAt(at) === ch;
  }

  // The shape of a datetime, the range checks being the parser's.
  matchDatetime(at) {
    if (this.digitsAt(at, 4) && this.charAt(at + 4, 45) && this.digitsAt(at + 5, 2) && this.charAt(at + 7, 45) && this.digitsAt(at + 8, 2)) {
      const dateEnd = at + 10;
      let sep = null;
      if (this.charAt(dateEnd, 84) || this.charAt(dateEnd, 116)) sep = dateEnd + 1;
      else if (this.charAt(dateEnd, 32) && this.matchTime(dateEnd + 1) !== null) sep = dateEnd + 1;
      if (sep !== null) {
        const timeEnd = this.matchTime(sep);
        if (timeEnd === null) return dateEnd;
        return this.matchOffset(timeEnd) ?? timeEnd;
      }
      return dateEnd;
    }
    return this.matchTime(at);
  }

  matchTime(at) {
    if (!(this.digitsAt(at, 2) && this.charAt(at + 2, 58) && this.digitsAt(at + 3, 2))) return null;
    let e = at + 5;
    if (this.charAt(e, 58) && this.digitsAt(e + 1, 2)) {
      e += 3;
      if (this.charAt(e, 46)) {
        let f = e + 1;
        if (!this.digitsAt(f, 1)) return null;
        while (this.digitsAt(f, 1)) f += 1;
        e = f;
      }
    } else if (!this.minutePrecision) {
      return null;
    }
    return e;
  }

  matchOffset(at) {
    if (this.charAt(at, 90) || this.charAt(at, 122)) return at + 1;
    if ((this.charAt(at, 43) || this.charAt(at, 45)) && this.digitsAt(at + 1, 2) && this.charAt(at + 3, 58) && this.digitsAt(at + 4, 2)) return at + 6;
    return null;
  }
}

// ── scalars ───────────────────────────────────────────────────────────────

function validUnderscored(s, pred) {
  if (s === "") return false;
  if (s[0] === "_" || s[s.length - 1] === "_") return false;
  let prevUs = false;
  for (let j = 0; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 95) {
      if (prevUs) return false;
      prevUs = true;
    } else if (pred(c)) {
      prevUs = false;
    } else {
      return false;
    }
  }
  return true;
}

const isHex = (c) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isOctal = (c) => c >= 48 && c <= 55;
const isBinary = (c) => c === 48 || c === 49;

const validDecimalInt = (s) => validUnderscored(s, isDigit) && !(s.length > 1 && s[0] === "0");

const SPECIALS = new Set(["inf", "+inf", "-inf", "nan", "+nan", "-nan"]);

// "int", "float", or null for not a number.
function classifyNumber(raw) {
  if (raw === "") return null;
  if (SPECIALS.has(raw)) return "float";
  if (raw.length >= 2 && raw[0] === "0") {
    const r = raw[1];
    if (r === "x") return validUnderscored(raw.slice(2), isHex) ? "int" : null;
    if (r === "o") return validUnderscored(raw.slice(2), isOctal) ? "int" : null;
    if (r === "b") return validUnderscored(raw.slice(2), isBinary) ? "int" : null;
  }
  let body = raw;
  if (body[0] === "+" || body[0] === "-") body = body.slice(1);
  if (body === "") return null;
  let mantissa = body;
  let exponent = null;
  const e = body.search(/[eE]/);
  if (e >= 0) {
    mantissa = body.slice(0, e);
    exponent = body.slice(e + 1);
  }
  let intPart = mantissa;
  let fracPart = null;
  const d = mantissa.indexOf(".");
  if (d >= 0) {
    intPart = mantissa.slice(0, d);
    fracPart = mantissa.slice(d + 1);
  }
  if (!validDecimalInt(intPart)) return null;
  let isFloat = false;
  if (fracPart !== null) {
    if (!validUnderscored(fracPart, isDigit)) return null;
    isFloat = true;
  }
  if (exponent !== null) {
    let ex = exponent;
    if (ex[0] === "+" || ex[0] === "-") ex = ex.slice(1);
    if (!validUnderscored(ex, isDigit)) return null;
    isFloat = true;
  }
  return isFloat ? "float" : "int";
}

function looksNumeric(raw) {
  let body = raw;
  if (body[0] === "+" || body[0] === "-") body = body.slice(1);
  if (body === "") return false;
  if (body === "inf" || body === "nan") return true;
  return isDigit(body.charCodeAt(0));
}

const I64_MAX = 9223372036854775807n;
const I64_MIN = -9223372036854775808n;

// A decimal integer's text is its value: radix and underscores gone, a
// `+` dropped, `-0` is `0`. Beyond i64 the compiled parser refuses.
function canonicalInt(raw) {
  let digits = raw.replace(/_/g, "");
  let v;
  if (digits[0] === "0" && "xob".includes(digits[1] ?? "")) {
    v = BigInt(digits);
  } else {
    if (digits[0] === "+") digits = digits.slice(1);
    v = BigInt(digits);
  }
  if (v > I64_MAX || v < I64_MIN) return null;
  return v.toString();
}

function canonicalFloat(raw) {
  if (raw === "inf" || raw === "+inf") return "inf";
  if (raw === "-inf") return "-inf";
  if (raw === "nan" || raw === "+nan" || raw === "-nan") return "nan";
  return raw.replace(/_/g, "");
}

// RFC 3339, as fig's shared `util.datetime` validates it.
const two = (s, at) => parseInt(s.slice(at, at + 2), 10);
const bothDigits = (s, at) => at + 1 < s.length && isDigit(s.charCodeAt(at)) && isDigit(s.charCodeAt(at + 1));

function daysInMonth(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function validDate(s) {
  if (s.length !== 10 || s[4] !== "-" || s[7] !== "-") return false;
  if (!(bothDigits(s, 0) && bothDigits(s, 2) && bothDigits(s, 5) && bothDigits(s, 8))) return false;
  const year = two(s, 0) * 100 + two(s, 2);
  const month = two(s, 5);
  const day = two(s, 8);
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

function validTime(s, minutePrecision) {
  if (s.length < 5 || s[2] !== ":") return false;
  if (!(bothDigits(s, 0) && bothDigits(s, 3))) return false;
  if (two(s, 0) > 23 || two(s, 3) > 59) return false;
  if (s.length === 5) return minutePrecision;
  if (s[5] !== ":" || s.length < 8) return false;
  if (!bothDigits(s, 6) || two(s, 6) > 60) return false;
  if (s.length === 8) return true;
  if (s[8] !== "." || s.length < 10) return false;
  return /^[0-9]+$/.test(s.slice(9));
}

function validOffset(s) {
  if (s.length !== 6 || s[3] !== ":") return false;
  if (!(bothDigits(s, 1) && bothDigits(s, 4))) return false;
  return two(s, 1) <= 23 && two(s, 4) <= 59;
}

function classifyDatetime(raw, minutePrecision) {
  if (raw.length >= 3 && raw[2] === ":") return validTime(raw, minutePrecision) ? "local_time" : null;
  if (raw.length < 10) return null;
  if (!validDate(raw.slice(0, 10))) return null;
  if (raw.length === 10) return "local_date";
  const sep = raw[10];
  if (sep !== "T" && sep !== "t" && sep !== " ") return null;
  const rest = raw.slice(11);
  let timeStr = rest;
  let hasOffset = false;
  const last = rest[rest.length - 1];
  if (last === "Z" || last === "z") {
    timeStr = rest.slice(0, -1);
    hasOffset = true;
  } else if (rest.length >= 6 && (rest[rest.length - 6] === "+" || rest[rest.length - 6] === "-") && rest[rest.length - 3] === ":") {
    if (!validOffset(rest.slice(-6))) return null;
    timeStr = rest.slice(0, -6);
    hasOffset = true;
  }
  if (!validTime(timeStr, minutePrecision)) return null;
  return hasOffset ? "offset_datetime" : "local_datetime";
}

// ── string decoding ───────────────────────────────────────────────────────

function trimLeadingNewline(inner) {
  if (inner.startsWith("\n")) return inner.slice(1);
  if (inner.startsWith("\r\n")) return inner.slice(2);
  return inner;
}

const SIMPLE = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };

// A codepoint as text, or null where the compiled parser refuses it: a
// surrogate, or past U+10FFFF.
function charOf(cp) {
  if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
  return String.fromCodePoint(cp);
}

// ── the parser ────────────────────────────────────────────────────────────
// Over the token list, with the cursor's token as the default place a
// refusal points to; `failAt` pins another where the cursor has already
// moved past the offender, as the compiled `failSpan` does.

class Parser {
  constructor(sc, tokens, v11) {
    this.sc = sc;
    this.tokens = tokens;
    this.pos = 0;
    this.v11 = v11;
    this.pending = []; // comments waiting for a key
    this.lastValue = null; // the node a same-line comment trails
    this.meta = new Map(); // per table: explicit / dotted / implicit / aot / inlineTable
  }

  peek() {
    return this.tokens[this.pos];
  }

  advance() {
    const t = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return t;
  }

  fail(message) {
    fig.fail(message, this.peek().s);
  }

  failAt(at, message) {
    fig.fail(message, at);
  }

  text(t) {
    return this.sc.slice(t.s, t.e);
  }

  // ── strings ──

  decodeBasic(inner, multiline, at) {
    let out = "";
    let i = 0;
    const n = inner.length;
    while (i < n) {
      const c = inner[i];
      if (c !== "\\") {
        out += c;
        i += 1;
        continue;
      }
      if (i + 1 >= n) this.failAt(at, MESSAGES.BadEscape);
      const e = inner[i + 1];
      if (Object.hasOwn(SIMPLE, e)) {
        out += SIMPLE[e];
        i += 2;
      } else if (e === "u" || e === "U" || e === "x") {
        const width = e === "u" ? 4 : e === "U" ? 8 : 2;
        if (e === "x" && !this.v11) this.failAt(at, MESSAGES.BadEscape);
        if (i + 2 + width > n) this.failAt(at, MESSAGES.BadEscape);
        const hex = inner.slice(i + 2, i + 2 + width);
        if (!/^[0-9a-fA-F]+$/.test(hex)) this.failAt(at, MESSAGES.InvalidUnicode);
        const ch = charOf(parseInt(hex, 16));
        if (ch === null) this.failAt(at, MESSAGES.InvalidUnicode);
        out += ch;
        i += 2 + width;
      } else if (e === "e") {
        if (!this.v11) this.failAt(at, MESSAGES.BadEscape);
        out += "\x1b";
        i += 2;
      } else if (e === " " || e === "\t" || e === "\n" || e === "\r") {
        if (!multiline) this.failAt(at, MESSAGES.BadEscape);
        // A line-ending backslash: whitespace, then a newline, then every
        // blank up to the next content, all trimmed.
        let j = i + 1;
        while (j < n && (inner[j] === " " || inner[j] === "\t")) j += 1;
        if (j >= n || (inner[j] !== "\n" && inner[j] !== "\r")) this.failAt(at, MESSAGES.BadEscape);
        while (j < n && " \t\r\n".includes(inner[j])) j += 1;
        i = j;
      } else {
        this.failAt(at, MESSAGES.BadEscape);
      }
    }
    return out;
  }

  // Any of the four string forms to its value. `at` is where a refusal is
  // reported: the compiled parser has consumed the token by then and its
  // caret rests on what follows.
  decodeString(raw, at) {
    if (raw.length < 2) this.failAt(at, MESSAGES.UnclosedString);
    const q = raw[0];
    const triple = raw.length >= 6 && raw[1] === q && raw[2] === q;
    if (q === "'") {
      if (triple) return trimLeadingNewline(raw.slice(3, -3));
      return raw.slice(1, -1);
    }
    if (triple) return this.decodeBasic(trimLeadingNewline(raw.slice(3, -3)), true, at);
    const inner = raw.slice(1, -1);
    if (!inner.includes("\\")) return inner;
    return this.decodeBasic(inner, false, at);
  }

  // ── comments and trivia ──

  captureComment(t) {
    const raw = this.text(t);
    const body = raw.startsWith("#") ? raw.slice(1) : raw;
    const text = body.replace(/^[ \t\r]+|[ \t\r]+$/g, "");
    if (this.lastValue !== null) {
      this.lastValue.comment("trailing", text);
      this.lastValue = null;
    } else {
      this.pending.push(text);
    }
  }

  // Whitespace and comments, not newlines: a comment here is on the current
  // line, so it can trail a just-parsed value.
  skipInline() {
    for (;;) {
      const k = this.peek().kind;
      if (k === "whitespace") this.pos += 1;
      else if (k === "comment") {
        this.captureComment(this.peek());
        this.pos += 1;
      } else return;
    }
  }

  // Whitespace, comments and blank lines; a newline closes the trailing
  // window, so comments past it lead the next entry.
  skipBlank() {
    for (;;) {
      const k = this.peek().kind;
      if (k === "whitespace") this.pos += 1;
      else if (k === "comment") {
        this.captureComment(this.peek());
        this.pos += 1;
      } else if (k === "newline") {
        this.lastValue = null;
        this.pos += 1;
      } else return;
    }
  }

  skipFlowWs() {
    if (this.v11) this.skipBlank();
    else this.skipInline();
  }

  claimLeading(node) {
    for (const text of this.pending) node.comment("leading", text);
    this.pending = [];
  }

  claimDangling(node) {
    for (const text of this.pending) node.comment("dangling", text);
    this.pending = [];
  }

  requireLineEnd() {
    this.skipInline();
    const k = this.peek().kind;
    if (k !== "newline" && k !== "end_of_file") this.fail(MESSAGES.TrailingContent);
  }

  // The whole physical line holding `at`, newline included: a region.
  lineRegion(at) {
    const { bin, n } = this.sc;
    let s = at;
    while (s > 0 && bin.charCodeAt(s - 1) !== 10) s -= 1;
    let e = at;
    while (e < n && bin.charCodeAt(e) !== 10) e += 1;
    if (e < n) e += 1;
    return [s, e];
  }

  recordHeader(node, at) {
    (node.regions ??= []).push(this.lineRegion(at));
  }

  // ── keys ──

  decodeKey(t) {
    const raw = this.text(t);
    if (raw === "") this.fail(MESSAGES.InvalidKey);
    if (raw[0] === '"' || raw[0] === "'") return this.decodeString(raw, this.peek().s);
    return raw;
  }

  // `a.b.c`: the cursor at the first key.
  parseKeyPath() {
    const segs = [];
    for (;;) {
      const t = this.peek();
      if (t.kind !== "key") this.fail(MESSAGES.UnexpectedToken);
      this.advance();
      segs.push({ str: this.decodeKey(t), span: [t.s, t.e] });
      this.skipInline();
      if (this.peek().kind !== "dot") return segs;
      this.advance();
      this.skipInline();
    }
  }

  lookupChild(map, key) {
    for (const e of map.entries) if (e.key.text === key) return e.value;
    return null;
  }

  appendKeyValue(map, seg, value) {
    const key = fig.scalar("string", seg.span, seg.str);
    this.claimLeading(key);
    const e = fig.entry(key, value, [seg.span[0], value.span[1]]);
    map.entries.push(e);
    return e;
  }

  createTable(parent, seg, meta) {
    const m = fig.mapping(seg.span, { duplicates: "keep" });
    this.appendKeyValue(parent, seg, m);
    this.meta.set(m, meta);
    this.recordHeader(m, seg.span[0]);
    return m;
  }

  appendArrayElement(seq) {
    const elem = fig.mapping(seq.span, { duplicates: "keep" });
    seq.items.push(elem);
    return elem;
  }

  // An existing path node to continue from: a table itself, an array of
  // tables its last element; anything else is a conflict.
  descend(child, seg) {
    const meta = this.meta.get(child) ?? {};
    if (child.kind === "mapping") {
      if (meta.inlineTable) this.failAt(seg.span[0], MESSAGES.DuplicateKey);
      return child;
    }
    if (child.kind === "sequence") {
      if (!meta.aot) this.failAt(seg.span[0], MESSAGES.DuplicateKey);
      const last = child.items[child.items.length - 1];
      if (last === undefined) this.failAt(seg.span[0], MESSAGES.DuplicateKey);
      return last;
    }
    this.failAt(seg.span[0], MESSAGES.DuplicateKey);
  }

  navigateHeaderPath(start, segs, count) {
    let cur = start;
    for (let j = 0; j < count; j++) {
      const seg = segs[j];
      const child = this.lookupChild(cur, seg.str);
      if (child !== null) {
        (child.mentions ??= []).push({ span: seg.span, kind: "header" });
        cur = this.descend(child, seg);
      } else {
        cur = this.createTable(cur, seg, { implicit: true });
        (cur.mentions ??= []).push({ span: seg.span, kind: "header" });
      }
    }
    return cur;
  }

  navigateDottedPath(start, segs, count) {
    let cur = start;
    for (let j = 0; j < count; j++) {
      const seg = segs[j];
      const child = this.lookupChild(cur, seg.str);
      if (child !== null) {
        if (child.kind !== "mapping") this.failAt(seg.span[0], MESSAGES.DuplicateKey);
        const meta = this.meta.get(child) ?? {};
        if (meta.explicit || meta.inlineTable) this.failAt(seg.span[0], MESSAGES.DuplicateKey);
        this.recordHeader(child, seg.span[0]);
        (child.mentions ??= []).push({ span: seg.span, kind: "entry" });
        cur = child;
      } else {
        cur = this.createTable(cur, seg, { dotted: true });
        (cur.mentions ??= []).push({ span: seg.span, kind: "entry" });
      }
    }
    return cur;
  }

  // ── statements ──

  parseTableHeader() {
    this.advance(); // [
    this.skipInline();
    const segs = this.parseKeyPath();
    this.skipInline();
    if (this.peek().kind !== "close_bracket") this.fail(MESSAGES.UnexpectedToken);
    this.advance();
    const cur = this.navigateHeaderPath(this.root, segs, segs.length - 1);
    const final = segs[segs.length - 1];
    const child = this.lookupChild(cur, final.str);
    if (child !== null) {
      if (child.kind !== "mapping") this.failAt(final.span[0], MESSAGES.DuplicateKey);
      const meta = this.meta.get(child) ?? {};
      if (meta.explicit || meta.dotted || meta.inlineTable) this.failAt(final.span[0], MESSAGES.DuplicateKey);
      this.meta.set(child, { explicit: true });
      this.recordHeader(child, final.span[0]);
      (child.mentions ??= []).push({ span: final.span, kind: "header" });
      this.current = child;
    } else {
      this.current = this.createTable(cur, final, { explicit: true });
      (this.current.mentions ??= []).push({ span: final.span, kind: "header" });
    }
  }

  parseArrayTable() {
    this.advance(); // [[
    this.skipInline();
    const segs = this.parseKeyPath();
    this.skipInline();
    if (this.peek().kind !== "double_close_bracket") this.fail(MESSAGES.UnexpectedToken);
    this.advance();
    const cur = this.navigateHeaderPath(this.root, segs, segs.length - 1);
    const final = segs[segs.length - 1];
    const child = this.lookupChild(cur, final.str);
    if (child !== null) {
      const meta = this.meta.get(child) ?? {};
      if (child.kind !== "sequence" || !meta.aot) this.failAt(final.span[0], MESSAGES.DuplicateKey);
      this.recordHeader(child, final.span[0]);
      (child.mentions ??= []).push({ span: final.span, kind: "header" });
      this.current = this.appendArrayElement(child);
    } else {
      const seq = fig.sequence(final.span);
      this.appendKeyValue(cur, final, seq);
      this.meta.set(seq, { aot: true });
      this.recordHeader(seq, final.span[0]);
      (seq.mentions ??= []).push({ span: final.span, kind: "header" });
      this.current = this.appendArrayElement(seq);
    }
    // The element shares the array's span, so its `[[…]]` line is recorded
    // on the element too: the only way its header is findable.
    this.recordHeader(this.current, final.span[0]);
  }

  parseKeyValue() {
    const segs = this.parseKeyPath();
    this.skipInline();
    if (this.peek().kind !== "equals") this.fail(MESSAGES.UnexpectedToken);
    this.advance();
    this.skipInline();
    const cur = this.navigateDottedPath(this.current, segs, segs.length - 1);
    const final = segs[segs.length - 1];
    if (this.lookupChild(cur, final.str) !== null) this.failAt(final.span[0], MESSAGES.DuplicateKey);
    const value = this.parseValue();
    this.lastValue = value;
    this.appendKeyValue(cur, final, value);
  }

  // ── values ──

  parseValue() {
    const t = this.peek();
    const k = t.kind;
    if (k === "string") {
      this.advance();
      return fig.scalar("string", [t.s, t.e], this.decodeString(this.text(t), this.peek().s));
    }
    if (k === "number") {
      this.advance();
      const raw = this.text(t);
      const kind = classifyNumber(raw);
      if (kind === null) this.failAt(t.s, looksNumeric(raw) ? MESSAGES.InvalidNumber : MESSAGES.UnquotedString);
      let canon;
      if (kind === "int") {
        canon = canonicalInt(raw);
        if (canon === null) this.failAt(t.s, MESSAGES.InvalidNumber);
      } else {
        canon = canonicalFloat(raw);
      }
      return fig.scalar(kind, [t.s, t.e], canon);
    }
    if (k === "datetime") {
      this.advance();
      const raw = this.text(t);
      const shape = classifyDatetime(raw, this.v11);
      if (shape === null) this.fail(MESSAGES.InvalidDatetime);
      return fig.scalar("string", [t.s, t.e], raw, { ext_kind: shape });
    }
    if (k === "boolean") {
      this.advance();
      return fig.scalar("bool", [t.s, t.e], this.text(t));
    }
    if (k === "open_bracket") return this.parseArray();
    if (k === "open_brace") return this.parseInlineTable();
    this.fail(MESSAGES.UnexpectedToken);
  }

  parseArray() {
    const start = this.peek().s;
    this.advance();
    const seq = fig.sequence([start, start + 1]);
    for (;;) {
      this.skipBlank();
      if (this.peek().kind === "close_bracket") break;
      seq.items.push(this.parseValue());
      this.skipBlank();
      const k = this.peek().kind;
      if (k === "comma") this.advance();
      else if (k === "close_bracket") break;
      else this.fail(MESSAGES.UnexpectedToken);
    }
    seq.span = [start, this.peek().e];
    this.advance();
    return seq;
  }

  decodeInlineKey(t) {
    const k = t.kind;
    if (k === "string") return this.decodeString(this.text(t), this.peek().s);
    if (k === "key") return this.text(t);
    if (k === "number" || k === "boolean" || k === "datetime") {
      const text = this.sc.binSlice(t.s, t.e);
      if (text === "") this.fail(MESSAGES.InvalidKey);
      for (let j = 0; j < text.length; j++) if (!isBareKeyChar(text.charCodeAt(j))) this.fail(MESSAGES.InvalidKey);
      return text;
    }
    this.fail(MESSAGES.UnexpectedToken);
  }

  parseInlineEntry(map) {
    const segs = [];
    for (;;) {
      const t = this.peek();
      const key = this.decodeInlineKey(t);
      this.advance();
      segs.push({ str: key, span: [t.s, t.e] });
      this.skipFlowWs();
      if (this.peek().kind !== "dot") break;
      this.advance();
      this.skipFlowWs();
    }
    if (this.peek().kind !== "equals") this.fail(MESSAGES.UnexpectedToken);
    this.advance();
    this.skipFlowWs();
    const cur = this.navigateDottedPath(map, segs, segs.length - 1);
    const final = segs[segs.length - 1];
    if (this.lookupChild(cur, final.str) !== null) this.failAt(final.span[0], MESSAGES.DuplicateKey);
    const value = this.parseValue();
    this.appendKeyValue(cur, final, value);
  }

  parseInlineTable() {
    const start = this.peek().s;
    this.advance();
    const map = fig.mapping([start, start + 1], { duplicates: "keep" });
    this.meta.set(map, { inlineTable: true });
    this.skipFlowWs();
    if (this.peek().kind !== "close_brace") {
      for (;;) {
        this.parseInlineEntry(map);
        this.skipFlowWs();
        const k = this.peek().kind;
        if (k === "comma") {
          this.advance();
          this.skipFlowWs();
          if (this.peek().kind === "close_brace") {
            if (!this.v11) this.fail(MESSAGES.UnexpectedToken);
            break;
          }
        } else if (k === "close_brace") {
          break;
        } else {
          this.fail(MESSAGES.UnexpectedToken);
        }
      }
    }
    if (this.peek().kind !== "close_brace") this.fail(MESSAGES.UnexpectedToken);
    map.span = [start, this.peek().e];
    this.advance();
    return map;
  }
}

// ── the document ──

function parse(_dialect, input) {
  const v11 = true;
  const sc = fig.scanner(input);
  const tokens = new Tokenizer(sc.bin, v11).run();
  const p = new Parser(sc, tokens, v11);
  const root = fig.mapping([0, sc.n], { duplicates: "keep" });
  p.root = root;
  p.current = root;
  p.skipBlank();
  while (p.peek().kind !== "end_of_file") {
    const k = p.peek().kind;
    if (k === "key") p.parseKeyValue();
    else if (k === "open_bracket") p.parseTableHeader();
    else if (k === "double_open_bracket") p.parseArrayTable();
    else p.fail(MESSAGES.UnexpectedToken);
    p.requireLineEnd();
    p.skipBlank();
  }
  // Comments left at the end of the file dangle off the table the last
  // header opened.
  p.claimDangling(p.current);
  return fig.rows(root);
}

// ── the printer ───────────────────────────────────────────────────────────
// The compiled printer's layout, rule for rule: the root's scalar and array
// entries as `key = value` lines; a mapping inline when the whole line fits
// the width and nothing in it carries a comment, else a `[section]`; a
// non-empty sequence of mappings always `[[array.of.tables]]`; an array
// wider than the budget wrapped one element per line. TOML puts a table's
// sections after its lines, so a table child that sits before a later
// inline sibling is *demoted* to dotted keys (an inline array, for an array
// of tables) to keep its place — unless it carries comments, which outrank
// order and keep the section form. Widths are byte widths, as the compiled
// printer measures them.

const isBareKey = (name) => /^[A-Za-z0-9_-]+$/.test(name);

const ESCAPES = { '"': '\\"', "\\": "\\\\", "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" };

function basicString(s) {
  return (
    '"' +
    s.replace(/[\x00-\x1f"\\\x7f]/g, (ch) => ESCAPES[ch] ?? "\\u" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")) +
    '"'
  );
}

function keyText(row) {
  if (row.kind !== "string") throw new Error("a TOML key must be a string");
  return row.text ?? "";
}

const spellKey = (name) => (isBareKey(name) ? name : basicString(name));
const spellPath = (path) => path.map(spellKey).join(".");

function tomlSpecial(text) {
  if (text.endsWith("NaN")) return text[0] === "-" ? "-nan" : text[0] === "+" ? "+nan" : "nan";
  return text[0] === "-" ? "-inf" : text[0] === "+" ? "+inf" : "inf";
}

function inlineValue(row) {
  const k = row.kind;
  if (k === "null") throw new Error("TOML has no null; a null value cannot be written");
  if (k === "bool" || k === "int" || k === "float") return row.text;
  if (k === "string") {
    const ext = row.ext_kind;
    if (ext == null) return basicString(row.text ?? "");
    if (ext === "offset_datetime" || ext === "local_datetime" || ext === "local_date" || ext === "local_time") return row.text;
    if (ext === "char_literal") return row.text;
    if (ext === "number_special") return tomlSpecial(row.text);
    return basicString(row.text ?? "");
  }
  if (k === "sequence") return row.items.length === 0 ? "[]" : "[" + row.items.map(inlineValue).join(", ") + "]";
  if (k === "mapping") {
    if (row.items.length === 0) return "{}";
    return "{ " + row.items.map((e) => spellKey(keyText(e.key)) + " = " + inlineValue(e.value)).join(", ") + " }";
  }
  if (k === "alias") throw new Error("an alias must be resolved before it is written as TOML");
  throw new Error("a " + k + " is not a value");
}

const hasComments = (row) => row.leading.length > 0 || row.trailing.length > 0 || row.dangling.length > 0;

function subtreeHasComments(row) {
  if (hasComments(row)) return true;
  if (row.kind === "sequence") return row.items.some(subtreeHasComments);
  if (row.kind === "mapping") return row.items.some((e) => hasComments(e) || subtreeHasComments(e.key) || subtreeHasComments(e.value));
  return false;
}

const allMappings = (row) => row.items.length > 0 && row.items.every((item) => item.kind === "mapping");

function fitsInline(ctx, e) {
  if (e.value.kind === "mapping" && e.value.items.length === 0) return false;
  if (hasComments(e) || subtreeHasComments(e.key) || subtreeHasComments(e.value)) return false;
  return fig.byteLength(spellKey(keyText(e.key))) + 3 + fig.byteLength(inlineValue(e.value)) <= ctx.width;
}

function classify(ctx, e) {
  const v = e.value;
  if (v.kind === "mapping") return fitsInline(ctx, e) ? "inline" : "section";
  if (v.kind === "sequence") return allMappings(v) ? "aot" : "inline";
  return "inline";
}

const demotable = (e) => !(hasComments(e) || subtreeHasComments(e.key) || subtreeHasComments(e.value));

function hashLines(w, list) {
  for (const c of list) {
    for (const line of c.text.split("\n")) {
      const t = line.replace(/^[ \t]+|[ \t]+$/g, "");
      w.put(t === "" ? "#" : "# " + t, "\n");
    }
  }
}

function writeValue(ctx, w, value, col) {
  if (value.kind === "sequence" && ctx.pretty && value.items.length > 0) {
    const text = inlineValue(value);
    if (col + fig.byteLength(text) > ctx.width) {
      w.put("[\n");
      for (const item of value.items) w.put(ctx.unit, inlineValue(item), ",\n");
      w.put("]");
      return;
    }
    w.put(text);
    return;
  }
  w.put(inlineValue(value));
}

function kvLine(ctx, w, e) {
  hashLines(w, e.key.leading);
  const key = spellKey(keyText(e.key));
  w.put(key, " = ");
  writeValue(ctx, w, e.value, fig.byteLength(key) + 3);
  const t = e.value.trailing[0];
  if (t) {
    w.put(" #");
    if (t.text !== "") w.put(" ", t.text.replace(/\n/g, " "));
  }
  w.put("\n");
  ctx.wrote = true;
}

function dottedBody(ctx, w, prefix, map) {
  for (const e of map.items) {
    const path = [...prefix, keyText(e.key)];
    if (e.value.kind === "mapping" && e.value.items.length > 0) {
      dottedBody(ctx, w, path, e.value);
      continue;
    }
    const spelled = spellPath(path);
    w.put(spelled, " = ");
    writeValue(ctx, w, e.value, fig.byteLength(spelled) + 3);
    w.put("\n");
    ctx.wrote = true;
  }
}

function needsHeader(ctx, map) {
  if (map.items.length === 0) return true;
  return map.items.some((e) => classify(ctx, e) === "inline");
}

function section(ctx, w, e, parent) {
  const path = [...parent, keyText(e.key)];
  if (needsHeader(ctx, e.value)) {
    if (ctx.wrote) w.put("\n");
    hashLines(w, e.key.leading);
    w.put("[", spellPath(path), "]\n");
    ctx.wrote = true;
  }
  body(ctx, w, e.value, path);
}

function aot(ctx, w, e, parent) {
  const path = [...parent, keyText(e.key)];
  for (const elem of e.value.items) {
    if (ctx.wrote) w.put("\n");
    w.put("[[", spellPath(path), "]]\n");
    ctx.wrote = true;
    body(ctx, w, elem, path);
  }
}

function body(ctx, w, map, path) {
  let lastInline = -1;
  map.items.forEach((e, i) => {
    if (classify(ctx, e) === "inline") lastInline = i;
  });
  // Pass 1: the lines, in document order, up to the last inline child.
  for (let i = 0; i <= lastInline; i++) {
    const e = map.items[i];
    const cls = classify(ctx, e);
    if (cls === "inline") kvLine(ctx, w, e);
    else if (cls === "section") {
      if (demotable(e)) dottedBody(ctx, w, [keyText(e.key)], e.value);
    } else if (demotable(e)) kvLine(ctx, w, e);
  }
  hashLines(w, map.dangling);
  if (map.dangling.length > 0) ctx.wrote = true;
  // Pass 2: the sections, after the lines; a commented one that could not
  // demote comes here from the middle.
  map.items.forEach((e, i) => {
    const demoted = i <= lastInline && demotable(e);
    const cls = classify(ctx, e);
    if (cls === "section") {
      if (!demoted) section(ctx, w, e, path);
    } else if (cls === "aot") {
      if (!demoted) aot(ctx, w, e, path);
    }
  });
}

function print(_dialect, t, options) {
  options ??= {};
  fig.index(t);
  const w = fig.writer(options);
  const ctx = { width: options.width ?? 80, pretty: options.pretty !== false, unit: " ".repeat(options.indent ?? 2), wrote: false };
  const root = t.byid(0);
  if (root.kind === "mapping") body(ctx, w, root, []);
  // A non-table root has no TOML document form; the inline value is a
  // best-effort fragment.
  else w.put(inlineValue(root), "\n");
  return w.string();
}

// ── the language ──────────────────────────────────────────────────────────

export default {
  name: "js-toml",
  caps: { read: true, edit: true, serialize: true },
  // TOML holds its four datetimes and inf/nan natively; nothing else is
  // native, so a null or an enum literal rides in a `$fig` envelope.
  lossless: { offset_datetime: true, local_datetime: true, local_date: true, local_time: true, number_special: true },
  syntax: {
    comments: { style: "hash", line: { open: "#" }, trailing: { open: "#" } },
    kv_sep: " = ",
    flow_map_pad: " ",
    key_style: "bare_or_quoted",
    empty_map_literal: "{}",
    block_seq_editable: false,
    section_noun: "table",
    section_header: { open: "[", close: "]", seq_open: "[[", seq_close: "]]" },
  },
  // The compiled format owns `.toml`, and a compiled format's extension
  // wins, so this is reached by `--lang js-toml`.
  dialects: [{ name: "js-toml", extensions: ["toml"], splice: "literal", empty_doc_seed: "" }],
  samples: ['a = 1\nb = [1, 2]\n\n[s]\nk = "v"\nt = { x = 1 }\n'],
  renderers: [],
  parse,
  print,
};
