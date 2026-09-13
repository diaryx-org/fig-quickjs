//! Each module in `languages/` is a twin of a format fig compiles in, and
//! is held to it two ways.
//!
//! **Table for table.** `tests/fixtures/<format>/*.<ext>` are documents;
//! beside each, `*.table.json` is the node table the compiled format gives
//! for it, printed by `fig lang table -i <format>` — regenerate one with
//! that command when the compiled format changes. The module's `parse` must
//! give the same table: every row, span, text and comment.
//!
//! **Through fig.** The module is registered in-process, the same source is
//! parsed through it and through the compiled format, and the two trees
//! are printed through the compiled printer, edited the same way, and
//! compared. What `fig lang check js-dotenv --against dotenv` does from
//! the command line, without the command line.

use std::path::Path;
use std::sync::OnceLock;

use fig::language::{Language, Literal, RenderArgs, Renderer};
use fig::{Document, Editor, Format, Segment, Value};
use fig_quickjs::JsLanguage;

fn module(name: &str) -> JsLanguage {
    JsLanguage::from_file(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("languages")
            .join(name),
    )
    .expect("the module loads")
}

/// A value with every map's keys sorted and every null entry dropped, so
/// two JSON spellings of one table compare equal whichever side wrote them.
fn canonical(v: &Value) -> Value {
    match v {
        Value::Map(entries) => {
            let mut out: Vec<(Value, Value)> = entries
                .iter()
                .filter(|(_, v)| !matches!(v, Value::Null))
                .map(|(k, v)| (canonical(k), canonical(v)))
                .collect();
            out.sort_by(|a, b| format!("{:?}", a.0).cmp(&format!("{:?}", b.0)));
            Value::Map(out)
        }
        Value::Seq(items) => Value::Seq(items.iter().map(canonical).collect()),
        // A span is written as an unsigned integer by one side and read
        // back as a signed one by the other.
        Value::Uint(n) => match i64::try_from(*n) {
            Ok(i) => Value::Int(i),
            Err(_) => Value::Uint(*n),
        },
        other => other.clone(),
    }
}

fn fixtures(format: &str, ext: &str) -> Vec<(String, Vec<u8>, Value)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(format);
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("fixture directory") {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some(ext) {
            continue;
        }
        // A JSON twin's fixtures share the table's extension.
        if path.to_string_lossy().ends_with(".table.json") {
            continue;
        }
        let source = std::fs::read(&path).unwrap();
        let table_path = path.with_extension("table.json");
        let table_json = std::fs::read(&table_path)
            .unwrap_or_else(|_| panic!("{} has no table beside it", path.display()));
        let table = Document::parse(&table_json, Format::Json)
            .expect("the table is JSON")
            .to_value()
            .unwrap();
        out.push((
            path.file_name().unwrap().to_string_lossy().into_owned(),
            source,
            table,
        ));
    }
    assert!(!out.is_empty(), "no fixtures under {}", dir.display());
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// One registration per process: a name can be registered once.
fn js_dotenv() -> Format {
    static FORMAT: OnceLock<Format> = OnceLock::new();
    *FORMAT.get_or_init(|| fig::language::register(module("dotenv.mjs")).expect("registers")[0])
}

#[test]
fn dotenv_parses_every_fixture_to_the_compiled_table() {
    let lang = module("dotenv.mjs");
    for (name, source, want) in fixtures("dotenv", "env") {
        let table = lang
            .parse("js-dotenv", &source)
            .unwrap_or_else(|e| panic!("{name}: {}", e.message));
        let got = fig::helper::table_to_value(&table);
        assert_eq!(
            canonical(&got),
            canonical(&want),
            "{name}: the module's table differs from the compiled one\n  got:  {}\n  want: {}",
            fig::helper::encode(&canonical(&got)),
            fig::helper::encode(&canonical(&want)),
        );
    }
}

#[test]
fn dotenv_registers_and_is_the_compiled_format_at_every_entry_point() {
    let js = js_dotenv();
    assert!(matches!(js, Format::Runtime(_)));
    assert_eq!(Format::by_name("js-dotenv"), Some(js));

    for (name, source, _) in fixtures("dotenv", "env") {
        let mine = Document::parse(&source, js).unwrap_or_else(|e| panic!("{name}: {e}"));
        let theirs = Document::parse(&source, Format::Dotenv).unwrap();
        // The same tree, comments included: both print the same through
        // the compiled printer and through the module's.
        assert_eq!(
            mine.serialize(Format::Dotenv).unwrap(),
            theirs.serialize(Format::Dotenv).unwrap(),
            "{name}: trees differ"
        );
        assert_eq!(
            mine.serialize(js).unwrap(),
            theirs.serialize(js).unwrap(),
            "{name}: the module prints the two trees differently"
        );
        assert_eq!(
            mine.serialize(js).unwrap(),
            theirs.serialize(Format::Dotenv).unwrap(),
            "{name}: the module's printer differs from the compiled one"
        );
        assert_eq!(mine.to_value().unwrap(), theirs.to_value().unwrap());
    }
}

#[test]
fn dotenv_refuses_what_the_compiled_format_refuses() {
    // The documents the compiled format refuses, refused here too. The
    // message and the offset each side gives are its own: the contract
    // is the format, not the compiled parser.
    let js = js_dotenv();
    for bad in [
        &b"A=1\nB\nC=2\n"[..],
        b"A=1\n-B=2\n",
        b"A=\"unclosed\n",
        b"A=\"bad \\q escape\"\n",
        b"A=\"x\" y\n",
        b"A=1\rB=2\n",
        b"\n=1\n",
    ] {
        assert!(
            Document::parse(bad, Format::Dotenv).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
        assert!(
            Document::parse(bad, js).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
    }
}

#[test]
fn dotenv_edits_as_the_compiled_format_does() {
    let js = js_dotenv();
    let src = b"# secrets\nexport DB_URL=postgres://localhost/app # local\nAPI_KEY=\"abc\\n123\"\nEMPTY=\n";
    let mut mine = Editor::open(src, js).unwrap();
    let mut theirs = Editor::open(src, Format::Dotenv).unwrap();
    for ed in [&mut mine, &mut theirs] {
        ed.replace_value(&[Segment::Key("DB_URL")], "sqlite://x")
            .unwrap();
        ed.insert_value(&[], "NEW", "two words").unwrap();
        ed.delete(&[Segment::Key("EMPTY")]).unwrap();
        ed.add_leading_comment(&[Segment::Key("API_KEY")], "the key")
            .unwrap();
    }
    assert_eq!(mine.source().unwrap(), theirs.source().unwrap());
    assert!(mine.source().unwrap().contains("# the key\nAPI_KEY="));
}

/// One registration per process: a name can be registered once.
fn js_json() -> Format {
    static FORMAT: OnceLock<Format> = OnceLock::new();
    *FORMAT.get_or_init(|| fig::language::register(module("json.mjs")).expect("registers")[0])
}

#[test]
fn json_parses_every_fixture_to_the_compiled_table() {
    let lang = module("json.mjs");
    for (name, source, want) in fixtures("json", "json") {
        let table = lang
            .parse("js-json", &source)
            .unwrap_or_else(|e| panic!("{name}: {}", e.message));
        let got = fig::helper::table_to_value(&table);
        assert_eq!(
            canonical(&got),
            canonical(&want),
            "{name}: the script's table differs from the compiled one\n  got:  {}\n  want: {}",
            fig::helper::encode(&canonical(&got)),
            fig::helper::encode(&canonical(&want)),
        );
    }
}

#[test]
fn json_registers_and_is_the_compiled_format_at_every_entry_point() {
    let mine_fmt = js_json();
    assert!(matches!(mine_fmt, Format::Runtime(_)));
    assert_eq!(Format::by_name("js-json"), Some(mine_fmt));

    for (name, source, _) in fixtures("json", "json") {
        let mine = Document::parse(&source, mine_fmt).unwrap_or_else(|e| panic!("{name}: {e}"));
        let theirs = Document::parse(&source, Format::Json).unwrap();
        // The same tree: both print the same through the compiled printer
        // and through the script's, and the script's printer is the
        // compiled one's, byte for byte.
        assert_eq!(
            mine.serialize(Format::Json).unwrap(),
            theirs.serialize(Format::Json).unwrap(),
            "{name}: trees differ"
        );
        assert_eq!(
            mine.serialize(mine_fmt).unwrap(),
            theirs.serialize(mine_fmt).unwrap(),
            "{name}: the script prints the two trees differently"
        );
        assert_eq!(
            mine.serialize(mine_fmt).unwrap(),
            theirs.serialize(Format::Json).unwrap(),
            "{name}: the script's printer differs from the compiled one"
        );
        assert_eq!(mine.to_value().unwrap(), theirs.to_value().unwrap());
    }
}

#[test]
fn json_refuses_what_the_compiled_format_refuses() {
    // The documents the compiled format refuses, refused here too. The
    // message and the offset each side gives are its own: the contract
    // is the format, not the compiled parser.
    let mine = js_json();
    for bad in [
        &b"[1,]"[..],
        b"[1 2]",
        b"{\"a\" 1}",
        b"{a: 1}",
        b"{\"a\":1",
        b"{\"a\":1}{",
        b"\"\\q\"",
        b"\"\\u12g4\"",
        b"\"ab\ncd\"",
        b"nul",
        b"-x",
        b"01",
        b"1.",
        b"1e",
        b"\"abc",
    ] {
        assert!(
            Document::parse(bad, Format::Json).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
        assert!(
            Document::parse(bad, mine).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
    }
}

#[test]
fn json_edits_as_the_compiled_format_does() {
    let mine_fmt = js_json();
    let src = b"{\n  \"name\": \"fig\",\n  \"formats\": [\"json\", \"yaml\"],\n  \"runtime\": {\"lua\": true},\n  \"gone\": null\n}\n";
    let mut mine = Editor::open(src, mine_fmt).unwrap();
    let mut theirs = Editor::open(src, Format::Json).unwrap();
    for ed in [&mut mine, &mut theirs] {
        ed.replace_value(&[Segment::Key("name")], "fig 3").unwrap();
        ed.insert_value(&[Segment::Key("runtime")], "js", true)
            .unwrap();
        ed.append_value(&[Segment::Key("formats")], "toml").unwrap();
        ed.delete(&[Segment::Key("gone")]).unwrap();
        ed.remove_item(&[Segment::Key("formats")], 0).unwrap();
        ed.set_value(&[Segment::Key("count")], 3i64).unwrap();
    }
    assert_eq!(mine.source().unwrap(), theirs.source().unwrap());
    let out = mine.source().unwrap();
    assert!(out.contains("\"name\": \"fig 3\""), "{out}");
    assert!(out.contains("[\"yaml\", \"toml\"]"), "{out}");
    assert!(!out.contains("gone"), "{out}");
    // A flow root edited by comma-aware splice, as the compiled format's
    // is: the root of a runtime language is not a section root.
    let list = b"[1, 2, 3]\n";
    let mut mine = Editor::open(list, mine_fmt).unwrap();
    let mut theirs = Editor::open(list, Format::Json).unwrap();
    for ed in [&mut mine, &mut theirs] {
        ed.remove_item(&[], 1).unwrap();
        ed.append_value(&[], 4i64).unwrap();
    }
    assert_eq!(mine.source().unwrap(), theirs.source().unwrap());
    assert_eq!(mine.source().unwrap(), "[1, 3, 4]\n");
}

/// One registration per process: a name can be registered once.
fn js_toml() -> Format {
    static FORMAT: OnceLock<Format> = OnceLock::new();
    *FORMAT.get_or_init(|| fig::language::register(module("toml.mjs")).expect("registers")[0])
}

#[test]
fn toml_parses_every_fixture_to_the_compiled_table() {
    let lang = module("toml.mjs");
    for (name, source, want) in fixtures("toml", "toml") {
        let table = lang
            .parse("js-toml", &source)
            .unwrap_or_else(|e| panic!("{name}: {}", e.message));
        let got = fig::helper::table_to_value(&table);
        assert_eq!(
            canonical(&got),
            canonical(&want),
            "{name}: the script's table differs from the compiled one\n  got:  {}\n  want: {}",
            fig::helper::encode(&canonical(&got)),
            fig::helper::encode(&canonical(&want)),
        );
    }
}

#[test]
fn toml_registers_and_is_the_compiled_format_at_every_entry_point() {
    let mine_fmt = js_toml();
    assert!(matches!(mine_fmt, Format::Runtime(_)));
    assert_eq!(Format::by_name("js-toml"), Some(mine_fmt));

    for (name, source, _) in fixtures("toml", "toml") {
        let mine = Document::parse(&source, mine_fmt).unwrap_or_else(|e| panic!("{name}: {e}"));
        let theirs = Document::parse(&source, Format::Toml).unwrap();
        // The same tree, comments included: both print the same through
        // the compiled printer and through the script's, and the script's
        // printer is the compiled one's, byte for byte — sections, dotted
        // demotions, wrapped arrays and all.
        assert_eq!(
            mine.serialize(Format::Toml).unwrap(),
            theirs.serialize(Format::Toml).unwrap(),
            "{name}: trees differ"
        );
        assert_eq!(
            mine.serialize(mine_fmt).unwrap(),
            theirs.serialize(mine_fmt).unwrap(),
            "{name}: the script prints the two trees differently"
        );
        assert_eq!(
            mine.serialize(mine_fmt).unwrap(),
            theirs.serialize(Format::Toml).unwrap(),
            "{name}: the script's printer differs from the compiled one"
        );
        // Compared as printed: a `nan` is a NaN, and NaN is not equal to
        // itself.
        assert_eq!(
            format!("{:?}", mine.to_value().unwrap()),
            format!("{:?}", theirs.to_value().unwrap())
        );
    }
}

#[test]
fn toml_refuses_what_the_compiled_format_refuses() {
    // The documents the compiled format refuses, refused here too. The
    // message and the offset each side gives are its own: the contract
    // is the format, not the compiled parser.
    let mine = js_toml();
    for bad in [
        &b"a = 1\na = 2\n"[..],
        b"[t]\n[t]\n",
        b"[a.b]\n[a]\nb.c = 1\n",
        b"a = 1 b = 2\n",
        b"a = \"unclosed\n",
        b"a = hello\n",
        b"a = 1.2.3\n",
        b"a = 07\n",
        b"a = 2024-13-01\n",
        b"a = \"\\q\"\n",
        b"= 1\n",
        b"a = [1, 2\n",
        b"a = { b = 1\n",
    ] {
        assert!(
            Document::parse(bad, Format::Toml).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
        assert!(
            Document::parse(bad, mine).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
    }
}

#[test]
fn toml_edits_as_the_compiled_format_does() {
    // The section format's whole editing surface: a value in a table, a key
    // that creates a table, a table deleted and one renamed with every
    // mention of its name, an array appended to, a comment placed — each
    // through the script and through the compiled format, to the same bytes.
    let mine_fmt = js_toml();
    let src = b"title = \"fig\"\nports = [80]\n\n[server]\nhost = \"h\"\n\n[server.tls]\non = true\n\n[[products]]\nname = \"a\"\n\n[[products]]\nname = \"b\"\n";
    let mut mine = Editor::open(src, mine_fmt).unwrap();
    let mut theirs = Editor::open(src, Format::Toml).unwrap();
    for ed in [&mut mine, &mut theirs] {
        ed.replace_value(&[Segment::Key("server"), Segment::Key("host")], "localhost")
            .unwrap();
        ed.set_value(
            &[
                Segment::Key("fresh"),
                Segment::Key("deep"),
                Segment::Key("key"),
            ],
            1i64,
        )
        .unwrap();
        ed.append_value(&[Segment::Key("ports")], 443i64).unwrap();
        ed.delete_container(&[Segment::Key("server"), Segment::Key("tls")])
            .unwrap();
        ed.rename_container(&[Segment::Key("server")], "srv")
            .unwrap();
        ed.add_leading_comment(&[Segment::Key("title")], "the name")
            .unwrap();
        ed.delete(&[
            Segment::Key("products"),
            Segment::Index(0),
            Segment::Key("name"),
        ])
        .unwrap();
    }
    assert_eq!(mine.source().unwrap(), theirs.source().unwrap());
    let out = mine.source().unwrap();
    assert!(out.contains("[srv]\nhost = \"localhost\""), "{out}");
    assert!(!out.contains("tls"), "{out}");
    assert!(out.contains("ports = [80, 443]"), "{out}");
    assert!(out.contains("# the name\ntitle"), "{out}");
}

/// One registration per process: a name can be registered once.
fn js_ini() -> Format {
    static FORMAT: OnceLock<Format> = OnceLock::new();
    *FORMAT.get_or_init(|| fig::language::register(module("ini.mjs")).expect("registers")[0])
}

#[test]
fn ini_parses_every_fixture_to_the_compiled_table() {
    let lang = module("ini.mjs");
    for (name, source, want) in fixtures("ini", "ini") {
        let table = lang
            .parse("js-ini", &source)
            .unwrap_or_else(|e| panic!("{name}: {}", e.message));
        let got = fig::helper::table_to_value(&table);
        assert_eq!(
            canonical(&got),
            canonical(&want),
            "{name}: the script's table differs from the compiled one\n  got:  {}\n  want: {}",
            fig::helper::encode(&canonical(&got)),
            fig::helper::encode(&canonical(&want)),
        );
    }
}

#[test]
fn ini_registers_and_is_the_compiled_format_at_every_entry_point() {
    let mine_fmt = js_ini();
    assert!(matches!(mine_fmt, Format::Runtime(_)));
    assert_eq!(Format::by_name("js-ini"), Some(mine_fmt));

    for (name, source, _) in fixtures("ini", "ini") {
        let mine = Document::parse(&source, mine_fmt).unwrap_or_else(|e| panic!("{name}: {e}"));
        let theirs = Document::parse(&source, Format::Ini).unwrap();
        // The same tree, comments included: both print the same through
        // the compiled printer and through the script's, and the script's
        // printer is the compiled one's, byte for byte.
        assert_eq!(
            mine.serialize(Format::Ini).unwrap(),
            theirs.serialize(Format::Ini).unwrap(),
            "{name}: trees differ"
        );
        assert_eq!(
            mine.serialize(mine_fmt).unwrap(),
            theirs.serialize(mine_fmt).unwrap(),
            "{name}: the script prints the two trees differently"
        );
        assert_eq!(
            mine.serialize(mine_fmt).unwrap(),
            theirs.serialize(Format::Ini).unwrap(),
            "{name}: the script's printer differs from the compiled one"
        );
        assert_eq!(mine.to_value().unwrap(), theirs.to_value().unwrap());
    }
}

#[test]
fn ini_refuses_what_the_compiled_format_refuses() {
    // The documents the compiled format refuses, refused here too. The
    // message and the offset each side gives are its own: the contract
    // is the format, not the compiled parser.
    let mine = js_ini();
    for bad in [
        &b"a = 1\n[a]\n"[..],
        b"[open\n",
        b"nokey\n",
        b"k = v\n]\n",
        b"[s] x\n",
        b"[ ]\n",
        b"= 1\n",
        b"a=1\r\rb=2\n",
    ] {
        assert!(
            Document::parse(bad, Format::Ini).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
        assert!(
            Document::parse(bad, mine).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
    }
}

#[test]
fn ini_edits_as_the_compiled_format_does() {
    // A section format's editing surface, INI-sized: values in and out of
    // a section, a key that lands in a section, a whole section deleted —
    // a reopened one, gathered from its regions — and a comment placed.
    let mine_fmt = js_ini();
    let src = b"; top\nroot = 1\n\n[server]\nhost = h\n\n[other]\nk = v\n\n[server]\nport = 80\n";
    let mut mine = Editor::open(src, mine_fmt).unwrap();
    let mut theirs = Editor::open(src, Format::Ini).unwrap();
    for ed in [&mut mine, &mut theirs] {
        ed.replace_value(&[Segment::Key("server"), Segment::Key("host")], "localhost")
            .unwrap();
        ed.insert_value(&[Segment::Key("other")], "new", "yes")
            .unwrap();
        ed.set_value(&[Segment::Key("root")], 2i64).unwrap();
        ed.add_leading_comment(&[Segment::Key("other"), Segment::Key("k")], "the k")
            .unwrap();
        ed.delete_container(&[Segment::Key("server")]).unwrap();
    }
    assert_eq!(mine.source().unwrap(), theirs.source().unwrap());
    let out = mine.source().unwrap();
    assert!(!out.contains("server"), "{out}");
    assert!(out.contains("; the k\nk = v"), "{out}");
    assert!(out.contains("new = yes"), "{out}");
}

/// One registration per process: a name can be registered once.
fn js_fig() -> Format {
    static FORMAT: OnceLock<Format> = OnceLock::new();
    *FORMAT.get_or_init(|| fig::language::register(module("fig.mjs")).expect("registers")[0])
}

#[test]
fn fig_parses_every_fixture_to_the_compiled_table() {
    let lang = module("fig.mjs");
    for (name, source, want) in fixtures("fig", "figl") {
        let table = lang
            .parse("js-fig", &source)
            .unwrap_or_else(|e| panic!("{name}: {}", e.message));
        let got = fig::helper::table_to_value(&table);
        assert_eq!(
            canonical(&got),
            canonical(&want),
            "{name}: the script's table differs from the compiled one\n  got:  {}\n  want: {}",
            fig::helper::encode(&canonical(&got)),
            fig::helper::encode(&canonical(&want)),
        );
    }
}

#[test]
fn fig_registers_and_is_the_compiled_format_at_every_entry_point() {
    let mine_fmt = js_fig();
    assert!(matches!(mine_fmt, Format::Runtime(_)));
    assert_eq!(Format::by_name("js-fig"), Some(mine_fmt));

    for (name, source, _) in fixtures("fig", "figl") {
        let mine = Document::parse(&source, mine_fmt).unwrap_or_else(|e| panic!("{name}: {e}"));
        let theirs = Document::parse(&source, Format::Fig).unwrap();
        // The same tree, comments included: both print the same through
        // the compiled printer and through the script's, and the script's
        // printer is the compiled one's, byte for byte — sections, dotted
        // collapse, append groups, multi-line flow and all.
        assert_eq!(
            mine.serialize(Format::Fig).unwrap(),
            theirs.serialize(Format::Fig).unwrap(),
            "{name}: trees differ"
        );
        assert_eq!(
            mine.serialize(mine_fmt).unwrap(),
            theirs.serialize(mine_fmt).unwrap(),
            "{name}: the script prints the two trees differently"
        );
        assert_eq!(
            mine.serialize(mine_fmt).unwrap(),
            theirs.serialize(Format::Fig).unwrap(),
            "{name}: the script's printer differs from the compiled one"
        );
        // Compared as printed: `n: float = inf` is a NaN-class float on
        // neither side, but a `nan` would be, and NaN is not equal to itself.
        assert_eq!(
            format!("{:?}", mine.to_value().unwrap()),
            format!("{:?}", theirs.to_value().unwrap())
        );
    }
}

#[test]
fn fig_refuses_what_the_compiled_format_refuses() {
    // The documents the compiled format refuses, refused here too. The
    // message and the offset each side gives are its own: the contract
    // is the format, not the compiled parser.
    let mine = js_fig();
    for bad in [
        &b"a\n>> b = 1\n"[..],
        b"> a = 1\n",
        b">a = 1\n",
        b"key: value\n",
        b"a = 1\na = 2\n",
        b"a\n",
        b"a = \"unclosed\n",
        b"a = \"x\" y\n",
        b"a = [1, 2\n",
        b"a = {x: 1}\n",
        b"a: int = x\n",
        b"+\n",
        b"a = { x = 1 }\na.y = 2\n",
        b"l\n> * 1\n> k = 2\n",
        b"a = '''abc'''\n",
    ] {
        assert!(
            Document::parse(bad, Format::Fig).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
        assert!(
            Document::parse(bad, mine).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
    }
}

#[test]
fn fig_edits_as_the_compiled_format_does() {
    // The section format's editing surface, fig-shaped: values under
    // markers, a key that creates a container, a container deleted with
    // its re-entered header lines gathered from its regions, an element
    // appended, a comment placed — each through the script and through the
    // compiled format, to the same bytes.
    let mine_fmt = js_fig();
    let src = b"title = x\ndatabase\n> host = localhost\n> pool\n> > size = 10\n\nlogging\n> level = info\nlogging\n> file = a.log\ntags = [a, b]\n";
    let mut mine = Editor::open(src, mine_fmt).unwrap();
    let mut theirs = Editor::open(src, Format::Fig).unwrap();
    for ed in [&mut mine, &mut theirs] {
        ed.replace_value(
            &[
                Segment::Key("database"),
                Segment::Key("pool"),
                Segment::Key("size"),
            ],
            20i64,
        )
        .unwrap();
        ed.set_value(
            &[
                Segment::Key("fresh"),
                Segment::Key("deep"),
                Segment::Key("key"),
            ],
            1i64,
        )
        .unwrap();
        ed.append_value(&[Segment::Key("tags")], "c").unwrap();
        ed.delete_container(&[Segment::Key("logging")]).unwrap();
        ed.add_leading_comment(&[Segment::Key("title")], "the name")
            .unwrap();
    }
    assert_eq!(mine.source().unwrap(), theirs.source().unwrap());
    let out = mine.source().unwrap();
    assert!(out.contains("> > size = 20"), "{out}");
    assert!(!out.contains("logging"), "{out}");
    assert!(out.contains("tags = [a, b, c]"), "{out}");
    assert!(out.contains("# the name\ntitle"), "{out}");

    // A block map set as a value. The Rust editor spells a `Value` through
    // the format it is editing, and asks the compiled fig printer for the
    // flow form by name — a request the wire does not carry — so the
    // compiled format splices `registry = { a = 1, b = 2 }` while the
    // script's block spelling goes through its `tail` renderer and lands
    // as a nested section. Two spellings of one tree.
    let registry = Value::Map(vec![
        (Value::Str("a".into()), Value::Int(1)),
        (Value::Str("b".into()), Value::Int(2)),
    ]);
    mine.set_value(&[Segment::Key("registry")], registry.clone())
        .unwrap();
    theirs
        .set_value(&[Segment::Key("registry")], registry)
        .unwrap();
    assert!(
        mine.source()
            .unwrap()
            .contains("registry\n> a = 1\n> b = 2"),
        "{}",
        mine.source().unwrap()
    );
    assert!(
        theirs
            .source()
            .unwrap()
            .contains("registry = { a = 1, b = 2 }"),
        "{}",
        theirs.source().unwrap()
    );
    assert_eq!(
        Document::parse(mine.source().unwrap().as_bytes(), mine_fmt)
            .unwrap()
            .to_value()
            .unwrap(),
        Document::parse(theirs.source().unwrap().as_bytes(), Format::Fig)
            .unwrap()
            .to_value()
            .unwrap(),
    );
}

#[test]
fn plist_parses_every_fixture_to_the_compiled_table() {
    let lang = module("plist.mjs");
    for (name, source, want) in fixtures("plist", "plist") {
        let table = lang
            .parse("js-plist", &source)
            .unwrap_or_else(|e| panic!("{name}: {}", e.message));
        let got = fig::helper::table_to_value(&table);
        assert_eq!(
            canonical(&got),
            canonical(&want),
            "{name}: the module's table differs from the compiled one"
        );
    }
}

#[test]
fn plist_registers_and_renders_typed_values() {
    // plist is not in fig's default feature set, so the compiled sibling is
    // not here to compare against in-process; `fig lang check js-plist
    // --against plist` is that comparison, and the CLI is where the editor
    // is driven with bare text (the Rust editor spells a key through the
    // printer, which for plist is not the key — a task in fig). What is
    // checked here is the harness, the printer, and the two renderers by
    // the rules the compiled ones follow.
    let lang = module("plist.mjs");
    // The value renderer spells the kind fig's bare-literal rules gave the
    // text — `literal` — and decides none itself.
    let render = |which: Renderer, key: &str, value: &str, literal: Literal| -> String {
        let args = RenderArgs {
            dialect: "js-plist",
            indent: b"  ",
            key: key.as_bytes(),
            value: value.as_bytes(),
            literal,
            old_key: b"",
        };
        String::from_utf8(lang.render(which, args).expect("renders")).unwrap()
    };
    for (bare, literal, element) in [
        ("42", Literal::Int, "<integer>42</integer>"),
        ("-1_000", Literal::Int, "<integer>-1_000</integer>"),
        ("007", Literal::String, "<string>007</string>"),
        ("2.5", Literal::Float, "<real>2.5</real>"),
        ("true", Literal::Bool, "<true/>"),
        ("false", Literal::Bool, "<false/>"),
        ("Yes", Literal::String, "<string>Yes</string>"),
        ("2026-09-10", Literal::Datetime, "<date>2026-09-10</date>"),
        (
            "1 < 2 & 3",
            Literal::String,
            "<string>1 &lt; 2 &amp; 3</string>",
        ),
        ("<data>aGk=</data>", Literal::String, "<data>aGk=</data>"),
        (
            "  <string>2.0</string>  ",
            Literal::String,
            "<string>2.0</string>",
        ),
    ] {
        assert_eq!(
            render(Renderer::Value, "", bare, literal),
            element,
            "{bare}"
        );
    }
    assert!(
        lang.render(
            Renderer::Value,
            RenderArgs {
                value: b"null",
                literal: Literal::Null,
                ..Default::default()
            }
        )
        .is_err()
    );
    assert_eq!(
        render(Renderer::Entry, "a&b", "<true/>", Literal::String),
        "<key>a&amp;b</key>\n  <true/>"
    );

    let js = fig::language::register(lang).expect("registers")[0];
    let src = b"<dict>\n  <key>a</key>\n  <string>x</string>\n  <key>l</key>\n  <array><integer>1</integer></array>\n</dict>\n";
    let doc = Document::parse(src, js).unwrap();
    assert_eq!(
        doc.to_value().unwrap().get("a").and_then(Value::as_str),
        Some("x")
    );
    let printed = doc.serialize(js).unwrap();
    assert_eq!(
        printed,
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>a</key>\n  <string>x</string>\n  <key>l</key>\n  <array>\n    <integer>1</integer>\n  </array>\n</dict>\n</plist>\n"
    );
    // The literal's arrival through the engine is proved at the command
    // line (`fig set … --lang js-plist` against `-i plist`), where the
    // value is bare text: the Rust editor prints a value through the format
    // before the renderer sees it, so in-process a `42` is already an
    // element by the time `literal` is computed.
    // Deleting is generic and line-based, so it holds without a renderer.
    let mut ed = Editor::open(src, js).unwrap();
    ed.delete(&[Segment::Key("a")]).unwrap();
    assert_eq!(
        ed.source().unwrap(),
        "<dict>\n  <key>l</key>\n  <array><integer>1</integer></array>\n</dict>\n"
    );
}

#[test]
fn canonical_parses_every_fixture_to_the_compiled_table() {
    let lang = module("canonical.mjs");
    for (name, source, want) in fixtures("canonical", "canonical") {
        let table = lang
            .parse("js-canonical", &source)
            .unwrap_or_else(|e| panic!("{name}: {}", e.message));
        let got = fig::helper::table_to_value(&table);
        assert_eq!(
            canonical(&got),
            canonical(&want),
            "{name}: the module's table differs from the compiled one\n  got:  {}\n  want: {}",
            fig::helper::encode(&canonical(&got)),
            fig::helper::encode(&canonical(&want)),
        );
    }
}

#[test]
fn canonical_prints_one_spelling_that_reparses_to_the_same_table() {
    // The canonical form is opt-in in fig's build, so the compiled sibling
    // is not here to compare against in-process; `fig lang check
    // js-canonical --against canonical` is that comparison. What is
    // checked here is the printer: every fixture prints to a document
    // that parses back to the same rows and comments, and a second print
    // is the first.
    let lang = module("canonical.mjs");
    for (name, source, _) in fixtures("canonical", "canonical") {
        let table = lang.parse("js-canonical", &source).unwrap();
        let printed = lang
            .print("js-canonical", &table, &Default::default())
            .unwrap_or_else(|e| panic!("{name}: {}", e.message));
        let again = lang.parse("js-canonical", &printed).unwrap_or_else(|e| {
            panic!(
                "{name}: {}\n{}",
                e.message,
                String::from_utf8_lossy(&printed)
            )
        });
        // Spans move; rows, texts and comments do not.
        let strip = |t: &fig::language::NodeTable| {
            let mut v = fig::helper::table_to_value(t);
            let rows = match &mut v {
                Value::Map(entries) => entries
                    .iter_mut()
                    .find(|(k, _)| k.as_str() == Some("rows"))
                    .map(|(_, rows)| rows),
                _ => None,
            };
            if let Some(Value::Seq(rows)) = rows {
                for row in rows.iter_mut() {
                    if let Value::Map(fields) = row {
                        fields.retain(|(k, _)| k.as_str() != Some("span"));
                    }
                }
            }
            canonical(&v)
        };
        assert_eq!(
            strip(&table),
            strip(&again),
            "{name}: the print does not reparse to the same tree"
        );
        let twice = lang
            .print("js-canonical", &again, &Default::default())
            .unwrap();
        assert_eq!(
            printed, twice,
            "{name}: the second print differs from the first"
        );
    }

    // The layout is the compiled printer's, with a trailing comment kept
    // on the line of the value it belongs to.
    let table = lang
        .parse(
            "js-canonical",
            b"/* d */ { \"a\": [1, ~f2, @local_date \"2024-01-01\"], &x \"b\": {}, // e\n \"c\": *x }\n",
        )
        .unwrap();
    let printed = lang
        .print("js-canonical", &table, &Default::default())
        .unwrap();
    assert_eq!(
        String::from_utf8(printed).unwrap(),
        "{\n  /* d */\n  \"a\": [\n    1,\n    ~f2,\n    @local_date \"2024-01-01\"\n  ],\n  &x \"b\": {}, // e\n  \"c\": *x\n}\n"
    );
}

#[test]
fn a_module_that_is_not_a_description_is_refused_at_load() {
    let err = JsLanguage::from_source("bad.mjs", "export default 42;").unwrap_err();
    assert!(err.to_string().contains("bad.mjs"), "{err}");
    let err = JsLanguage::from_source("syntax.mjs", "export default {").unwrap_err();
    assert!(err.to_string().contains("syntax.mjs"), "{err}");
    // A language, but not a description: no `caps`. (What is well-formed
    // but wrong — no samples, a taken name — is the harness's to refuse,
    // at registration.)
    let err = JsLanguage::from_source(
        "capless.mjs",
        r#"export default { name: "x", dialects: [{ name: "x" }], samples: [""], parse() {} };"#,
    )
    .unwrap_err();
    assert!(err.to_string().contains("capless.mjs"), "{err}");
    // An import nothing serves.
    let err = JsLanguage::from_source(
        "imports.mjs",
        r#"import fs from "node:fs"; export default {};"#,
    )
    .unwrap_err();
    assert!(err.to_string().contains("node:fs"), "{err}");
    // The package root, with the pointer to the entry that is served.
    let err = JsLanguage::from_source(
        "root.mjs",
        r#"import { LanguageError } from "@diaryx/fig"; export default {};"#,
    )
    .unwrap_err();
    assert!(err.to_string().contains("@diaryx/fig/helper"), "{err}");
}

#[test]
fn a_parse_that_throws_is_a_language_error() {
    let lang = JsLanguage::from_source(
        "raise.mjs",
        r#"
        import * as fig from "fig";
        export default {
          name: "raise", caps: { read: true }, dialects: [{ name: "raise" }], samples: [""],
          parse(_, input) {
            if (input === "") { const t = fig.table(); t.row("null", null, [0, 0]); return t; }
            throw new TypeError("no thanks");
          },
        };
        "#,
    )
    .unwrap();
    let err = lang.parse("raise", b"x").unwrap_err();
    assert_eq!(err.message, "no thanks");
    assert_eq!(err.byte_offset, None);
    let err = JsLanguage::from_source(
        "refuse.mjs",
        r#"
        import * as fig from "fig";
        export default {
          name: "refuse", caps: { read: true }, dialects: [{ name: "refuse" }], samples: [""],
          parse(_, input) { return fig.fail("not here", 3); },
        };
        "#,
    )
    .unwrap()
    .parse("refuse", b"x")
    .unwrap_err();
    assert_eq!(
        (err.message.as_str(), err.byte_offset),
        ("not here", Some(3))
    );
    // Not UTF-8: refused on this side, at the first bad byte, since the
    // wire carries text and the module could never see it.
    let err = module("dotenv.mjs")
        .parse("js-dotenv", b"A=1\n\xff")
        .unwrap_err();
    assert_eq!(err.byte_offset, Some(4));
}

#[test]
fn a_language_may_be_any_export_with_a_parse_and_may_log_to_stderr() {
    // No default export: the first export with a `parse` is the language.
    // `console` reaches stderr, never the wire.
    let lang = JsLanguage::from_source(
        "named.mjs",
        r#"
        import * as fig from "fig";
        export const helper = 1;
        export const lang = {
          name: "named", caps: { read: true }, dialects: [{ name: "named" }], samples: [""],
          parse(_, input) { console.log("parsing", input.length); const t = fig.table(); t.row("null", null, [0, 0]); return t; },
        };
        "#,
    )
    .unwrap();
    assert_eq!(lang.description().name, "named");
    assert_eq!(lang.parse("named", b"").unwrap().rows.len(), 1);
    // Bytes in, byte offsets out: a scanner over multibyte text.
    let table = module("dotenv.mjs")
        .parse("js-dotenv", "K=ü # ünï\n".as_bytes())
        .unwrap();
    let v = fig::helper::table_to_value(&table);
    let value_span = v.get("rows").unwrap().get(3).unwrap().get("span").unwrap();
    assert_eq!(fig::helper::encode(value_span), "[2,4]");
}

/// One registration per process: a name can be registered once.
fn js_properties() -> Format {
    static FORMAT: OnceLock<Format> = OnceLock::new();
    *FORMAT.get_or_init(|| fig::language::register(module("properties.mjs")).expect("registers")[0])
}

#[test]
fn properties_parses_every_fixture_to_the_compiled_table() {
    let lang = module("properties.mjs");
    for (name, source, want) in fixtures("properties", "properties") {
        let table = lang
            .parse("js-properties", &source)
            .unwrap_or_else(|e| panic!("{name}: {}", e.message));
        let got = fig::helper::table_to_value(&table);
        assert_eq!(
            canonical(&got),
            canonical(&want),
            "{name}: the module's table differs from the compiled one\n  got:  {}\n  want: {}",
            fig::helper::encode(&canonical(&got)),
            fig::helper::encode(&canonical(&want)),
        );
    }
}

#[test]
fn properties_registers_and_is_the_compiled_format_at_every_entry_point() {
    let mine_fmt = js_properties();
    assert!(matches!(mine_fmt, Format::Runtime(_)));
    assert_eq!(Format::by_name("js-properties"), Some(mine_fmt));

    for (name, source, _) in fixtures("properties", "properties") {
        let mine = Document::parse(&source, mine_fmt).unwrap_or_else(|e| panic!("{name}: {e}"));
        let theirs = Document::parse(&source, Format::Properties).unwrap();
        assert_eq!(
            mine.serialize(Format::Properties).unwrap(),
            theirs.serialize(Format::Properties).unwrap(),
            "{name}: trees differ"
        );
        assert_eq!(
            mine.serialize(mine_fmt).unwrap(),
            theirs.serialize(mine_fmt).unwrap(),
            "{name}: the module prints the two trees differently"
        );
        assert_eq!(
            mine.serialize(mine_fmt).unwrap(),
            theirs.serialize(Format::Properties).unwrap(),
            "{name}: the module's printer differs from the compiled one"
        );
        assert_eq!(mine.to_value().unwrap(), theirs.to_value().unwrap());
    }
}

#[test]
fn properties_refuses_what_the_compiled_format_refuses() {
    // The documents the compiled format refuses, refused here too. The
    // message and the offset each side gives are its own: the contract
    // is the format, not the compiled parser.
    let mine = js_properties();
    for bad in [
        &b"a=\\u00zz\n"[..],
        b"a=\\uD800\n",
        b"a=\\u00E\n",
        b"a\\u00zz=1\n",
        b"ok=1\nbad=\\uXYZW\nlater=2\n",
        b"a=b\\",
        b"a=b\rc\n",
    ] {
        assert!(
            Document::parse(bad, Format::Properties).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
        assert!(
            Document::parse(bad, mine).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
    }
}

#[test]
fn properties_edits_as_the_compiled_format_does() {
    // A flat format's editing surface: a value replaced, one that needs
    // escaping, a key inserted, a key deleted, a comment placed.
    let mine_fmt = js_properties();
    let src = b"# top\nroot = 1\nq: quoted value\nflag\nesc\\:k=v\\tx\n";
    let mut mine = Editor::open(src, mine_fmt).unwrap();
    let mut theirs = Editor::open(src, Format::Properties).unwrap();
    for ed in [&mut mine, &mut theirs] {
        ed.replace_value(&[Segment::Key("q")], "x y").unwrap();
        ed.set_value(&[Segment::Key("flag")], " lead\ttab").unwrap();
        ed.insert_value(&[], "new", "a:b=c").unwrap();
        ed.set_value(&[Segment::Key("root")], 2i64).unwrap();
        ed.add_leading_comment(&[Segment::Key("esc:k")], "the k")
            .unwrap();
        ed.delete(&[Segment::Key("q")]).unwrap();
    }
    assert_eq!(mine.source().unwrap(), theirs.source().unwrap());
    let out = mine.source().unwrap();
    assert!(!out.contains("quoted"), "{out}");
    assert!(out.contains("new=a:b=c"), "{out}");
    assert!(out.contains("# the k\nesc\\:k=v\\tx"), "{out}");
    assert!(out.contains("flag=\\ lead\\ttab"), "{out}");
}

/// One registration per process: a name can be registered once.
fn js_zon() -> Format {
    static FORMAT: OnceLock<Format> = OnceLock::new();
    *FORMAT.get_or_init(|| fig::language::register(module("zon.mjs")).expect("registers")[0])
}

/// A file beside the fixtures that is not itself a fixture: what the
/// compiled format made of one, recorded by the `fig` CLI.
fn zon_recorded(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/zon")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{} is missing", path.display()))
}

#[test]
fn zon_parses_every_fixture_to_the_compiled_table() {
    let lang = module("zon.mjs");
    for (name, source, want) in fixtures("zon", "zon") {
        let table = lang
            .parse("js-zon", &source)
            .unwrap_or_else(|e| panic!("{name}: {}", e.message));
        let got = fig::helper::table_to_value(&table);
        assert_eq!(
            canonical(&got),
            canonical(&want),
            "{name}: the module's table differs from the compiled one\n  got:  {}\n  want: {}",
            fig::helper::encode(&canonical(&got)),
            fig::helper::encode(&canonical(&want)),
        );
    }
}

#[test]
fn zon_registers_and_prints_every_fixture_as_the_compiled_printer_did() {
    // ZON is not in fig's default feature set, so the compiled sibling is
    // not here to compare against in-process; `fig lang check js-zon
    // --against zon` is that comparison. What the compiled printer made of
    // each fixture is recorded beside it (`fig fmt --dry-run -i zon`), and
    // the module's printer is held to those bytes.
    let mine_fmt = js_zon();
    assert!(matches!(mine_fmt, Format::Runtime(_)));
    assert_eq!(Format::by_name("js-zon"), Some(mine_fmt));
    for (name, source, _) in fixtures("zon", "zon") {
        let doc = Document::parse(&source, mine_fmt).unwrap_or_else(|e| panic!("{name}: {e}"));
        let want = zon_recorded(&name.replace(".zon", ".printed"));
        assert_eq!(doc.serialize(mine_fmt).unwrap(), want, "{name}");
    }
}

#[test]
fn zon_refuses_what_the_compiled_format_refuses() {
    // The documents the compiled format refuses, refused here too. The
    // message and the offset each side gives are its own: the contract
    // is the format, not the compiled parser.
    let mine = js_zon();
    for bad in [
        &b".{ .a = }"[..],
        b"",
        b"// only\n",
        b".{ .a = 1 .b = 2 }",
        b".{ .a = 1",
        b".{ 1, .a = 2 }",
        b".{ .a = 1 } .{}",
        b".{ .a = \"\\q\" }",
        b".{ .a = 'ab' }",
        b".{ .a = \"\\u{D800}\" }",
        b".{ .a = 1 +2 }",
        b"/// doc\n.{}",
        b".{ .a = /* c */ 1 }",
        b".{ .a = \"tab\there\" }",
        b".{ .a = foo }",
        b".{ .a = undefined }",
        b".{ .a = 1 + 2 }",
        b".{ .a = @import(\"x\") }",
        b".{ .a = --1 }",
        b".{ .a = -(1) }",
        b".{ 1, 2 }.len",
        b".{ .a = [_]u8{1} }",
        b".{ .a = if (x) 1 else 2 }",
        b".{ .a = foo, .b = \"\\q\" }",
        b".{ .a = \"\\q\", .b = foo }",
    ] {
        assert!(
            Document::parse(bad, Format::Zon).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
        assert!(
            Document::parse(bad, mine).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
    }
}

#[test]
fn zon_edits_as_the_compiled_format_did() {
    // A flow format's editing surface with a key sigil, against the bytes
    // the compiled editor produced for the same edits (`edited.expected`,
    // from the `fig` CLI): a value replaced, a key inserted — spelled
    // `.new` — one deleted from a one-line struct with its `.`, a list
    // item, a comment.
    let mine_fmt = js_zon();
    let src = b"// top\n.{\n    .root = 1, // t\n    .server = .{ // head\n        .host = \"h\",\n        .tags = .{ .a, .b },\n    },\n    .list = .{ 1, 2, 3 },\n    .flat = .{ .a = 1, .b = 2 },\n}\n";
    let mut ed = Editor::open(src, mine_fmt).unwrap();
    // Values, spelled by the module's printer: a string gets its quotes,
    // a key its `.` — the binding hands the editor the key's NAME.
    ed.replace_value(&[Segment::Key("server"), Segment::Key("host")], "h2")
        .unwrap();
    ed.insert_value(&[Segment::Key("server")], "new", true)
        .unwrap();
    ed.set_value(&[Segment::Key("root")], 2i64).unwrap();
    ed.replace_value(&[Segment::Key("list"), Segment::Index(1)], 9i64)
        .unwrap();
    ed.delete(&[Segment::Key("flat"), Segment::Key("a")])
        .unwrap();
    ed.add_leading_comment(&[Segment::Key("list")], "the list")
        .unwrap();
    ed.delete(&[Segment::Key("server"), Segment::Key("tags")])
        .unwrap();
    assert_eq!(ed.source().unwrap(), zon_recorded("edited.expected"));
}

/// One registration per process: a name can be registered once. The
/// language serves two dialects, `js-json5` first (its own name) and
/// `js-jsonc`; `register` answers one `Format` per dialect, in order.
fn js_json5_dialects() -> &'static [Format] {
    static FORMATS: OnceLock<Vec<Format>> = OnceLock::new();
    FORMATS.get_or_init(|| fig::language::register(module("json5.mjs")).expect("registers"))
}
fn js_json5() -> Format {
    js_json5_dialects()[0]
}
fn js_jsonc() -> Format {
    js_json5_dialects()[1]
}

#[test]
fn json5_and_jsonc_parse_every_fixture_to_the_compiled_table() {
    let lang = module("json5.mjs");
    for (dialect, dir) in [("js-json5", "json5"), ("js-jsonc", "jsonc")] {
        for (name, source, want) in fixtures(dir, dir) {
            let table = lang
                .parse(dialect, &source)
                .unwrap_or_else(|e| panic!("{name}: {}", e.message));
            let got = fig::helper::table_to_value(&table);
            assert_eq!(
                canonical(&got),
                canonical(&want),
                "{name}: the module's table differs from the compiled one\n  got:  {}\n  want: {}",
                fig::helper::encode(&canonical(&got)),
                fig::helper::encode(&canonical(&want)),
            );
        }
    }
}

#[test]
fn json5_and_jsonc_register_and_are_the_compiled_dialects_at_every_entry_point() {
    let (json5, jsonc) = (js_json5(), js_jsonc());
    assert_eq!(Format::by_name("js-json5"), Some(json5));
    assert_eq!(Format::by_name("js-jsonc"), Some(jsonc));
    for (mine_fmt, theirs_fmt, dir) in [
        (js_json5(), Format::Json5, "json5"),
        (js_jsonc(), Format::Jsonc, "jsonc"),
    ] {
        assert!(matches!(mine_fmt, Format::Runtime(_)));
        for (name, source, _) in fixtures(dir, dir) {
            let mine = Document::parse(&source, mine_fmt).unwrap_or_else(|e| panic!("{name}: {e}"));
            let theirs = Document::parse(&source, theirs_fmt).unwrap();
            assert_eq!(
                mine.serialize(theirs_fmt).unwrap(),
                theirs.serialize(theirs_fmt).unwrap(),
                "{name}: trees differ"
            );
            assert_eq!(
                mine.serialize(mine_fmt).unwrap(),
                theirs.serialize(mine_fmt).unwrap(),
                "{name}: the module prints the two trees differently"
            );
            assert_eq!(
                mine.serialize(mine_fmt).unwrap(),
                theirs.serialize(theirs_fmt).unwrap(),
                "{name}: the module's printer differs from the compiled one"
            );
            assert_eq!(mine.to_value().unwrap(), theirs.to_value().unwrap());
        }
    }
}

#[test]
fn json5_and_jsonc_refuses_what_the_compiled_format_refuses() {
    // The documents the compiled format refuses, refused here too. The
    // message and the offset each side gives are its own: the contract
    // is the format, not the compiled parser.
    for (mine, theirs, bad) in [
        (js_jsonc(), Format::Jsonc, &b"{\"a\": true, }"[..]),
        (js_jsonc(), Format::Jsonc, b"// c"),
        (js_jsonc(), Format::Jsonc, b"/* unclosed"),
        (js_jsonc(), Format::Jsonc, b"{\"a\": /x 1}"),
        (js_jsonc(), Format::Jsonc, b"{ a: 1 }"),
        (js_jsonc(), Format::Jsonc, b"[1, 2,]"),
        (js_jsonc(), Format::Jsonc, b"\"\\u12g4\""),
        (js_jsonc(), Format::Jsonc, b"{\"a\":1} x"),
        (js_jsonc(), Format::Jsonc, b""),
        (js_json5(), Format::Json5, b"{ a: 0x }"),
        (js_json5(), Format::Json5, b"{ a: 012 }"),
        (js_json5(), Format::Json5, b"{ a: . }"),
        (js_json5(), Format::Json5, b"{ a: 1e }"),
        (js_json5(), Format::Json5, b"{ a: '\\x4' }"),
        (js_json5(), Format::Json5, b"{ a: foo }"),
        (js_json5(), Format::Json5, b"[1,,]"),
    ] {
        assert!(
            Document::parse(bad, theirs).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
        assert!(
            Document::parse(bad, mine).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
    }
}

#[test]
fn json5_and_jsonc_edit_as_the_compiled_dialects_do() {
    // The editing surface of a flow format with comments: a value
    // replaced beside its trailing comment, a key inserted into a
    // multi-line object and a one-line one, an entry deleted with its
    // comment, a comment placed. JSON5's bare keys stay bare; a new key is
    // spelled quoted in both.
    for (mine_fmt, theirs_fmt) in [(js_json5(), Format::Json5), (js_jsonc(), Format::Jsonc)] {
        let src = b"// top\n{ // head\n  \"root\": 1, // t\n  \"server\": {\n    \"host\": \"h\",\n    \"tags\": [\"a\", \"b\"]\n  },\n  \"list\": [1, 2, 3],\n  /* lead */\n  \"flat\": {\"a\": 1, \"b\": 2}\n  // dangle\n}\n";
        let mut mine = Editor::open(src, mine_fmt).unwrap();
        let mut theirs = Editor::open(src, theirs_fmt).unwrap();
        for ed in [&mut mine, &mut theirs] {
            ed.replace_value(&[Segment::Key("server"), Segment::Key("host")], "h2")
                .unwrap();
            ed.insert_value(&[Segment::Key("server")], "new", true)
                .unwrap();
            ed.set_value(&[Segment::Key("root")], 2i64).unwrap();
            ed.replace_value(&[Segment::Key("list"), Segment::Index(1)], 9i64)
                .unwrap();
            ed.delete(&[Segment::Key("flat"), Segment::Key("a")])
                .unwrap();
            ed.add_leading_comment(&[Segment::Key("list")], "the list")
                .unwrap();
            ed.delete(&[Segment::Key("server"), Segment::Key("tags")])
                .unwrap();
        }
        assert_eq!(mine.source().unwrap(), theirs.source().unwrap());
        let out = mine.source().unwrap();
        assert!(out.contains("\"host\": \"h2\""), "{out}");
        assert!(out.contains("\"new\": true"), "{out}");
        assert!(out.contains("\"flat\": {\"b\": 2}"), "{out}");
        assert!(out.contains("// the list\n  \"list\": [1, 9, 3]"), "{out}");
        assert!(!out.contains("tags"), "{out}");
        assert!(out.contains("\"root\": 2, // t"), "{out}");
    }
}

/// One registration per process: a name can be registered once.
fn js_nestedtext() -> Format {
    static FORMAT: OnceLock<Format> = OnceLock::new();
    *FORMAT.get_or_init(|| fig::language::register(module("nestedtext.mjs")).expect("registers")[0])
}

#[test]
fn nestedtext_parses_every_fixture_to_the_compiled_table() {
    let lang = module("nestedtext.mjs");
    for (name, source, want) in fixtures("nestedtext", "nt") {
        let table = lang
            .parse("js-nestedtext", &source)
            .unwrap_or_else(|e| panic!("{name}: {}", e.message));
        let got = fig::helper::table_to_value(&table);
        assert_eq!(
            canonical(&got),
            canonical(&want),
            "{name}: the module's table differs from the compiled one\n  got:  {}\n  want: {}",
            fig::helper::encode(&canonical(&got)),
            fig::helper::encode(&canonical(&want)),
        );
    }
}

#[test]
fn nestedtext_registers_and_is_the_compiled_format_at_every_entry_point() {
    let mine_fmt = js_nestedtext();
    assert!(matches!(mine_fmt, Format::Runtime(_)));
    assert_eq!(Format::by_name("js-nestedtext"), Some(mine_fmt));

    for (name, source, _) in fixtures("nestedtext", "nt") {
        let mine = Document::parse(&source, mine_fmt).unwrap_or_else(|e| panic!("{name}: {e}"));
        let theirs = Document::parse(&source, Format::Nestedtext).unwrap();
        assert_eq!(
            mine.serialize(Format::Nestedtext).unwrap(),
            theirs.serialize(Format::Nestedtext).unwrap(),
            "{name}: trees differ"
        );
        assert_eq!(
            mine.serialize(mine_fmt).unwrap(),
            theirs.serialize(mine_fmt).unwrap(),
            "{name}: the module prints the two trees differently"
        );
        assert_eq!(
            mine.serialize(mine_fmt).unwrap(),
            theirs.serialize(Format::Nestedtext).unwrap(),
            "{name}: the module's printer differs from the compiled one"
        );
        assert_eq!(mine.to_value().unwrap(), theirs.to_value().unwrap());
    }
}

#[test]
fn nestedtext_refuses_what_the_compiled_format_refuses() {
    // The documents the compiled format refuses, refused here too. The
    // message and the offset each side gives are its own: the contract
    // is the format, not the compiled parser.
    let mine = js_nestedtext();
    for bad in [
        &b"k:v"[..],
        b"  a: 1",
        b"a: 1\n  b: 2",
        b"- a\nb: 1",
        b"a: 1\na: 2",
        b"{a:0,}",
        b"[a",
        b"{a}",
        b"{a: b} x",
        b"[a, b]\nc: 1",
        b"a:\n  \xc2\xa0b: 1",
        b": k\n",
        b": k\nv: 1\n",
        b"a:\n    b: 1\n    - y\n",
        b"a:\n    > x\n    - y\n",
        b"[a, {b}]",
        b"{a: b]",
    ] {
        assert!(
            Document::parse(bad, Format::Nestedtext).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
        assert!(
            Document::parse(bad, mine).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
    }
}

#[test]
fn nestedtext_renders_as_the_compiled_editor_helper_does() {
    // The four renderers, by the rules `editor_helper.zig` follows. The
    // Rust editor is not driven here: it spells a scalar through the
    // printer, which for NestedText is a `>` block that the tail renderer
    // then blocks again (fig's `docs/tasks/rust-editor-spells-a-nestedtext-value-through-the-printer.md`);
    // the twin's edits are held to the compiled format's bytes through the
    // `fig` CLI instead, which hands the editor plain text.
    let lang = module("nestedtext.mjs");
    let render = |which: Renderer,
                  indent: &str,
                  key: &str,
                  value: &str,
                  old_key: &str|
     -> Result<String, String> {
        let args = RenderArgs {
            dialect: "js-nestedtext",
            indent: indent.as_bytes(),
            key: key.as_bytes(),
            value: value.as_bytes(),
            literal: Literal::String,
            old_key: old_key.as_bytes(),
        };
        lang.render(which, args)
            .map(|b| String::from_utf8(b).unwrap())
            .map_err(|e| e.message)
    };
    assert_eq!(render(Renderer::Entry, "", "b", "2", "").unwrap(), "b: 2");
    assert_eq!(
        render(Renderer::Entry, "    ", "b", "", "").unwrap(),
        "b:\n        >"
    );
    assert_eq!(
        render(Renderer::Entry, "", "b", "line1\nline2", "").unwrap(),
        "b:\n    > line1\n    > line2"
    );
    assert_eq!(
        render(Renderer::Entry, "", "- looks like a list tag", "v", "").unwrap(),
        ": - looks like a list tag\n    > v"
    );
    assert_eq!(render(Renderer::Item, "", "", "x", "").unwrap(), "- x");
    assert_eq!(
        render(Renderer::Item, "  ", "", "a\nb", "").unwrap(),
        "-\n      > a\n      > b"
    );
    assert_eq!(
        render(Renderer::Tail, "", "name", "fig", "").unwrap(),
        ": fig"
    );
    assert_eq!(
        render(Renderer::Tail, "", "name", "l1\nl2", "").unwrap(),
        ":\n    > l1\n    > l2"
    );
    assert_eq!(
        render(Renderer::Tail, "", ": key 1\n: spread", "v", "").unwrap(),
        "\n    > v"
    );
    assert_eq!(
        render(Renderer::Tail, "", "", "hi\n\nthere", "").unwrap(),
        "> hi\n>\n> there"
    );
    assert_eq!(
        render(Renderer::Key, "", "lang", "", "name").unwrap(),
        "lang"
    );
    assert_eq!(
        render(Renderer::Key, "", "plain", "", ": multi\n: line").unwrap(),
        "plain:"
    );
    assert_eq!(
        render(Renderer::Key, "  ", "a\nb", "", ": was").unwrap(),
        "  : a\n  : b"
    );
    assert!(render(Renderer::Key, "", "- tag", "", "plain").is_err());
}

// ── yaml ───────────────────────────────────────────────────────────────────

/// One registration per process: a name can be registered once. The
/// language serves two dialects, `js-yaml` first (its own name) and
/// `js-yaml-1.1`, whose plain scalars resolve by the 1.1 tag repository;
/// `register` answers one `Format` per dialect, in order.
fn js_yaml_dialects() -> &'static [Format] {
    static FORMATS: OnceLock<Vec<Format>> = OnceLock::new();
    FORMATS.get_or_init(|| fig::language::register(module("yaml.mjs")).expect("registers"))
}

#[test]
fn yaml_parses_every_fixture_to_the_compiled_table() {
    let lang = module("yaml.mjs");
    for (dir, dialect) in [("yaml", "js-yaml"), ("yaml-1.1", "js-yaml-1.1")] {
        for (name, source, want) in fixtures(dir, "yaml") {
            let table = lang
                .parse(dialect, &source)
                .unwrap_or_else(|e| panic!("{name}: {}", e.message));
            let got = fig::helper::table_to_value(&table);
            assert_eq!(
                canonical(&got),
                canonical(&want),
                "{name}: the module's table differs from the compiled one\n  got:  {}\n  want: {}",
                fig::helper::encode(&canonical(&got)),
                fig::helper::encode(&canonical(&want)),
            );
        }
    }
}

#[test]
fn yaml_registers_and_is_the_compiled_format_at_every_entry_point() {
    let dialects = js_yaml_dialects();
    let mine_fmt = dialects[0];
    assert!(matches!(mine_fmt, Format::Runtime(_)));
    assert_eq!(Format::by_name("js-yaml"), Some(mine_fmt));
    assert_eq!(Format::by_name("js-yaml-1.1"), Some(dialects[1]));
    // A reference layer is declared, as the compiled YAML's is.
    assert!(fig::capabilities(mine_fmt).references);
    assert!(fig::capabilities(Format::Yaml).references);

    for (name, source, _) in fixtures("yaml", "yaml") {
        let mine = Document::parse(&source, mine_fmt).unwrap_or_else(|e| panic!("{name}: {e}"));
        let theirs = Document::parse(&source, Format::Yaml).unwrap();
        assert_eq!(
            mine.serialize(Format::Yaml).unwrap(),
            theirs.serialize(Format::Yaml).unwrap(),
            "{name}: trees differ"
        );
        assert_eq!(
            mine.serialize(mine_fmt).unwrap(),
            theirs.serialize(mine_fmt).unwrap(),
            "{name}: the module prints the two trees differently"
        );
        assert_eq!(
            mine.serialize(mine_fmt).unwrap(),
            theirs.serialize(Format::Yaml).unwrap(),
            "{name}: the module's printer differs from the compiled one"
        );
        // Leaving for a format without the layer collapses it — aliases
        // to copies, merges flattened, tags applied — for the twin as for
        // the compiled format, because both declare it.
        assert_eq!(
            mine.serialize(Format::Json).map_err(|e| e.to_string()),
            theirs.serialize(Format::Json).map_err(|e| e.to_string()),
            "{name}: materialized differently"
        );
        // `to_value` walks the reference layer as the compiled document's
        // is walked: an alias or a tagged node has no value, which is the
        // same refusal from both.
        // (Compared as text: a `.nan` is a NaN, which is never equal to
        // itself.)
        assert_eq!(
            format!("{:?}", mine.to_value()),
            format!("{:?}", theirs.to_value()),
            "{name}: values differ"
        );
    }

    // The 1.1 dialect resolves as the compiled `--spec 1.1` does (its
    // fixtures' tables were recorded with it); the binding selects no
    // version, so here it is the resolution that shows: `yes` a bool,
    // `0777` an int, `1e3` a string.
    let one_one = Document::parse(b"a: yes\nb: 0777\nc: 1e3\n", dialects[1]).unwrap();
    assert_eq!(
        one_one.serialize(Format::Json).unwrap(),
        "{\n  \"a\": true,\n  \"b\": 777,\n  \"c\": \"1e3\"\n}\n"
    );
}

#[test]
fn yaml_refuses_what_the_compiled_format_refuses() {
    // The documents the compiled format refuses, refused here too. The
    // message and the offset each side gives are its own: the contract
    // is the format, not the compiled parser.
    let mine = js_yaml_dialects()[0];
    for bad in [
        &b"a: b: c"[..],
        b"a:\n\t- b\n",
        b"a:\n  b: 1\n c: 2\n",
        b"&a &b x\n",
        b"x: *nope\n",
        b"\"abc\n",
        b"!e!x a\n",
        b"a: \"\\q\"\n",
        b"a: \"\\uD800\"\n",
        b"a: \"\\u12\"\n",
        b"a: 1\n---\nb: 2\n",
        b"%YAML 1.2\n",
        b"%YAML 1.2\n%YAML 1.2\n---\n",
        b"a: |0\n  x\n",
        b"a: !<>\n",
        b"a: !!str,x\n",
        b"a: & x\n",
        b"a: *\n",
        b"- a\n- b\nk: v\n",
        b"--- a: b\n",
        b"{a: b}x\n",
        b"[a, b\n",
        b"a: [b, - c]\n",
        b"key: - one\n",
        b"a: 'x\n",
        b"a: |\n\tx\n",
        b"k:\n  v\n  more: x\n",
        b"&b *a\n",
    ] {
        assert!(
            Document::parse(bad, Format::Yaml).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
        assert!(
            Document::parse(bad, mine).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
    }
}

#[test]
fn yaml_edits_as_the_compiled_format_does() {
    // The engine YAML was written against, through the twin's table: the
    // cases of fig's `editor_helper.zig` — an edit through an alias that
    // severs only that alias, a merge-only key materialized locally and
    // refused for deletion, keys inserted block and flow, deletions that
    // carry comments, sequence appends in every style, block-over-inline
    // reframes, keys and items moved and reordered, a sequence set — each
    // through the module and through the compiled format, to the same
    // bytes or the same refusal.
    let mine_fmt = js_yaml_dialects()[0];
    let k = Segment::Key;
    let i = Segment::Index;
    type Edit = Box<dyn Fn(&mut Editor) -> Result<(), String>>;
    let cases: Vec<(&[u8], Edit)> = vec![
        (
            b"a: &x 1\nb: *x\n",
            Box::new(move |ed| ed.replace_value(&[k("b")], 5i64).map_err(|e| e.to_string())),
        ),
        (
            b"base: &b\n  x: 1\nd:\n  <<: *b\n  y: 2\n",
            Box::new(move |ed| {
                ed.replace_value(&[k("d"), k("x")], 5i64)
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"base: &b\n  x: 1\nd:\n  <<: *b\n  y: 2\n",
            Box::new(move |ed| ed.delete(&[k("d"), k("x")]).map_err(|e| e.to_string())),
        ),
        (
            b"a: 1\nb: 2\n",
            Box::new(move |ed| ed.insert_value(&[], "c", 3i64).map_err(|e| e.to_string())),
        ),
        (
            b"a: 1\nb: 2",
            Box::new(move |ed| ed.insert_value(&[], "c", 3i64).map_err(|e| e.to_string())),
        ),
        (
            b"a:\n  b: 1\n",
            Box::new(move |ed| {
                ed.insert_value(&[k("a")], "c", 3i64)
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"a: {}\n",
            Box::new(move |ed| {
                ed.insert_value(&[k("a")], "c", 3i64)
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"a: {b: 1}\n",
            Box::new(move |ed| {
                ed.insert_value(&[k("a")], "c", "x")
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"a:\n",
            Box::new(move |ed| {
                ed.insert_value(&[k("a")], "c", 3i64)
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"a: 1\n",
            Box::new(move |ed| {
                ed.insert_value(&[], "m", Value::Map(vec![("x".into(), 1i64.into())]))
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"a: 1\n",
            Box::new(move |ed| {
                ed.insert_value(&[], "s", Value::Seq(vec![1i64.into(), 2i64.into()]))
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"a: {b: 1}\n",
            Box::new(move |ed| {
                ed.insert_value(&[k("a")], "s", Value::Seq(vec![1i64.into()]))
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"a: [1]\n",
            Box::new(move |ed| {
                ed.append_value(&[k("a")], Value::Map(vec![("x".into(), 1i64.into())]))
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"a: 1\nb: 2\nc: 3\n",
            Box::new(move |ed| ed.delete(&[k("b")]).map_err(|e| e.to_string())),
        ),
        (
            b"a: 1\n# owned\nb: 2\nc: 3\n",
            Box::new(move |ed| ed.delete(&[k("b")]).map_err(|e| e.to_string())),
        ),
        (
            b"a: 1\n\n# kept\nb: 2\n",
            Box::new(move |ed| ed.delete(&[k("b")]).map_err(|e| e.to_string())),
        ),
        (
            b"a: 1\nb: 2 # trail\n",
            Box::new(move |ed| ed.delete(&[k("b")]).map_err(|e| e.to_string())),
        ),
        (
            b"a: 1\n",
            Box::new(move |ed| ed.delete(&[k("a")]).map_err(|e| e.to_string())),
        ),
        (
            b"{a: 1, b: 2, c: 3}\n",
            Box::new(move |ed| ed.delete(&[k("b")]).map_err(|e| e.to_string())),
        ),
        (
            b"{a: 1, b: 2}\n",
            Box::new(move |ed| ed.delete(&[k("a")]).map_err(|e| e.to_string())),
        ),
        (
            b"{a: 1}\n",
            Box::new(move |ed| ed.delete(&[k("a")]).map_err(|e| e.to_string())),
        ),
        (
            b"m: {\n  a: 1,\n  b: 2,\n}\n",
            Box::new(move |ed| ed.delete(&[k("m"), k("b")]).map_err(|e| e.to_string())),
        ),
        (
            b"a: |\n  x\n  y\nb: 1\n",
            Box::new(move |ed| ed.delete(&[k("a")]).map_err(|e| e.to_string())),
        ),
        (
            b"s:\n  - a\n  - b\n",
            Box::new(move |ed| ed.append_value(&[k("s")], "c").map_err(|e| e.to_string())),
        ),
        (
            b"s:\n- a\n- b\n",
            Box::new(move |ed| ed.append_value(&[k("s")], "c").map_err(|e| e.to_string())),
        ),
        (
            b"s:\n  - a\n",
            Box::new(move |ed| ed.prepend_value(&[k("s")], "z").map_err(|e| e.to_string())),
        ),
        (
            b"s: [a, b]\n",
            Box::new(move |ed| ed.append_value(&[k("s")], "c").map_err(|e| e.to_string())),
        ),
        (
            b"s: []\n",
            Box::new(move |ed| ed.append_value(&[k("s")], "c").map_err(|e| e.to_string())),
        ),
        (
            b"s: [a, b,]\n",
            Box::new(move |ed| ed.append_value(&[k("s")], "c").map_err(|e| e.to_string())),
        ),
        (
            b"s: [\n  a,\n  b,\n]\n",
            Box::new(move |ed| ed.append_value(&[k("s")], "c").map_err(|e| e.to_string())),
        ),
        (
            b"s:\n  - a\n  - b\n  - c\n",
            Box::new(move |ed| ed.remove_item(&[k("s")], 1).map_err(|e| e.to_string())),
        ),
        (
            b"s: [a, b, c]\n",
            Box::new(move |ed| ed.remove_item(&[k("s")], 1).map_err(|e| e.to_string())),
        ),
        (
            b"s: [a, b, c]\n",
            Box::new(move |ed| ed.remove_item(&[k("s")], 0).map_err(|e| e.to_string())),
        ),
        (
            b"s: [\n  a,\n  b,\n]\n",
            Box::new(move |ed| ed.remove_item(&[k("s")], 1).map_err(|e| e.to_string())),
        ),
        (
            b"s: []\n",
            Box::new(move |ed| {
                ed.replace_value(&[k("s")], Value::Seq(vec![1i64.into(), 2i64.into()]))
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"s:\n  - 1\n  - 2\n",
            Box::new(move |ed| {
                ed.replace_value(&[k("s")], Value::Seq(vec![]))
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"s: x\n",
            Box::new(move |ed| {
                ed.replace_value(&[k("s")], Value::Seq(vec![1i64.into()]))
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"s:\n",
            Box::new(move |ed| {
                ed.replace_value(&[k("s")], Value::Seq(vec![1i64.into()]))
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"s: x\n",
            Box::new(move |ed| {
                ed.replace_value(&[k("s")], Value::Map(vec![("a".into(), 1i64.into())]))
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"s: x # c\n",
            Box::new(move |ed| ed.replace_value(&[k("s")], "y").map_err(|e| e.to_string())),
        ),
        (
            b"s: {a: 1}\n",
            Box::new(move |ed| {
                ed.replace_value(
                    &[k("s")],
                    Value::Map(vec![("a".into(), 1i64.into()), ("b".into(), 2i64.into())]),
                )
                .map_err(|e| e.to_string())
            }),
        ),
        (
            b"a: 1\nb: 2\nc: 3\n",
            Box::new(move |ed| ed.move_key(&[k("a")], &[k("c")]).map_err(|e| e.to_string())),
        ),
        (
            b"a: 1\nb: 2\nc: 3\n",
            Box::new(move |ed| ed.move_key(&[k("c")], &[k("a")]).map_err(|e| e.to_string())),
        ),
        (
            b"# c\na: 1\nb: 2\n",
            Box::new(move |ed| ed.move_key(&[k("a")], &[k("b")]).map_err(|e| e.to_string())),
        ),
        (
            b"a: 1 # t\nb: 2\n",
            Box::new(move |ed| ed.move_key(&[k("a")], &[k("b")]).map_err(|e| e.to_string())),
        ),
        (
            b"a: |\n  x\nb: 2\n",
            Box::new(move |ed| ed.move_key(&[k("a")], &[k("b")]).map_err(|e| e.to_string())),
        ),
        (
            b"a: 1\nb: 2\nc: 3\n",
            Box::new(move |ed| {
                ed.reorder_keys(&[], &["c", "a", "b"])
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"a: 1\nb: 2\nc: 3\n",
            Box::new(move |ed| ed.reorder_keys(&[], &["c"]).map_err(|e| e.to_string())),
        ),
        (
            b"# a\na: 1\n\nb: 2\nc: 3\n",
            Box::new(move |ed| ed.reorder_keys(&[], &["b", "a"]).map_err(|e| e.to_string())),
        ),
        (
            b"m:\n  a: 1\n  b: 2\n",
            Box::new(move |ed| {
                ed.reorder_keys(&[k("m")], &["b", "a"])
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"s:\n  - a\n  - b\n  - c\n",
            Box::new(move |ed| ed.move_item(&[k("s")], 0, 2).map_err(|e| e.to_string())),
        ),
        (
            b"s:\n  - a\n  - b\n  - c\n",
            Box::new(move |ed| ed.move_item(&[k("s")], 2, 0).map_err(|e| e.to_string())),
        ),
        (
            b"s:\n  # a\n  - a\n  - b\n",
            Box::new(move |ed| ed.move_item(&[k("s")], 0, 1).map_err(|e| e.to_string())),
        ),
        (
            b"s: [a, b, c]\n",
            Box::new(move |ed| ed.move_item(&[k("s")], 0, 2).map_err(|e| e.to_string())),
        ),
        (
            b"s:\n  - a\n  - b\n  - c\n",
            Box::new(move |ed| {
                ed.reorder_items(&[k("s")], &[2, 0])
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"s: [a, b, c]\n",
            Box::new(move |ed| {
                ed.reorder_items(&[k("s")], &[2, 1, 0])
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"s: [a,b,c]\n",
            Box::new(move |ed| {
                ed.reorder_items(&[k("s")], &[1, 0])
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"s:\n  # x\n  - x\n  - y\n  - z\n",
            Box::new(move |ed| {
                ed.set_sequence(&[k("s")], &["z".into(), "x".into(), "w".into()])
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"s:\n  - x\n  - y\n",
            Box::new(move |ed| ed.set_sequence(&[k("s")], &[]).map_err(|e| e.to_string())),
        ),
        (
            b"a: 1\n",
            Box::new(move |ed| {
                ed.add_leading_comment(&[k("a")], "note")
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"a: 1\n",
            Box::new(move |ed| {
                ed.set_trailing_comment(&[k("a")], "note")
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"a:\n  - x\n",
            Box::new(move |ed| {
                ed.add_leading_comment(&[k("a"), i(0)], "item")
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"a: 1\n",
            Box::new(move |ed| {
                ed.add_dangling_comment(&[], "end")
                    .map_err(|e| e.to_string())
            }),
        ),
        (
            b"a: 1\nb: 2\n",
            Box::new(move |ed| ed.comment_out(&[k("a")]).map_err(|e| e.to_string())),
        ),
        (
            b"a: 1\nb: 2\n",
            Box::new(move |ed| ed.replace_key(&[k("a")], "z").map_err(|e| e.to_string())),
        ),
    ];
    for (n, (src, edit)) in cases.iter().enumerate() {
        let mut mine = Editor::open(src, mine_fmt).unwrap();
        let mut theirs = Editor::open(src, Format::Yaml).unwrap();
        let a = edit(&mut mine);
        let b = edit(&mut theirs);
        assert_eq!(
            a,
            b,
            "case {n} ({}): outcomes differ",
            String::from_utf8_lossy(src)
        );
        assert_eq!(
            mine.source().unwrap(),
            theirs.source().unwrap(),
            "case {n} ({}): sources differ",
            String::from_utf8_lossy(src)
        );
    }
}
