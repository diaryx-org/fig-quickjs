//! The JavaScript engine: one QuickJS runtime per language, on a thread of
//! its own.
//!
//! A [`fig::language::Language`] is `Send + Sync`, and a QuickJS runtime is
//! neither, so the runtime lives on one thread for the life of the
//! language and every call is a message to it — a request line in, a
//! response line out. That is also the whole of what the engine does: the
//! module's object is turned into the wire by `@diaryx/fig`'s own `handle`
//! (`js/wire.js`, vendored from the package), so the object-to-wire step
//! has one implementation, shared with the wasm module a browser runs, and
//! this crate converts nothing itself.
//!
//! What the engine adds to QuickJS is what a language written for Node or
//! the browser assumes and QuickJS does not have: `TextEncoder` and
//! `TextDecoder` (UTF-8, over two native functions — the scanner's byte
//! offsets depend on them), and a `console` that writes to stderr, since
//! stdout is the wire.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::{self, JoinHandle};

use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::{Context, Ctx, Function, Module, Runtime, TypedArray};

/// The modules served from the binary, by the name a language imports.
///
/// `@diaryx/fig/helper` is the wire — `LanguageError`, `describe`,
/// `handle`, the same file the npm package ships as its helper entry — so
/// a language imports it by the name it would under Node, and the one
/// `LanguageError` class is the one `handle` tests a thrown error against.
const MODULES: &[(&str, &str)] = &[
    ("@diaryx/fig/helper", include_str!("../js/wire.js")),
    ("fig", include_str!("../js/fig.js")),
    ("fig/grammar", include_str!("../js/grammar.js")),
    ("fig/xml", include_str!("../js/xml.js")),
];

/// What QuickJS lacks that a language assumes.
const PRELUDE: &str = r#"
globalThis.TextEncoder = class TextEncoder {
  get encoding() { return "utf-8"; }
  encode(s) { return __fig_utf8_encode(s === undefined ? "" : String(s)); }
};
globalThis.TextDecoder = class TextDecoder {
  constructor(label) {
    const l = label === undefined ? "utf-8" : String(label).toLowerCase();
    if (l !== "utf-8" && l !== "utf8") throw new RangeError("TextDecoder: only utf-8 is supported here");
  }
  get encoding() { return "utf-8"; }
  decode(b) { return b === undefined ? "" : __fig_utf8_decode(b); }
};
const __fig_console = (level) => (...args) => __fig_stderr(level + ": " + args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" "));
globalThis.console = { log: __fig_console("log"), info: __fig_console("info"), warn: __fig_console("warn"), error: __fig_console("error"), debug: __fig_console("debug") };
"#;

/// Where a language's module comes from.
#[derive(Debug, Clone)]
pub enum Source {
    /// A file; relative imports resolve beside it.
    File(PathBuf),
    /// Text, under a name error messages use.
    Text { name: String, source: String },
}

/// Why the engine could not load a module. A failure inside `parse`,
/// `print` or `render` is a wire refusal instead, and never reaches here.
#[derive(Debug)]
pub enum LoadError {
    Io(std::io::Error),
    Script(String),
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoadError::Io(e) => write!(f, "{e}"),
            LoadError::Script(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for LoadError {}

impl From<std::io::Error> for LoadError {
    fn from(e: std::io::Error) -> Self {
        LoadError::Io(e)
    }
}

struct Job {
    line: String,
    reply: Sender<String>,
}

/// A loaded language: a QuickJS runtime on its own thread, answering the
/// wire one line at a time.
pub struct Engine {
    jobs: Sender<Job>,
    _thread: JoinHandle<()>,
}

impl std::fmt::Debug for Engine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Engine")
    }
}

impl Engine {
    /// Start a runtime, load the module and its imports, and find its
    /// language: the default export, or the first export with a `parse`
    /// function.
    pub fn load(source: Source) -> Result<Engine, LoadError> {
        let (name, text, dir) = match &source {
            Source::File(path) => {
                let path = std::fs::canonicalize(path)?;
                let text = std::fs::read_to_string(&path)?;
                let dir = path.parent().map(Path::to_path_buf);
                (path.to_string_lossy().into_owned(), text, dir)
            }
            Source::Text { name, source } => (name.clone(), source.clone(), None),
        };
        let (jobs, inbox) = mpsc::channel::<Job>();
        let (ready, loaded) = mpsc::channel::<Result<(), String>>();
        let thread = thread::Builder::new()
            .name(format!("fig-quickjs {name}"))
            .spawn(move || run(name, text, dir, ready, inbox))
            .map_err(LoadError::Io)?;
        match loaded.recv() {
            Ok(Ok(())) => Ok(Engine {
                jobs,
                _thread: thread,
            }),
            Ok(Err(message)) => Err(LoadError::Script(message)),
            Err(_) => Err(LoadError::Script(
                "the engine thread ended before the module loaded".to_owned(),
            )),
        }
    }

    /// One request line to one response line — `handle` in the wire's
    /// terms, which never throws: a refusal, a malformed request and a bug
    /// in the language alike come back as `{"ok":false,…}`. `Err` is the
    /// engine itself being gone.
    pub fn respond(&self, line: &str) -> Result<String, String> {
        let (reply, answer) = mpsc::channel();
        self.jobs
            .send(Job {
                line: line.to_owned(),
                reply,
            })
            .map_err(|_| "the engine thread is gone".to_owned())?;
        answer
            .recv()
            .map_err(|_| "the engine thread ended without answering".to_owned())
    }
}

/// The engine thread: everything that touches the runtime happens here.
fn run(
    name: String,
    text: String,
    dir: Option<PathBuf>,
    ready: Sender<Result<(), String>>,
    inbox: Receiver<Job>,
) {
    let rt = match Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            let _ = ready.send(Err(format!("could not start QuickJS: {e}")));
            return;
        }
    };
    let mut inline: HashMap<String, String> = MODULES
        .iter()
        .map(|(n, s)| ((*n).to_owned(), (*s).to_owned()))
        .collect();
    if dir.is_none() {
        inline.insert(name.clone(), text);
    }
    let modules = Modules {
        inline: Rc::new(inline),
    };
    rt.set_loader(modules.clone(), modules);
    let ctx = match Context::full(&rt) {
        Ok(ctx) => ctx,
        Err(e) => {
            let _ = ready.send(Err(format!("could not start QuickJS: {e}")));
            return;
        }
    };
    let loaded = ctx.with(|ctx| -> Result<(), String> {
        install_natives(&ctx).map_err(|e| describe_error(&ctx, e))?;
        ctx.eval::<(), _>(PRELUDE)
            .map_err(|e| describe_error(&ctx, e))?;
        let main = format!(
            r#"import {{ handle }} from "@diaryx/fig/helper";
import * as mod from {module};
const lang = mod.default ?? Object.values(mod).find((v) => v !== null && typeof v === "object" && typeof v.parse === "function");
if (!lang) throw new Error("the module exports no language: neither a default export nor an export with a `parse` function");
if (typeof lang.parse !== "function") throw new Error("the language's `parse` is not a function");
globalThis.__fig_respond = (line) => handle(lang, line);"#,
            module = js_string(&name),
        );
        let promise = Module::evaluate(ctx.clone(), "fig-quickjs:main", main)
            .map_err(|e| describe_error(&ctx, e))?;
        promise
            .finish::<()>()
            .map_err(|e| describe_error(&ctx, e))?;
        ctx.globals()
            .get::<_, Function>("__fig_respond")
            .map(|_| ())
            .map_err(|e| describe_error(&ctx, e))
    });
    if let Err(message) = loaded {
        let _ = ready.send(Err(format!("{name}: {message}")));
        return;
    }
    let _ = ready.send(Ok(()));
    // A `Function<'js>` cannot outlive one `with`; the responder is held by
    // its global name and fetched per call, a property lookup.
    while let Ok(job) = inbox.recv() {
        let answer = ctx.with(|ctx| -> String {
            let result: Result<String, rquickjs::Error> = ctx
                .globals()
                .get::<_, Function>("__fig_respond")
                .and_then(|f| f.call((job.line.as_str(),)));
            match result {
                Ok(s) => s,
                // `handle` does not throw; this is the engine failing —
                // out of memory, a stack overflow — reported as a refusal
                // so the caller sees a message rather than nothing.
                Err(e) => {
                    let message = describe_error(&ctx, e);
                    format!(
                        r#"{{"ok":false,"message":{}}}"#,
                        js_string(&format!("the engine failed: {message}"))
                    )
                }
            }
        });
        let _ = job.reply.send(answer);
    }
}

/// `TextEncoder`/`TextDecoder`'s work, and `console`'s: the functions the
/// prelude wraps.
fn install_natives<'js>(ctx: &Ctx<'js>) -> rquickjs::Result<()> {
    let g = ctx.globals();
    g.set(
        "__fig_utf8_encode",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, s: String| {
            TypedArray::<u8>::new(ctx, s.into_bytes())
        })?,
    )?;
    g.set(
        "__fig_utf8_decode",
        Function::new(ctx.clone(), |b: TypedArray<'js, u8>| -> String {
            // The view's bytes, offset and length honoured. Nothing else
            // runs on the engine while a native does, so the buffer cannot
            // move under it.
            let bytes = unsafe { b.as_bytes() }.unwrap_or(&[]);
            String::from_utf8_lossy(bytes).into_owned()
        })?,
    )?;
    g.set(
        "__fig_stderr",
        Function::new(ctx.clone(), |line: String| {
            eprintln!("{line}");
        })?,
    )?;
    Ok(())
}

/// A JavaScript error as one line for a message: the exception's message
/// and, where QuickJS gives one, the first frame of its stack.
fn describe_error(ctx: &Ctx<'_>, err: rquickjs::Error) -> String {
    match err {
        rquickjs::Error::Exception => {
            let ex = ctx.catch();
            if let Some(ex) = ex.as_exception() {
                let message = ex.message().unwrap_or_else(|| "error".to_owned());
                match ex.stack() {
                    Some(stack) if !stack.trim().is_empty() => {
                        let first = stack.lines().next().unwrap_or("").trim();
                        format!("{message} ({first})")
                    }
                    _ => message,
                }
            } else if let Some(s) = ex.as_string() {
                s.to_string().unwrap_or_else(|_| "error".to_owned())
            } else {
                format!("{ex:?}")
            }
        }
        other => other.to_string(),
    }
}

/// `s` as a JavaScript string literal.
fn js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c == '\u{2028}' || c == '\u{2029}' => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The module resolver and loader: a name in `inline` is served from
/// memory (the embedded modules, and a language given as text); anything
/// else is a file, absolute or relative to the module importing it.
#[derive(Clone)]
struct Modules {
    inline: Rc<HashMap<String, String>>,
}

impl Resolver for Modules {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<String> {
        if self.inline.contains_key(name) {
            return Ok(name.to_owned());
        }
        if name == "@diaryx/fig" {
            // A helpful refusal rather than "not found": the package root
            // needs the wasm module, which is not here.
            return Err(rquickjs::Error::new_resolving_message(
                base,
                name,
                "import `LanguageError` and the wire from \"@diaryx/fig/helper\"; the package root needs the wasm module and is not served by fig-quickjs",
            ));
        }
        let candidate: PathBuf = if name.starts_with("./") || name.starts_with("../") {
            Path::new(base)
                .parent()
                .map(|d| d.join(name))
                .unwrap_or_else(|| PathBuf::from(name))
        } else {
            PathBuf::from(name)
        };
        match std::fs::canonicalize(&candidate) {
            Ok(path) if path.is_file() => Ok(path.to_string_lossy().into_owned()),
            _ => Err(rquickjs::Error::new_resolving_message(
                base,
                name,
                "not one of the modules fig-quickjs serves (fig, fig/grammar, fig/xml, @diaryx/fig/helper), and not a file",
            )),
        }
    }
}

impl Loader for Modules {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<Module<'js>> {
        let source = match self.inline.get(name) {
            Some(s) => s.clone(),
            None => std::fs::read_to_string(name)
                .map_err(|e| rquickjs::Error::new_loading_message(name, e.to_string()))?,
        };
        Module::declare(ctx.clone(), name, source)
    }
}
