use std::io::{self, Read};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct Input {
    a: i64,
    b: i64,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Read entire stdin
    let mut s = String::new();
    io::stdin().read_to_string(&mut s)?;

    // Parse JSON: {"a": ..., "b": ...}
    let input: Input = serde_json::from_str(&s)?;

    // Compute sum
    let sum = input.a + input.b;

    // Output JSON: {"sum": ...}
    let out = json!({ "sum": sum });
    println!("{}", out);

    Ok(())
}