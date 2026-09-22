//! The modules in `languages/` that are not twins: formats fig does not
//! compile in, each written to its own specification and held to what it
//! recorded of itself.
//!
//! **Table for table.** `tests/fixtures/<name>/*.<ext>` are documents;
//! beside each, `*.table.json` is the node table the module gave for it
//! when it was reviewed, printed by `fig lang table -i js-<name>`, and
//! `*.printed` what its printer made of it. A change to either is a
//! change to the format's contract, and shows up here as a diff to read.
//!
//! **Through fig.** Each module is registered in-process, its print is
//! parsed again and must carry the same values, the documents it refuses
//! are refused, and the edits its header says the generic editor makes
//! come out as the bytes they should — and the ones it says are not made
//! are refused, not misplaced.

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
/// two JSON spellings of one table compare equal whichever side wrote
/// them, and a printer that orders entries its own way still carries the
/// same tree.
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
        Value::Uint(n) => match i64::try_from(*n) {
            Ok(i) => Value::Int(i),
            Err(_) => Value::Uint(*n),
        },
        other => other.clone(),
    }
}

/// Every fixture under `tests/fixtures/<dir>` that is a document: its
/// name, its bytes, its recorded table and its recorded print.
fn fixtures(dir: &str) -> Vec<(String, Vec<u8>, Value, String)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(dir);
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&root).expect("fixture directory") {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if name.ends_with(".table.json") || name.ends_with(".printed") {
            continue;
        }
        let source = std::fs::read(&path).unwrap();
        let stem = path.with_extension("");
        let table_json = std::fs::read(stem.with_extension("table.json"))
            .unwrap_or_else(|_| panic!("{} has no table beside it", path.display()));
        let table = Document::parse(&table_json, Format::Json)
            .expect("the table is JSON")
            .to_value()
            .unwrap();
        let printed = std::fs::read_to_string(stem.with_extension("printed"))
            .unwrap_or_else(|_| panic!("{} has no print beside it", path.display()));
        out.push((name, source, table, printed));
    }
    assert!(!out.is_empty(), "no fixtures under {}", root.display());
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn assert_tables(dir: &str, file: &str, dialect: &str) {
    let lang = module(file);
    for (name, source, want, _) in fixtures(dir) {
        let table = lang
            .parse(dialect, &source)
            .unwrap_or_else(|e| panic!("{name}: {}", e.message));
        let got = fig::helper::table_to_value(&table);
        assert_eq!(
            canonical(&got),
            canonical(&want),
            "{name}: the module's table differs from the recorded one\n  got:  {}\n  want: {}",
            fig::helper::encode(&canonical(&got)),
            fig::helper::encode(&canonical(&want)),
        );
    }
}

fn assert_prints(dir: &str, format: Format, name_of: &str) {
    assert!(matches!(format, Format::Runtime(_)));
    assert_eq!(Format::by_name(name_of), Some(format));
    for (name, source, _, printed) in fixtures(dir) {
        let doc = Document::parse(&source, format).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(
            doc.serialize(format).unwrap(),
            printed,
            "{name}: the print differs from the recorded one"
        );
        let again = Document::parse(printed.as_bytes(), format)
            .unwrap_or_else(|e| panic!("{name}: the print does not read back: {e}"));
        assert_eq!(
            canonical(&again.to_value().unwrap()),
            canonical(&doc.to_value().unwrap()),
            "{name}: the print reads back as a different tree"
        );
    }
}

fn assert_refuses(format: Format, docs: &[&[u8]]) {
    for bad in docs {
        assert!(
            Document::parse(bad, format).is_err(),
            "accepted: {}",
            String::from_utf8_lossy(bad)
        );
    }
}

fn key(k: &str) -> Segment<'_> {
    Segment::Key(k)
}

// ── git config ────────────────────────────────────────────────────────────

fn js_gitconfig() -> Format {
    static FORMAT: OnceLock<Format> = OnceLock::new();
    *FORMAT.get_or_init(|| fig::language::register(module("gitconfig.mjs")).expect("registers")[0])
}

#[test]
fn gitconfig_parses_every_fixture_to_its_recorded_table() {
    assert_tables("gitconfig", "gitconfig.mjs", "js-gitconfig");
}

#[test]
fn gitconfig_prints_as_recorded_and_reads_back() {
    assert_prints("gitconfig", js_gitconfig(), "js-gitconfig");
}

#[test]
fn gitconfig_refuses_what_git_refuses() {
    assert_refuses(
        js_gitconfig(),
        &[
            b"name = value\n",          // a variable before any section
            b"[core\n",                 // an unclosed header
            b"[]\n",                    // no name
            b"[a b]\n",                 // a subsection without quotes
            b"[a \"b]\n",               // an unclosed subsection
            b"[core]\n\t1abc = 1\n",    // a name starting with a digit
            b"[core]\n\ta = \"open\n",  // an unclosed quote
            b"[core]\n\ta = \\q\n",     // an escape git does not know
            b"[core]\n\ta = 1\n\t[x\n", // stray text
            b"[a]\r\tb = 1\n",          // a bare CR
        ],
    );
}

#[test]
fn gitconfig_edits_a_value_a_variable_and_a_comment_and_refuses_a_section() {
    let src = b"[core]\n\tbare = false\n\tautocrlf\n[remote \"origin\"]\n\turl = a\n";
    let mut ed = Editor::open(src, js_gitconfig()).unwrap();
    ed.replace_value(&[key("core"), key("bare")], "true")
        .unwrap();
    // A bare variable takes its `= value` after its name.
    ed.replace_value(&[key("core"), key("autocrlf")], "input")
        .unwrap();
    ed.insert_value(&[key("remote"), key("origin")], "fetch", "+refs/*:refs/*")
        .unwrap();
    ed.add_leading_comment(&[key("core"), key("bare")], "not bare")
        .unwrap();
    assert_eq!(
        ed.source().unwrap(),
        "[core]\n\t# not bare\n\tbare = true\n\tautocrlf = input\n[remote \"origin\"]\n\turl = a\n\tfetch = +refs/*:refs/*\n"
    );
    ed.delete(&[key("core"), key("autocrlf")]).unwrap();
    assert!(!ed.source().unwrap().contains("autocrlf"));
    // A section is not a value to replace, nor a line to delete; the
    // container op is.
    assert!(ed.replace_value(&[key("core")], "x").is_err());
    assert!(ed.delete(&[key("remote")]).is_err());
    ed.delete_container(&[key("remote"), key("origin")])
        .unwrap();
    assert!(
        !ed.source().unwrap().contains("origin"),
        "{}",
        ed.source().unwrap()
    );
    // No section to land in: nothing is vivified.
    assert!(ed.set_value(&[key("pull"), key("rebase")], "true").is_err());
}

// ── ssh_config ────────────────────────────────────────────────────────────

fn js_sshconfig() -> Format {
    static FORMAT: OnceLock<Format> = OnceLock::new();
    *FORMAT.get_or_init(|| fig::language::register(module("sshconfig.mjs")).expect("registers")[0])
}

#[test]
fn sshconfig_parses_every_fixture_to_its_recorded_table() {
    assert_tables("sshconfig", "sshconfig.mjs", "js-sshconfig");
}

#[test]
fn sshconfig_prints_as_recorded_and_reads_back() {
    assert_prints("sshconfig", js_sshconfig(), "js-sshconfig");
}

#[test]
fn sshconfig_refuses_what_openssh_refuses() {
    assert_refuses(
        js_sshconfig(),
        &[
            b"Host\n",                 // a block with no pattern
            b"=1\n",                   // no keyword
            b"Host \"open\n",          // an unclosed quote
            b"Host\"x\"\n",            // nothing between keyword and arguments
            b"Host a\r  HostName b\n", // a bare CR
        ],
    );
}

#[test]
fn sshconfig_edits_a_keyword_in_a_block_and_refuses_a_block() {
    let src = b"AddKeysToAgent yes\n\nHost github\n    HostName github.com\n    User git\n";
    let mut ed = Editor::open(src, js_sshconfig()).unwrap();
    ed.replace_value(&[key("Host"), key("github"), key("User")], "me")
        .unwrap();
    ed.insert_value(&[key("Host"), key("github")], "Port", "2222")
        .unwrap();
    ed.insert_value(&[], "Compression", "yes").unwrap();
    assert_eq!(
        ed.source().unwrap(),
        "AddKeysToAgent yes\nCompression yes\n\nHost github\n    HostName github.com\n    User me\n    Port 2222\n"
    );
    ed.delete(&[key("Host"), key("github"), key("HostName")])
        .unwrap();
    assert!(!ed.source().unwrap().contains("HostName"));
    assert!(
        ed.replace_value(&[key("Host"), key("github")], "x")
            .is_err()
    );
    assert!(ed.delete(&[key("Host")]).is_err());
    assert!(
        ed.set_value(&[key("Host"), key("other"), key("User")], "x")
            .is_err()
    );
    // A new block is the container op, spelled by the header syntax.
    ed.insert_container(&[key("Host"), key("other")], "    User x\n")
        .unwrap();
    assert!(
        ed.source().unwrap().ends_with("\nHost other\n    User x\n"),
        "{}",
        ed.source().unwrap()
    );
}

// ── OpenStep property lists ───────────────────────────────────────────────

fn js_openstep() -> Format {
    static FORMAT: OnceLock<Format> = OnceLock::new();
    *FORMAT.get_or_init(|| fig::language::register(module("openstep.mjs")).expect("registers")[0])
}

#[test]
fn openstep_parses_every_fixture_to_its_recorded_table() {
    assert_tables("openstep", "openstep.mjs", "js-openstep");
}

#[test]
fn openstep_prints_as_recorded_and_reads_back() {
    assert_prints("openstep", js_openstep(), "js-openstep");
}

#[test]
fn openstep_reads_data_as_the_xml_twin_carries_it() {
    let doc = Document::parse(b"{ d = <4869 21>; }\n", js_openstep()).unwrap();
    assert!(
        matches!(doc.to_value().unwrap().get("d"), Some(Value::Extended { text, .. }) if text == "SGkh")
    );
    assert_eq!(
        doc.serialize(js_openstep()).unwrap(),
        "{\n\td = <486921>;\n}\n"
    );
}

#[test]
fn openstep_refuses_what_plutil_refuses() {
    assert_refuses(
        js_openstep(),
        &[
            b"{ a = 1 }\n",           // no `;`
            b"{ a = 1;\n",            // unclosed dictionary
            b"( a b )\n",             // no `,`
            b"( a,\n",                // unclosed array
            b"{ a = \"open; }\n",     // unclosed string
            b"{ a = \"\\q\"; }\n",    // an escape it does not know
            b"{ a = <0f0>; }\n",      // half a byte
            b"{ a = <0g>; }\n",       // not hex
            b"{ a = 1; } trailing\n", // more than one value
            b"/* open\n{ }\n",        // unclosed comment
            b"{ = 1; }\n",            // no key
        ],
    );
}

#[test]
fn openstep_edits_entries_and_items() {
    let src = b"// !$*UTF8*$!\n{\n\tobjects = {\n\t\tA1 /* Foo.swift */ = {isa = PBXBuildFile; fileRef = B2 /* Foo.swift */; };\n\t\tC3 = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\tA1 /* Foo.swift */,\n\t\t\t);\n\t\t};\n\t};\n\tempty = {\n\t};\n}\n";
    let mut ed = Editor::open(src, js_openstep()).unwrap();
    ed.replace_value(&[key("objects"), key("A1"), key("fileRef")], "B3")
        .unwrap();
    ed.insert_value(&[key("objects"), key("C3")], "name", "Sources Dir")
        .unwrap();
    ed.append_value(&[key("objects"), key("C3"), key("children")], "D4")
        .unwrap();
    ed.set_value(&[key("objects"), key("C3"), key("path"), key("x")], "y")
        .unwrap();
    let out = ed.source().unwrap();
    assert!(out.contains("fileRef = B3 /* Foo.swift */;"), "{out}");
    assert!(out.contains("\t\t\tname = \"Sources Dir\";\n"), "{out}");
    assert!(
        out.contains("\t\t\t\tA1 /* Foo.swift */,\n\t\t\t\tD4,\n\t\t\t);"),
        "{out}"
    );
    assert!(out.contains("path = {\n"), "{out}");
    assert!(out.contains("x = y;"), "{out}");
    // An empty dictionary after its key on one line expands under that
    // line's indent.
    ed.set_value(&[key("empty2")], Value::Map(vec![])).unwrap();
    ed.set_value(&[key("empty2"), key("k")], "v").unwrap();
    assert!(
        ed.source()
            .unwrap()
            .contains("\tempty2 = {\n\t\tk = v;\n\t};\n"),
        "{}",
        ed.source().unwrap()
    );
    ed.delete(&[key("objects"), key("A1")]).unwrap();
    assert!(!ed.source().unwrap().contains("PBXBuildFile"));
}

#[test]
#[ignore = "fig 0304c11 refuses an entry into a closed-container format's mapping whose span ends no later than its last entry's line, and a braceless `.strings` root runs to the end of input, which is that line: every `.strings` file whose last entry is on its last line is refused ContainerClosesOnItsLine"]
fn openstep_strings_takes_an_entry_and_keeps_its_braceless_shape() {
    // A `.strings` file keeps its braceless shape.
    let strings = b"\"hello\" = \"Hello\";\n";
    let mut ed = Editor::open(strings, js_openstep()).unwrap();
    ed.insert_value(&[], "bye", "Goodbye").unwrap();
    assert_eq!(
        ed.source().unwrap(),
        "\"hello\" = \"Hello\";\nbye = Goodbye;\n"
    );
    let doc = Document::parse(ed.source().unwrap().as_bytes(), js_openstep()).unwrap();
    assert_eq!(
        doc.serialize(js_openstep()).unwrap(),
        "\"hello\" = \"Hello\";\n\"bye\" = \"Goodbye\";\n"
    );
}

#[test]
fn openstep_refuses_a_member_for_a_one_line_object() {
    // fig's engine refuses an entry into a dictionary that closes on its
    // last entry's line (`ContainerClosesOnItsLine`, over the C ABI as an
    // invalid argument): the line-based splice would land it outside the
    // braces. `set` reports the same, and the source is untouched.
    let src = b"{\n\tobjects = {\n\t\tA1 /* Foo.swift */ = {isa = PBXBuildFile; fileRef = B2 /* Foo.swift */; };\n\t};\n}\n";
    let mut ed = Editor::open(src, js_openstep()).unwrap();
    let inserted = ed.insert_value(&[key("objects"), key("A1")], "settings", "z");
    assert!(
        matches!(inserted, Err(fig::Error::InvalidArgument)),
        "{inserted:?}\n{}",
        ed.source().unwrap()
    );
    let set = ed.set_value(&[key("objects"), key("A1"), key("settings")], "z");
    assert!(matches!(set, Err(fig::Error::InvalidArgument)), "{set:?}");
    assert_eq!(ed.source().unwrap().as_bytes(), src);
}

#[test]
#[ignore = "fig's engine refuses an entry into a one-line mapping (0304c11) but not an item into a one-line sequence: the item lands after the line, in the enclosing array"]
fn openstep_refuses_an_item_for_a_one_line_array() {
    let src = b"{\n\tL = (\n\t\t(a, b),\n\t);\n}\n";
    let mut ed = Editor::open(src, js_openstep()).unwrap();
    let appended = ed.append_value(&[key("L"), Segment::Index(0)], "c");
    assert!(appended.is_err(), "{}", ed.source().unwrap());
    assert_eq!(ed.source().unwrap().as_bytes(), src);
}

// ── pom.xml ───────────────────────────────────────────────────────────────

fn js_pom() -> Format {
    static FORMAT: OnceLock<Format> = OnceLock::new();
    *FORMAT.get_or_init(|| fig::language::register(module("pom.mjs")).expect("registers")[0])
}

#[test]
fn pom_parses_every_fixture_to_its_recorded_table() {
    assert_tables("pom", "pom.mjs", "js-pom");
}

#[test]
fn pom_prints_as_recorded_and_reads_back() {
    assert_prints("pom", js_pom(), "js-pom");
}

#[test]
fn pom_refuses_what_is_not_a_record() {
    assert_refuses(
        js_pom(),
        &[
            b"<a>text <b>x</b></a>\n",               // mixed content
            b"<a><b>x</b> text</a>\n",               // mixed content, the other way
            b"<a>\n",                                // unclosed
            b"<a></b>\n",                            // the wrong close
            b"<a>&nope;</a>\n",                      // an unknown entity
            b"<a/><b/>\n",                           // two roots
            b"text\n",                               // no element
            b"<!DOCTYPE a [<!ENTITY x 'y'>]><a/>\n", // an internal subset
            b"<a b=1/>\n",                           // an unquoted attribute
            b"",                                     // nothing
        ],
    );
}

#[test]
fn pom_renders_text_and_entries_and_refuses_a_rename() {
    let lang = module("pom.mjs");
    let render = |which: Renderer, key: &str, value: &str| -> Result<String, ()> {
        let args = RenderArgs {
            dialect: "js-pom",
            indent: b"  ",
            key: key.as_bytes(),
            value: value.as_bytes(),
            literal: Literal::String,
            old_key: b"",
        };
        lang.render(which, args)
            .map(|b| String::from_utf8(b).unwrap())
            .map_err(|_| ())
    };
    assert_eq!(
        render(Renderer::Value, "", " a < b & c ").unwrap(),
        "a &lt; b &amp; c"
    );
    assert_eq!(render(Renderer::Value, "", "<x>1</x>").unwrap(), "<x>1</x>");
    assert_eq!(
        render(Renderer::Entry, "version", "1.0").unwrap(),
        "<version>1.0</version>"
    );
    assert!(render(Renderer::Entry, "@attr", "1").is_err());
    assert!(render(Renderer::Entry, "not a name", "1").is_err());
    assert!(render(Renderer::Key, "renamed", "").is_err());
}

#[test]
fn pom_edits_text_and_entries_and_refuses_items() {
    let src = b"<project>\n  <version>1.0</version>\n  <deps>\n    <dep>a</dep>\n    <dep>b</dep>\n  </deps>\n  <build>\n    <x>1</x>\n  </build>\n</project>\n";
    let mut ed = Editor::open(src, js_pom()).unwrap();
    ed.replace_value(&[key("version")], "2.0 & up").unwrap();
    ed.insert_value(&[key("build")], "y", "2").unwrap();
    ed.replace_value(&[key("deps"), Segment::Index(1)], "c")
        .unwrap();
    ed.add_leading_comment(&[key("build")], "the build")
        .unwrap();
    assert_eq!(
        ed.source().unwrap(),
        "<project>\n  <version>2.0 &amp; up</version>\n  <deps>\n    <dep>a</dep>\n    <dep>c</dep>\n  </deps>\n  <!-- the build -->\n  <build>\n    <x>1</x>\n    <y>2</y>\n  </build>\n</project>\n"
    );
    ed.delete(&[key("build"), key("x")]).unwrap();
    assert!(!ed.source().unwrap().contains("<x>"));
    // A list takes no item in place, and a missing element is not vivified.
    assert!(ed.append_value(&[key("deps")], "d").is_err());
    assert!(ed.set_value(&[key("properties"), key("k")], "v").is_err());
    // A list replaced by text is a text element.
    ed.replace_value(&[key("deps")], "none").unwrap();
    assert!(
        ed.source().unwrap().contains("<deps>none</deps>"),
        "{}",
        ed.source().unwrap()
    );
}

// ── HCL ───────────────────────────────────────────────────────────────────

fn js_hcl() -> Format {
    static FORMAT: OnceLock<Format> = OnceLock::new();
    *FORMAT.get_or_init(|| fig::language::register(module("hcl.mjs")).expect("registers")[0])
}

#[test]
fn hcl_parses_every_fixture_to_its_recorded_table() {
    assert_tables("hcl", "hcl.mjs", "js-hcl");
}

#[test]
fn hcl_prints_as_recorded_and_reads_back() {
    assert_prints("hcl", js_hcl(), "js-hcl");
}

#[test]
fn hcl_keeps_expressions_as_text_and_reads_values() {
    let doc = Document::parse(
        b"a = 1\nb = \"s\"\nc = var.x\nd = [1, \"two\"]\ne = { k = true }\nf = \"${x}-y\"\ng = <<-EOT\n  hi\n  EOT\n",
        js_hcl(),
    )
    .unwrap();
    let v = doc.to_value().unwrap();
    assert_eq!(v.get("a").and_then(Value::as_i64), Some(1));
    assert_eq!(v.get("b").and_then(Value::as_str), Some("s"));
    assert_eq!(v.get("c").and_then(Value::as_str), Some("var.x"));
    assert_eq!(
        v.get("d").and_then(|d| d.get(1)).and_then(Value::as_str),
        Some("two")
    );
    assert_eq!(
        v.get("e").and_then(|e| e.get("k")).and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(v.get("f").and_then(Value::as_str), Some("${x}-y"));
    assert_eq!(v.get("g").and_then(Value::as_str), Some("hi\n"));
}

#[test]
fn hcl_refuses_what_hcl_refuses() {
    assert_refuses(
        js_hcl(),
        &[
            b"a = 1\na = 2\n",            // a repeated attribute
            b"a = 1\na {}\n",             // an attribute and a block of one name
            b"a {}\na = 1\n",             // the other way
            b"a \"x\" {}\na {}\n",        // a block with fewer labels
            b"a {\n",                     // an unclosed block
            b"a = \"open\n",              // an unclosed string
            b"a = \"\\q\"\n",             // an escape it does not know
            b"a = [1, 2\n",               // an unclosed tuple
            b"a = 1 b = 2\n",             // two attributes on a line
            b"a =\n",                     // no value
            b"\"a\" = 1\n",               // a quoted attribute name
            b"a = <<EOT\nnever closed\n", // an unclosed heredoc
            b"a \"${x}\" {}\n",           // a template as a label
            b"a {} b {}\n",               // two blocks on a line
        ],
    );
}

#[test]
fn hcl_renders_a_value_by_its_literal() {
    let lang = module("hcl.mjs");
    let render = |value: &str, literal: Literal| -> String {
        let args = RenderArgs {
            dialect: "js-hcl",
            indent: b"  ",
            key: b"",
            value: value.as_bytes(),
            literal,
            old_key: b"",
        };
        String::from_utf8(lang.render(Renderer::Value, args).expect("renders")).unwrap()
    };
    assert_eq!(render("42", Literal::Int), "42");
    assert_eq!(render("2.5", Literal::Float), "2.5");
    assert_eq!(render("true", Literal::Bool), "true");
    assert_eq!(render("null", Literal::Null), "null");
    assert_eq!(render("us-east-1", Literal::String), "\"us-east-1\"");
    assert_eq!(
        render("say \"hi\" ${x}", Literal::String),
        "\"say \\\"hi\\\" $${x}\""
    );
    assert_eq!(render("\"kept\"", Literal::String), "\"kept\"");
    assert_eq!(render("[1, 2]", Literal::String), "[1, 2]");
    assert_eq!(render("{ a = 1 }", Literal::String), "{ a = 1 }");
}

#[test]
fn hcl_edits_attributes_and_refuses_what_it_cannot_spell() {
    let src = b"region = \"us-east-1\"\n\nterraform {\n  required_providers {\n    aws = {\n      source = \"hashicorp/aws\"\n    }\n  }\n}\n\nresource \"aws_instance\" \"web\" {\n  ami           = \"ami-1\"\n  instance_type = var.type # size\n\n  lifecycle {\n    create_before_destroy = true\n  }\n}\n\nresource \"aws_instance\" \"db\" {}\n";
    let mut ed = Editor::open(src, js_hcl()).unwrap();
    ed.replace_value(&[key("region")], "eu-west-1").unwrap();
    ed.replace_value(
        &[
            key("resource"),
            key("aws_instance"),
            key("web"),
            key("instance_type"),
        ],
        "t3.large",
    )
    .unwrap();
    ed.set_value(
        &[
            key("resource"),
            key("aws_instance"),
            key("web"),
            key("monitoring"),
        ],
        true,
    )
    .unwrap();
    // A body with only a nested block takes the attribute after it.
    ed.insert_value(&[key("terraform")], "required_version", ">= 1.5")
        .unwrap();
    ed.insert_value(
        &[key("terraform"), key("required_providers"), key("aws")],
        "version",
        "~> 5",
    )
    .unwrap();
    ed.set_value(
        &[
            key("resource"),
            key("aws_instance"),
            key("web"),
            key("lifecycle"),
            key("prevent_destroy"),
        ],
        false,
    )
    .unwrap();
    assert_eq!(
        ed.source().unwrap(),
        "region = \"eu-west-1\"\n\nterraform {\n  required_providers {\n    aws = {\n      source = \"hashicorp/aws\"\n      version = \"~> 5\"\n    }\n  }\n  required_version = \">= 1.5\"\n}\n\nresource \"aws_instance\" \"web\" {\n  ami           = \"ami-1\"\n  instance_type = \"t3.large\" # size\n\n  lifecycle {\n    create_before_destroy = true\n    prevent_destroy = false\n  }\n  monitoring = true\n}\n\nresource \"aws_instance\" \"db\" {}\n"
    );
    ed.delete(&[key("resource"), key("aws_instance"), key("web"), key("ami")])
        .unwrap();
    assert!(!ed.source().unwrap().contains("ami-1"));
    // An empty body takes nothing in place; a block is not a line to
    // delete nor a value to replace; nothing is vivified.
    assert!(
        ed.insert_value(
            &[key("resource"), key("aws_instance"), key("db")],
            "ami",
            "x"
        )
        .is_err()
    );
    assert!(
        ed.delete(&[key("resource"), key("aws_instance"), key("web")])
            .is_err()
    );
    assert!(
        ed.replace_value(&[key("resource"), key("aws_instance"), key("web")], "x")
            .is_err()
    );
    assert!(ed.replace_value(&[key("resource")], "x").is_err());
    assert!(
        ed.set_value(&[key("module"), key("vpc"), key("source")], "x")
            .is_err()
    );
    // The container op takes a block whole, with its closing line.
    ed.delete_container(&[key("resource"), key("aws_instance"), key("web")])
        .unwrap();
    let out = ed.source().unwrap();
    assert!(
        !out.contains("\"web\"") && !out.contains("lifecycle"),
        "{out}"
    );
    assert!(
        out.ends_with("resource \"aws_instance\" \"db\" {}\n"),
        "{out}"
    );
    Document::parse(out.as_bytes(), js_hcl()).unwrap();
}
