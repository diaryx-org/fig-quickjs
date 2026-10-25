//! The binary speaks fig's helper wire: JSON-RPC 2.0, one message per line,
//! as `docs/helper-protocol.md` in the fig repository specifies it and a
//! `fig` command line sends it. Driven here as the CLI drives a helper — the
//! binary spawned on a module, requests on stdin, responses on stdout.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::{Value, json};

/// Each request, one line apiece, to the binary serving `module`; the
/// response lines it wrote, in order.
fn exchange(module: &str, requests: &[Value]) -> Vec<Value> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("languages")
        .join(module);
    let mut child = Command::new(env!("CARGO_BIN_EXE_fig-quickjs"))
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("the binary starts");
    {
        let mut stdin = child.stdin.take().unwrap();
        for r in requests {
            writeln!(stdin, "{r}").unwrap();
        }
    }
    let out = BufReader::new(child.stdout.take().unwrap())
        .lines()
        .map(|l| serde_json::from_str(&l.unwrap()).expect("each response is one line of JSON"))
        .collect();
    assert!(child.wait().unwrap().success());
    out
}

#[test]
fn the_binary_answers_each_request_with_its_id() {
    let answers = exchange(
        "dotenv.mjs",
        &[
            json!({"jsonrpc": "2.0", "id": 1, "method": "describe"}),
            json!({"jsonrpc": "2.0", "id": "two", "method": "parse",
                   "params": {"dialect": "js-dotenv", "input": "A=1\n"}}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "render",
                   "params": {"which": "value", "dialect": "js-dotenv", "value": "x"}}),
        ],
    );
    assert_eq!(answers.len(), 3);
    for a in &answers {
        assert_eq!(a["jsonrpc"], "2.0", "{a}");
    }

    assert_eq!(answers[0]["id"], 1);
    assert_eq!(answers[0]["result"]["name"], "js-dotenv");
    assert_eq!(answers[0]["result"]["dialects"][0]["name"], "js-dotenv");

    assert_eq!(answers[1]["id"], "two");
    let rows = answers[1]["result"]["rows"].as_array().unwrap();
    assert_eq!(rows[0]["kind"], "mapping");
    assert_eq!(rows[2]["text"], "A");
    assert_eq!(rows[3]["text"], "1");

    // dotenv declares no renderers: the method is not there to call.
    assert_eq!(answers[2]["id"], 3);
    assert_eq!(answers[2]["error"]["code"], -32601, "{}", answers[2]);
}

#[test]
fn a_refusal_is_an_error_carrying_its_offset() {
    let answers = exchange(
        "dotenv.mjs",
        &[json!({"jsonrpc": "2.0", "id": 9, "method": "parse",
                 "params": {"dialect": "js-dotenv", "input": "A B=1\n"}})],
    );
    let a = &answers[0];
    assert_eq!(a["id"], 9);
    assert!(a.get("result").is_none(), "{a}");
    assert_eq!(a["error"]["code"], fig::helper::LANGUAGE_REFUSED);
    assert_eq!(a["error"]["data"]["byte_offset"], 2);
    assert!(a["error"]["message"].as_str().unwrap().contains('='), "{a}");
}

#[test]
fn a_request_that_is_not_json_rpc_is_refused_as_one() {
    let answers = exchange(
        "dotenv.mjs",
        &[
            json!({"id": 1, "method": "describe"}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "nonsense"}),
        ],
    );
    assert_eq!(answers[0]["error"]["code"], -32600, "{}", answers[0]);
    assert_eq!(answers[1]["error"]["code"], -32601, "{}", answers[1]);
}
