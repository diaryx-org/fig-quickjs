//! `fig-quickjs <module.mjs>`: serve the format a module defines to a `fig`
//! binary, as a helper process — what a `languages.figl` names as the
//! language's `command`:
//!
//! ```fig
//! language[]
//! > name = js-dotenv
//! > extensions = [env]
//! > command = [fig-quickjs, ~/.config/fig/languages/dotenv.mjs]
//! ```
//!
//! `fig-quickjs check <module.mjs>` loads the module and registers it here,
//! in this process, which runs fig's own harness over the module's samples
//! — the same check the `fig` CLI makes when it loads a helper — and prints
//! what it declared or why it was refused.

use std::io::{BufRead, Write};
use std::process::ExitCode;

use fig_quickjs::JsLanguage;

fn usage() -> String {
    format!(
        "fig-quickjs {}\n\
         \n\
         Usage: fig-quickjs <module.mjs>          serve the module's format on stdin/stdout\n\
         \x20      fig-quickjs check <module.mjs>    load it, run fig's harness, report\n\
         \x20      fig-quickjs --version | --help\n\
         \n\
         A module is an ES module whose default export is a description of the format\n\
         and its parse, print and render functions — the `Language` of @diaryx/fig;\n\
         see the crate's `module` docs.\n",
        env!("CARGO_PKG_VERSION")
    )
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["-h" | "--help" | "help"] => {
            print!("{}", usage());
            ExitCode::SUCCESS
        }
        ["-V" | "--version" | "version"] => {
            println!("fig-quickjs {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        ["check", module] => check(module),
        [module] => serve(module),
        _ => {
            eprint!("{}", usage());
            ExitCode::from(2)
        }
    }
}

fn load(module: &str) -> Result<JsLanguage, ExitCode> {
    JsLanguage::from_file(module).map_err(|e| {
        eprintln!("fig-quickjs: {module}: {e}");
        ExitCode::from(2)
    })
}

/// The wire, straight through: a request line from stdin to the module's
/// `handle`, its response line to stdout. What `fig::helper::serve` would
/// do over the `Language`, without decoding and re-encoding each side.
fn serve(module: &str) -> ExitCode {
    let lang = match load(module) {
        Ok(l) => l,
        Err(code) => return code,
    };
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("fig-quickjs: {e}");
                return ExitCode::FAILURE;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let response = match fig_quickjs::respond(&lang, &line) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("fig-quickjs: {}", e.message);
                return ExitCode::FAILURE;
            }
        };
        if out
            .write_all(response.as_bytes())
            .and_then(|()| out.write_all(b"\n"))
            .and_then(|()| out.flush())
            .is_err()
        {
            // The reader went away; nothing more to say to it.
            return ExitCode::SUCCESS;
        }
    }
    ExitCode::SUCCESS
}

fn check(module: &str) -> ExitCode {
    let lang = match load(module) {
        Ok(l) => l,
        Err(code) => return code,
    };
    let d = lang.description().clone();
    match fig::language::register(lang) {
        Ok(formats) => {
            let caps = [
                (d.caps.read, "read"),
                (d.caps.edit, "edit"),
                (d.caps.serialize, "serialize"),
            ]
            .iter()
            .filter(|(on, _)| *on)
            .map(|(_, name)| *name)
            .collect::<Vec<_>>()
            .join(" ");
            println!(
                "{}: registered ({caps}); {} dialect(s), {} sample(s) parsed{}{}",
                d.name,
                formats.len(),
                d.samples.len(),
                if d.caps.serialize {
                    ", printed and reparsed to the same tree"
                } else {
                    ""
                },
                if d.caps.edit {
                    ", and took a no-op edit"
                } else {
                    ""
                },
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{}: refused: {e}", d.name);
            ExitCode::FAILURE
        }
    }
}
