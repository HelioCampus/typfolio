//! Command-line front end of paramdoc-runtime: reads an exported document directory, data and fonts, calls
//! [`paramdoc_runtime::fill`] and writes the PDF and a trace of what was drawn into each slot.
//!
//! Usage: paramdoc-runtime <doc-dir> --data data.json --out out.pdf [--expect reference.json]

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow, bail};
use paramdoc_runtime::{ReferenceSlot, compare, fill};

struct Args { dir: PathBuf, data: PathBuf, out: PathBuf, expect: Option<PathBuf> }

fn parse_args() -> Result<Args> {
    let mut args = std::env::args().skip(1);
    let dir = PathBuf::from(args.next().ok_or_else(|| anyhow!("usage: paramdoc-runtime <doc-dir> --data data.json --out out.pdf [--expect reference.json]"))?);
    let mut parsed = Args { data: dir.join("data.json"), out: dir.join("runtime.pdf"), expect: None, dir };
    while let Some(flag) = args.next() {
        let value = args.next().ok_or_else(|| anyhow!("{flag} needs a value"))?;
        match flag.as_str() {
            "--data" => parsed.data = value.into(),
            "--out" => parsed.out = value.into(),
            "--expect" => parsed.expect = Some(value.into()),
            other => bail!("unknown flag {other}"),
        }
    }
    Ok(parsed)
}

#[derive(serde::Serialize)]
struct FillTrace<'a> { slots: &'a [ReferenceSlot] }

fn main() {
    if let Err(error) = run() {
        eprintln!("error: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    let doc_json = fs::read(args.dir.join("doc.json")).context("reading doc.json")?;
    let listed: paramdoc_ir::Document = serde_json::from_slice(&doc_json).context("parsing doc.json")?;
    let data = fs::read(&args.data).with_context(|| format!("reading {}", args.data.display()))?;
    let font_files = listed.fonts.iter().map(|f| fs::read(args.dir.join("fonts").join(&f.file)).with_context(|| format!("reading font {}", f.file))).collect::<Result<Vec<_>>>()?;
    let fonts: Vec<&[u8]> = font_files.iter().map(|f| f.as_slice()).collect();

    let started = std::time::Instant::now();
    let output = fill(&doc_json, &fonts, &data)?;
    let elapsed = started.elapsed();
    fs::write(&args.out, &output.pdf)?;
    fs::write(args.out.with_extension("trace.json"), serde_json::to_string_pretty(&FillTrace { slots: &output.trace })?)?;
    println!("filled {} slot(s) on {} page(s) and wrote {} bytes to {} in {elapsed:.1?}", output.trace.len(), output.pages, output.pdf.len(), args.out.display());

    if let Some(expect) = &args.expect {
        let reference: Vec<ReferenceSlot> = serde_json::from_slice(&fs::read(expect).with_context(|| format!("reading {}", expect.display()))?)?;
        let problems = compare(&output.trace, &reference);
        if problems.is_empty() {
            println!("reference: every slot's glyphs and positions match Typst's own layout of this data");
        } else {
            for p in &problems { println!("reference mismatch: {p}"); }
            std::process::exit(1);
        }
    }
    Ok(())
}
