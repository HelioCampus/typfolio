//! Command-line front end of paramdoc-runtime: reads an exported document directory, data and fonts, calls
//! [`paramdoc_runtime::fill`] and writes the PDF and a trace of what was drawn into each slot.
//!
//! Usage: paramdoc-runtime <doc-dir> --data data.json --out out.pdf [--expect reference.json]
//!        paramdoc-runtime bench <doc-dir> --inputs inputs.json [--out dir] [--repeat N]

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow, bail};
use paramdoc_runtime::{ReferenceSlot, Runtime, compare};

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

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() { return 0.0; }
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

/// Fills every input of a JSON array once per repeat on one thread, fonts parsed once, and reports throughput.
fn bench() -> Result<()> {
    let mut args = std::env::args().skip(2);
    let dir = PathBuf::from(args.next().ok_or_else(|| anyhow!("usage: paramdoc-runtime bench <doc-dir> --inputs inputs.json [--out dir] [--repeat N]"))?);
    let (mut inputs, mut out, mut repeat) = (None, dir.clone(), 1usize);
    while let Some(flag) = args.next() {
        let value = args.next().ok_or_else(|| anyhow!("{flag} needs a value"))?;
        match flag.as_str() { "--inputs" => inputs = Some(PathBuf::from(value)), "--out" => out = value.into(), "--repeat" => repeat = value.parse()?, other => bail!("unknown flag {other}") }
    }
    let inputs = inputs.ok_or_else(|| anyhow!("--inputs is required"))?;
    let doc_json = fs::read(dir.join("doc.json")).context("reading doc.json")?;
    let listed: paramdoc_ir::Document = serde_json::from_slice(&doc_json)?;
    let font_files = listed.fonts.iter().map(|f| fs::read(dir.join("fonts").join(&f.file)).with_context(|| format!("reading font {}", f.file))).collect::<Result<Vec<_>>>()?;
    let fonts: Vec<&[u8]> = font_files.iter().map(|f| f.as_slice()).collect();
    let values: Vec<serde_json::Value> = serde_json::from_slice(&fs::read(&inputs).with_context(|| format!("reading {}", inputs.display()))?)?;
    let payloads: Vec<Vec<u8>> = values.iter().map(|v| serde_json::to_vec(v).expect("serializable")).collect();

    let setup = std::time::Instant::now();
    let runtime = Runtime::new(&doc_json, &fonts)?;
    let setup_time = setup.elapsed();
    let mut durations = Vec::with_capacity(payloads.len() * repeat);
    let (mut bytes, mut pages) = (0usize, 0usize);
    let mut first = None;
    let started = std::time::Instant::now();
    for _ in 0..repeat {
        for payload in &payloads {
            let t = std::time::Instant::now();
            let output = runtime.fill(payload)?;
            durations.push(t.elapsed().as_secs_f64() * 1000.0);
            bytes += output.pdf.len();
            pages += output.pages;
            if first.is_none() { first = Some(output.pdf); }
        }
    }
    let total = started.elapsed().as_secs_f64();
    fs::create_dir_all(&out)?;
    if let Some(pdf) = first { fs::write(out.join("bench-first.pdf"), pdf)?; }
    durations.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = durations.len();
    println!("bench: {n} documents in {:.3} s on one thread = {:.0} documents/s; setup (parse document and fonts) {setup_time:.1?}", total, n as f64 / total);
    println!("       per document: median {:.3} ms, p95 {:.3} ms, max {:.3} ms; {pages} pages, {:.1} kB average PDF", percentile(&durations, 0.5), percentile(&durations, 0.95), durations[n - 1], bytes as f64 / n as f64 / 1000.0);
    println!("{{\"documents\":{n},\"seconds\":{total:.4},\"per_second\":{:.1},\"median_ms\":{:.4},\"p95_ms\":{:.4},\"pages\":{pages},\"bytes\":{bytes}}}", n as f64 / total, percentile(&durations, 0.5), percentile(&durations, 0.95));
    Ok(())
}

fn run() -> Result<()> {
    if std::env::args().nth(1).as_deref() == Some("bench") { return bench(); }
    let args = parse_args()?;
    let doc_json = fs::read(args.dir.join("doc.json")).context("reading doc.json")?;
    let listed: paramdoc_ir::Document = serde_json::from_slice(&doc_json).context("parsing doc.json")?;
    let data = fs::read(&args.data).with_context(|| format!("reading {}", args.data.display()))?;
    let font_files = listed.fonts.iter().map(|f| fs::read(args.dir.join("fonts").join(&f.file)).with_context(|| format!("reading font {}", f.file))).collect::<Result<Vec<_>>>()?;
    let fonts: Vec<&[u8]> = font_files.iter().map(|f| f.as_slice()).collect();

    let started = std::time::Instant::now();
    let runtime = Runtime::new(&doc_json, &fonts)?;
    let output = runtime.fill(&data)?;
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
