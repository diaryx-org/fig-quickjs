//! Spike: `fig-quickjs <module.mjs>` — serve the `Language` a module exports
//! on stdin/stdout, through `@diaryx/fig`'s own `handle` (js/wire.js, vendored
//! from the package's dist), under QuickJS.
use std::io::{BufRead, Write};

use std::path::{Path, PathBuf};

use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::{Context, Ctx, Function, Module, Runtime, TypedArray};

const WIRE_JS: &str = include_str!("../js/wire.js");

/// What QuickJS lacks that a language written for the browser or Node
/// assumes: TextEncoder/TextDecoder as UTF-8, over native functions.
const PRELUDE_JS: &str = r#"
globalThis.TextEncoder = class TextEncoder { encode(s) { return __fig_utf8_encode(String(s)); } };
globalThis.TextDecoder = class TextDecoder { decode(b) { return b === undefined ? "" : __fig_utf8_decode(b); } };
"#;

fn main() {
    let path = std::env::args().nth(1).expect("usage: fig-quickjs <module.mjs>");
    let path = std::fs::canonicalize(&path).expect("module path");
    let file = path.to_str().unwrap().to_owned();

    let rt = Runtime::new().unwrap();
    rt.set_loader(Modules, Modules);
    let ctx = Context::full(&rt).unwrap();
    ctx.with(|ctx| {
        install_natives(&ctx);
        ctx.eval::<(), _>(PRELUDE_JS).unwrap();
        let main = format!(
            r#"import {{ handle }} from "fig/wire";
import * as mod from "{file}";
const lang = mod.default ?? Object.values(mod).find((v) => v && typeof v.parse === "function");
if (!lang) throw new Error("module exports no Language");
globalThis.__fig_respond = (line) => handle(lang, line);"#
        );
        let promise = Module::evaluate(ctx.clone(), "main", main).unwrap_or_else(|e| die(&ctx, e));
        promise.finish::<()>().unwrap_or_else(|e| die(&ctx, e));
        let respond: Function = ctx.globals().get("__fig_respond").unwrap();

        let stdin = std::io::stdin();
        let mut out = std::io::stdout().lock();
        for line in stdin.lock().lines() {
            let line = line.unwrap();
            if line.trim().is_empty() {
                continue;
            }
            let response: String = respond.call((line,)).unwrap_or_else(|e| die(&ctx, e));
            out.write_all(response.as_bytes()).unwrap();
            out.write_all(b"\n").unwrap();
            out.flush().unwrap();
        }
    });
}

/// `fig/*` is embedded; anything else is a file, absolute or relative to
/// the module importing it.
struct Modules;

impl Resolver for Modules {
    fn resolve<'js>(&mut self, _ctx: &Ctx<'js>, base: &str, name: &str, _attrs: Option<ImportAttributes<'js>>) -> rquickjs::Result<String> {
        // One instance of the wire, whatever it was imported as, so the
        // `LanguageError` a language throws is the one `handle` tests for.
        if name == "@diaryx/fig/helper" || name == "fig/wire" {
            return Ok("fig/wire".to_owned());
        }
        let candidate: PathBuf = if name.starts_with('.') {
            Path::new(base).parent().map(|d| d.join(name)).unwrap_or_else(|| PathBuf::from(name))
        } else {
            PathBuf::from(name)
        };
        if candidate.is_file() {
            Ok(candidate.to_str().unwrap().to_owned())
        } else {
            Err(rquickjs::Error::new_resolving(base, name))
        }
    }
}

impl Loader for Modules {
    fn load<'js>(&mut self, ctx: &Ctx<'js>, name: &str, _attrs: Option<ImportAttributes<'js>>) -> rquickjs::Result<Module<'js>> {
        let source = match name {
            "fig/wire" => WIRE_JS.to_owned(),
            _ => std::fs::read_to_string(name).map_err(|_| rquickjs::Error::new_loading(name))?,
        };
        Module::declare(ctx.clone(), name, source)
    }
}

fn install_natives<'js>(ctx: &Ctx<'js>) {
    let g = ctx.globals();
    g.set(
        "__fig_utf8_encode",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, s: String| TypedArray::<u8>::new(ctx, s.into_bytes())).unwrap(),
    )
    .unwrap();
    g.set(
        "__fig_utf8_decode",
        Function::new(ctx.clone(), |b: TypedArray<'js, u8>| -> String {
            // The view's bytes; nothing else runs on the engine while this
            // native does, so the buffer cannot move under it.
            let bytes = unsafe { b.as_bytes() }.unwrap_or(&[]);
            String::from_utf8_lossy(bytes).into_owned()
        })
        .unwrap(),
    )
    .unwrap();
}

fn die(ctx: &Ctx<'_>, err: rquickjs::Error) -> ! {
    if let rquickjs::Error::Exception = err {
        let ex = ctx.catch();
        eprintln!("fig-quickjs: {:?}", ex);
    } else {
        eprintln!("fig-quickjs: {err}");
    }
    std::process::exit(2);
}
