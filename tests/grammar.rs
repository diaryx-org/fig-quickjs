//! The grammar, through the README's own example: the first `js` block in
//! `README.md` is loaded as a module, so the example cannot drift from what
//! `fig/grammar` does.

use fig::language::Language;
use fig::{Document, Editor, Segment, Value};
use fig_quickjs::JsLanguage;

fn readme_module() -> String {
    let readme =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/README.md")).unwrap();
    let start = readme.find("```js\n").expect("a js block") + "```js\n".len();
    let end = readme[start..].find("\n```").expect("the block closes") + start;
    readme[start..end].to_owned()
}

fn tinykv() -> JsLanguage {
    JsLanguage::from_source("README.md", &readme_module()).expect("the README's module loads")
}

#[test]
fn the_readme_example_parses_its_sample_with_comments_bound() {
    let lang = tinykv();
    let table = lang
        .parse("tinykv", b"a=1\n# two\nb=two # words\n")
        .unwrap();
    let json = fig::helper::encode(&fig::helper::table_to_value(&table));
    assert_eq!(
        json,
        r#"{"rows":[{"kind":"mapping","parent":null,"span":[0,24]},{"kind":"keyvalue","parent":0,"span":[0,3]},{"kind":"string","parent":1,"span":[0,1],"text":"a"},{"kind":"string","parent":1,"span":[2,3],"text":"1"},{"kind":"keyvalue","parent":0,"span":[10,15]},{"kind":"string","parent":4,"span":[10,11],"text":"b"},{"kind":"string","parent":4,"span":[12,15],"text":"two"}],"regions":[],"mentions":[],"comments":[{"node":5,"slot":"leading","style":"line","text":"two"},{"node":6,"slot":"trailing","style":"line","text":"words"}]}"#
    );
}

#[test]
fn the_readme_example_applies_the_duplicate_policy_and_dangles_a_last_comment() {
    let lang = tinykv();
    let table = lang.parse("tinykv", b"a=1\na=2\n# end\n").unwrap();
    let v = fig::helper::table_to_value(&table);
    let rows = v.get("rows").and_then(Value::as_seq).unwrap();
    assert_eq!(rows.len(), 4, "one entry: the first keeps its place");
    assert_eq!(rows[3].get("text").and_then(Value::as_str), Some("2"));
    assert_eq!(
        rows[1].get("span").map(fig::helper::encode).as_deref(),
        Some("[0,3]")
    );
    let comments = v.get("comments").and_then(Value::as_seq).unwrap();
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0].get("node").and_then(Value::as_i64), Some(0));
    assert_eq!(
        comments[0].get("slot").and_then(Value::as_str),
        Some("dangling")
    );
}

#[test]
fn a_failure_raised_inside_the_grammar_is_reported_at_its_offset() {
    let lang = tinykv();
    let err = lang.parse("tinykv", b"a=1\nb\n").unwrap_err();
    assert_eq!(err.message, "expected `=` after this key");
    assert_eq!(err.byte_offset, Some(5));
    let err = lang.parse("tinykv", b"=1\n").unwrap_err();
    assert_eq!(err.message, "expected `key=value` here");
    assert_eq!(err.byte_offset, Some(0));
}

#[test]
fn the_readme_example_registers_prints_and_edits() {
    let format = fig::language::register(tinykv()).expect("the harness passes")[0];
    let src = b"a=1\n# two\nb=two # words\n";
    let doc = Document::parse(src, format).unwrap();
    assert_eq!(doc.serialize(format).unwrap().as_bytes(), src);
    let mut ed = Editor::open(src, format).unwrap();
    ed.replace_value(&[Segment::Key("a")], "one").unwrap();
    ed.insert_value(&[], "c", "3").unwrap();
    assert_eq!(ed.source().unwrap(), "a=one\n# two\nb=two # words\nc=3\n");
}

/// A section format small enough to read whole: `[name]` opens a section
/// or re-enters one, `k=v` is an entry, `#` a comment, `>` in front of a
/// line its depth. Every region, mention and comment comes from
/// `G.sections`; only what a header means is the module's.
const TINYSECTIONS: &str = r##"
import * as fig from "fig";
import * as G from "fig/grammar";
function parse(_dialect, input) {
  const sc = fig.scanner(input);
  const { bin } = sc;
  const S = G.sections(bin);
  const root = fig.mapping([0, sc.n]);
  let current = root;
  let pos = 0;
  while (pos < sc.n) {
    let nl = bin.indexOf("\n", pos);
    if (nl < 0) nl = sc.n;
    const line = bin.slice(pos, nl);
    const depth = line.match(/^>*/)[0].length;
    const body = line.slice(depth);
    const at = pos + depth;
    if (body.startsWith("#")) {
      S.comment(body.slice(1), depth);
    } else if (body.startsWith("[")) {
      const name = body.slice(1, -1);
      const span = [at + 1, at + 1 + name.length];
      const e = root.byKey.get(name);
      if (e) {
        S.reopen(e.value, span, "header");
        current = e.value;
      } else {
        const key = fig.scalar("string", span, name);
        S.claim(key, "leading");
        current = S.open(root, fig.entry(key, fig.mapping(span)), "header");
      }
    } else if (body !== "") {
      const eq = body.indexOf("=");
      const key = fig.scalar("string", [at, at + eq], body.slice(0, eq));
      S.claim(key, "leading", depth);
      current.put(fig.entry(key, fig.scalar("string", [at + eq + 1, at + body.length], body.slice(eq + 1))));
    }
    pos = nl + 1;
  }
  S.claim(current, "dangling");
  return fig.rows(root);
}
export default { name: "tinysections", caps: { read: true }, dialects: [{ name: "tinysections", extensions: ["tsec"] }], parse };
"##;

#[test]
fn sections_record_the_header_lines_the_names_and_the_waiting_comments() {
    let lang = JsLanguage::from_source("tinysections.mjs", TINYSECTIONS).unwrap();
    let table = lang
        .parse(
            "tinysections",
            b"# about a\n[a]\nx=1\n[b]\n[a]\ny=2\n# end\n",
        )
        .unwrap();
    let v = fig::helper::table_to_value(&table);
    let regions = fig::helper::encode(v.get("regions").unwrap());
    // `[a]` at 10, `[b]` at 18, `[a]` again at 22: each whole line, newline
    // included, on the section it opened or re-entered — `a` is node 3
    // (root, keyvalue, key, mapping), `b` node 12.
    assert_eq!(
        regions,
        r#"[{"node":3,"start":10,"end":14},{"node":3,"start":22,"end":26},{"node":12,"start":18,"end":22}]"#
    );
    let mentions = fig::helper::encode(v.get("mentions").unwrap());
    assert_eq!(
        mentions,
        r#"[{"node":3,"span":[11,12],"kind":"header"},{"node":3,"span":[23,24],"kind":"header"},{"node":12,"span":[19,20],"kind":"header"}]"#
    );
    let comments = fig::helper::encode(v.get("comments").unwrap());
    assert_eq!(
        comments,
        r#"[{"node":2,"slot":"leading","style":"line","text":" about a"},{"node":3,"slot":"dangling","style":"line","text":" end"}]"#
    );
}

#[test]
fn sections_take_the_waiting_comments_by_depth() {
    let lang = JsLanguage::from_source("tinysections.mjs", TINYSECTIONS).unwrap();
    // A key at depth 1 claims only the comments at its depth or deeper;
    // the shallower one keeps waiting, and dangles at the end.
    let table = lang
        .parse("tinysections", b"[s]\n#shallow\n>#deep\n>k=v\n")
        .unwrap();
    let v = fig::helper::table_to_value(&table);
    let comments = fig::helper::encode(v.get("comments").unwrap());
    assert_eq!(
        comments,
        r#"[{"node":3,"slot":"dangling","style":"line","text":"shallow"},{"node":5,"slot":"leading","style":"line","text":"deep"}]"#
    );
}

/// A module that answers, for the one token it is given, what `fig/number`
/// and `fig/datetime` make of it — so the two modules are held to what
/// fig's own `src/util/number.zig` and `src/util/datetime.zig` say.
const PROBE: &str = r##"
import * as fig from "fig";
import * as N from "fig/number";
import * as DT from "fig/datetime";
function parse(_dialect, input) {
  const raw = input.slice(2);
  const out = (input[0] === "n"
    ? [N.spellable(raw, N.JSON), N.spellable(raw, N.JSON5), N.spellable(raw, N.YAML_1_2), N.canonical(raw)]
    : [DT.classify(raw) ?? "-", DT.classify(raw, { minutePrecision: false, timeOnly: false }) ?? "-"]
  ).join(" ");
  return fig.rows(fig.scalar("string", [0, input.length], out));
}
export default { name: "probe", caps: { read: true }, dialects: [{ name: "probe" }], parse };
"##;

#[test]
fn number_and_datetime_answer_as_the_compiled_utilities_do() {
    let lang = JsLanguage::from_source("probe.mjs", PROBE).unwrap();
    for (raw, want) in [
        // `n:` — spellable for JSON, JSON5, YAML 1.2, then canonical;
        // `d:` — classify lenient, then with seconds required and no bare time.
        ("n:0xff", "false true true 255"),
        ("n:-0x1F", "false true true -31"),
        ("n:0b1010", "false false false 10"),
        ("n:0o17", "false false true 15"),
        ("n:1_000", "false false false 1000"),
        ("n:.5", "false true true 0.5"),
        ("n:5.", "false true true 5.0"),
        ("n:0755", "false false true 755"),
        ("n:+7", "false true true 7"),
        ("n:1e5", "true true true 1e5"),
        ("n:-12.5", "true true true -12.5"),
        ("d:2024-02-29", "local_date local_date"),
        ("d:2023-02-29", "- -"),
        ("d:12:30", "local_time -"),
        ("d:12:30:00", "local_time -"),
        ("d:2024-01-02T12:30:00Z", "offset_datetime offset_datetime"),
        ("d:2024-01-02 12:30+01:00", "offset_datetime -"),
        ("d:2024-01-02t12:30:60.5", "local_datetime local_datetime"),
        ("d:2024-01-02T25:00:00", "- -"),
    ] {
        let table = lang.parse("probe", raw.as_bytes()).unwrap();
        let v = fig::helper::table_to_value(&table);
        let rows = v.get("rows").and_then(Value::as_seq).unwrap();
        assert_eq!(
            rows[0].get("text").and_then(Value::as_str),
            Some(want),
            "{raw}"
        );
    }
}
