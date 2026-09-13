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
//! use fig::{Document, Format};
//! use fig_quickjs::JsLanguage;
//!
//! let lang = JsLanguage::from_file("languages/dotenv.mjs")?;
//! let js_dotenv = fig::language::register(lang)?[0];
//! let doc = Document::parse(b"A=1\n", js_dotenv)?;
//! assert_eq!(doc.serialize(Format::Json)?, "{\n  \"A\": \"1\"\n}\n");
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

use std::path::Path;

use fig::helper::{description_from_value, encode, table_from_value, table_to_value};
use fig::language::{
    Description, Language, LanguageError, NodeTable, PrintOptions, RenderArgs, Renderer,
};
use fig::{Document, Format, Value};

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
    //!   caps: { read: true, edit: true, serialize: true },
    //!   max_mapping_depth: 0,
    //!   syntax: { comments: { style: "hash", line: { open: "#" }, trailing: { open: "#" } }, kv_sep: "=", empty_map_literal: "{}" },
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
    //! for the root; `comments`, `regions`, `mentions`. `fig.table()` and
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
    //! width}`. It returns the document as a string; `fig.writer(options)`
    //! is a buffer that knows the options. A table whose root is a scalar
    //! is a fragment the editor will splice: spell it as the scalar stands
    //! alone.
    //!
    //! `render(which, args)` answers one of the renderers `renderers`
    //! declares — `which` is "value", "entry", "item", "tail" or "key" —
    //! given `{dialect, indent, key, value, literal, old_key}`, and returns
    //! the fragment as a string. `literal` is what fig's bare-literal rules
    //! made of `value`: "null", "bool", "int", "float", "datetime" or
    //! "string" — classified by fig, so a module spells the kind it is told
    //! and never decides one.
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
    //! `languages/dotenv.mjs`, `languages/properties.mjs`,
    //! `languages/nestedtext.mjs`, `languages/plist.mjs` and
    //! `languages/canonical.mjs` in this repository are complete modules;
    //! `js/fig.js`, `js/grammar.js` and `js/xml.js` are the modules they
    //! import.
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
        let response = engine
            .respond(r#"{"op":"describe"}"#)
            .map_err(Error::Script)?;
        let value =
            decode(&response).map_err(|e| Error::Script(format!("{name}: {}", e.message)))?;
        if !ok(&value) {
            return Err(Error::Script(format!(
                "{name}: {}",
                failure(&value).message
            )));
        }
        let description = value
            .get("description")
            .ok_or_else(|| Error::Script(format!("{name}: describe answered no description")))
            .and_then(|d| {
                description_from_value(d)
                    .map_err(|e| Error::Script(format!("{name}: {}", e.message)))
            })?;
        Ok(JsLanguage {
            engine,
            description,
        })
    }

    /// What the module declared, as loaded.
    pub fn description(&self) -> &Description {
        &self.description
    }

    /// One request to one response over the wire, decoded: the `ok`
    /// response's value, or the refusal as a `LanguageError`.
    fn call(&self, request: Value) -> Result<Value, LanguageError> {
        let line = encode(&request);
        let response = self.engine.respond(&line).map_err(LanguageError::new)?;
        let value = decode(&response)?;
        if ok(&value) {
            Ok(value)
        } else {
            Err(failure(&value))
        }
    }
}

fn ok(v: &Value) -> bool {
    v.get("ok").and_then(Value::as_bool) == Some(true)
}

/// The `LanguageError` a `{"ok":false,…}` response carries.
fn failure(v: &Value) -> LanguageError {
    LanguageError {
        message: v
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("the language refused without a message")
            .to_owned(),
        byte_offset: v
            .get("byte_offset")
            .and_then(Value::as_u64)
            .map(|n| n as usize),
    }
}

/// One line of the wire as a `Value`.
fn decode(line: &str) -> Result<Value, LanguageError> {
    let doc = Document::parse(line.as_bytes(), Format::Json).map_err(|e| {
        LanguageError::new(format!(
            "the language answered something that is not JSON: {e}"
        ))
    })?;
    doc.to_value()
        .map_err(|e| LanguageError::new(format!("the language's answer could not be read: {e}")))
}

fn text(v: &[u8]) -> Value {
    Value::Str(String::from_utf8_lossy(v).into_owned())
}

fn map(entries: Vec<(&str, Value)>) -> Value {
    Value::Map(
        entries
            .into_iter()
            .map(|(k, v)| (Value::Str(k.to_owned()), v))
            .collect(),
    )
}

impl Language for JsLanguage {
    fn describe(&self) -> Description {
        self.description.clone()
    }

    fn parse(&self, dialect: &str, input: &[u8]) -> Result<NodeTable, LanguageError> {
        // The wire carries text: what is not UTF-8 is refused here, at the
        // first byte that is not, since the module could never see it.
        let input = std::str::from_utf8(input).map_err(|e| LanguageError {
            message: "the input is not valid UTF-8".to_owned(),
            byte_offset: Some(e.valid_up_to()),
        })?;
        let response = self.call(map(vec![
            ("op", Value::Str("parse".to_owned())),
            ("dialect", Value::Str(dialect.to_owned())),
            ("input", Value::Str(input.to_owned())),
        ]))?;
        let table = response
            .get("table")
            .ok_or_else(|| LanguageError::new("the language's parse answered no table"))?;
        table_from_value(table)
    }

    fn print(
        &self,
        dialect: &str,
        table: &NodeTable,
        options: &PrintOptions,
    ) -> Result<Vec<u8>, LanguageError> {
        let response = self.call(map(vec![
            ("op", Value::Str("print".to_owned())),
            ("dialect", Value::Str(dialect.to_owned())),
            ("table", table_to_value(table)),
            (
                "options",
                map(vec![
                    ("pretty", Value::Bool(options.pretty)),
                    ("strip_comments", Value::Bool(options.strip_comments)),
                    ("indent", Value::Int(options.indent as i64)),
                    ("width", Value::Int(options.width as i64)),
                ]),
            ),
        ]))?;
        output(&response)
    }

    fn render(&self, which: Renderer, args: RenderArgs<'_>) -> Result<Vec<u8>, LanguageError> {
        let name = match which {
            Renderer::Value => "value",
            Renderer::Entry => "entry",
            Renderer::Item => "item",
            Renderer::Tail => "tail",
            Renderer::Key => "key",
        };
        let response = self.call(map(vec![
            ("op", Value::Str("render".to_owned())),
            ("which", Value::Str(name.to_owned())),
            ("dialect", Value::Str(args.dialect.to_owned())),
            ("indent", text(args.indent)),
            ("key", text(args.key)),
            ("value", text(args.value)),
            // What fig's bare-literal rules made of the value, for the
            // value renderer: "null", "bool", "int", "float", "datetime" or
            // "string".
            ("literal", Value::Str(args.literal.name().to_owned())),
            ("old_key", text(args.old_key)),
        ]))?;
        output(&response)
    }
}

fn output(response: &Value) -> Result<Vec<u8>, LanguageError> {
    response
        .get("output")
        .and_then(Value::as_str)
        .map(|s| s.as_bytes().to_vec())
        .ok_or_else(|| LanguageError::new("the language answered no output"))
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
