//! The command line of paramdoc-export: reads a template directory, its data, fonts and references, runs the
//! library's `export` (or `plain_pdf`) and writes the files it returns, printing its log.
//!
//! Usage: paramdoc-export <fixture-dir> [--data f] [--fonts d] [--out d] [--fuzz N] [--seed S] [--reference data.json]... [--fuzz-references K] [--plain-pdf out.pdf]

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use paramdoc_export::{ExportInput, File, export, plain_pdf};

struct Args { fixture: PathBuf, data: PathBuf, fonts: PathBuf, out: PathBuf, fuzz: usize, seed: u64, references: Vec<PathBuf>, fuzz_references: usize, plain_pdf: Option<PathBuf> }

fn parse_args() -> Result<Args> {
    let mut args = std::env::args().skip(1);
    let fixture = PathBuf::from(args.next().ok_or_else(|| anyhow!("usage: paramdoc-export <fixture-dir> [--data f] [--fonts d] [--out d] [--fuzz N] [--seed S] [--reference data.json]... [--fuzz-references K] [--plain-pdf out.pdf]"))?);
    let name = fixture.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "doc".into());
    let mut parsed = Args {
        data: fixture.join("data.json"),
        fonts: PathBuf::from("../../fixtures/fonts"),
        out: PathBuf::from("../../.build/paramdoc").join(name),
        fuzz: 0,
        seed: 1,
        references: Vec::new(),
        fuzz_references: 0,
        plain_pdf: None,
        fixture,
    };
    while let Some(flag) = args.next() {
        let value = args.next().ok_or_else(|| anyhow!("{flag} needs a value"))?;
        match flag.as_str() {
            "--data" => parsed.data = value.into(),
            "--fonts" => parsed.fonts = value.into(),
            "--out" => parsed.out = value.into(),
            "--fuzz" => parsed.fuzz = value.parse()?,
            "--seed" => parsed.seed = value.parse()?,
            "--reference" => parsed.references.push(value.into()),
            "--fuzz-references" => parsed.fuzz_references = value.parse()?,
            "--plain-pdf" => parsed.plain_pdf = Some(value.into()),
            other => bail!("unknown flag {other}"),
        }
    }
    Ok(parsed)
}

fn walk_files(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))? {
        let path = entry?.path();
        if path.is_dir() { out.extend(walk_files(&path)?); } else { out.push(path); }
    }
    out.sort();
    Ok(out)
}

/// Every file under `dir`, by its path relative to `dir` with `/` separators, in sorted order.
fn read_dir_files(dir: &Path) -> Result<Vec<File>> {
    let mut out = Vec::new();
    for path in walk_files(dir)? {
        let rel = path.strip_prefix(dir)?.to_string_lossy().replace('\\', "/");
        let bytes = fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
        out.push((rel, bytes));
    }
    Ok(out)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("error: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    let template = read_dir_files(&args.fixture)?;
    let fonts = read_dir_files(&args.fonts).with_context(|| format!("no fonts found in {}", args.fonts.display()))?;
    let data = fs::read(&args.data).with_context(|| format!("reading {}", args.data.display()))?;
    let references = args.references.iter().map(|path| {
        let name = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        Ok((name, fs::read(path).with_context(|| format!("reading {}", path.display()))?))
    }).collect::<Result<Vec<File>>>()?;
    let input = ExportInput { template, data, fonts, references, fuzz: args.fuzz, seed: args.seed, fuzz_references: args.fuzz_references };

    if let Some(path) = &args.plain_pdf {
        let (pdf, pages, log) = plain_pdf(&input)?;
        fs::write(path, &pdf).with_context(|| format!("writing {}", path.display()))?;
        print!("{log}");
        println!("compiled {pages} page(s) and wrote {} ({} bytes)", path.display(), pdf.len());
        return Ok(());
    }

    fs::create_dir_all(&args.out)?;
    let out = export(&input);
    for (rel, bytes) in &out.files {
        let path = args.out.join(rel);
        if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }
        fs::write(&path, bytes).with_context(|| format!("writing {}", path.display()))?;
    }
    print!("{}", out.log);
    if let Some(error) = out.error { bail!("{error}"); }
    Ok(())
}
