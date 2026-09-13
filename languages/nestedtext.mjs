// NestedText, in JavaScript: the twin of fig's compiled `nestedtext`
// format, row for row, marker for marker.
//
// `fig lang check js-nestedtext --against nestedtext <files…>` holds this
// module to the compiled parser's node table on every file given, and this
// module is written against `fig lang table -i nestedtext`, which prints
// that table. What the compiled format accepts is stated in fig's
// `src/languages/nestedtext/` (`tokenizer.zig`, `parser.zig`,
// `printer.zig`, `editor_helper.zig`), and this follows them function for
// function: the tokenizer classifies every physical line by the tag that
// starts its content, and the parser relates the lines by indentation.
//
// The shape, as the compiled parser builds it:
//
//   * a line is `key: value` or `key:` (a dict item; the key is what
//     precedes the first `: ` or a trailing `:`, trimmed at its end; the
//     value is the rest of the line, exactly), `: text` (a multiline key,
//     its lines joined with `\n`), `- value` (a list item), `> text` (a
//     string block, its lines joined with `\n`), `# comment`, or blank; a
//     value left empty on its line is what the more-indented lines below
//     hold, or the empty string where those lines would begin; a line
//     beginning `{` or `[` where a document or a nested value starts is an
//     inline dict or list, the whole line;
//   * every scalar is a string, and every string is literal — no escapes,
//     no quoting; a `{` after `key: ` is text;
//   * a block container spans its first line's start (indentation
//     included) to its last value's end; a string block and a multiline
//     key likewise; a dict item spans its key through its value with the
//     `:` as its `sep` (zero-width at the key's end for a multiline key);
//     a list item records its `-` as `marker`; an inline container spans
//     its brackets, its entries have no `sep`; a duplicate key is refused;
//   * a comment leads the next key or list item, or dangles on the root
//     when no item follows; nothing trails a value; an empty document is a
//     null spanning nothing at the input's end.
//
// The refusals are the compiled parser's, in its words and at its offsets
// — a line's start for a line that is wrong, the cursor for an inline
// value, the input's start for a duplicate key, which the compiled parser
// reports without a position. Indentation is spaces only: a tab or a
// no-break space where indentation is read is refused. There is no UTF-8
// refusal: the input reaches a module as text the host already decoded.
//
// Every offset is a byte offset: the tokenizer walks the scanner's
// one-char-per-byte shadow of the input (`sc.bin`) and decodes text from
// the bytes a line covers.
import * as fig from "fig";

// ── errors, as the compiled parser words them ─────────────────────────────

const MESSAGES = {
  InvalidIndentChar: "indentation must use plain spaces; a tab or other whitespace character is not allowed here",
  TopLevelIndent: "top-level content must start in column 1",
  InvalidIndentation: "this line's indentation does not match any enclosing block (partial dedent)",
  ExpectedDictItem: "expected a dictionary item (`key: value` or a `: multiline key` line) here",
  ExpectedListItem: "expected a list item (`- value`) here",
  UnrecognizedLine: "this line is not a valid dictionary item, list item, string item, or comment",
  MissingValue: "expected a value here",
  MultilineKeyNoValue: "a multiline key requires a value on a more-indented line",
  MultilineKeyBadValue: "the value of a multiline key must be on a more-indented line",
  DuplicateKey: "this key is already defined in this mapping",
  ExtraContent: "unexpected content after the document's value",
  ExtraCharsAfterDelim: "unexpected content after the closing `}`/`]`",
  UnclosedDelim: "this line ended without a closing `}`/`]`",
  ExpectedColon: "expected `:` after this inline dictionary key",
  ExpectedCommaOrClose: "expected `,` or a closing `}`/`]` here",
};

// ── the tokenizer ─────────────────────────────────────────────────────────
// One record per physical line: `{ kind, indent, lineStart, s, e }` with
// `kind` one of `blank`, `comment`, `dash`, `colon`, `gt`, `other`,
// `end_of_file`; `[s, e)` is the content after the tag and its one space,
// the whole line for `other`.

function tokenize(bin) {
  const n = bin.length;
  let i = 0;
  const lines = [];
  const at = (k) => (k < n ? bin.charCodeAt(k) : undefined);
  if (bin.startsWith("\xef\xbb\xbf")) i = 3;
  while (i < n) {
    const lineStart = i;
    let j = i;
    while (j < n && at(j) === 32) j += 1;
    let e = j;
    while (e < n && at(e) !== 10 && at(e) !== 13) e += 1;
    const indent = j - lineStart;
    if (j === e) {
      lines.push({ kind: "blank", indent, lineStart, s: e, e });
    } else {
      const c = at(j);
      if (c === 9 || (c === 0xc2 && at(j + 1) === 0xa0)) fig.fail(MESSAGES.InvalidIndentChar, lineStart);
      const tagged = (kind) => {
        const after = j + 1;
        if (after < e) lines.push({ kind, indent, lineStart, s: after + 1, e });
        else lines.push({ kind, indent, lineStart, s: e, e });
      };
      const nextIsSpaceOrEnd = j + 1 === e || at(j + 1) === 32;
      if (c === 35) lines.push({ kind: "comment", indent, lineStart, s: j + 1, e });
      else if (c === 45 && nextIsSpaceOrEnd) tagged("dash");
      else if (c === 58 && nextIsSpaceOrEnd) tagged("colon");
      else if (c === 62 && nextIsSpaceOrEnd) tagged("gt");
      else lines.push({ kind: "other", indent, lineStart, s: j, e });
    }
    let k = e;
    if (k < n && at(k) === 13) k += 1;
    if (k < n && at(k) === 10) k += 1;
    i = k;
  }
  lines.push({ kind: "end_of_file", indent: 0, lineStart: n, s: n, e: n });
  return lines;
}

// ── the parser ────────────────────────────────────────────────────────────

// `std.mem.trimEnd(key, " \t\xC2\xA0")`: trailing bytes in that set go — a
// byte at a time, as the compiled parser trims, so the two bytes of a
// no-break space go one by one and so would a lone `\xC2`.
function trimKeyBin(s) {
  let e = s.length;
  while (e > 0) {
    const b = s.charCodeAt(e - 1);
    if (b === 32 || b === 9 || b === 0xc2 || b === 0xa0) e -= 1;
    else break;
  }
  return s.slice(0, e);
}

const isInlineStop = (c) => c === 44 || c === 123 || c === 125 || c === 91 || c === 93;

class Parser {
  constructor(sc) {
    this.sc = sc;
    this.bin = sc.bin;
    this.n = sc.n;
    this.lines = tokenize(sc.bin);
    this.pos = 0;
    this.pending = [];
    this.ipos = 0;
    this.iend = 0;
  }

  peek() {
    return this.lines[this.pos];
  }
  atEnd() {
    return this.peek().kind === "end_of_file";
  }
  text(s, e) {
    return this.sc.slice(s, e);
  }
  failAtLine(l, code) {
    fig.fail(MESSAGES[code], l.lineStart);
  }

  skipBlank() {
    for (;;) {
      const l = this.peek();
      if (l.kind === "comment") {
        this.pending.push(this.text(l.s, l.e));
        this.pos += 1;
      } else if (l.kind === "blank") {
        this.pos += 1;
      } else return;
    }
  }

  takeLeading() {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  // A mapping keeps its entries in order and refuses a repeated key where
  // the compiled parser does: with no position.
  put(map, entry) {
    if (map.byKey.has(entry.key.text)) fig.fail(MESSAGES.DuplicateKey, 0);
    map.put(entry);
  }

  startsWithBracket(l) {
    if (l.e === l.s) return false;
    const c = this.bin.charCodeAt(l.s);
    return c === 123 || c === 91;
  }

  // `key: value` / `key:`: where the key ends and the value begins, or null.
  splitDictItem(l) {
    for (let i = l.s; i < l.e; i++) {
      if (this.bin.charCodeAt(i) !== 58) continue;
      if (i + 1 === l.e) return [i, l.e];
      if (this.bin.charCodeAt(i + 1) === 32) return [i, i + 2];
    }
    return null;
  }

  isDictItemLine(l) {
    if (this.startsWithBracket(l)) return false;
    return this.splitDictItem(l) !== null;
  }

  // The value that belongs here: the whole document (`parentIndent` null,
  // at indent 0) or the block under an item whose own line left its value
  // empty (more indented than `parentIndent`). Nothing there is
  // `onMissing`: a null document, an empty string, or a refusal.
  parseRegion(parentIndent, onMissing) {
    this.skipBlank();
    const noContent = this.atEnd() || (parentIndent !== null && this.peek().indent <= parentIndent);
    if (noContent) {
      if (onMissing === "null_document") return fig.scalar("null", [this.n, this.n]);
      if (onMissing === "empty_string") {
        const at = this.atEnd() ? this.n : this.peek().lineStart;
        return fig.scalar("string", [at, at], "");
      }
      fig.fail(MESSAGES.MissingValue, this.peek().lineStart);
    }
    const first = this.peek();
    const regionIndent = first.indent;
    if (parentIndent === null && regionIndent !== 0) this.failAtLine(first, "TopLevelIndent");
    if (first.kind === "other" && this.startsWithBracket(first)) {
      const node = this.parseInlineLine(first);
      this.pos += 1;
      this.skipBlank();
      const stillInRegion = !this.atEnd() && (parentIndent === null || this.peek().indent > parentIndent);
      if (stillInRegion) this.failAtLine(this.peek(), "ExtraContent");
      return node;
    }
    return this.parseContainerAt(regionIndent);
  }

  parseContainerAt(indent) {
    const first = this.peek();
    if (first.kind === "dash") return this.parseListBlock(indent);
    if (first.kind === "gt") return this.parseStringBlock(indent);
    if (first.kind === "colon") return this.parseDictBlock(indent);
    if (this.isDictItemLine(first)) return this.parseDictBlock(indent);
    this.failAtLine(first, "UnrecognizedLine");
  }

  parseItemValue(s, e, containerIndent) {
    if (e !== s) return fig.scalar("string", [s, e], this.text(s, e));
    return this.parseRegion(containerIndent, "empty_string");
  }

  parseListBlock(indent) {
    const start = this.peek().lineStart;
    const seq = fig.sequence([start, start]);
    let end = start;
    for (;;) {
      this.skipBlank();
      if (this.atEnd()) break;
      const l = this.peek();
      if (l.indent < indent) break;
      if (l.indent > indent) this.failAtLine(l, "InvalidIndentation");
      if (l.kind !== "dash") this.failAtLine(l, "ExpectedListItem");
      this.pos += 1;
      const leading = this.takeLeading();
      const value = this.parseItemValue(l.s, l.e, indent);
      for (const t of leading) value.comment("leading", t);
      const dash = l.lineStart + l.indent;
      value.marker = [dash, dash + 1];
      seq.add(value);
      end = value.span[1];
    }
    seq.span[1] = end;
    return seq;
  }

  // The `: ` lines of a multiline key, or the `> ` lines of a string
  // block, at `indent`: joined with `\n`, spanning the first line's start
  // to the last line's content end; blank and comment lines between are
  // skipped.
  collectLines(kind, indent) {
    const parts = [];
    const start = this.peek().lineStart;
    let end = start;
    for (;;) {
      let i = this.pos;
      while (i < this.lines.length && (this.lines[i].kind === "blank" || this.lines[i].kind === "comment")) i += 1;
      const l = this.lines[i];
      if (l === undefined || l.kind !== kind || l.indent !== indent) break;
      this.pos = i;
      parts.push(this.text(l.s, l.e));
      end = l.e;
      this.pos += 1;
    }
    return [parts.join("\n"), [start, end]];
  }

  parseStringBlock(indent) {
    const [text, span] = this.collectLines("gt", indent);
    return fig.scalar("string", span, text);
  }

  parseDictBlock(indent) {
    const start = this.peek().lineStart;
    const map = fig.mapping([start, start], { duplicates: "keep" });
    let end = start;
    for (;;) {
      this.skipBlank();
      if (this.atEnd()) break;
      const l = this.peek();
      if (l.indent < indent) break;
      if (l.indent > indent) this.failAtLine(l, "InvalidIndentation");
      if (l.kind === "colon") {
        const [text, span] = this.collectLines("colon", indent);
        const key = fig.scalar("string", span, text);
        for (const t of this.takeLeading()) key.comment("leading", t);
        if (this.atEnd()) fig.fail(MESSAGES.MultilineKeyNoValue, this.peek().lineStart);
        if (this.peek().indent <= indent) this.failAtLine(this.peek(), "MultilineKeyBadValue");
        const value = this.parseRegion(indent, "err");
        const kv = fig.entry(key, value, [key.span[0], value.span[1]]);
        kv.sep = [span[1], span[1]];
        this.put(map, kv);
        end = value.span[1];
      } else if (l.kind === "other" && this.isDictItemLine(l)) {
        const [keyEnd, valStart] = this.splitDictItem(l);
        this.pos += 1;
        const keyBin = trimKeyBin(this.bin.slice(l.s, keyEnd));
        const key = fig.scalar("string", [l.s, l.s + keyBin.length], this.text(l.s, l.s + keyBin.length));
        for (const t of this.takeLeading()) key.comment("leading", t);
        const value = this.parseItemValue(valStart, l.e, indent);
        const kv = fig.entry(key, value, [key.span[0], value.span[1]]);
        kv.sep = [keyEnd, keyEnd + 1];
        this.put(map, kv);
        end = value.span[1];
      } else {
        this.failAtLine(l, "ExpectedDictItem");
      }
    }
    map.span[1] = end;
    return map;
  }

  // ── inline values ───────────────────────────────────────────────────────
  // `{…}` and `[…]` on one line, scanned over absolute offsets; the
  // refusals are reported at the cursor.

  skipInlineWs() {
    while (this.ipos < this.iend && (this.bin.charCodeAt(this.ipos) === 32 || this.bin.charCodeAt(this.ipos) === 9)) this.ipos += 1;
  }

  parseInlineLine(l) {
    this.ipos = l.s;
    this.iend = l.e;
    const node = this.parseInlineValue(null);
    this.skipInlineWs();
    if (this.ipos < this.iend) fig.fail(MESSAGES.ExtraCharsAfterDelim, this.ipos);
    return node;
  }

  parseInlineValue(close) {
    this.skipInlineWs();
    if (this.ipos >= this.iend) fig.fail(MESSAGES.UnclosedDelim, this.ipos);
    const c = this.bin.charCodeAt(this.ipos);
    if (c === 123) return this.parseInlineDict();
    if (c === 91) return this.parseInlineList();
    return this.scanInlineValue(close);
  }

  scanInlineValue(close) {
    const start = this.ipos;
    while (this.ipos < this.iend && !isInlineStop(this.bin.charCodeAt(this.ipos))) this.ipos += 1;
    const rawEnd = this.ipos;
    if (this.ipos < this.iend) {
      const stop = this.bin.charCodeAt(this.ipos);
      if (stop !== 44 && stop !== close) fig.fail(MESSAGES.ExpectedCommaOrClose, this.ipos);
    }
    let e = rawEnd;
    while (e > start && (this.bin.charCodeAt(e - 1) === 32 || this.bin.charCodeAt(e - 1) === 9)) e -= 1;
    return fig.scalar("string", [start, rawEnd], this.text(start, e));
  }

  parseInlineEntry(map) {
    this.skipInlineWs();
    const keyStart = this.ipos;
    while (this.ipos < this.iend) {
      const c = this.bin.charCodeAt(this.ipos);
      if (c === 58 || isInlineStop(c)) break;
      this.ipos += 1;
    }
    if (this.ipos >= this.iend) fig.fail(MESSAGES.UnclosedDelim, this.ipos);
    if (this.bin.charCodeAt(this.ipos) !== 58) fig.fail(MESSAGES.ExpectedColon, this.ipos);
    let e = this.ipos;
    while (e > keyStart && (this.bin.charCodeAt(e - 1) === 32 || this.bin.charCodeAt(e - 1) === 9)) e -= 1;
    const key = fig.scalar("string", [keyStart, this.ipos], this.text(keyStart, e));
    this.ipos += 1;
    const value = this.parseInlineValue(125);
    this.put(map, fig.entry(key, value, [key.span[0], value.span[1]]));
  }

  parseInlineDict() {
    const start = this.ipos;
    this.ipos += 1;
    const map = fig.mapping([start, start], { duplicates: "keep" });
    if (this.ipos < this.iend && this.bin.charCodeAt(this.ipos) === 125) {
      this.ipos += 1;
      map.span[1] = this.ipos;
      return map;
    }
    let first = true;
    for (;;) {
      if (!first) {
        this.skipInlineWs();
        if (this.ipos < this.iend && this.bin.charCodeAt(this.ipos) === 125) fig.fail(MESSAGES.MissingValue, this.ipos);
      }
      first = false;
      this.parseInlineEntry(map);
      this.skipInlineWs();
      if (this.ipos >= this.iend) fig.fail(MESSAGES.UnclosedDelim, this.ipos);
      const d = this.bin.charCodeAt(this.ipos);
      if (d === 44) {
        this.ipos += 1;
      } else if (d === 125) {
        this.ipos += 1;
        break;
      } else {
        fig.fail(MESSAGES.ExpectedCommaOrClose, this.ipos);
      }
    }
    map.span[1] = this.ipos;
    return map;
  }

  parseInlineList() {
    const start = this.ipos;
    this.ipos += 1;
    const seq = fig.sequence([start, start]);
    if (this.ipos < this.iend && this.bin.charCodeAt(this.ipos) === 93) {
      this.ipos += 1;
      seq.span[1] = this.ipos;
      return seq;
    }
    for (;;) {
      seq.add(this.parseInlineValue(93));
      this.skipInlineWs();
      if (this.ipos >= this.iend) fig.fail(MESSAGES.UnclosedDelim, this.ipos);
      const d = this.bin.charCodeAt(this.ipos);
      if (d === 44) {
        this.ipos += 1;
      } else if (d === 93) {
        this.ipos += 1;
        break;
      } else {
        fig.fail(MESSAGES.ExpectedCommaOrClose, this.ipos);
      }
    }
    seq.span[1] = this.ipos;
    return seq;
  }
}

function parse(_dialect, input) {
  const sc = fig.scanner(input);
  const p = new Parser(sc);
  const root = p.parseRegion(null, "null_document");
  p.skipBlank();
  if (!p.atEnd()) p.failAtLine(p.peek(), "ExtraContent");
  for (const t of p.takeLeading()) root.comment("dangling", t);
  return fig.rows(root);
}

// ── the printer ───────────────────────────────────────────────────────────
// The compiled printer's layout: block form throughout, four spaces a
// level, `key: value` on one line when the value is a non-empty single
// line and a `>` block below the key otherwise, `- ` items likewise, a key
// that would not read back as one spelled as `: ` lines with its value
// always nested; comments as `#` lines — leading above the item, a
// trailing one on its own line after it, dangling at a container's end.
// A null root prints nothing; a scalar root is a `>` block.

const INDENT = "    ";

function needsMultilineKey(key) {
  if (key === "") return true;
  const c0 = key[0];
  if (c0 === "#" || c0 === "{" || c0 === "[" || c0 === " " || c0 === "\t") return true;
  if ((c0 === "-" || c0 === ":" || c0 === ">") && (key.length === 1 || key[1] === " ")) return true;
  if (key.includes("\n")) return true;
  if (key.includes(": ")) return true;
  return false;
}

function scalarText(row) {
  const k = row.kind;
  if (k === "string" || k === "int" || k === "float" || k === "bool") return row.text ?? "";
  if (k === "null") throw new Error("NestedText has no null; a null value cannot be written");
  if (k === "alias") throw new Error("an alias must be resolved before it is written as NestedText");
  throw new Error("a " + k + " is not a value");
}

class Printer {
  constructor(w) {
    this.w = w;
  }

  indent(depth) {
    this.w.put(INDENT.repeat(depth));
  }

  // `tag` lines (`> ` or `: `) for each line of `text`, a bare tag for an
  // empty line.
  taggedLines(tag, depth, text) {
    for (const line of text.split("\n")) {
      this.indent(depth);
      this.w.put(line === "" ? tag : tag + " " + line, "\n");
    }
  }

  hashLines(texts, depth) {
    for (const c of texts) {
      for (const line of c.text.split("\n")) {
        const t = line.replace(/^[ \t]+|[ \t]+$/g, "");
        this.indent(depth);
        this.w.put(t === "" ? "#" : "# " + t, "\n");
      }
    }
  }

  itemValue(row, depth, forceNested) {
    const { w } = this;
    const k = row.kind;
    if (k === "mapping") {
      if (!forceNested) w.put("\n");
      this.mapping(row, depth + 1);
    } else if (k === "sequence") {
      if (!forceNested) w.put("\n");
      this.sequence(row, depth + 1);
    } else {
      const text = scalarText(row);
      if (!forceNested && text !== "" && !text.includes("\n")) {
        w.put(" ", text, "\n");
      } else {
        if (!forceNested) w.put("\n");
        this.taggedLines(">", depth + 1, text);
      }
    }
  }

  mapping(row, depth) {
    for (const kv of row.items) {
      this.hashLines(kv.key.leading, depth);
      if (kv.key.kind !== "string") throw new Error("a NestedText key must be a string");
      const keyText = kv.key.text ?? "";
      const multiline = needsMultilineKey(keyText);
      if (multiline) {
        this.taggedLines(":", depth, keyText);
      } else {
        this.indent(depth);
        this.w.put(keyText, ":");
      }
      this.itemValue(kv.value, depth, multiline);
      this.hashLines(kv.value.trailing, depth);
    }
    this.hashLines(row.dangling, depth);
  }

  sequence(row, depth) {
    for (const item of row.items) {
      this.hashLines(item.leading, depth);
      this.indent(depth);
      this.w.put("-");
      this.itemValue(item, depth, false);
      this.hashLines(item.trailing, depth);
    }
    this.hashLines(row.dangling, depth);
  }
}

function print(_dialect, t, _options) {
  const w = fig.writer();
  const p = new Printer(w);
  const root = fig.index(t).byid(0);
  if (root.kind === "null") return "";
  if (root.kind === "mapping") p.mapping(root, 0);
  else if (root.kind === "sequence") p.sequence(root, 0);
  else p.taggedLines(">", 0, scalarText(root));
  return w.string();
}

// ── the renderers ─────────────────────────────────────────────────────────
// What the editor splices, spelled as the compiled `editor_helper.zig`
// spells it. `args.indent` is the line's indentation; a value that is
// empty or has a line break goes under its key as a `>` block one level
// in, a single line rides the key's line.

function valueTail(out, childIndent, text, forceNested) {
  if (!forceNested && text !== "" && !text.includes("\n")) {
    out.push(" " + text);
    return;
  }
  for (const line of text.split("\n")) out.push("\n" + childIndent + (line === "" ? ">" : "> " + line));
}

function multilineKeyLines(out, indent, key) {
  key.split("\n").forEach((line, i) => {
    if (i > 0) out.push("\n" + indent);
    out.push(line === "" ? ":" : ": " + line);
  });
}

// Whether the key's source text is the `: ` spelling.
function isMultilineKeyText(key) {
  const k = key.replace(/^[ \t]+/, "");
  if (k === "" || k[0] !== ":") return false;
  if (k.length === 1) return true;
  return k[1] === " " || k[1] === "\n" || k[1] === "\r";
}

function render(which, args) {
  const out = [];
  const indent = args.indent ?? "";
  const child = indent + INDENT;
  if (which === "entry") {
    if (needsMultilineKey(args.key)) {
      multilineKeyLines(out, indent, args.key);
      valueTail(out, child, args.value, true);
    } else {
      out.push(args.key + ":");
      valueTail(out, child, args.value, false);
    }
  } else if (which === "item") {
    out.push("-");
    valueTail(out, child, args.value, false);
  } else if (which === "tail") {
    if (args.key === "") {
      args.value.split("\n").forEach((line, i) => {
        if (i > 0) out.push("\n");
        out.push(line === "" ? ">" : "> " + line);
      });
    } else {
      const multiline = isMultilineKeyText(args.key);
      if (!multiline) out.push(":");
      valueTail(out, child, args.value, multiline);
    }
  } else if (which === "key") {
    const wasMultiline = isMultilineKeyText(args.old_key ?? "");
    const wantsMultiline = needsMultilineKey(args.key);
    if (wantsMultiline && !wasMultiline) {
      throw new Error("this key needs the `: ` multiline spelling, which cannot replace a plain key in place");
    }
    if (wantsMultiline) {
      out.push(indent);
      multilineKeyLines(out, indent, args.key);
    } else if (wasMultiline) {
      out.push(args.key + ":");
    } else {
      out.push(args.key);
    }
  } else {
    throw new Error("no renderer named " + String(which));
  }
  return out.join("");
}

export default {
  name: "js-nestedtext",
  caps: { read: true, edit: true, serialize: true },
  syntax: {
    comments: { style: "hash", line: { open: "#" } },
    kv_sep: ": ",
    indent_unit: "    ",
    seq_item_marker: "- ",
  },
  // The compiled format owns `.nt`, and a compiled format's extension
  // wins, so this is reached by `--lang js-nestedtext`.
  dialects: [{ name: "js-nestedtext", extensions: ["nt"], splice: "raw", empty_doc_seed: "" }],
  samples: ["a: 1\nb:\n  - x\n  - y\n"],
  // The compiled editor's four renderers: an entry, an item, a value's
  // tail after its key, and a key over an old one.
  renderers: ["entry", "item", "tail", "key"],
  parse,
  print,
  render,
};
