# fig-quickjs

A [fig](https://github.com/diaryx-org/fig) format written in JavaScript.

fig reads, converts and edits configuration in the formats it compiles in.
A format it does not compile in can be a program — fig's *runtime language*
contract, carried to a helper process over stdin and stdout — and this is
that program for JavaScript: `fig-quickjs <module.mjs>` serves whatever
format an ES module defines, on a QuickJS built into the binary, and the
`fig` command line then reads, converts and edits that format as it does
any other.

```fig
# ~/.config/fig/languages.figl
language[]
> name = js-dotenv
> extensions = [env]
> command = [fig-quickjs, ~/.config/fig/languages/dotenv.mjs]
```

```bash
$ fig get secrets.env --lang js-dotenv
$ fig set secrets.env API_KEY hunter2 --lang js-dotenv
$ fig lang check js-dotenv --against dotenv secrets.env
js-dotenv: registered (read edit serialize); every sample parsed, printed and reparsed to the same tree, and took a no-op edit
secrets.env: same table as `dotenv` (13 rows)
```

The module is the same object fig's npm package, `@diaryx/fig`, takes in
`registerLanguage` — a `Language`, whose fields are the wire's — so a format
written for the browser or Node is, unchanged, a format the CLI reads
through this binary. What differs is the start-up: a QuickJS helper answers
in a few milliseconds where Node takes fifty, which is what a helper the
CLI spawns per invocation is measured by.

Twelve modules in `languages/` are each the twin of a format fig compiles
in. The format and the tree are the contract: a twin produces the same
node table as the compiled format — every row, span, text and comment,
`tests/fixtures/<format>/*.table.json` beside each fixture — and refuses
every document the compiled format refuses, in words and at offsets of
its own. How it gets there is its own too; none is written to follow
the compiled parser step for step, and most are grammars:

- `json.mjs` — strict JSON, RFC 8259: the values, the escapes with
  surrogate pairs, the byte-order mark, no comments; the format everyone
  already knows, so the one to read first.
- `json5.mjs` — JSONC and JSON5, two dialects from one module (`js-json5`
  and `js-jsonc`), one grammar built twice: `//` and `/* */` comments,
  with the three refinements of the binding policy these dialects make
  stated as context options; and JSON5's unquoted keys, single quotes,
  trailing commas, `Infinity`/`NaN`, hex and bare dots. The one to read
  for how a grammar states where a comment goes.
- `fig.mjs` — fig's own authoring dialect, `.figl`, whole: `>` marker
  depth, section headers and `a.b[]`/`+` append headers, `*` elements,
  dotted keys, `key: type = value` annotations kept as tags, flow values
  with the balanced-then-trailing rule that leaves a markdown link bare,
  multiline strings, comments placed by their own depth; and the `fig
  fmt` house style — sections, hoisting, dotted collapse, append groups,
  multi-line flow — byte for byte, plus the `tail` renderer that
  re-prints a block value one marker level below its key.
- `ini.mjs` — `[section]` files: `key = value` lines, `;` and `#`
  comments, a reopened section merged into the first. The smaller section
  format, and the one to read beside `toml.mjs` for what a section is.
- `toml.mjs` — TOML 1.1, whole: `[tables]`, `[[arrays of tables]]`,
  dotted keys, inline tables, every string and number form, datetimes.
  A *section* format, so it is what a runtime language looks like when
  it carries the regions and mentions the editor moves a table by, and
  the compiled printer's layout rules, width budget and all; held to
  the whole of toml-test, and its edits to the compiled format's bytes.
- `zon.mjs` — Zig Object Notation, `.zon`: `.{ .field = value }` structs,
  `.{ 1, 2 }` arrays, Zig's numbers, strings and `\\` multiline strings,
  `.enum` and `'c'` literals kept as extended scalars, `//` comments. A
  grammar over the data format: what is Zig but not ZON — an operator, a
  builtin, a doc comment — is refused in words of its own, not parsed
  and then declined as the compiled `std.zig.Ast` does.
- `yaml.mjs` — YAML 1.2, whole, and 1.1's scalar resolution as a second
  dialect (`js-yaml-1.1`): block and flow collections, every scalar
  style — plain, quoted with their escapes and folds, `|` and `>` blocks
  with their indicators — anchors, aliases and `<<` merges, tags kept
  verbatim with their `%TAG` handles, explicit `?` keys, directives and
  document markers, comments; and the compiled printer's block style
  with its flow form where a
  collection fits the width. The largest twin, and the one that carries
  a reference layer (`caps.references`), so a document leaving it for
  JSON is collapsed as one leaving the compiled YAML is; held to the
  whole yaml-test-suite and to the compiled editor's cases.
- `dotenv.mjs` — `.env` files: bash-identifier keys, an optional `export`,
  quoted and unquoted values, `#` comments, flat.
- `properties.mjs` — Java `.properties`: `=`, `:` or a space between key
  and value, backslash escapes on both, `\uXXXX`, line continuations,
  `#` and `!` comments, flat.
- `nestedtext.mjs` — NestedText: indentation-nested dicts, lists and `>`
  string blocks, multiline `: ` keys, one-line inline `{…}`/`[…]`, every
  scalar a literal string; and the four renderers the compiled editor
  spells its edits with — an entry, an item, a value's tail, a key.
- `plist.mjs` — Apple property lists, the XML form: `dict`, `array`, typed
  scalars, `date` and `data`; and the two fragment renderers that spell an
  edited value as a typed element and an entry as `<key>` over it.
- `canonical.mjs` — fig's canonical form, the tree spelled with nothing
  added: flow containers, JSON strings, numbers with their kind pinned,
  extended scalars, anchors, tags and aliases, keys that are any node, `//`
  and `/* */` comments. Every row the wire can carry, in one module; the
  compiled sibling is opt-in (`zig build -Dcanonical=true`).

They are also what a new module is written against: each is a complete
parser and printer, and `fig lang check <name> --against <format>` is how a
twin is proven — the table, row for row. What a twin says when it refuses
a document is not compared; `fig lang table -i <format>` prints what the
table has to be.

Five more are formats fig does not compile in at all — the reason a
runtime language exists. Each is written to its own specification, reads
the whole format, and says in its header exactly which edits the generic
engine makes on it and which it refuses, because the tree fig holds is
values and these formats hold a little more than that. What each recorded
of itself — the table and the print of every fixture under
`tests/fixtures/<name>/` — is what `tests/languages.rs` holds it to.

- `gitconfig.mjs` — git's configuration files, as git-config(1) reads
  them: `[section]` and `[section "subsection"]` headers, quoted values
  with git's escapes, `\`-continued lines, a bare name as `true`,
  multivalued variables kept as the entries they are. A section format
  with regions and mentions, edited like INI.
- `sshconfig.mjs` — OpenSSH client configuration: `Keyword arguments`
  lines, `Host` and `Match` blocks as mappings under those two names,
  arguments kept as written since `"a b"` is one and `a b` is two. A new
  block is `insertContainer`, spelled `Host name`.
- `openstep.mjs` — the OpenStep property list, Xcode's `project.pbxproj`
  and `Localizable.strings`: `{ k = v; }`, `( a, b, )`, `<hex>` data as
  the XML twin's `plist_data`, every scalar a string, `/* */` comments
  trailing keys and values inline where Xcode puts them. Prints an Xcode
  project back byte for byte, one-line `PBXBuildFile` objects and section
  markers included.
- `pom.xml` (`pom.mjs`) — a Maven POM, and any XML shaped like one:
  text elements as strings, element-holding elements as mappings, a run of
  same-named children as a sequence whose item name rides its tag,
  attributes as `@name` entries, the root's name as the root's tag. The
  answer to "which elements are a list" that fig's retired generic XML
  never had. Comments kept; mixed content refused.
- `hcl.mjs` — HCL's native syntax, Terraform's `.tf` and `.tfvars`:
  attributes and blocks nested `type → label → … → body` as `hcl2json`
  nests them, repeated blocks a sequence, literals and tuples and objects
  as values, every expression — a reference, a call, a conditional, a
  `for` — kept as its text under an `!expr` tag and written back
  unchanged, heredocs and templates likewise. A section format: a block
  is a container the engine never line-splices, and deleting one is the
  container op.

## Install

```bash
cargo install fig-quickjs
```

One binary, QuickJS built in; nothing else to install — no Node, no npm. A
module is any `.mjs` file, wherever you keep it — `languages.figl` names
the path.

## Writing a format

A module's default export is an object: what the format declares, and the
functions it is. The parser is a description — a grammar whose pieces are
fig's own kinds of node, so the tree, the byte spans, the comment binding
and the duplicate-key policy come with it — and the printer walks the tree
back out.

```js
import * as fig from "fig";
import * as G from "fig/grammar";

export default {
  name: "tinykv",
  caps: { read: true, edit: true, serialize: true },
  max_mapping_depth: 0,
  syntax: {
    comments: { style: "hash", line: { open: "#" }, trailing: { open: "#" } },
    kv_sep: "=",
    empty_map_literal: "{}",
    flow_containers: false,
  },
  dialects: [{ name: "tinykv", extensions: ["tkv"], splice: "raw", empty_doc_seed: "" }],
  samples: ["a=1\n# two\nb=two # words\n"],

  parse: G.document({
    root: G.map({
      whole: true,
      trivia: G.trivia({ comment: G.comment("#") }),
      entry: G.entry({
        key: G.key(G.pat(/[A-Za-z0-9_]+/)),
        sep: G.lit("="),
        value: G.bare({ stop: G.lit("#") }),
        missingSep: "expected `=` after this key",
      }),
      expected: "expected `key=value` here",
    }),
  }),

  print(_dialect, t) {
    const root = fig.index(t).byid(0);
    if (root.kind !== "mapping") return root.text ?? "";
    const w = fig.writer();
    for (const kv of root.items) {
      for (const c of kv.key.leading) w.put("# ", c.text, "\n");
      w.put(kv.key.text, "=", kv.value.text);
      for (const c of kv.value.trailing) w.put(" # ", c.text);
      w.put("\n");
    }
    return w.string();
  },
};
```

The declarations are the same fields, with the same names and values, as
the description a helper answers `describe` with — documented on the
`helper` module of the [`fig` crate](https://docs.rs/fig), which is where
the wire and every shape on it are stated once, and typed as `Language` in
`@diaryx/fig` for an editor that checks the shape as you write it.

**The grammar.** A rule is a function over a scanner: it answers a result,
or `null` for "not here", and a `choice` moves on. `lit`, `pat`, `eol` and
`eof` are the primitives; `seq`, `choice`, `opt`, `many`, `ahead`,
`expect` and `fail` combine them. The rules that matter are the ones that
answer nodes: `key` and `scalar` over anything, `quoted` (escapes, `\r\n`,
what may follow the closing quote) and `bare` (to the line's end or a
stop) for values, `comment` for a comment, `entry` for `key sep value`,
and `map` and `sequence` for containers, which run `trivia` between their
members and take their duplicate policy and their close. `document` makes
a `parse` of a root rule. Comments are bound as trivia passes them: on the
same line as the last node, trailing; otherwise leading on the next entry's
key, or dangling on the container that closes first. To refuse the input
from anywhere, `fig.fail(message, byteOffset)`; the messages a rule uses
are options on it, so a twin can word a refusal exactly as the compiled
parser does.

**Bytes, not UTF-16.** Every offset fig wants is a byte offset, and a
JavaScript string is indexed by UTF-16 unit, so the scanner never indexes
the input string: it encodes it once and works over the bytes, with a
one-char-per-byte shadow for regular expressions — so a pattern given to
`pat` is a pattern over bytes, and `[A-Za-z_]` means what it says. A
module that stays above the scanner never meets a UTF-16 index; `sc.slice`
decodes what it hands back.

**Below the grammar.** A `parse` may also return a tree built by hand —
`fig.mapping`, `fig.sequence`, `fig.entry`, `fig.scalar`, nodes that hold
their children and their comments as fields, with `map.put(entry)` applying
the policy, and `fig.rows(root)` laying them out — or the wire's node table
itself, `fig.table()` and `t.row(...)`, rows in pre-order. `fig.scanner(src)`
is the byte cursor, whose positions are already the wire's: 0-based,
`[start, end)`, what `fig lang table <file>` prints for any file, which is
the fastest way to see what a table should be. A rule is only a function of
one, so any piece of a grammar can be plain JavaScript where the grammar
cannot say it.

Where a format's binding rule is not the module's, a module says so around
it: `canonical.mjs` runs its own `parse` over `G.context` with a `comment`
method of its own, and gives `G.map` an `open` rule that keeps a `//` on
the opening line for the container, and an `after` rule that takes the
comma or looks ahead for the close. A rule is a function, and so is the
context's policy.

**Sections.** A format whose containers are opened by a header line and
re-entered by another — INI, TOML, fig — is not a grammar of rules, and
`ini.mjs`, `toml.mjs` and `fig.mjs` state their headers by hand. What the
three share is `G.sections(bin)`: `S.open(parent, entry, kind)` puts the
keyvalue in its parent and gives the container its first *region* (the
whole line holding the key) and its first *mention* (the key, of kind
`header` or `entry`); `S.reopen(node, span, kind)` adds one of each for a
header that names it again; `S.region` and `S.mention` add one alone, for
the header line an array-of-tables element shares or the segment a
`[a.b]` passes through. `S.comment(text, depth)` is a comment waiting for
its key, and `S.claim(node, slot, depth)` gives the waiting comments at
that depth or deeper to a key (`leading`) or a closing container
(`dangling`); `depth` is for a format whose lines have one, and the
others leave it. What a header *means* — which containers it may
re-enter, what its dots and brackets say, where the cursor goes — is each
format's own, and stays in its parser.

**XML.** `import X from "fig/xml"` is the XML shape — tags with or without
attributes, text with entities and CDATA decoded, comments and processing
instructions skipped — as rules: `X.tag`, `X.close(name)`,
`X.textElement(name)`, `X.element({ name: handler })`, `X.trivia`.
`plist.mjs` is a `G.map` of `<key>`/value entries closed by `</dict>`.

**Numbers and datetimes.** A number row's `text` is its lexeme, verbatim,
and a printer writing it for another format asks `fig/number` whether that
format reads it back as the same number — `N.text(raw, N.JSON5)` is the
lexeme when it is, decimal when it is not. `fig/datetime` is the other
typed scalar every format spells alike: `DT.classify(raw, opts)` answers
`local_date`, `local_time`, `local_datetime` or `offset_datetime`, with
`opts` for what the format allows. Both are the twins of the utilities
fig's compiled formats share.

**Printing.** `print(dialect, t, options)` gets the table as parsed;
`fig.index(t)` is its first line, after which every row has `items` (its
children), `leading`, `trailing`, `dangling`, a keyvalue has `key` and
`value`, and `t.byid(id)` finds one. `fig.writer(options)` is a buffer
that writes nothing for `nl()` and `indent(depth)` when `pretty` is off. A
table whose root is a scalar is a fragment the editor will splice: spell
it as the scalar stands alone.

**Editing** needs no code: fig's splice engine writes an edit from
`syntax`. A format whose fragments cannot be spelled from constants
declares `renderers` and answers `render(which, args)` — `plist.mjs` does,
for the typed element a value becomes. A value renderer is told what fig's
own literal rules made of the text, `args.literal`: `"int"`, `"float"`,
`"bool"`, `"datetime"`, `"null"` or `"string"`, the one meaning every
format's `set` gives `42` or `Yes`, so a module spells a kind and never
decides one.

**What a module may import.** `fig`, `fig/grammar`, `fig/xml`,
`fig/number`, `fig/datetime`, and `@diaryx/fig/helper` — `LanguageError` and the wire, the npm package's own
helper entry, so the import reads the same under Node — are served from the
binary; a relative import is a file beside the module. Nothing else
resolves: no `node:` modules, no package lookup, no TypeScript. A module is
plain ES2023, with `TextEncoder`, `TextDecoder` and a `console` that
writes to stderr provided.

`fig-quickjs check <module.mjs>` loads a module and runs fig's own harness
over its samples — parse, print, reparse, a no-op edit — which is the check
the `fig` CLI makes before it accepts a helper, and says why if it is
refused.

## In a Rust program

The same module is a `fig::language::Language`, registered in-process:

```rust
let js_dotenv = fig_quickjs::register_file("languages/dotenv.mjs")?[0];
let doc = fig::Document::parse(b"A=1\n", js_dotenv)?;
```

## Under Node or in the browser

The same module is a `Language` for `@diaryx/fig`'s `registerLanguage`,
which registers it with fig's wasm module in-process — the way to develop
one, with `node:test` and the compiled format as the oracle:

```js
import { registerLanguage, parse } from "@diaryx/fig";
import tinykv from "./tinykv.mjs";
const format = registerLanguage(tinykv);
parse("a=1\n", format); // { a: "1" }
```

The `fig`, `fig/grammar`, `fig/xml`, `fig/number` and `fig/datetime`
modules this binary serves are `js/fig.js`, `js/grammar.js`, `js/xml.js`,
`js/number.js` and `js/datetime.js` in this repository, and run unchanged
there: `node --import ./scripts/node-imports.mjs test.mjs` resolves the
five names to them, and a bundler alias does the same.

## The vendored wire

`js/wire.js` is `@diaryx/fig`'s `dist/wire.js` — `LanguageError`,
`describe` and `handle`, the object-to-wire step — copied as published, so
that a module's object becomes the wire by the one implementation the wasm
module also uses, and this crate converts nothing itself. Refresh it from
the package when fig's wire changes; the twins' tests are what notice a
mismatch.

## License

MIT OR Apache-2.0.
