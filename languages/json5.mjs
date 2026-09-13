// JSONC and JSON5, in JavaScript: the twins of fig's compiled `jsonc` and
// `json5` dialects — one module, two dialects, as the compiled JSON module
// is one parser with a dialect switch — row for row.
//
// `fig lang check js-jsonc --against jsonc <files…>` and `fig lang check
// js-json5 --against json5 <files…>` hold this module to the compiled
// parser's node table on every file given, and this module is written
// against `fig lang table -i jsonc` / `-i json5`, which print that table.
// What the compiled dialects accept is stated in fig's
// `src/languages/json/` (`tokenizer.zig`, `parser.zig`, `printer.zig`),
// and this follows them function for function: the tokenizer runs over
// the whole file first, then a state machine over its tokens. Strict JSON
// is `json.mjs`, written as a grammar; this is the compiled shape, because
// the comments are what make these dialects, and the compiled parser
// binds them by looking at the tokens around each one.
//
// The shape, as the compiled parser builds it:
//
//   * JSONC is JSON with `//` and `/* */` comments; JSON5 adds unquoted
//     `identifier` keys (and `true`/`false`/`null` as keys), single-quoted
//     strings, the escapes `\x`, `\v`, `\0`, `\'`, any other `\c` as `c`,
//     a `\` before a line ending as a continuation, trailing commas,
//     `Infinity`/`NaN` (signed too) as `number_special` strings, `0x`
//     integers, `.5`, `5.`, `+1`, and `\v`/`\f` as whitespace;
//   * a container spans its brackets, an entry its key through its value;
//     a number keeps its lexeme and is a float when it has a `.` or an
//     exponent (a `0x` integer never); a duplicate key keeps both entries;
//   * a comment that is the last thing on the line of the value just
//     finished trails it — or dangles on a container whose closing line
//     it is; one right after a `[` or `{` that ends its line trails the
//     container; any other waits and leads the next key, value or
//     container, or dangles on the container that closes with it still
//     waiting; what waits after the document is dropped. A comment's text
//     is trimmed; a block comment's style is `block`.
//
// The refusals are the compiled parser's, in its words and at its
// offsets: a tokenizer error where its cursor stopped, a parser error at
// the start of the token it was dispatching (the document's end, for a
// document that ended early). Nearly everything is `UnexpectedToken`, as
// in strict JSON.
//
// Every offset is a byte offset: the tokenizer walks the scanner's
// one-char-per-byte shadow of the input (`sc.bin`) and decodes text from
// the bytes a token covers.
import * as fig from "fig";

// ── errors, as the compiled parser words them ─────────────────────────────

const MESSAGES = {
  UnexpectedToken: "unexpected token here; check for a missing comma, colon, key, or closing bracket/brace",
  UnexpectedEndOfInput: "the document ended before this value/token was complete",
  UnclosedString: "unclosed string; a JSON string cannot span multiple lines — add the closing quote, or escape the newline as `\\n`",
  LeadingZero: "a number cannot have a leading zero; write the digits without the padding, or quote it as a string to keep the padding (e.g. a zip code)",
  UnexpectedSlash: "a `/` here must start a `//` or `/* */` comment, and strict JSON has no comments at all — use a .jsonc/.json5 file, or remove it",
  UnclosedComment: "unclosed block comment; add the closing `*/`",
  InvalidUnicodeEscape: "invalid `\\u` escape; it needs exactly 4 hex digits (e.g. `\\u00e9`)",
};

// ── the tokenizer ─────────────────────────────────────────────────────────
// Tokens are `{ kind, s, e }` over 0-based byte offsets. A failure is
// reported where the compiled tokenizer's cursor stopped.

const isDigit = (b) => b !== undefined && b >= 48 && b <= 57;
const isHex = (b) => b !== undefined && (isDigit(b) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102));
const isIdentStart = (b) => b !== undefined && ((b >= 97 && b <= 122) || (b >= 65 && b <= 90) || b === 95 || b === 36);
const isIdentPart = (b) => isIdentStart(b) || isDigit(b);
// `std.ascii.isWhitespace`: space, tab, newline, return, vertical tab, form feed.
const isSpace = (b) => b === 32 || b === 9 || b === 10 || b === 13 || b === 11 || b === 12;

function tokenize(bin, json5) {
  const n = bin.length;
  let i = 0;
  const tokens = [];
  const at = (k) => (k < n ? bin.charCodeAt(k) : undefined);
  const fail = (message) => fig.fail(message, i);
  const emit = (kind, s, e) => {
    tokens.push({ kind, s, e });
    i = e;
  };
  const matches = (word) => bin.startsWith(word, i);

  const literal = (word, kind) => {
    if (!matches(word)) fail(MESSAGES.UnexpectedToken);
    emit(kind, i, i + word.length);
  };

  const whitespace = () => {
    const s = i;
    while (i < n && isSpace(at(i))) i += 1;
    emit("whitespace", s, i);
  };

  const identifierOrKeyword = () => {
    const s = i;
    while (i < n && isIdentPart(at(i))) i += 1;
    const word = bin.slice(s, i);
    const kind = word === "true" ? "true_" : word === "false" ? "false_" : word === "null" ? "null_" : "identifier";
    emit(kind, s, i);
  };

  const stringToken = (delimiter) => {
    const s = i;
    i += 1;
    while (i < n) {
      const c = at(i);
      if (c === delimiter) {
        i += 1;
        emit("string", s, i);
        return;
      }
      if (c === 92) {
        i += 1;
        const escaped = at(i);
        if (escaped === undefined) fail(MESSAGES.UnclosedString);
        if (json5) {
          // Any escape is consumed here and judged by the parser; a `\'`
          // or a `\<newline>` must not end the string.
          i += 1;
          if (escaped === 13 && at(i) === 10) i += 1;
        } else if (
          escaped === 34 || escaped === 92 || escaped === 47 || escaped === 98 || escaped === 102 ||
          escaped === 110 || escaped === 114 || escaped === 116
        ) {
          i += 1;
        } else if (escaped === 117) {
          i += 1;
          for (let k = 0; k < 4; k++) {
            const h = at(i);
            if (h === undefined) fail(MESSAGES.UnclosedString);
            if (!isHex(h)) fail(MESSAGES.UnexpectedToken);
            i += 1;
          }
        } else {
          fail(MESSAGES.UnexpectedToken);
        }
      } else if (c < 32) {
        fail(MESSAGES.UnexpectedToken);
      } else {
        i += 1;
      }
    }
    fail(MESSAGES.UnclosedString);
  };

  const digits = () => {
    while (i < n && isDigit(at(i))) i += 1;
  };

  const numberJson = () => {
    const s = i;
    if (at(i) === 45) i += 1;
    const c = at(i);
    if (c === undefined) fail(MESSAGES.UnexpectedEndOfInput);
    if (c === 48) {
      i += 1;
      if (isDigit(at(i))) fail(MESSAGES.LeadingZero);
    } else if (c >= 49 && c <= 57) {
      i += 1;
      digits();
    } else {
      fail(MESSAGES.UnexpectedToken);
    }
    if (at(i) === 46) {
      i += 1;
      const f = at(i);
      if (f === undefined) fail(MESSAGES.UnexpectedEndOfInput);
      if (!isDigit(f)) fail(MESSAGES.UnexpectedToken);
      digits();
    }
    const e = at(i);
    if (e === 101 || e === 69) {
      i += 1;
      const sign = at(i);
      if (sign === 43 || sign === 45) i += 1;
      const x = at(i);
      if (x === undefined) fail(MESSAGES.UnexpectedEndOfInput);
      if (!isDigit(x)) fail(MESSAGES.UnexpectedToken);
      digits();
    }
    emit("number", s, i);
  };

  // An ES5 numeric literal: a sign, then `Infinity`, `NaN`, a `0x` integer,
  // or a decimal with a leading or trailing point and an exponent. A
  // leading zero before a digit stays refused.
  const numberJson5 = () => {
    const s = i;
    if (at(i) === 43 || at(i) === 45) i += 1;
    if (matches("Infinity")) {
      emit("number", s, i + 8);
      return;
    }
    if (matches("NaN")) {
      emit("number", s, i + 3);
      return;
    }
    if (at(i) === 48 && (at(i + 1) === 120 || at(i + 1) === 88)) {
      i += 2;
      const hs = i;
      while (i < n && isHex(at(i))) i += 1;
      if (i === hs) fail(MESSAGES.UnexpectedToken);
      emit("number", s, i);
      return;
    }
    let seen = false;
    if (at(i) === 48) {
      i += 1;
      seen = true;
      if (isDigit(at(i))) fail(MESSAGES.LeadingZero);
    } else {
      while (i < n && isDigit(at(i))) {
        i += 1;
        seen = true;
      }
    }
    if (at(i) === 46) {
      i += 1;
      while (i < n && isDigit(at(i))) {
        i += 1;
        seen = true;
      }
    }
    if (!seen) fail(MESSAGES.UnexpectedToken);
    const e = at(i);
    if (e === 101 || e === 69) {
      i += 1;
      const sign = at(i);
      if (sign === 43 || sign === 45) i += 1;
      const xs = i;
      digits();
      if (i === xs) fail(MESSAGES.UnexpectedEndOfInput);
    }
    emit("number", s, i);
  };

  const comment = () => {
    if (i + 1 >= n) fail(MESSAGES.UnexpectedSlash);
    const s = i;
    const second = at(i + 1);
    if (second === 47) {
      i += 2;
      while (i < n && at(i) !== 10 && at(i) !== 13) i += 1;
      emit("comment", s, i);
    } else if (second === 42) {
      i += 2;
      while (i + 1 < n) {
        if (at(i) === 42 && at(i + 1) === 47) {
          i += 2;
          emit("comment", s, i);
          return;
        }
        i += 1;
      }
      fail(MESSAGES.UnclosedComment);
    } else {
      fail(MESSAGES.UnexpectedSlash);
    }
  };

  if (bin.startsWith("\xef\xbb\xbf")) i = 3;
  while (i < n) {
    const c = at(i);
    if (json5 && isIdentStart(c)) identifierOrKeyword();
    else if (json5 && c === 39) stringToken(39);
    else if (json5 && (c === 43 || c === 46)) numberJson5();
    else if (json5 && (c === 11 || c === 12)) whitespace();
    else if (c === 123) emit("open_brace", i, i + 1);
    else if (c === 125) emit("close_brace", i, i + 1);
    else if (c === 91) emit("open_bracket", i, i + 1);
    else if (c === 93) emit("close_bracket", i, i + 1);
    else if (c === 58) emit("colon", i, i + 1);
    else if (c === 44) emit("comma", i, i + 1);
    else if (c === 116) literal("true", "true_");
    else if (c === 102) literal("false", "false_");
    else if (c === 110) literal("null", "null_");
    else if (c === 34) stringToken(34);
    else if (c === 47) comment();
    else if (isDigit(c) || c === 45) {
      if (json5) numberJson5();
      else numberJson();
    } else if (c === 32 || c === 9 || c === 10 || c === 13) whitespace();
    else fail(MESSAGES.UnexpectedToken);
  }
  emit("end_of_file", n, n);
  return tokens;
}

// ── decoding ──────────────────────────────────────────────────────────────
// Over the one-char-per-byte shadow, so an escape yields bytes and the text
// is the bytes decoded at the end; `\u` yields a codepoint's UTF-8.

const SIMPLE_ESCAPES = { '"': 34, "\\": 92, "/": 47, b: 8, f: 12, n: 10, r: 13, t: 9 };
const HEX2 = /^[0-9a-fA-F]{2}$/;
const HEX4 = /^[0-9a-fA-F]{4}$/;

function utf8Bytes(cp) {
  if (cp < 0x80) return [cp];
  if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
  if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
  return [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
}

// The text of a string token (over `bin`, quotes included): `{ text }`, or
// `{ error }` with the message the compiled parser refuses it with.
function decodeString(slice, json5) {
  const quote = slice[0];
  const validQuote = quote === '"' || (json5 && quote === "'");
  if (slice.length < 2 || !validQuote || slice[slice.length - 1] !== quote) return { error: "UnclosedString" };
  const inner = slice.slice(1, -1);
  if (!inner.includes("\\")) return { text: fig.textOf(binBytes(inner)) };
  const out = [];
  let i = 0;
  const n = inner.length;
  while (i < n) {
    const c = inner.charCodeAt(i);
    if (c !== 92) {
      out.push(c);
      i += 1;
      continue;
    }
    i += 1;
    if (i >= n) return { error: "UnclosedString" };
    const e = inner[i];
    if (Object.hasOwn(SIMPLE_ESCAPES, e)) {
      out.push(SIMPLE_ESCAPES[e]);
    } else if (e === "'") {
      if (!json5) return { error: "UnexpectedToken" };
      out.push(39);
    } else if (e === "v") {
      if (!json5) return { error: "UnexpectedToken" };
      out.push(11);
    } else if (e === "0") {
      if (!json5) return { error: "UnexpectedToken" };
      out.push(0);
    } else if (e === "x") {
      if (!json5) return { error: "UnexpectedToken" };
      if (i + 2 >= n) return { error: "UnclosedString" };
      const hex = inner.slice(i + 1, i + 3);
      if (!HEX2.test(hex)) return { error: "InvalidUnicodeEscape" };
      out.push(...utf8Bytes(parseInt(hex, 16)));
      i += 2;
    } else if (e === "\n") {
      if (!json5) return { error: "UnexpectedToken" };
    } else if (e === "\r") {
      if (!json5) return { error: "UnexpectedToken" };
      if (inner[i + 1] === "\n") i += 1;
    } else if (e === "u") {
      // One UTF-16 unit in four hex digits; a surrogate pair joins; an
      // unpaired surrogate keeps the whole string as written.
      if (i + 4 >= n) return { error: "UnclosedString" };
      const hex = inner.slice(i + 1, i + 5);
      if (!HEX4.test(hex)) return { error: "InvalidUnicodeEscape" };
      let cp = parseInt(hex, 16);
      i += 4;
      if (cp >= 0xd800 && cp <= 0xdbff) {
        if (i + 6 >= n) return { text: fig.textOf(binBytes(inner)) };
        if (inner[i + 1] !== "\\" || inner[i + 2] !== "u") return { text: fig.textOf(binBytes(inner)) };
        const lo = inner.slice(i + 3, i + 7);
        if (!HEX4.test(lo)) return { error: "InvalidUnicodeEscape" };
        const lcp = parseInt(lo, 16);
        if (!(lcp >= 0xdc00 && lcp <= 0xdfff)) return { text: fig.textOf(binBytes(inner)) };
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lcp - 0xdc00);
        i += 6;
      } else if (cp >= 0xdc00 && cp <= 0xdfff) {
        return { text: fig.textOf(binBytes(inner)) };
      }
      out.push(...utf8Bytes(cp));
    } else {
      if (!json5) return { error: "UnexpectedToken" };
      out.push(inner.charCodeAt(i));
    }
    i += 1;
  }
  return { text: fig.textOf(new Uint8Array(out)) };
}

function binBytes(bin) {
  const bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  return bytes;
}

// `Infinity`/`NaN`, optionally signed.
function isSpecialNumber(raw) {
  const body = raw[0] === "+" || raw[0] === "-" ? raw.slice(1) : raw;
  return body === "Infinity" || body === "NaN";
}

function numberKind(raw) {
  const body = raw[0] === "+" || raw[0] === "-" ? raw.slice(1) : raw;
  if (/^0[xX]/.test(body)) return "int";
  if (raw.includes(".")) return "float";
  if (/[eE]/.test(raw)) return "float";
  return "int";
}

// ── the parser ────────────────────────────────────────────────────────────
// The compiled state machine over the tokens; comments are bound as the
// token loop meets them, by what stands around them.

const isValueToken = (k) => k === "null_" || k === "true_" || k === "false_" || k === "string" || k === "number" || k === "identifier";
const isKeyToken = (k) => k === "string" || k === "identifier" || k === "true_" || k === "false_" || k === "null_";

class Parser {
  constructor(sc, json5, tokens) {
    this.sc = sc;
    this.bin = sc.bin;
    this.json5 = json5;
    this.tokens = tokens;
    this.state = "ExpectValue";
    this.stack = [];
    this.pending = [];
    this.lastValue = null;
    this.root = null;
  }

  fail(message, token) {
    fig.fail(MESSAGES[message] ?? message, token.s);
  }

  raw(t) {
    return this.bin.slice(t.s, t.e);
  }

  claimLeading(node) {
    if (this.pending.length === 0) return;
    for (const c of this.pending) node.comment("leading", c.text, c.style);
    this.pending = [];
  }

  addNode(node) {
    this.claimLeading(node);
    return node;
  }

  scalarNode(token) {
    const raw = this.raw(token);
    const k = token.kind;
    const span = [token.s, token.e];
    if (k === "null_") return this.addNode(fig.scalar("null", span));
    if (k === "true_" || k === "false_") return this.addNode(fig.scalar("bool", span, raw));
    if (k === "string") {
      const d = decodeString(raw, this.json5);
      if (d.error) this.fail(d.error, token);
      return this.addNode(fig.scalar("string", span, d.text));
    }
    if (k === "number" || k === "identifier") {
      if (isSpecialNumber(raw)) return this.addNode(fig.scalar("string", span, raw, { ext_kind: "number_special" }));
      if (k === "identifier") this.fail("UnexpectedToken", token);
      return this.addNode(fig.scalar(numberKind(raw), span, raw));
    }
    this.fail("UnexpectedToken", token);
  }

  open(kind, token) {
    const node = kind === "object" ? fig.mapping([token.s, token.e], { duplicates: "keep" }) : fig.sequence([token.s, token.e]);
    this.addNode(node);
    this.stack.push({ kind, node, pendingKey: null });
    this.state = kind === "object" ? "ExpectObjectKeyOrEnd" : "ExpectArrayValueOrEnd";
  }

  close(token) {
    if (this.stack.length === 0) this.fail("UnexpectedToken", token);
    const frame = this.stack.pop();
    frame.node.span[1] = token.e;
    if (this.pending.length > 0) {
      for (const c of this.pending) frame.node.comment("dangling", c.text, c.style);
      this.pending = [];
    }
    return frame.node;
  }

  beginKey(token) {
    if (token.kind !== "string" && !this.json5) this.fail("UnexpectedToken", token);
    let text;
    if (token.kind === "string") {
      const d = decodeString(this.raw(token), this.json5);
      if (d.error) this.fail(d.error, token);
      text = d.text;
    } else {
      text = this.sc.slice(token.s, token.e);
    }
    const key = this.addNode(fig.scalar("string", [token.s, token.e], text));
    this.stack[this.stack.length - 1].pendingKey = key;
    this.state = "ExpectObjectColon";
  }

  finishValue(value, token) {
    this.lastValue = value;
    if (this.stack.length === 0) {
      this.root = value;
      this.state = "ExpectEndOfFile";
      return;
    }
    const frame = this.stack[this.stack.length - 1];
    if (frame.kind === "array") {
      frame.node.add(value);
      this.state = "ExpectArrayCommaOrEnd";
    } else {
      const key = frame.pendingKey;
      if (key === null) this.fail("UnexpectedToken", token);
      frame.pendingKey = null;
      frame.node.put(fig.entry(key, value, [key.span[0], value.span[1]]));
      this.state = "ExpectObjectCommaOrEnd";
    }
  }

  value(token) {
    const k = token.kind;
    if (k === "open_brace") this.open("object", token);
    else if (k === "open_bracket") this.open("array", token);
    else if (isValueToken(k)) this.finishValue(this.scalarNode(token), token);
    else this.fail("UnexpectedToken", token);
  }

  dispatch(token) {
    const { state } = this;
    const k = token.kind;
    if (state === "ExpectValue" || state === "ExpectObjectValue") {
      this.value(token);
    } else if (state === "ExpectArrayValueOrEnd") {
      if (k === "close_bracket") this.finishValue(this.close(token), token);
      else this.value(token);
    } else if (state === "ExpectArrayCommaOrEnd") {
      if (k === "close_bracket") this.finishValue(this.close(token), token);
      else if (k === "comma") this.state = this.json5 ? "ExpectArrayValueOrEnd" : "ExpectValue";
      else this.fail("UnexpectedToken", token);
    } else if (state === "ExpectObjectKeyOrEnd") {
      if (isKeyToken(k)) this.beginKey(token);
      else if (k === "close_brace") this.finishValue(this.close(token), token);
      else this.fail("UnexpectedToken", token);
    } else if (state === "ExpectObjectKey") {
      if (isKeyToken(k)) this.beginKey(token);
      else this.fail("UnexpectedToken", token);
    } else if (state === "ExpectObjectColon") {
      if (k === "colon") this.state = "ExpectObjectValue";
      else this.fail("UnexpectedToken", token);
    } else if (state === "ExpectObjectCommaOrEnd") {
      if (k === "close_brace") this.finishValue(this.close(token), token);
      else if (k === "comma") this.state = this.json5 ? "ExpectObjectKeyOrEnd" : "ExpectObjectKey";
      else this.fail("UnexpectedToken", token);
    } else if (state === "ExpectEndOfFile") {
      if (k !== "end_of_file") this.fail("UnexpectedToken", token);
    }
  }

  hasNewline(t) {
    return this.bin.slice(t.s, t.e).includes("\n");
  }

  // Whether the comment at `i` is the last content on its line: what
  // follows is a newline, a comma, a closer or the end. A value, a key or
  // another comment first on the same line means this one leads that.
  endsLine(i) {
    for (let j = i + 1; j < this.tokens.length; j++) {
      const t = this.tokens[j];
      if (t.kind === "whitespace") {
        if (this.hasNewline(t)) return true;
      } else if (t.kind === "comma" || t.kind === "close_brace" || t.kind === "close_bracket" || t.kind === "end_of_file") {
        return true;
      } else {
        return false;
      }
    }
    return true;
  }

  // Whether the last significant token before `i`, on the same line, is a
  // `[` or `{`: a comment riding the line a container opened on.
  afterOpenDelimiter(i) {
    for (let j = i - 1; j >= 0; j--) {
      const t = this.tokens[j];
      if (t.kind === "whitespace") {
        if (this.hasNewline(t)) return false;
      } else if (t.kind === "open_bracket" || t.kind === "open_brace") {
        return true;
      } else {
        return false;
      }
    }
    return false;
  }

  // Whether `node` is a container whose opener is on an earlier line than
  // `at`: a multi-line container whose close is on the comment's line.
  multilineContainer(node, at) {
    if (node.kind !== "mapping" && node.kind !== "sequence") return false;
    const open = node.span[0];
    if (at <= open) return false;
    return this.bin.slice(open, at).includes("\n");
  }

  handleComment(i) {
    const token = this.tokens[i];
    const raw = this.sc.slice(token.s, token.e);
    let c;
    if (raw[1] === "*") c = { text: raw.slice(2, -2).replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ""), style: "block" };
    else c = { text: raw.slice(2).replace(/^[ \t\r]+|[ \t\r]+$/g, ""), style: "line" };
    if (this.lastValue !== null && this.endsLine(i)) {
      const node = this.lastValue;
      this.lastValue = null;
      node.comment(this.multilineContainer(node, token.s) ? "dangling" : "trailing", c.text, c.style);
    } else if (this.endsLine(i) && this.stack.length > 0 && this.afterOpenDelimiter(i)) {
      this.stack[this.stack.length - 1].node.comment("trailing", c.text, c.style);
    } else {
      this.pending.push(c);
    }
  }
}

function parseDocument(input, json5) {
  const sc = fig.scanner(input);
  const tokens = tokenize(sc.bin, json5);
  const p = new Parser(sc, json5, tokens);
  tokens.forEach((token, i) => {
    if (token.kind === "whitespace") {
      if (p.hasNewline(token)) p.lastValue = null;
    } else if (token.kind === "comment") {
      p.handleComment(i);
    } else {
      p.dispatch(token);
    }
  });
  if (p.root === null) fig.fail(MESSAGES.UnexpectedToken, sc.n);
  return p.root;
}

function parse(dialect, input) {
  return fig.rows(parseDocument(input, dialect === "js-json5"));
}

// ── the printer ───────────────────────────────────────────────────────────
// The compiled printer's layout, as `json.mjs` has it — one element per
// line at `indent` spaces a level when `pretty`, nothing but the tokens
// otherwise — plus what the dialects add: comments (leading above a
// member, trailing after its comma, a container's own after its opener,
// dangling before its close; `pretty` only), and in JSON5 a bare
// identifier key, `Infinity`/`NaN` as written, and the number spellings
// JSON5 reads (`0xC8`, `.5`, `+1`). A number no JSON can read is written
// as decimal.

const QUOTE = { '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };

function quote(s) {
  return '"' + s.replace(/[\x00-\x1f"\\]/g, (ch) => QUOTE[ch] ?? "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")) + '"';
}

const isBareIdentifier = (name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);

// Whether a format that spells `s` reads `raw` back as the same number.
function spellable(raw, s) {
  let body = raw;
  if (raw[0] === "+" || raw[0] === "-") {
    if (raw[0] === "+" && !s.plus) return false;
    body = raw.slice(1);
  }
  if (body === "") return false;
  if (!s.underscores && body.includes("_")) return false;
  if (body.length >= 2 && body[0] === "0") {
    const r = body[1].toLowerCase();
    if (r === "x") return s.hex === true;
    if (r === "o") return s.octal === true;
    if (r === "b") return s.binary === true;
  }
  if (!s.bareDot && (body[0] === "." || body[body.length - 1] === ".")) return false;
  if (!s.leadingZero) {
    const m = body.search(/[.eE]/);
    const intEnd = m < 0 ? body.length : m;
    if (intEnd > 1 && body[0] === "0") return false;
  }
  return true;
}

// `raw` as a decimal lexeme every format reads: radix converted, `_` and
// `+` dropped, bare dots padded, leading zeros stripped.
function canonicalNumber(raw) {
  let out = "";
  let s = raw;
  if (s[0] === "-") {
    out += "-";
    s = s.slice(1);
  } else if (s[0] === "+") {
    s = s.slice(1);
  }
  if (s.length >= 2 && s[0] === "0" && /[xob]/.test(s[1].toLowerCase())) {
    const digits = s.slice(2).replace(/_/g, "");
    const base = { x: 16, o: 8, b: 2 }[s[1].toLowerCase()];
    const valid = { 16: /^[0-9a-fA-F]+$/, 8: /^[0-7]+$/, 2: /^[01]+$/ }[base];
    if (valid.test(digits)) {
      let v = 0n;
      for (const d of digits) v = v * BigInt(base) + BigInt(parseInt(d, base));
      return out + v.toString();
    }
    return out + s;
  }
  const eIdx = s.search(/[eE]/);
  const mantissa = eIdx < 0 ? s : s.slice(0, eIdx);
  const exponent = eIdx < 0 ? "" : s.slice(eIdx);
  const dot = mantissa.indexOf(".");
  const intPart = dot < 0 ? mantissa : mantissa.slice(0, dot);
  const intDigits = intPart.replace(/_/g, "").replace(/^0+/, "");
  out += intDigits === "" ? "0" : intDigits;
  if (dot >= 0) {
    const frac = mantissa.slice(dot + 1).replace(/_/g, "");
    out += "." + (frac === "" ? "0" : frac);
  }
  return out + exponent.replace(/_/g, "");
}

const JSON_SPELLING = {};
const JSON5_SPELLING = { hex: true, bareDot: true, plus: true };

const isContainer = (row) => row.kind === "mapping" || row.kind === "sequence";

class Printer {
  constructor(w, json5) {
    this.w = w;
    this.json5 = json5;
  }

  commentsOn() {
    return this.w.pretty;
  }

  commentText(c) {
    if (c.style === "block") return c.text === "" ? "/**/" : "/* " + c.text + " */";
    return c.text === "" ? "//" : "// " + c.text;
  }

  leading(row, depth) {
    if (!this.commentsOn()) return;
    for (const c of row.leading) this.w.indent(depth).put(this.commentText(c), "\n");
  }

  trailing(row) {
    if (!this.commentsOn()) return;
    const c = row.trailing[0];
    if (c) this.w.put(" ", this.commentText(c));
  }

  key(row) {
    const { w } = this;
    const k = row.kind;
    if (k === "string") {
      if (this.json5 && !row.ext_kind && isBareIdentifier(row.text ?? "")) w.put(row.text);
      else w.put(quote(row.text ?? ""));
    } else if (k === "null") {
      w.put(quote("null"));
    } else if (k === "bool" || k === "int" || k === "float") {
      w.put(quote(row.text ?? ""));
    } else if (k === "alias") {
      throw new Error("an alias must be resolved before it is written as JSON");
    } else {
      throw new Error("a JSON key must be a string");
    }
  }

  node(row, depth) {
    const { w } = this;
    const k = row.kind;
    if (k === "null") w.put("null");
    else if (k === "bool") w.put(row.text);
    else if (k === "int" || k === "float") {
      if (row.ext_kind === "char_literal") {
        w.put(row.text);
      } else {
        const raw = row.text ?? "";
        w.put(spellable(raw, this.json5 ? JSON5_SPELLING : JSON_SPELLING) ? raw : canonicalNumber(raw));
      }
    } else if (k === "string") {
      if (row.ext_kind === "number_special" && this.json5) w.put(row.text);
      else w.put(quote(row.text ?? ""));
    } else if (k === "sequence" || k === "mapping") {
      this.container(row, depth);
    } else if (k === "keyvalue") {
      this.key(row.key);
      w.put(w.pretty ? ": " : ":");
      this.node(row.value, depth);
    } else if (k === "alias") {
      throw new Error("an alias must be resolved before it is written as JSON");
    } else {
      throw new Error("a " + k + " is not a value");
    }
  }

  container(row, depth) {
    const { w } = this;
    const [open, close] = row.kind === "mapping" ? ["{", "}"] : ["[", "]"];
    const dangling = this.commentsOn() ? row.dangling : [];
    if (row.items.length === 0 && dangling.length === 0) {
      w.put(open, close);
      this.trailing(row);
      return;
    }
    w.put(open);
    this.trailing(row);
    w.nl();
    row.items.forEach((item, i) => {
      const lead = item.kind === "keyvalue" ? item.key : item;
      const trail = item.kind === "keyvalue" ? item.value : item;
      this.leading(lead, depth + 1);
      w.indent(depth + 1);
      this.node(item, depth + 1);
      if (i < row.items.length - 1) w.put(",");
      if (!isContainer(trail)) this.trailing(trail);
      w.nl();
    });
    for (const c of dangling) w.indent(depth + 1).put(this.commentText(c), "\n");
    w.indent(depth).put(close);
  }
}

function print(dialect, t, options) {
  const w = fig.writer(options);
  const p = new Printer(w, dialect === "js-json5");
  const root = fig.index(t).byid(0);
  p.leading(root, 0);
  p.node(root, 0);
  if (!isContainer(root)) p.trailing(root);
  w.put("\n");
  return w.string();
}

export default {
  name: "js-json5",
  caps: { read: true, edit: true, serialize: true },
  // Beyond the core kinds, `null` and nothing else: every extended scalar
  // rides in a `$fig` envelope, JSON5's own `Infinity`/`NaN` included.
  lossless: { null: true },
  syntax: {
    comments: { style: "slashes", line: { open: "//" }, trailing: { open: "//" } },
    kv_sep: ": ",
    key_style: "json_quoted",
    empty_map_literal: "{}",
  },
  // The language's own name goes on its first dialect; the compiled
  // dialects own `.json5` and `.jsonc`, and a compiled format's extension
  // wins, so these are reached by `--lang js-json5` / `--lang js-jsonc`.
  dialects: [
    { name: "js-json5", extensions: ["json5"], splice: "json_string", empty_doc_seed: "{}\n" },
    { name: "js-jsonc", extensions: ["jsonc"], splice: "json_string", empty_doc_seed: "{}\n" },
  ],
  samples: ['{"a": 1, "b": [true, null, "s"], "c": {"d": 2.5}}\n', "// top\n[] // empty\n"],
  renderers: [],
  parse,
  print,
};
