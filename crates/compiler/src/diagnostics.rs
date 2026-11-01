//! Typst's diagnostics as data: severity, message, hints, and where in which file (and package) they point.

use serde::Serialize;
use typst::World;
use typst::WorldExt;
use typst::diag::{Severity, SourceDiagnostic};
use typst::syntax::{DiagSpan, VirtualRoot};

use crate::world::CompileWorld;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    /// `error`, `warning`, or `hint` for an entry of the trace that led to the one before it.
    pub severity: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub hints: Vec<String>,
    /// The file the diagnostic points into, as an absolute virtual path; absent when it points nowhere.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub path: String,
    /// `line:column-line:column`, zero-based, in characters.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub range: String,
    /// The package the file belongs to (`@local/typfolio:0.1.0`), absent for the project's own files.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub package: String,
}

/// Appends each diagnostic, followed by its trace as `hint` entries.
pub fn convert(world: &CompileWorld, diagnostics: &[SourceDiagnostic], into: &mut Vec<Diagnostic>) {
    for diagnostic in diagnostics {
        let (path, range, package) = locate(world, diagnostic.span);
        into.push(Diagnostic {
            severity: match diagnostic.severity {
                Severity::Error => "error",
                Severity::Warning => "warning",
            },
            message: diagnostic.message.to_string(),
            hints: diagnostic.hints.iter().map(|hint| hint.v.to_string()).collect(),
            path,
            range,
            package,
        });
        for point in &diagnostic.trace {
            let (path, range, package) = locate(world, point.span);
            into.push(Diagnostic { severity: "hint", message: point.v.to_string(), hints: Vec::new(), path, range, package });
        }
    }
}

fn locate(world: &CompileWorld, span: impl Into<DiagSpan>) -> (String, String, String) {
    let span: DiagSpan = span.into();
    let Some(id) = span.id() else { return Default::default() };
    let rooted = id.get();
    let path = rooted.vpath().get_with_slash().to_string();
    let package = match rooted.root() {
        VirtualRoot::Project => String::new(),
        VirtualRoot::Package(spec) => spec.to_string(),
    };
    let range = match (world.range(span), world.source(id)) {
        (Some(range), Ok(source)) => {
            let lines = source.lines();
            let position = |offset: usize| {
                let line = lines.byte_to_line(offset).unwrap_or(0);
                let column = lines.byte_to_column(offset).unwrap_or(0);
                format!("{line}:{column}")
            };
            format!("{}-{}", position(range.start), position(range.end))
        }
        _ => String::new(),
    };
    (path, range, package)
}
