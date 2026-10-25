//! A fig format written in JavaScript.
//!
//! [`JsLanguage`] is a [`fig::language::Language`] whose parser and printer
//! are functions in an ES module, run on a QuickJS built into this crate.
//! What a module is — the object it exports, the shape of a node table, the
//! `fig` modules it may import — is documented in [`module`]; what the crate
//! does with one is two things:
//!
//! - the `fig-quickjs` binary serves a module to a `fig` command line as a
//!   helper process — the out-of-process carrier of fig's runtime-language
//!   contract, spoken exactly as `fig::helper` documents it;
//! - a Rust program registers one in-process with
//!   [`fig::language::register`], and it is then a [`fig::Format`] every
//!   entry point of the `fig` crate accepts.
//!
//! The two are the same [`Language`]. The object a module exports is the
//! `Language` of `@diaryx/fig`, fig's npm package — the same fields with the
//! same names, which are the wire's — and the object is turned into the
//! wire by that package's own `handle`, vendored into this crate as
//! `js/wire.js`. So a language written for `registerLanguage` in a browser
//! or under Node is, unchanged, a format the `fig` CLI reads through this
//! binary; and this crate converts nothing itself.
//!
//! ```no_run
//! use fig::Document;
//! use fig_quickjs::JsLanguage;
//!
//! let lang = JsLanguage::from_file("languages/dotenv.mjs")?;
//! let js_dotenv = fig::language::register(lang)?[0];
//! let doc = Document::parse(b"A=1\n", js_dotenv)?;
//! assert_eq!(doc.serialize(fig_json::format()?)?, "{\n  \"A\": \"1\"\n}\n");
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

use std::path::Path;

use fig::helper::{decode, description_from_value, encode, table_from_value, table_to_value};
use fig::language::{
    Description, Language, LanguageError, NodeTable, PrintOptions, RenderArgs, Renderer,
};
use serde_json::{Value, json};

mod engine;

pub use engine::{LoadError as Error, Source};

pub mod module {
    //! What a fig-quickjs module is.
    //!
    //! A module is an ES module whose default export (or, failing that,
    //! first export with a `parse` function) is the language: an object
    //! with the same fields, names and values as the `description` a
    //! helper answers `describe` with (see `fig::helper`) — which is also
    //! the `Language` type of `@diaryx/fig` — plus the functions the
    //! format is:
    //!
    //! ```js
    //! import * as fig from "fig";
    //! import * as G from "fig/grammar";
    //!
    //! export default {
    //!   name: "js-dotenv",
    //!   caps: { read: true, edit: true, serialize: true }, // and `references` for a format with anchors, aliases and tags
    //!   max_mapping_depth: 0,
    //!   syntax: { comments: { line: { open: "#" }, trailing: { open: "#" } }, kv_sep: "=", empty_map_literal: "{}" },
    //!   dialects: [{ name: "js-dotenv", extensions: ["env"], splice: "raw", empty_doc_seed: "" }],
    //!   samples: ["A=1\n"],
    //!   renderers: ["value"],
    //!   parse(dialect, input) { /* ... */ },
    //!   print(dialect, t, options) { /* ... */ },
    //!   render(which, args) { /* ... */ },
    //! };
    //! ```
    //!
    //! `parse(dialect, input)` takes the input as a string and returns the
    //! wire's **node table**: `rows` in pre-order, each `{kind, parent,
    //! span: [s, e], text, ...}` with `parent` a 0-based row id or `null`
    //! for the root; `comments`, `regions`, `mentions`, and `directives`
    //! for a format with tag-handle declarations (YAML's `%TAG`;
    //! `t.directive(handle, prefix)`). `fig.table()` and
    //! `t.row(...)` build one by hand; a **tree** — nodes built with
    //! `fig.mapping`, `fig.sequence`, `fig.entry` and `fig.scalar`, holding
    //! their children and comments as fields — becomes one through
    //! `fig.rows(root)`. To refuse the input it calls `fig.fail(message,
    //! byteOffset)`, from anywhere; any other error it throws is reported
    //! without an offset. Most modules write neither by hand:
    //! `import * as G from "fig/grammar"` is a set of rules whose results
    //! are these nodes, and `G.document({...})` is a `parse` function. A
    //! format of header lines, whose parser is its own, takes
    //! `G.sections(bin)` for the regions, the mentions and the waiting
    //! comments every section format records alike.
    //!
    //! `print(dialect, t, options)` receives the node table as parsed —
    //! `fig.index(t)` is its first line, after which every row has `id`,
    //! `children` (ids), `items` (rows), `leading`, `trailing` and
    //! `dangling`, a keyvalue row has `key` and `value`, and `t.byid(id)`
    //! finds a row — and `options` as `{pretty, strip_comments, indent,
    //! width, splice, flow}`. It returns the document as a string;
    //! `fig.writer(options)` is a buffer that knows the options. `splice`
    //! is `true` when fig wants the value as the editor splices it into a
    //! document — every value a binding's editor hands it — and not as a
    //! document of its own: a format whose document wraps its root
    //! (plist's `<plist>`) or spells a root differently from the same
    //! value in place (NestedText's `>` block) prints it bare, and every
    //! other format prints the same either way. A table whose root is a
    //! scalar is a fragment even without it (`fig get <file> <path>`):
    //! spell it as the scalar stands alone.
    //!
    //! `render(which, args)` answers one of the renderers `renderers`
    //! declares — `which` is "value", "entry", "item", "tail", "key",
    //! "key_name" or "string" — given `{dialect, indent, key, value,
    //! literal, old_key, old_value, parent_key, parent_tag}`, and returns
    //! the fragment as a string. What each renderer is handed is
    //! `fig::language::RenderArgs`'s to say. `literal` is what fig's
    //! bare-literal rules made of `value`: "null", "bool", "int", "float",
    //! "datetime" or "string" — classified by fig, so a module spells the
    //! kind it is told and never decides one.
    //!
    //! Offsets are byte offsets into the input, 0-based and `[start, end)`,
    //! as the wire's are. JavaScript indexes strings by UTF-16 unit, so a
    //! module never indexes the input string: `fig.scanner(input)` works
    //! over its bytes and speaks byte offsets, and a module above the
    //! scanner never meets a UTF-16 index.
    //!
    //! The modules a language may import are served from the binary:
    //! `fig` (the prelude: the node table, the tree, the scanner, the
    //! writer, `fail`), `fig/grammar`, `fig/xml`, and `@diaryx/fig/helper`
    //! (`LanguageError` and the wire — the npm package's own helper entry,
    //! so the import reads the same under Node). A relative import is a
    //! file beside the module. Nothing else resolves: no `node:` modules,
    //! no package lookup, and no TypeScript — a language is plain ES2023.
    //!
    //! `languages/json.mjs`, `languages/json5.mjs`, `languages/toml.mjs`,
    //! `languages/ini.mjs`, `languages/fig.mjs`, `languages/zon.mjs`,
    //! `languages/yaml.mjs`, `languages/dotenv.mjs`,
    //! `languages/properties.mjs`, `languages/nestedtext.mjs`,
    //! `languages/plist.mjs` and
    //! `languages/canonical.mjs` in this repository are complete modules,
    //! each the twin of a format fig compiles in; `languages/gitconfig.mjs`,
    //! `languages/sshconfig.mjs`, `languages/openstep.mjs`,
    //! `languages/pom.mjs` and `languages/hcl.mjs` are formats fig does not
    //! compile in at all; `js/fig.js`, `js/grammar.js` and `js/xml.js` are
    //! the modules they import.
}

/// A format whose parser and printer are an ES module.
#[derive(Debug)]
pub struct JsLanguage {
    engine: engine::Engine,
    /// Asked of the module once, at load; what `describe` answers.
    description: Description,
}

impl JsLanguage {
    /// Load the module at `path`. Its relative imports resolve beside it.
    pub fn from_file(path: impl AsRef<Path>) -> Result<Self, Error> {
        Self::load(Source::File(path.as_ref().to_path_buf()))
    }

    /// Load a module from its text; `name` is what an error message calls
    /// it. Such a module can import the served modules and nothing
    /// relative.
    pub fn from_source(name: &str, source: &str) -> Result<Self, Error> {
        Self::load(Source::Text {
            name: name.to_owned(),
            source: source.to_owned(),
        })
    }

    fn load(source: Source) -> Result<Self, Error> {
        let name = match &source {
            Source::File(p) => p.display().to_string(),
            Source::Text { name, .. } => name.clone(),
        };
        let engine = engine::Engine::load(source)?;
        // The description, validated as the CLI validates a helper's: a
        // module that declares itself wrongly is refused here, at load.
        let description = answer(&engine, "describe", json!({}))
            .and_then(|d| description_from_value(&d))
            .map_err(|e| Error::Script(format!("{name}: {}", e.message)))?;
        Ok(JsLanguage {
            engine,
            description,
        })
    }

    /// What the module declared, as loaded.
    pub fn description(&self) -> &Description {
        &self.description
    }

    /// One request to the module, its `result` or its refusal.
    fn call(&self, method: &str, params: Value) -> Result<Value, LanguageError> {
        answer(&self.engine, method, params)
    }
}

/// One JSON-RPC request to one response over the wire, decoded: the
/// response's `result`, or its `error` as a `LanguageError`.
fn answer(engine: &engine::Engine, method: &str, params: Value) -> Result<Value, LanguageError> {
    let request = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
    let line = engine
        .respond(&encode(&request))
        .map_err(LanguageError::new)?;
    let mut response = decode(&line).map_err(|e| {
        LanguageError::new(format!(
            "the language answered something that is not JSON: {}",
            e.message
        ))
    })?;
    if let Some(result) = response.get_mut("result") {
        return Ok(result.take());
    }
    let error = response
        .get("error")
        .ok_or_else(|| LanguageError::new("the language answered neither a result nor an error"))?;
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("the language refused without a message")
        .to_owned();
    let offset = error
        .get("data")
        .and_then(|d| d.get("byte_offset"))
        .and_then(Value::as_u64);
    Err(match offset {
        Some(offset) => LanguageError::at(message, offset as usize),
        None => LanguageError::new(message),
    })
}

fn text(v: &[u8]) -> Value {
    Value::String(String::from_utf8_lossy(v).into_owned())
}

impl Language for JsLanguage {
    fn describe(&self) -> Description {
        self.description.clone()
    }

    fn parse(&self, dialect: &str, input: &[u8]) -> Result<NodeTable, LanguageError> {
        // The wire carries text: what is not UTF-8 is refused here, at the
        // first byte that is not, since the module could never see it.
        let input = std::str::from_utf8(input)
            .map_err(|e| LanguageError::at("the input is not valid UTF-8", e.valid_up_to()))?;
        let table = self.call("parse", json!({"dialect": dialect, "input": input}))?;
        table_from_value(&table)
    }

    fn print(
        &self,
        dialect: &str,
        table: &NodeTable,
        options: &PrintOptions,
    ) -> Result<Vec<u8>, LanguageError> {
        let response = self.call(
            "print",
            json!({
                "dialect": dialect,
                "table": table_to_value(table),
                "options": {
                    "pretty": options.pretty,
                    "strip_comments": options.strip_comments,
                    "indent": options.indent,
                    "width": options.width,
                    "splice": options.splice,
                    "flow": options.flow,
                },
            }),
        )?;
        output(response)
    }

    fn render(&self, which: Renderer, args: RenderArgs<'_>) -> Result<Vec<u8>, LanguageError> {
        let response = self.call(
            "render",
            json!({
                "which": which.name(),
                "dialect": args.dialect,
                "indent": text(args.indent),
                "key": text(args.key),
                "value": text(args.value),
                // What fig's bare-literal rules made of the value, for the
                // value renderer: "null", "bool", "int", "float", "datetime"
                // or "string".
                "literal": args.literal.name(),
                "old_key": text(args.old_key),
                "old_value": text(args.old_value),
                "parent_key": text(args.parent_key),
                "parent_tag": text(args.parent_tag),
            }),
        )?;
        output(response)
    }
}

/// A `print` or `render` answer: the text it is.
fn output(response: Value) -> Result<Vec<u8>, LanguageError> {
    match response {
        Value::String(s) => Ok(s.into_bytes()),
        _ => Err(LanguageError::new("the language answered no output")),
    }
}

/// Convenience: [`fig::language::register`] over a module file.
pub fn register_file(
    path: impl AsRef<Path>,
) -> Result<Vec<fig::Format>, Box<dyn std::error::Error>> {
    let lang = JsLanguage::from_file(path)?;
    Ok(fig::language::register(lang)?)
}

/// The wire, raw: one request line to one response line, as the binary
/// serves it. For a host that speaks the wire over something other than
/// the `Language` trait.
pub fn respond(lang: &JsLanguage, request_line: &str) -> Result<String, LanguageError> {
    lang.engine
        .respond(request_line)
        .map_err(LanguageError::new)
}
