// OpenStep property lists, in JavaScript: the text form Xcode writes
// `project.pbxproj` in and `Localizable.strings` is a dictionary of —
// the older sibling of the XML plist `plist.mjs` twins, and the one
// `plutil` calls `openstep`.
//
// The format:
//
//   * a value is a dictionary `{ key = value; … }`, an array `( a, b, )`,
//     data `<0fb3 …>` (hex pairs, whitespace ignored), or a string — in
//     double quotes with `\"`, `\\`, `\n`, `\t`, `\r`, `\a`, `\b`, `\f`,
//     `\v`, octal `\ooo` and `\Uxxxx` escapes, or bare when it is nothing
//     but letters, digits and `_$/:.-`; every entry ends in `;`, every
//     item in `,` but the last, which may;
//   * a key is a string; a repeated key keeps the first entry's place and
//     takes the last value, as `plutil` does;
//   * `/* … */` and `//` comments, anywhere whitespace may be; Xcode's
//     `A1B2 /* Foo.swift */ = …` trails its key and `fileRef = C3D4 /*
//     Foo.swift */;` trails its value, and the `// !$*UTF8*$!` on the
//     first line leads the root;
//   * a document is one value; a `.strings` file is the entries of a
//     dictionary with the braces left off, read as a root mapping and
//     tagged `!strings` so that it prints the same way back.
//
// Every scalar is a string, as `plutil` reads them — `1` and `"1"` are
// the same value, and `YES` is text. Data is the one extended scalar,
// carried as `plist_data` with its bytes in base64, the convention the
// XML twin uses, so that a document converted between the two forms
// keeps its data. Spans are byte offsets, 0-based, `[start, end)`; a
// container's span runs from its open to its close bracket, a string's
// over its quotes, and an entry's from its key to its value.
//
// Partial by design: the generic editor replaces a value, adds or deletes
// an entry or an item, expands `{}` and `()` around a first member, and
// `set` vivifies a missing dictionary as `{}`. A dictionary or array
// written on one line, `{isa = PBXBuildFile; fileRef = C3D4; }`, takes
// no new member in place, because a line-based splice would land the
// member on the next line outside it. The renderers refused it where the
// file is tab-indented, as Xcode's are, by the spaces fig's engine padded
// the member's indent with out to the container's column; an engine that
// no longer pads (fig's 63c448b) gives them nothing to tell it by, and the
// member lands after the line, in the enclosing dictionary. A `.strings`
// file in UTF-16 does not arrive: the host decodes UTF-8 alone. The same
// object `@diaryx/fig`'s `registerLanguage` takes, so it serves the
// browser and Node unchanged.
import * as fig from "fig";
import * as G from "fig/grammar";

// ── lexical pieces ────────────────────────────────────────────────────────

const isBareChar = (c) =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 36 || c === 47 || c === 58 || c === 46 || c === 45;
const isHex = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 13;

const trivia = G.trivia({
  space: G.ws1,
  comment: G.choice([G.comment({ open: "/*", close: "*/", unclosed: "unclosed comment; expected `*/`" }), G.comment("//")]),
});

const SIMPLE_ESCAPES = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", '"': '"', "\\": "\\", "'": "'" };

// A `"…"` string: the span over its quotes, the text decoded.
function quoted(sc) {
  if (sc.byte() !== 34) return null;
  const s = sc.pos;
  sc.advance();
  let out = "";
  for (;;) {
    const c = sc.byte();
    if (c === undefined) fig.fail("unclosed string; expected a closing `\"`", s);
    if (c === 34) break;
    if (c === 92) {
      const at = sc.pos;
      const n = sc.byte(1);
      if (n === undefined) fig.fail("unclosed string; expected a closing `\"`", s);
      const ch = String.fromCharCode(n);
      if (Object.hasOwn(SIMPLE_ESCAPES, ch)) {
        out += SIMPLE_ESCAPES[ch];
        sc.advance(2);
      } else if (n >= 48 && n <= 55) {
        // Up to three octal digits.
        let i = 1;
        let v = 0;
        while (i <= 3 && sc.byte(i) >= 48 && sc.byte(i) <= 55) {
          v = v * 8 + (sc.byte(i) - 48);
          i += 1;
        }
        out += String.fromCharCode(v);
        sc.advance(i);
      } else if (ch === "U" || ch === "u") {
        let i = 2;
        while (i < 6 && isHex(sc.byte(i))) i += 1;
        if (i !== 6) fig.fail("`\\U` takes four hex digits", at);
        out += String.fromCharCode(parseInt(sc.slice(at + 2, at + 6), 16));
        sc.advance(6);
      } else {
        fig.fail("invalid escape `\\" + ch + "` in a string", at);
      }
      continue;
    }
    const from = sc.pos;
    sc.advance();
    while (sc.byte() >= 128) sc.advance();
    out += sc.slice(from, sc.pos);
  }
  sc.advance();
  return fig.scalar("string", [s, sc.pos], out);
}

function bare(sc) {
  const s = sc.pos;
  while (isBareChar(sc.byte())) sc.advance();
  if (sc.pos === s) return null;
  return fig.scalar("string", [s, sc.pos], sc.slice(s, sc.pos));
}

const string = (sc) => quoted(sc) ?? bare(sc);

// `<0fb3 …>`: hex pairs, whitespace between them ignored, carried as
// base64.
function data(sc) {
  if (sc.byte() !== 60) return null;
  const s = sc.pos;
  sc.advance();
  const bytes = [];
  let pending = -1;
  for (;;) {
    const c = sc.byte();
    if (c === undefined) fig.fail("unclosed data; expected a closing `>`", s);
    if (c === 62) break;
    if (isWs(c)) {
      sc.advance();
      continue;
    }
    if (!isHex(c)) sc.fail("data holds hex digits only");
    const d = parseInt(String.fromCharCode(c), 16);
    if (pending < 0) pending = d;
    else {
      bytes.push(pending * 16 + d);
      pending = -1;
    }
    sc.advance();
  }
  if (pending >= 0) sc.fail("data holds whole bytes; this hex digit has no pair");
  sc.advance();
  return fig.scalar("string", [s, sc.pos], base64(bytes), { ext_kind: "plist_data" });
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : B64[c & 63];
  }
  return out;
}

function fromBase64(text) {
  const bytes = [];
  let bits = 0;
  let n = 0;
  for (const ch of text) {
    const v = B64.indexOf(ch);
    if (v < 0) {
      if (ch === "=") break;
      throw new Error("data is not base64");
    }
    bits = (bits << 6) | v;
    n += 6;
    if (n >= 8) {
      n -= 8;
      bytes.push((bits >> n) & 255);
    }
  }
  return bytes;
}

// ── the grammar ───────────────────────────────────────────────────────────

let value;

// `key = value;` — the key takes a comment on its line before the `=`,
// the value one before or after the `;`.
function entry(sc, ctx) {
  const k = string(sc);
  if (k == null) return null;
  ctx.flush(k, "leading");
  ctx.last = k;
  trivia(sc, ctx);
  if (sc.lit("=") == null) sc.fail("expected `=` after this key");
  trivia(sc, ctx);
  const v = value(sc, ctx);
  if (v == null) sc.fail("expected a value after `=`");
  ctx.last = v;
  trivia(sc, ctx);
  if (sc.lit(";") == null) sc.fail("expected `;` after this value");
  return fig.entry(k, v);
}

// The entries of a dictionary up to `close` — `}` or, for a braceless
// `.strings` file, the end of the input.
function entries(sc, ctx, m, close) {
  for (;;) {
    trivia(sc, ctx);
    if (close) {
      if (sc.lit("}") != null) return;
      if (sc.eof()) sc.fail("unclosed dictionary; expected `}`", m.span[0]);
    } else if (sc.eof()) {
      return;
    }
    const e = entry(sc, ctx);
    if (e == null) sc.fail("expected a `key = value;` entry here");
    m.put(e);
    ctx.last = e.value;
  }
}

function dict(sc, ctx) {
  if (sc.byte() !== 123) return null;
  const s = sc.pos;
  sc.advance();
  const m = fig.mapping([s, s], { duplicates: "last_value" });
  entries(sc, ctx, m, true);
  m.span = [s, sc.pos];
  ctx.flush(m, "dangling");
  ctx.last = m;
  return m;
}

function array(sc, ctx) {
  if (sc.byte() !== 40) return null;
  const s = sc.pos;
  sc.advance();
  const q = fig.sequence([s, s]);
  for (;;) {
    trivia(sc, ctx);
    if (sc.lit(")") != null) break;
    if (sc.eof()) sc.fail("unclosed array; expected `)`", s);
    const v = value(sc, ctx);
    if (v == null) sc.fail("expected a value here");
    q.add(v);
    ctx.flush(v, "leading");
    ctx.last = v;
    trivia(sc, ctx);
    if (sc.lit(",") != null) continue;
    if (sc.byte() !== 41) sc.fail("expected `,` or `)` after this item");
  }
  q.span = [s, sc.pos];
  ctx.flush(q, "dangling");
  ctx.last = q;
  return q;
}

value = (sc, ctx) => dict(sc, ctx) ?? array(sc, ctx) ?? data(sc) ?? string(sc);

function parse(_dialect, input) {
  const sc = fig.scanner(input);
  if (sc.bytes[0] === 0xef && sc.bytes[1] === 0xbb && sc.bytes[2] === 0xbf) sc.pos = 3;
  const ctx = G.context(sc);
  trivia(sc, ctx);
  // What stands before the document leads it: Xcode's `// !$*UTF8*$!`.
  const lead = ctx.pending;
  ctx.pending = [];
  let root;
  const c = sc.byte();
  if (c === 123 || c === 40 || c === 60) {
    root = value(sc, ctx);
  } else {
    // A `.strings` file: entries with no braces around them.
    root = fig.mapping([0, sc.n], { duplicates: "last_value" });
    root.tag = "!strings";
    entries(sc, ctx, root, false);
    ctx.last = root;
  }
  trivia(sc, ctx);
  if (!sc.eof()) sc.fail("unexpected content after the document; a property list is one value");
  for (const l of lead) root.comment("leading", l.text, l.style);
  ctx.flush(root, "dangling");
  return fig.rows(root);
}

// ── the printer ───────────────────────────────────────────────────────────
// Xcode's own layout: tab-indented, one entry or item per line, every
// item with its comma, `{` and `(` closing on their own line even when
// empty — except a `PBXBuildFile` or `PBXFileReference` object, which
// Xcode writes on one line. A string is bare when Xcode would leave it
// bare, quoted otherwise. A block comment trailing a key or value is written inline
// where Xcode writes it, before the `;` or `,`; a line comment leads its
// entry.

// What Xcode leaves bare: narrower than what is read, which also takes
// `-` and `:`, so a file Xcode wrote comes back as Xcode wrote it.
const BARE = /^[A-Za-z0-9_$./]+$/;

function spellString(s, always) {
  if (!always && BARE.test(s)) return s;
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (code < 32) out += "\\U" + code.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

function spellData(text) {
  const bytes = fromBase64(text);
  let out = "<";
  bytes.forEach((b, i) => {
    if (i > 0 && i % 4 === 0) out += " ";
    out += b.toString(16).padStart(2, "0");
  });
  return out + ">";
}

const ind = (depth) => "\t".repeat(depth);

function inlineComments(list) {
  let out = "";
  for (const c of list) out += " /* " + c.text + " */";
  return out;
}

// Whether the output so far ends in a blank line.
function afterBlank(w) {
  const tail = w.parts.slice(-2).join("");
  return w.parts.length === 0 || tail.endsWith("\n\n");
}

const SECTION_MARK = /^(Begin|End) .* section$/;

// Leading comments, each on its own line. Xcode's `/* Begin X section */`
// and `/* End X section */` stand at the left margin, a blank line above
// each `Begin`, and are written back that way.
function leading(w, list, depth) {
  for (const c of list) {
    if (c.style === "block" && SECTION_MARK.test(c.text)) {
      if (c.text.startsWith("Begin") && !afterBlank(w)) w.put("\n");
      w.put("/* ", c.text, " */\n");
      continue;
    }
    for (const line of c.text.split("\n")) {
      const t = line.replace(/^[ \t]+|[ \t]+$/g, "");
      w.put(ind(depth), c.style === "block" ? "/* " + t + " */" : t === "" ? "//" : "// " + t, "\n");
    }
  }
}

// The objects Xcode writes on one line: `{isa = PBXBuildFile; fileRef =
// B2 /* Foo.swift */; }`.
const ONE_LINE_ISA = new Set(["PBXBuildFile", "PBXFileReference"]);

function isOneLine(m) {
  const isa = m.items.find((e) => e.key.kind === "string" && e.key.text === "isa");
  if (!isa || isa.value.kind !== "string" || !ONE_LINE_ISA.has(isa.value.text)) return false;
  return m.items.every((e) => fig.isScalar(e.value.kind) && e.key.leading.length === 0 && e.value.leading.length === 0) && m.dangling.length === 0;
}

function writeValue(w, row, depth) {
  const k = row.kind;
  if (k === "string") {
    w.put(row.ext_kind === "plist_data" ? spellData(row.text ?? "") : spellString(row.text ?? ""));
  } else if (k === "int" || k === "float" || k === "bool") {
    w.put(spellString(row.text ?? ""));
  } else if (k === "null") {
    throw new Error("an OpenStep property list has no null; a null value cannot be written");
  } else if (k === "alias") {
    throw new Error("an alias must be resolved before it is written as a property list");
  } else if (k === "mapping") {
    if (isOneLine(row)) {
      w.put("{");
      for (const e of row.items) {
        w.put(spellString(e.key.text ?? ""), inlineComments(e.key.trailing), " = ");
        writeValue(w, e.value, depth);
        w.put(inlineComments(e.value.trailing), "; ");
      }
      w.put("}");
      return;
    }
    w.put("{\n");
    writeEntries(w, row, depth + 1);
    w.put(ind(depth), "}");
  } else if (k === "sequence") {
    w.put("(\n");
    for (const item of row.items) {
      leading(w, item.leading, depth + 1);
      w.put(ind(depth + 1));
      writeValue(w, item, depth + 1);
      w.put(inlineComments(item.trailing), ",\n");
    }
    leading(w, row.dangling, depth + 1);
    w.put(ind(depth), ")");
  } else {
    throw new Error("a " + k + " is not a value");
  }
}

function writeEntries(w, m, depth, quoted) {
  for (const e of m.items) {
    if (e.key.kind !== "string") throw new Error("a property list key must be a string");
    leading(w, e.key.leading, depth);
    w.put(ind(depth), spellString(e.key.text ?? "", quoted), inlineComments(e.key.trailing), " = ");
    if (quoted && e.value.kind === "string" && !e.value.ext_kind) w.put(spellString(e.value.text ?? "", true));
    else writeValue(w, e.value, depth);
    w.put(inlineComments(e.value.trailing), ";\n");
  }
  leading(w, m.dangling, depth);
}

function print(_dialect, t, _options) {
  fig.index(t);
  const root = t.byid(0);
  const w = fig.writer();
  leading(w, root.leading, 0);
  if (root.kind === "mapping" && root.tag === "!strings") {
    // A `.strings` file, as Xcode writes one: every key and value quoted.
    writeEntries(w, root, 0, true);
    return w.string();
  }
  writeValue(w, root, 0);
  w.put("\n");
  return w.string();
}

// ── the renderers ─────────────────────────────────────────────────────────
// A value is text the CLI hands over, spelled as a string — bare when it
// can be — unless it is already a dictionary, an array, data or a quoted
// string, which is spliced as written. An entry ends in `;`, an item in
// `,`, and a value over several lines is moved under the member's indent.
// Where the target's indentation is tabs padded with spaces, the member
// the engine is placing would follow a container written on one line, and
// land outside it: refused. (Only an engine that pads says so; see the
// header.)

function oneLine(indent) {
  return /^\t+ +$/.test(indent);
}

// A value over several lines — a dictionary or array spliced as the
// printer writes it, its lines at the top level — moved under the member's
// indent, so its entries and its close bracket land at the member's depth.
function under(indent, text) {
  const [first, ...rest] = text.split("\n");
  return [first, ...rest.map((line) => (line === "" ? "" : indent + line))].join("\n");
}

function render(which, args) {
  if (which === "value") {
    const t = args.value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
    if (t[0] === "{" || t[0] === "(" || t[0] === "<" || (t[0] === '"' && t.endsWith('"') && t.length >= 2)) return t;
    return spellString(t);
  }
  if (which === "entry") {
    if (oneLine(args.indent)) throw new Error("this dictionary is written on one line; an entry cannot be added to it in place");
    return under(args.indent, spellString(args.key) + " = " + args.value + ";");
  }
  if (which === "item") {
    if (oneLine(args.indent)) throw new Error("this array is written on one line; an item cannot be added to it in place");
    return under(args.indent, args.value + ",");
  }
  throw new Error("no renderer `" + which + "`");
}

// ── the language ──────────────────────────────────────────────────────────

export default {
  name: "js-openstep",
  caps: { read: true, edit: true, serialize: true },
  // No `lossless` declaration: the CLI's lossy strip for a language that
  // makes one rebuilds the tree without its tags, and `!strings` is a tag
  // this printer needs. A null reaching the printer is refused instead.
  syntax: {
    comments: { style: "slashes", line: { open: "//" }, trailing: { open: "//" } },
    kv_sep: " = ",
    empty_map_literal: "{}",
    // `{` opens a dictionary whose entries end in `;`, not a comma-separated
    // flow container: every container is edited line by line.
    flow_containers: false,
    indent_unit: "\t",
    seq_item_marker: "",
    closed_containers: { map_open: "{", map_close: "}", seq_open: "(", seq_close: ")" },
  },
  dialects: [{ name: "js-openstep", extensions: ["pbxproj", "strings"], splice: "raw", empty_doc_seed: "{\n}\n" }],
  samples: [
    '// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tobjects = {\n\t\tA1 /* Foo.swift */ = {isa = PBXBuildFile; fileRef = B2 /* Foo.swift */; };\n\t};\n\tlist = (\n\t\ta,\n\t\t"b c",\n\t);\n}\n',
  ],
  renderers: ["value", "entry", "item"],
  parse,
  print,
  render,
};
