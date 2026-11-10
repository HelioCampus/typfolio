//! The compile request's options, as the caller passes them in JSON, and their translation to typst-pdf's.

use std::collections::BTreeMap;

use serde::Deserialize;
use typst::foundations::{Datetime, Smart};
use typst::{Feature, Features};
use typst_pdf::{PdfOptions, PdfStandard, PdfStandards, Timestamp};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct CompileOptions {
    /// `sys.inputs`, string values only.
    pub inputs: BTreeMap<String, String>,
    pub pdf: PdfRequest,
    /// Typst's in-development features by their CLI names (`a11y-extras`, `html`, `bundle`). `["a11y-extras"]` when
    /// absent; an empty list enables none.
    pub features: Option<Vec<String>>,
    /// The caller's clock. Without it the document has no date unless it sets one, and `datetime.today()` fails.
    pub now: Option<Now>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct PdfRequest {
    /// One PDF standard by its Typst name (`ua-1`, `a-2b`, `1.7`, …), or none.
    pub standard: Option<String>,
    /// Tagged PDF; `true` when absent.
    pub tags: Option<bool>,
    /// Unix seconds for the PDF's creation date when the document's date is `auto`; `now` when absent.
    pub creation_timestamp: Option<i64>,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Now {
    pub unix_seconds: i64,
    /// The caller's local time zone as minutes east of UTC (JavaScript: `-new Date().getTimezoneOffset()`).
    #[serde(default)]
    pub utc_offset_minutes: i32,
}

/// The features of a request, sorted and without repeats (the standard library is cached by them).
pub fn feature_names(request: &Option<Vec<String>>) -> Result<Vec<String>, String> {
    let mut names = request.clone().unwrap_or_else(|| vec!["a11y-extras".into()]);
    names.sort();
    names.dedup();
    names.iter().try_for_each(|name| feature(name).map(drop))?;
    Ok(names)
}

/// Typst's features for names `feature_names` accepted.
pub fn features(names: &[String]) -> Features {
    names.iter().filter_map(|name| feature(name).ok()).collect()
}

fn feature(name: &str) -> Result<Feature, String> {
    match name {
        "a11y-extras" => Ok(Feature::A11yExtras),
        "html" => Ok(Feature::Html),
        "bundle" => Ok(Feature::Bundle),
        _ => Err(format!("unknown feature {name:?} (a11y-extras, html and bundle are available)")),
    }
}

/// typst-pdf's options for a request. The identifier stays `auto` (a hash of title and author), as the Typst CLI does.
pub fn pdf_options(request: &PdfRequest, now: Option<Now>) -> Result<PdfOptions, String> {
    let standards = match &request.standard {
        Some(name) => {
            let standard: PdfStandard = serde_json::from_value(serde_json::Value::String(name.clone()))
                .map_err(|_| format!("unknown PDF standard {name:?}"))?;
            PdfStandards::new(&[standard]).map_err(|error| error.message().to_string())?
        }
        None => PdfStandards::default(),
    };
    let timestamp = request
        .creation_timestamp
        .or(now.map(|now| now.unix_seconds))
        .and_then(datetime_from_unix)
        .map(Timestamp::new_utc);
    Ok(PdfOptions {
        ident: Smart::Auto,
        timestamp,
        standards,
        tagged: request.tags.unwrap_or(true),
        ..PdfOptions::default()
    })
}

/// The UTC date and time of a Unix timestamp.
pub fn datetime_from_unix(seconds: i64) -> Option<Datetime> {
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    let second_of_day = seconds.rem_euclid(86_400);
    Datetime::from_ymd_hms(year, month, day, (second_of_day / 3600) as u8, (second_of_day % 3600 / 60) as u8, (second_of_day % 60) as u8)
}

/// The UTC date of a Unix timestamp.
pub fn date_from_unix(seconds: i64) -> Option<Datetime> {
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    Datetime::from_ymd(year, month, day)
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i32, u8, u8) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = (z - era * 146_097) as u64;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u8;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 } as u8;
    let year = year_of_era as i64 + era * 400 + i64::from(month <= 2);
    (year as i32, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(19_676), (2023, 11, 15)); // 1700000000 / 86400
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(civil_from_days(-719_468), (0, 3, 1));
    }

    #[test]
    fn timestamps() {
        assert_eq!(datetime_from_unix(1_700_000_000), Datetime::from_ymd_hms(2023, 11, 14, 22, 13, 20));
        assert_eq!(date_from_unix(1_700_000_000), Datetime::from_ymd(2023, 11, 14));
        assert_eq!(datetime_from_unix(-1), Datetime::from_ymd_hms(1969, 12, 31, 23, 59, 59));
    }
}
