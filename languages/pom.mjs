// Maven's `pom.xml`, in JavaScript — and, by the same rules, any XML
// document shaped like one: elements holding either text or elements,
// never both, with a list spelled as a run of same-named children.
//
// fig retired generic XML as a format because an XML document is not a
// tree of values until someone says which elements are a list and which
// a record; a language is where that someone lives, and this one answers
// the way every Maven-to-JSON tool does:
//
//   * an element holding text is a string, trimmed, entities and CDATA
//     decoded; an element holding nothing is the empty string;
//   * an element holding elements is a mapping keyed by their names — or
//     a sequence of them when they all share one name and there are two
//     or more, or one whose parent is its plural (`dependencies` holding
//     one `dependency`, `includes` holding one `include`); the sequence
//     row carries the item name as its tag, `!dependency`, so that a
//     printer can spell the items back;
//   * an attribute is an entry `@name`, after the element's children,
//     with its value decoded; an element holding text and an attribute is
//     a mapping with the text under `#text`;
//   * the root element's name rides the root mapping as its tag,
//     `!project`; the XML declaration, a DOCTYPE without a subset and
//     processing instructions are skipped; `<!-- -->` comments are kept,
//     leading the next element, trailing one on its line, or dangling at
//     an element's close;
//   * text among elements is refused: mixed content is a document, not a
//     record.
//
// Spans are byte offsets, 0-based, `[start, end)`: a node's span is what
// stands between its tags — a string's the trimmed run of its text, a
// container's everything from its open tag to its close tag — so that
// replacing a value replaces the content alone and needs no element
// name, and a list replaced by text becomes a text element; an
// attribute's is the text inside its quotes; an entry's is the whole
// element or attribute; a key's is `<name`, from the opening bracket, so
// that the indentation a new sibling copies is the element's own.
//
// Partial by design: the generic editor replaces a value, adds or deletes
// an entry in a mapping (spelled `<key>value</key>` by the entry
// renderer) and comments one; a sequence takes no new item in place,
// since the item renderer is not told the element name a new item needs;
// an element is not renamed in place, since its close tag would not
// follow; `set` does not vivify a missing element; and an entry added to
// an element that has attributes lands first among its children, since
// the attributes are the entries the engine splices after. A container a
// binding hands the editor (`options.splice`) is its content, its children
// one level in: a new entry takes it indented under itself, and a value
// replaced takes it as it stands, which the engine does not re-indent; a
// list not tagged with its item name, or an attribute, is refused: neither
// has a spelling as content.
// An element written empty as `<a/>` has no text position: it reads as
// the empty string over the whole element, and a value written there
// lands over the element, which the reparse refuses. The same object
// `@diaryx/fig`'s `registerLanguage` takes, so it serves the browser and
// Node unchanged.
import * as fig from "fig";
import * as G from "fig/grammar";
import XML from "fig/xml";

const X = XML.with({
  unexpected: "unexpected content here; expected an element",
  textNotAllowed: "text among elements is mixed content, which has no place in a record",
  noElement: (name) => "`<" + name + ">` holds text; an element inside it is mixed content, which has no place in a record",
});

const isSpace = (c) => c === 32 || c === 9 || c === 13 || c === 10;

// ── trivia ────────────────────────────────────────────────────────────────
// Whitespace, comments (bound), processing instructions and a DOCTYPE
// (skipped), up to a tag or text.

function trivia(sc, ctx) {
  const s = sc.pos;
  for (;;) {
    while (!sc.eof() && isSpace(sc.byte())) sc.advance();
    if (sc.eof() || sc.byte() !== 60) break;
    if (sc.starts("<!--")) {
      const cs = sc.pos;
      const at = sc.find("-->");
      if (at < 0) fig.fail(X.messages.unclosedComment, cs);
      const text = sc.slice(cs + 4, at).replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
      sc.pos = at + 3;
      const c = [cs, sc.pos];
      c.text = text;
      c.style = "block";
      ctx.comment(c);
      continue;
    }
    if (sc.starts("<?") || sc.starts("<!DOCTYPE")) {
      X.skipMarkup(sc);
      continue;
    }
    break;
  }
  return [s, sc.pos];
}

// ── elements ──────────────────────────────────────────────────────────────

const tagRule = X.tag({ attributes: true });

// The span of an attribute's value inside its quotes, found from where
// its name begins.
function attrValueSpan(sc, attr) {
  let i = attr.s;
  while (sc.bytes[i] !== 34 && sc.bytes[i] !== 39) i += 1;
  const start = i + 1;
  return [start, start + fig.byteLength(attr.value)];
}

function attributeEntries(sc, tag) {
  const out = [];
  for (const a of tag.attrs) {
    const span = attrValueSpan(sc, a);
    const key = fig.scalar("string", [a.s, a.s + fig.byteLength(a.name)], "@" + a.name);
    const value = fig.scalar("string", span, X.decodeEntities(a.value, span[0]));
    out.push(fig.entry(key, value, [a.s, span[1] + 1]));
  }
  return out;
}

// The text content of an opened `tag` through its close tag: the decoded
// text, trimmed, and the span of the trimmed run. Entities and CDATA are
// decoded; a comment or processing instruction inside is skipped; an
// element inside is refused.
function textContent(sc, tag) {
  const inner = sc.pos;
  let raw = "";
  let plain = true; // no CDATA, comment or entity: the span is the trimmed run
  for (;;) {
    if (sc.eof()) sc.fail("`<" + tag.name + ">` is never closed");
    if (sc.byte() === 60) {
      if (sc.starts("</")) break;
      if (sc.starts("<![CDATA[")) {
        plain = false;
        sc.advance(9);
        const at = sc.find("]]>");
        if (at < 0) fig.fail(X.messages.unclosedCdata, sc.pos - 9);
        raw += sc.slice(sc.pos, at);
        sc.pos = at + 3;
      } else if (X.skipMarkup(sc)) {
        plain = false;
      } else {
        sc.fail(X.messages.noElement(tag.name));
      }
    } else {
      const s = sc.pos;
      let at = sc.find("<");
      if (at < 0) at = sc.n;
      sc.pos = at;
      const piece = sc.slice(s, at);
      if (piece.includes("&")) plain = false;
      raw += X.decodeEntities(piece, s);
    }
  }
  const end = sc.pos;
  X.close(tag.name)(sc);
  const text = raw.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
  if (!plain) return { text, span: [inner, end] };
  const lead = raw.length - raw.replace(/^[ \t\n\r]+/, "").length;
  const trail = raw.length - raw.replace(/[ \t\n\r]+$/, "").length;
  return { text, span: [inner + lead, end - (text === "" ? lead : trail)] };
}

// Whether `parent` is the plural of `child` — `dependencies`/`dependency`,
// `plugins`/`plugin`, `includes`/`include` — or ends in it, as
// `compilerArgs`/`arg` and `annotationProcessorPaths`/`path` do.
function plurals(word) {
  const out = [word + "s", word + "es"];
  if (word.endsWith("y")) out.push(word.slice(0, -1) + "ies");
  return out;
}

function isPluralOf(parent, child) {
  if (plurals(child).includes(parent)) return true;
  const cap = child[0].toUpperCase() + child.slice(1);
  return plurals(cap).some((p) => parent.length > p.length && parent.endsWith(p));
}

// An opened `tag` as a node: a string over its text, or a mapping or a
// sequence over its children.
function element(sc, ctx, tag) {
  const attrs = attributeEntries(sc, tag);
  if (tag.empty) {
    if (attrs.length === 0) return fig.scalar("string", [tag[0], tag[1]], "");
    const m = fig.mapping([tag[0], tag[1]], { duplicates: "keep" });
    for (const e of attrs) m.put(e);
    return m;
  }
  // What the element holds is settled by the first thing after its open
  // tag that is not trivia: a tag, the close tag, or text.
  const after = sc.pos;
  const inner = G.context(sc);
  trivia(sc, inner);
  const children = [];
  if (sc.byte() === 60 && X.isNameStart(sc.byte(1))) {
    // Elements. The comments met so far wait for the first child.
    for (const c of inner.pending) ctx.pending.push(c);
    for (;;) {
      const t = tagRule(sc);
      if (t == null) {
        if (sc.starts("</")) break;
        if (sc.eof()) sc.fail("`<" + tag.name + ">` is never closed");
        sc.fail(X.messages.textNotAllowed);
      }
      const key = fig.scalar("string", [t[0], t.nameStart + fig.byteLength(t.name)], t.name);
      ctx.flush(key, "leading");
      const node = element(sc, ctx, t);
      children.push(fig.entry(key, node, [t[0], sc.pos]));
      ctx.last = node;
      trivia(sc, ctx);
    }
    const end = sc.pos; // the close tag begins here
    X.close(tag.name)(sc);
    const names = new Set(children.map((e) => e.key.text));
    const one = names.size === 1 ? children[0].key.text : null;
    if (one !== null && attrs.length === 0 && (children.length >= 2 || isPluralOf(tag.name, one))) {
      const q = fig.sequence([after, end]);
      q.tag = "!" + one;
      for (const e of children) {
        // The item takes the comments its element's name took.
        for (const c of e.key.leading ?? []) e.value.comment("leading", c.text, c.style);
        q.add(e.value);
      }
      ctx.flush(q, "dangling");
      ctx.last = q;
      return q;
    }
    const m = fig.mapping([after, end], { duplicates: "keep" });
    for (const e of children) m.put(e);
    for (const e of attrs) m.put(e);
    ctx.flush(m, "dangling");
    ctx.last = m;
    return m;
  }
  // Text, or nothing. Comments inside a text element are skipped as
  // markup; the ones met so far are dropped with them.
  sc.pos = after;
  const { text, span } = textContent(sc, tag);
  const s = fig.scalar("string", span, text);
  if (attrs.length === 0) return s;
  const m = fig.mapping([after, span[1]], { duplicates: "keep" });
  m.put(fig.entry(fig.scalar("string", [after, after], "#text"), s, span));
  for (const e of attrs) m.put(e);
  return m;
}

function parse(_dialect, input) {
  const sc = fig.scanner(input);
  if (sc.bytes[0] === 0xef && sc.bytes[1] === 0xbb && sc.bytes[2] === 0xbf) sc.pos = 3;
  const ctx = G.context(sc);
  trivia(sc, ctx);
  const lead = ctx.pending;
  ctx.pending = [];
  if (sc.eof()) sc.fail("no document here; expected a root element");
  const tag = tagRule(sc);
  if (tag == null) sc.fail("expected the root element here");
  const root = element(sc, ctx, tag);
  root.tag = "!" + tag.name;
  for (const c of lead) root.comment("leading", c.text, c.style);
  trivia(sc, ctx);
  if (!sc.eof()) sc.fail(sc.byte() === 60 ? "a document holds one root element; a second begins here" : X.messages.textNotAllowed);
  ctx.flush(root, "dangling");
  return fig.rows(root);
}

// ── the printer ───────────────────────────────────────────────────────────
// The XML declaration, then the root element with its attributes, one
// element per line indented by `options.indent` per depth, text escaped,
// an empty string as `<a></a>` so that it keeps a text position. A
// sequence spells its items by its tag, or by the singular of its key
// when a tree built elsewhere carries none. Comments are `<!-- -->`
// lines, a trailing one on the element's line.

function singular(name) {
  if (name.endsWith("ies")) return name.slice(0, -3) + "y";
  if (name.endsWith("ses") || name.endsWith("xes") || name.endsWith("shes") || name.endsWith("ches")) return name.slice(0, -2);
  if (name.endsWith("s")) return name.slice(0, -1);
  throw new Error("a list under `<" + name + ">` needs an item element name, and `" + name + "` has no singular");
}

const escapeAttr = (s) => X.escape(s).replace(/"/g, "&quot;");

function textOf(row) {
  const k = row.kind;
  if (k === "string" || k === "int" || k === "float" || k === "bool") return row.text ?? "";
  if (k === "null") return "";
  if (k === "alias") throw new Error("an alias must be resolved before it is written as XML");
  throw new Error("a " + k + " is not text");
}

function validName(name) {
  if (!/^[A-Za-z_:][A-Za-z0-9_:.-]*$/.test(name)) throw new Error("`" + name + "` is not an XML element name");
  return name;
}

function writeComments(w, list, depth) {
  for (const c of list) w.line(depth, "<!-- ", c.text, " -->");
}

function trailing(w, row) {
  for (const c of row.trailing) w.put(" <!-- ", c.text, " -->");
}

// `<name …>` through `</name>` for `row`, on the current line; a
// container's children on lines of their own.
function writeElement(w, name, row, depth) {
  validName(name);
  if (row.kind === "sequence") {
    const item = row.tag && row.tag[0] === "!" ? row.tag.slice(1) : singular(name);
    if (row.items.length === 0) return w.put("<", name, "></", name, ">");
    w.put("<", name, ">").nl();
    for (const it of row.items) {
      writeComments(w, it.leading, depth + 1);
      w.indent(depth + 1);
      writeElement(w, item, it, depth + 1);
      trailing(w, it);
      w.nl();
    }
    writeComments(w, row.dangling, depth + 1);
    return w.indent(depth).put("</", name, ">");
  }
  if (row.kind === "mapping") {
    const attrs = row.items.filter((e) => e.key.kind === "string" && e.key.text.startsWith("@"));
    const text = row.items.find((e) => e.key.kind === "string" && e.key.text === "#text");
    const rest = row.items.filter((e) => !attrs.includes(e) && e !== text);
    w.put("<", name);
    for (const a of attrs) w.put(" ", a.key.text.slice(1), '="', escapeAttr(textOf(a.value)), '"');
    if (text) return w.put(">", X.escape(textOf(text.value)), "</", name, ">");
    if (rest.length === 0) return w.put("></", name, ">");
    w.put(">").nl();
    for (const e of rest) {
      if (e.key.kind !== "string") throw new Error("an element name must be a string");
      writeComments(w, e.key.leading, depth + 1);
      w.indent(depth + 1);
      writeElement(w, e.key.text, e.value, depth + 1);
      trailing(w, e.value);
      w.nl();
    }
    writeComments(w, row.dangling, depth + 1);
    return w.indent(depth).put("</", name, ">");
  }
  return w.put("<", name, ">", X.escape(textOf(row)), "</", name, ">");
}

// Splice text for a container: what stands between its element's tags —
// the node's span — which is its children on lines of their own, one level
// in, and the line break before the close tag. The entry renderer or the
// element already in place supplies the tags. What content cannot carry
// is refused: an attribute belongs to the opening tag, and a list's items
// are elements named for the list, a name the value is not told.
function spliceContent(root, options) {
  if (root.kind === "mapping" && root.items.some((e) => e.key.kind === "string" && e.key.text.startsWith("@"))) {
    throw new Error("an attribute belongs to an element's opening tag; a mapping with `@` entries cannot be spliced as a value");
  }
  if (root.kind === "sequence" && root.items.length > 0 && !(root.tag && root.tag[0] === "!")) {
    throw new Error("a list's items are elements named for the list, a name a spliced value is not told");
  }
  const w = fig.writer(options);
  writeElement(w, "splice", root, 0);
  const s = w.string();
  return s.slice(s.indexOf(">") + 1, s.lastIndexOf("</"));
}

function print(_dialect, t, options) {
  fig.index(t);
  const root = t.byid(0);
  const w = fig.writer(options);
  if (fig.isScalar(root.kind)) {
    // A fragment: the text, escaped, as it stands inside its element.
    w.put(X.escape(textOf(root)));
    return w.string();
  }
  // Splice text: the content, with no declaration and no root element.
  if (options?.splice) return spliceContent(root, options);
  const name = root.tag && root.tag[0] === "!" ? root.tag.slice(1) : "project";
  w.put('<?xml version="1.0" encoding="UTF-8"?>').nl();
  writeComments(w, root.leading, 0);
  writeElement(w, name, root, 0);
  trailing(w, root);
  w.nl();
  return w.string();
}

// ── the renderers ─────────────────────────────────────────────────────────
// A value is text inside its element, escaped — or markup, spliced as
// written, when it begins with `<`. An entry is `<key>value</key>`, a
// value over several lines (a container's content, its children one level
// in) moved under the entry's indent. A key is not renamed: the renderer
// is the refusal.

// `&`, `<` and `>` escaped, an `&` that already begins a reference left
// as it is: a value reaches the renderer bare from the command line and
// escaped from a binding that printed it first.
const escapeOnce = (s) => s.replace(/&(?![A-Za-z]+;|#[0-9]+;|#x[0-9A-Fa-f]+;)|[<>]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;"));

function render(which, args) {
  if (which === "value") {
    const t = args.value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
    // A container's content, as splice text spells it: its lines kept as
    // they stand, the child lines between a line break after the open tag
    // and one before the close tag.
    if (t[0] === "<" && /^[ \t]*\r?\n/.test(args.value)) {
      return "\n" + args.value.replace(/^[ \t]*\r?\n/, "").replace(/[ \t\r\n]+$/, "") + "\n";
    }
    return t[0] === "<" ? t : escapeOnce(t);
  }
  if (which === "entry") {
    if (args.key.startsWith("@")) throw new Error("an attribute cannot be added in place; edit the element's opening tag");
    const key = validName(args.key);
    const [first, ...rest] = ("<" + key + ">" + args.value + "</" + key + ">").split("\n");
    return [first, ...rest.map((line) => (line === "" ? "" : args.indent + line))].join("\n");
  }
  if (which === "key") throw new Error("an element cannot be renamed in place; its close tag would not follow");
  throw new Error("no renderer `" + which + "`");
}

// ── the language ──────────────────────────────────────────────────────────

export default {
  name: "js-pom",
  caps: { read: true, edit: true, serialize: true },
  syntax: {
    comments: {
      style: "xml_comment",
      line: { open: "<!--", close: "-->", forbidden: "--" },
      trailing: { open: "<!--", close: "-->", forbidden: "--" },
    },
    // An entry is an element, not a `key<sep>value` line, and a list
    // takes no item in place: the item renderer is not told the element
    // name a new item needs.
    kv_sep: null,
    empty_map_literal: null,
    flow_containers: false,
    block_seq_editable: false,
    seq_item_marker: "",
    indent_unit: "  ",
  },
  dialects: [{ name: "js-pom", extensions: ["xml"], splice: "raw", empty_doc_seed: "<project>\n</project>\n" }],
  samples: [
    '<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0">\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>org.example</groupId>\n  <artifactId>app</artifactId>\n  <version>1.0</version>\n  <dependencies>\n    <dependency>\n      <groupId>junit</groupId>\n      <artifactId>junit</artifactId>\n      <version>4.13.2</version>\n      <scope>test</scope>\n    </dependency>\n  </dependencies>\n</project>\n',
  ],
  renderers: ["value", "entry", "key"],
  parse,
  print,
  render,
};
