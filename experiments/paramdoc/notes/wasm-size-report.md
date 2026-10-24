# Typfolio pinned Typst WASM compiler: size breakdown

Analysis of `packages/wasm/generated/compiler_bg.wasm` as built by `npm run build:wasm` from the pins in
`compiler-source.json` (typst.ts `1189a2f1…`, Rust 1.92.0, wasm-bindgen 0.2.118, crate `typst-ts-web-compiler`,
features `web,pdf`, `cdylib`, release profile `opt-level=s`, `lto=fat`, `codegen-units=1`, no wasm-opt).
Machine: Linux x86_64 (kernel 6.18), 4 cores, 15 GB RAM. Date: 2026-10-24. No tracked file was modified; everything
generated lives under `.build/`, `packages/wasm/generated/` (both gitignored) and this scratchpad.

Scratchpad root for all raw outputs and scripts: `/tmp/claude-0/-home-user-typfolio/1c0be84b-aa31-5442-982b-25bbb7e3e225/scratchpad`
(`analysis/` = results, `scripts/` = the parsers used, `logs/` = build logs).

Three builds were made and are referred to throughout:

| build | what | purpose |
|---|---|---|
| **pinned** | exactly `tools/build-wasm.ts` (`.build/target`) | the artifact under analysis; sections, data blobs, compression |
| **named-LTO** | identical to pinned except `CARGO_PROFILE_RELEASE_STRIP=none` (`.build/target-named`, then wasm-bindgen into `analysis/named/`) | function names for per-function/per-crate attribution of the LTO'd code; the pinned artifact has no function names (see 3.2) |
| **non-LTO map** | same crate/features/target/opt-level, but `lto=off`, `codegen-units=16`, `strip=none`, `-C link-arg=-Map=…` (`.build/target-analysis`) | per-crate attribution of **code and data** from the wasm-ld map (without LTO every input section belongs to one rlib) |

Absolute numbers from the non-LTO build are larger than the shipped binary (29.2 MB code+data vs 24.3 MB); only
proportions transfer, except for embedded data blobs (`include_bytes!`, baked tables), which are the same bytes in
both — and for those the report byte-matches the non-LTO chunks against the pinned data section (section 5.3).

## 1. Build facts

| step | result | duration |
|---|---|---|
| `npm ci` | ok (Node 22.22.0, npm 10.9.4) | 21 s |
| `rustup toolchain install 1.92.0 --profile minimal --target wasm32-unknown-unknown` | ok, `rustc 1.92.0 (ded5c06cf 2025-12-08)` | 28 s |
| `cargo +1.92.0 install wasm-bindgen-cli --version 0.2.118 --locked --root .build/tools` | ok, `wasm-bindgen 0.2.118` | 172 s |
| `cargo +1.92.0 install cargo-about --version 0.9.2 --features cli` | **deliberately skipped** (see below) | – |
| `cargo install twiggy --locked`, `cargo install wasm-tools --locked` (stable 1.97.0) | twiggy 0.8.0, wasm-tools 1.262.0 | ran in parallel |
| `npm run build:wasm` (pinned build) | artifacts written; script exit code 1 **only** at the final notices step (`spawnSync .build/tools/bin/cargo-about ENOENT`) | 453 s wall; `cargo rustc` alone "Finished release in 7m 26s" (446 s) with `-j 4`; the fat-LTO stage is single-threaded for the last ~4 min |
| non-LTO analysis build (`scripts/analysis-build.sh`) | ok, map `analysis/link.map` (66 MB) | 212 s |
| named-LTO build (`scripts/named-lto-build.sh`) | ok | 387 s cargo + 3 s wasm-bindgen |

cargo-about decision: in `tools/build-wasm.ts` the notices generator runs last (line 133, `tools/generate-third-party-notices.ts`),
after `compiler_bg.wasm`, `compiler.js`, `compiler.d.ts`, `LICENSE.typst-ts` and `provenance.json` are written (lines 88–129).
It is not needed for the artifact, and building cargo-about 0.9.2 with its `cli` feature is slow, so it was not installed.
Consequence: `packages/wasm/THIRD_PARTY_NOTICES.md`/`THIRD_PARTY_LICENSES.md` were **not** regenerated (they are tracked, so
this also keeps the tree clean), and `npm run build:wasm` reported exit code 1 after producing everything else. `provenance.json`
records `cargoLockSha256 = 8d52e3ad…`, identical to the Cargo.lock hash printed in the committed `THIRD_PARTY_NOTICES.md`, so the
committed notices do describe this dependency graph.

Pinned build output (`packages/wasm/generated/`): `compiler_bg.wasm` 24,404,191 B, `compiler.js` 54,239 B (patched loader),
`compiler.d.ts`, `compiler_bg.wasm.d.ts`, `LICENSE.typst-ts`, `provenance.json`. 388 crates compiled (incl. host build scripts
and proc-macros), 299 downloaded. The pre-wasm-bindgen cdylib `.build/target/wasm32-unknown-unknown/release/typst_ts_web_compiler.wasm`
is 25,758,653 B: wasm-bindgen's own GC pass removed 1,108 unreachable functions (29,031 → 27,923), 923,505 B of code, 132 KB of
exports and the 297 KB `__wasm_bindgen_unstable` section.

### 1.1 Hash check: MISMATCH (informative)

| | this build (Linux x86_64) | pinned in `compiler-source.json` / docs |
|---|---|---|
| `compiler_bg.wasm` sha256 | `729fb23a5aa61d6467713f8697f801d9dbb28994a8ec8e5a8f831d0325aaace0` | `524d537303e9e3b95cbac888fe33fe1c15e5bd2b6fa9e6c3e547a77b074e7fc0` |
| size | 24,404,191 B | 24,325,868 B (docs) → **+78,323 B (+0.32 %)** |
| gzip -9 | 8,951,728 B | 8,941,574 B |
| brotli q11 | 6,522,576 B | "about 6.5 MB" |
| `compiler.js` sha256 | `12fb43ebe0b44ffc0f367335393ab3cdbf6873897c742c66afe2c005c9cd39fa` | `b463e089204caae9eb4024909d6f6630c698e85b7bf6c139b69416792533606c` |

The loader hash necessarily differs when the WASM differs (wasm-bindgen numbers glue functions per build). The pins were recorded on
macOS arm64 (docs/compiler-build.md); this is a Linux x86_64 build with the pinned toolchain, so the result confirms that the pinned
hash is not platform-independent on this machine. Not investigated further (out of scope); candidates are host-dependent build-script or
proc-macro output. `tools/check-package.ts` would fail "The build is not reproducing the pinned artifact" for this artifact.

Note: an untracked directory `experiments/paramdoc/` appeared in the repository root at 05:43 UTC while this analysis ran. It was not
created by this analysis (nothing here writes into the repository outside `.build/` and `packages/wasm/generated/`) and was left untouched.

## 2. Section-level breakdown (pinned artifact, 24,404,191 B)

| section | bytes (incl. header) | share | notes |
|---|---:|---:|---|
| code | 14,938,877 | 61.21 % | 27,923 functions; bodies 14,938,869 B; largest 119,299 / 97,486 / 52,080 / 51,481 / 46,770 B; median body 159 B |
| data | 9,397,255 | 38.51 % | 2 active segments: `data[0]` 9,334,552 B at memory 0x100000 (`.rodata`), `data[1]` 62,676 B at 10,383,136 (`.data`, mutable statics). No `.bss` bytes in the file |
| element | 29,834 | 0.12 % | one funcref table segment with 11,486 indirect-call targets |
| function | 29,171 | 0.12 % | type indices of the 27,923 functions |
| import | 4,078 | 0.02 % | 76 imports (wasm-bindgen glue) |
| type | 3,036 | 0.01 % | 328 signatures |
| export | 1,542 | 0.01 % | 50 exports |
| custom `name` | 302 | – | module/import names only; **function names are stripped** |
| custom `producers` | 62 | – | |
| table/memory/global/header | 34 | – | |

Compressed: gzip -9 = 8,951,728 B (code section alone 4,899,748; data section alone 4,008,488); brotli q11 = 6,522,576 B
(code 3,203,310; data 3,282,707). The data section is 38.5 % of the raw size but ~45 % of the gzip size and ~50 % of the brotli size, because
roughly 2 MB of it (hyphenation tries, the pre-compressed syntax dump, fonts) is nearly incompressible, while the CSL archive compresses 10–50×.

The wasm-ld `name` section is absent because Cargo's release profile defaults to `strip = "debuginfo"` when `debug = 0`; rustc then passes
`--strip-debug` to `rust-lld`, which drops the wasm name section. The build script does not set `CARGO_PROFILE_RELEASE_STRIP`. The
named-LTO build (`strip = none`) is otherwise the same configuration and carries a 2,438,545 B name section; wasm-bindgen keeps it.

Named-LTO vs pinned (how well the attribution build matches): code 14,866,164 B / 27,999 functions vs 14,938,872 B / 27,923 functions
(−0.49 %); data 9,397,154 vs 9,397,250 B (−96 B); 54 vs 50 exports, 2 vs 1 tables. Close but not byte-identical, so per-crate code
figures from it are accurate to about ±0.5 %.

## 3. Function-level attribution (named-LTO build; the pinned artifact itself has no function names)

### 3.1 Top 35 functions

| # | bytes | function (demangled) |
|---:|---:|---|
| 1 | 119,300 | `typst_library::visualize::color::map` — the 11 built-in gradient presets (`color.map.turbo`, `viridis`, …) as float constants; separate 26.5 KB functions in the non-LTO build, merged by LTO |
| 2 | 97,487 | `wasmi::engine::executor::instrs::execute_instrs` — the plugin interpreter loop |
| 3 | 52,081 | `<wasmi_ir::enum::Op as core::fmt::Debug>::fmt` |
| 4 | 51,482 | `regex_automata::meta::strategy::new` |
| 5 | 46,770 | `typst_pdf::convert::handle_frame` |
| 6 | 44,622 | `typst_pdf::convert::convert` |
| 7 | 43,746 | `krilla::serialize::SerializeContext::serialize_fonts` |
| 8 | 38,128 | `<citationberg::… Deserialize for LayoutRenderingElement>::deserialize::__Visitor …` |
| 9 | 35,107 | `hayro_syntax::object::stream::Stream::decoded_image` |
| 10 | 34,511 | `typst_library::visualize::image::raster::RasterImage::new_impl::{{closure}}` |
| 11 | 34,043 | `hayro_jbig2::decode::symbol::decode` |
| 12 | 33,258 | `<&mut ciborium::de::Deserializer<R> as Deserializer>::deserialize_map` (hayagriva CSL archive) |
| 13 | 32,310 | `krilla::serialize::SerializeContext::finish` |
| 14 | 31,310 | `serde_yaml::de::DeserializerFromEvents::visit_mapping` |
| 15 | 31,037 | `<hayagriva::Library as Deserialize>::… visit_map::EntrySeed …` |
| 16 | 30,755 | `hayagriva::csl::BibliographyDriver<T>::finish` |
| 17 | 30,378 | `typst_library::visualize::image::<impl Packed<ImageElem>>::…` |
| 18 | 29,810 | `<&mut wasmi_ir::enum::Op as ResultsVisitor>::host_visitor` |
| 19 | 29,801 | `skrifa::outline::glyf::hint::engine::…::Engine::run` (TrueType hinting interpreter) |
| 20 | 28,650 | `<citationberg::… Deserialize for NamesChild>::… __Visitor …` |
| 21 | 26,955 | `hayagriva::interop::<impl TryFrom<&biblatex::Entry> for hayagriva::Entry>::try_from` |
| 22 | 26,816 | `<&mut ciborium::de::Deserializer<R> …>::deserialize_map` |
| 23 | 26,591 | `krilla::chunk_container::ChunkContainer::finish` |
| 24 | 26,452 | `<&mut ciborium::de::Deserializer<R> …>::deserialize_seq` |
| 25 | 25,513 | `hayro_svg::convert` (PDF page → SVG, used by typst-svg's `pdf_to_svg`) |
| 26–27 | 24,766 ×2 | `<wasmparser::…::Operator as Debug>::fmt` (two copies) |
| 28 | 23,559 | `<&mut ciborium::de::Deserializer<R> …>::deserialize_map` |
| 29 | 22,676 | `regex_automata::dfa::dense::Builder::build_from_nfa` |
| 30 | 22,516 | `hayro_jbig2::decode::text::decode_with` |
| 31 | 22,334 | `<&mut ciborium::de::Deserializer<R> …>::deserialize_map` |
| 32 | 22,331 | `krilla::interchange::tagging::Node::serialize` |
| 33 | 21,906 | `<&mut ciborium::de::Deserializer<R> …>::deserialize_map` |
| 34 | 21,861 | `resvg::filter::apply_inner` |
| 35 | 21,718 | `hayro_write::extract` |

Full list: `analysis/named/twiggy-top200.txt`; all 28,525 items as JSON: `analysis/named/twiggy-top-all.json`.
The pinned artifact's own `twiggy top` (`analysis/pinned/twiggy-top200.txt`) shows the same sizes anonymously (`code[1]` 119,300, `code[0]` 97,487, …).

### 3.2 Per-crate code (named-LTO build; crate = first path component of the demangled name)

Caveat: Rust's legacy symbol mangling (used for wasm here) carries no generic arguments, so `core::ptr::drop_in_place`,
`core::ops::function::FnOnce::call_once` (closure bodies), `core::slice::sort::*`, `alloc::collections::btree::*`, `hashbrown::*` and
`<T as Trait>::method` instantiations cannot be attributed to the crate that instantiated them by name. They are ~2.9 MB here
(`core` 1.62 MB — of which `core::ops::function` 718 KB and `core::slice::sort` 414 KB —, `alloc` 0.40 MB, `hashbrown` 0.31 MB,
`T` 0.27 MB). The non-LTO linker map (section 4) charges those instantiations to the object file that emitted them, i.e. to the real crate.
Conversely, trait-impl instantiations such as `<&mut ciborium::de::Deserializer<R> as Deserializer>::deserialize_map` are charged
to the implementing crate (`ciborium`) although they are monomorphised for hayagriva's CSL types.

| # | crate (name prefix) | code bytes | % of code | functions |
|---:|---|---:|---:|---:|
| 1 | typst_library | 2,252,929 | 15.16 | 3,841 |
| 2 | core (generic instantiations, closures, sorts) | 1,622,892 | 10.92 | 6,943 |
| 3 | serde_path_to_error (citationberg's CSL deserialisation wrapper; generic over citationberg types) | 590,457 | 3.97 | 443 |
| 4 | wasmi | 483,878 | 3.26 | 2,360 |
| 5 | wasmparser | 395,797 | 2.66 | 598 |
| 6 | alloc | 395,553 | 2.66 | 1,840 |
| 7 | typst_layout | 373,730 | 2.51 | 226 |
| 8 | tiny_skia | 359,524 | 2.42 | 260 |
| 9 | read_fonts | 345,662 | 2.33 | 422 |
| 10 | krilla | 337,754 | 2.27 | 231 |
| 11 | regex_automata | 321,691 | 2.16 | 382 |
| 12 | skrifa | 319,162 | 2.15 | 402 |
| 13 | hashbrown | 305,131 | 2.05 | 327 |
| 14 | citationberg | 284,072 | 1.91 | 329 |
| 15 | hayro_interpret | 281,465 | 1.89 | 174 |
| 16 | T (`<T as Trait>` generics) | 273,614 | 1.84 | 1,523 |
| 17 | hayagriva | 266,234 | 1.79 | 233 |
| 18 | ciborium (hayagriva CSL archive decoding) | 253,879 | 1.71 | 32 |
| 19 | hayro_syntax | 250,210 | 1.68 | 271 |
| 20 | usvg | 216,489 | 1.46 | 225 |
| 21 | zune_jpeg | 201,928 | 1.36 | 101 |
| 22 | typst_pdf | 194,772 | 1.31 | 96 |
| 23 | hayro_jbig2 | 190,125 | 1.28 | 48 |
| 24 | serde | 177,305 | 1.19 | 177 |
| 25 | rustybuzz | 172,254 | 1.16 | 148 |
| 26 | image_webp | 170,786 | 1.15 | 115 |
| 27 | typst_eval | 147,602 | 0.99 | 86 |
| 28 | ttf_parser | 144,355 | 0.97 | 189 |
| 29 | serde_yaml | 140,090 | 0.94 | 147 |
| 30 | moxcms | 136,709 | 0.92 | 145 |
| 31 | std | 131,644 | 0.89 | 314 |
| 32 | regex_syntax | 113,810 | 0.77 | 146 |
| 33 | comemo | 113,217 | 0.76 | 180 |
| 34 | typst_syntax | 112,652 | 0.76 | 214 |
| 35 | wasmi_ir | 103,809 | 0.70 | 463 |
| 36 | toml_edit | 85,459 | 0.57 | 142 |
| 37 | time | 84,582 | 0.57 | 54 |
| 38 | biblatex | 84,300 | 0.57 | 83 |
| 39 | typst_html | 80,920 | 0.54 | 108 |
| 40 | serde_core | 80,863 | 0.54 | 174 |
| 41 | yaml_rust | 72,858 | 0.49 | 50 |
| 42 | syntect | 70,742 | 0.48 | 59 |
| 43 | hayro_jpeg2000 | 64,439 | 0.43 | 42 |
| 44 | image | 63,118 | 0.42 | 68 |
| 45 | quick_xml | 62,750 | 0.42 | 172 |

Further rows (`analysis/named/by-crate.txt`): png 58 KB, write_fonts 57 KB, smallvec 56 KB, unsafe_libyaml 55 KB, subsetter 55 KB,
resvg 55 KB, fancy_regex 54 KB, hayro_svg 52 KB, roxmltree 46 KB, ecow 46 KB, hayro_ccitt 45 KB, glidesort 43 KB, plist 42 KB,
pxfm 40 KB, winnow 40 KB, rust_decimal 34 KB, zlib_rs 34 KB, **typst_ts_web_compiler 33 KB**, tiny_skia_path 33 KB,
typst_realize 33 KB, url 32 KB, pdf_writer 31 KB, hayro_write 30 KB, **tinymist_* 27 KB total**, compiler_builtins 25 KB,
icu_collator 24 KB, krilla_svg 20 KB, fearless_simd 19 KB, icu_segmenter 18 KB, fontdb 18 KB, gif 13 KB, **hypher 5 KB**,
**reflexo_* 1.4 KB**, **typst_render 0**, **typst_svg ≈ 0** (its `pdf_to_svg` was inlined into a reflexo-typst2vec closure; see 6),
**reflexo_vec2svg 0**, **lsp_types 0**, **tokio 0**, **notify 0**, **two_face ≈ 0** (data only).

### 3.3 Per-family code (named-LTO build; total 14,864,451 B of named code items)

| family | code bytes | % | largest members |
|---|---:|---:|---|
| typst core (library/layout/eval/realize/syntax/utils/comemo/time/decimal) | 3,292,555 | 22.2 | typst_library 2200K, typst_layout 365K, typst_eval 144K, comemo 111K, typst_syntax 110K, time 83K |
| Rust std/core/alloc + hashbrown/smallvec (generic instantiations, see caveat) | 2,547,503 | 17.1 | core 1585K, alloc 386K, hashbrown 298K, std 129K, smallvec 55K |
| bibliography: hayagriva/citationberg/biblatex/ciborium/serde_path_to_error/quick_xml/icu_collator/url | 1,647,240 | 11.1 | serde_path_to_error 577K, citationberg 277K, hayagriva 260K, ciborium 248K, biblatex 82K, quick_xml 61K |
| PDF export: typst-pdf + krilla + font stack (skrifa/read-fonts/write-fonts/subsetter/pdf-writer) | 1,482,799 | 10.0 | read_fonts 338K, krilla 330K, skrifa 312K, typst_pdf 190K, write_fonts 56K, subsetter 53K |
| PDF-as-image: hayro-* + moxcms + pxfm (+ hayro-write) | 1,131,039 | 7.6 | hayro_interpret 275K, hayro_syntax 244K, hayro_jbig2 186K, moxcms 134K, hayro_jpeg2000 63K, hayro_svg 51K |
| Typst plugins: wasmi + wasmparser | 1,022,001 | 6.9 | wasmi 473K, wasmparser 387K, wasmi_ir 101K, wasmi_core 32K |
| syntax highlighting + regex: syntect/two-face/fancy-regex/plist/yaml + regex (regex also backs Typst's `regex` type) | 962,346 | 6.5 | regex_automata 314K, serde_yaml 137K, regex_syntax 111K, yaml_rust 71K, syntect 69K, aho_corasick 60K |
| SVG: usvg/resvg/tiny-skia/roxmltree | 801,187 | 5.4 | tiny_skia 351K, usvg 211K, resvg 53K, roxmltree 45K, tiny_skia_path 32K, svgtypes 28K |
| raster decoders: zune-jpeg/image-webp/image/png/gif | 531,257 | 3.6 | zune_jpeg 197K, image_webp 167K, image 62K, png 57K, gif 13K |
| text shaping: rustybuzz/ttf-parser/unicode-* | 358,589 | 2.4 | rustybuzz 168K, ttf_parser 141K, unicode_bidi 19K, unicode_segmentation 17K |
| other / unclassified (`<T as …>` generics, exif, `str`/`i64`/`f64` impls) | 349,318 | 2.4 | T 267K, exif 24K, str 22K |
| typst.ts / tinymist glue + formats they drag in (toml_edit is also Typst's `toml()`) | 310,855 | 2.1 | toml_edit 83K, glidesort 42K, winnow 39K, typst_ts_web_compiler 32K, rpds 18K, indexmap 17K |
| serde core + JSON | 276,743 | 1.9 | serde 173K, serde_core 79K, serde_json 15K |
| typst HTML export | 81,349 | 0.5 | typst_html 79K |
| ICU segmenter/properties/provider | 33,000 | 0.2 | icu_segmenter 17K |
| wasm-bindgen / js-sys / web-sys | 31,902 | 0.2 | serde_wasm_bindgen 15K, js_sys 10K |
| hyphenation (hypher code; its data is in section 5) | 4,768 | 0.0 | |

(`glidesort` is used by typst-library, `time`/`rust_decimal` by Typst's datetime/decimal types; family membership is a judgement call,
the per-crate table is the primary data.)

## 4. Per-crate code + data from the non-LTO linker map (`analysis/link-map-by-crate.txt`, `.json`)

Build: 39,273,458 B total; CODE 19,286,079 B (74,410 functions), DATA 9,881,846 B (`.rodata` 9,819,056 + `.data` 62,768; `.bss` 20,980
not in file), name section 8.0 MB, DWARF line tables 1.5 MB. Sum of CODE input chunks 19,286,076 B, DATA chunks 9,869,371 B.
Compared with the shipped binary (code 14.94 MB, data 9.40 MB) the code is 29 % larger (no cross-crate inlining/DCE, 16 CGUs);
data is 5 % larger. Use the proportions; the embedded blobs are exact.

| # | crate (rlib) | code | data | total | % of code+data |
|---:|---|---:|---:|---:|---:|
| 1 | typst_library | 4,543,633 | 1,030,767 | 5,574,400 | 19.12 |
| 2 | hayagriva | 1,040,188 | 2,864,395 | 3,904,583 | 13.39 |
| 3 | citationberg | 1,280,706 | 16,260 | 1,296,966 | 4.45 |
| 4 | hypher | 7,726 | 1,167,032 | 1,174,758 | 4.03 |
| 5 | icu_collator (incl. baked icu_collator_data) | 65,026 | 1,093,762 | 1,158,788 | 3.97 |
| 6 | wasmi | 959,119 | 55,391 | 1,014,510 | 3.48 |
| 7 | two_face | 7,520 | 920,980 | 928,500 | 3.18 |
| 8 | typst_layout | 773,209 | 61,697 | 834,906 | 2.86 |
| 9 | hayro_interpret | 511,576 | 265,929 | 777,505 | 2.67 |
| 10 | krilla | 689,913 | 30,598 | 720,511 | 2.47 |
| 11 | skrifa | 548,205 | 44,540 | 592,745 | 2.03 |
| 12 | regex_syntax | 185,091 | 361,937 | 547,028 | 1.88 |
| 13 | regex_automata | 442,432 | 31,399 | 473,831 | 1.63 |
| 14 | wasmparser | 399,693 | 49,344 | 449,037 | 1.54 |
| 15 | tiny_skia | 409,805 | 7,410 | 417,215 | 1.43 |
| 16 | usvg | 395,131 | 20,755 | 415,886 | 1.43 |
| 17 | hayro_syntax | 393,543 | 20,078 | 413,621 | 1.42 |
| 18 | rustybuzz | 261,928 | 107,012 | 368,940 | 1.27 |
| 19 | typst_eval | 345,549 | 12,283 | 357,832 | 1.23 |
| 20 | icu_segmenter (incl. baked icu_segmenter_data) | 24,993 | 332,644 | 357,637 | 1.23 |
| 21 | typst_html | 273,252 | 60,234 | 333,486 | 1.14 |
| 22 | typst_pdf | 303,977 | 16,690 | 320,667 | 1.10 |
| 23 | typst_svg | 19,499 | 266,380 | 285,879 | 0.98 |
| 24 | hayro_jbig2 | 266,039 | 10,787 | 276,826 | 0.95 |
| 25 | resvg | 238,686 | 22,064 | 260,750 | 0.89 |
| 26 | moxcms | 250,480 | 7,345 | 257,825 | 0.88 |
| 27 | read_fonts | 221,566 | 19,637 | 241,203 | 0.83 |
| 28 | toml_edit | 212,176 | 8,213 | 220,389 | 0.76 |
| 29 | write_fonts | 204,564 | 8,709 | 213,273 | 0.73 |
| 30 | hayro_jpeg2000 | 200,277 | 7,063 | 207,340 | 0.71 |
| 31 | syntect | 196,420 | 8,647 | 205,067 | 0.70 |
| 32 | typst_syntax | 176,804 | 20,591 | 197,395 | 0.68 |
| 33 | hayro_svg | 189,982 | 7,344 | 197,326 | 0.68 |
| 34 | typst_ts_web_compiler | 188,259 | 6,266 | 194,525 | 0.67 |
| 35 | subsetter | 182,865 | 1,966 | 184,831 | 0.63 |
| 36 | biblatex | 157,746 | 7,412 | 165,158 | 0.57 |
| 37 | ttf_parser | 155,083 | 810 | 155,893 | 0.53 |
| 38 | image | 121,747 | 19,329 | 141,076 | 0.48 |
| 39 | `<internal>` (wasm-ld merged string literals, all crates) | 0 | 127,869 | 127,869 | 0.44 |
| 40 | core | 72,416 | 52,564 | 124,980 | 0.43 |
| 41 | aho_corasick | 107,270 | 9,785 | 117,055 | 0.40 |
| 42 | unicode_normalization | 1,635 | 111,340 | 112,975 | 0.39 |
| 43 | yaml_rust | 98,947 | 5,788 | 104,735 | 0.36 |
| 44 | pxfm | 42,915 | 61,048 | 103,963 | 0.36 |
| 45 | fancy_regex | 92,583 | 7,133 | 99,716 | 0.34 |

Then: zlib_rs 96K, pdf_writer 92K, icu_normalizer 89K (18K code + 70K baked data), js_sys 88K, image_webp 82K, wasmi_core 75K, png 74K,
unsafe_libyaml 72K, tinymist_world 61K, roxmltree 61K, hayro_write 54K, svgtypes 53K, tiny_skia_path 49K, typst_realize 49K,
unicode_segmentation 48K, serde_yaml 48K, rust_decimal 47K, quick_xml 44K, kurbo 42K, gif 42K, unicode_properties 41K, url 40K,
std 37K, idna 36K, idna_adapter 35K (UTS-46 tables), zune_jpeg 35K, krilla_svg 34K, imagesize 33K, unicode_bidi 33K, libm 32K, …
The `icu_*_data` crates do not appear as rlibs: their baked statics are instantiated inside the consumer crate (`icu_collator`, `icu_segmenter`, `icu_normalizer`, `icu_properties`).

Per family (non-LTO, code+data, total 29,155,447 B): typst core 7.25 MB (24.9 %); bibliography 6.83 MB (23.4 %: hayagriva 3.81 MB,
citationberg 1.27 MB, icu_collator 1.13 MB); PDF export 2.63 MB (9.0 %); highlighting+regex 2.62 MB (9.0 %); hayro 2.31 MB (7.9 %);
plugins 1.55 MB (5.3 %); SVG 1.35 MB (4.6 %); hypher 1.17 MB (4.0 %); shaping+Unicode 0.82 MB (2.8 %); typst.ts/tinymist glue 0.65 MB (2.2 %);
typst HTML/SVG exporters 0.62 MB (2.1 %); raster decoders 0.42 MB (1.4 %); ICU segmenter/properties 0.38 MB (1.3 %); std 0.21 MB; other 0.15 MB;
wasm-bindgen 0.12 MB; serde+JSON 0.07 MB. (`analysis/link-map-by-family.md`.)

Noteworthy in the map but **gone after LTO** (0 B in 3.2): typst_render (pulled by tinymist-task/typst-bundle), reflexo-vec2svg, lsp-types,
tokio, notify, tar, almost all of typst_svg and reflexo-*; typst_ts_web_compiler shrinks from 188 KB to 33 KB and tinymist_* from ~150 KB to 27 KB.
The typst.ts glue is therefore cheap in the shipped binary; what it costs is indirect (section 6).

A second per-crate code view of the non-LTO wasm with twiggy (`analysis/nonlto/by-crate.txt`) agrees on ordering (typst_library 2.59 MB
of named code, core 2.16 MB, alloc 1.12 MB, wasmi 0.58 MB, read_fonts 0.56 MB, wasmparser 0.53 MB, serde_path_to_error 0.53 MB, …) and
shows the name-based view's blind spot: `core`+`alloc` 3.3 MB there vs 0.13 MB in the map, i.e. ~3 MB of generic instantiations that the
map correctly charges to typst_library (4.5 MB code in the map vs 2.6 MB named) and friends.

## 5. Data section attribution (pinned artifact, 9,397,228 B of segment payload)

### 5.1 Method and confidence

1. **Exact file matching** (`scripts/data-blobs.py`): every non-source file ≥ 1 KiB under the cargo registry/git checkouts and the upstream
   workspace was searched verbatim in the WASM (first 256 bytes, then full compare). A hit is an `include_bytes!` blob that survived — exact.
2. **Signature scan** of the remaining bytes: zlib/gzip streams (none ≥ 2 KiB found: the two-face dump is a flate stream but was already matched
   as a file), ICC profiles (`acsp` at +36), image/font magic, printable-text runs, zero runs.
3. **Byte-matching non-LTO data chunks** (`scripts/data-crosscheck.py`): every DATA input chunk ≥ 256 B of the linker map (which knows the crate)
   was looked up byte-for-byte in the pinned data section. Exact for pointer-free data (baked ICU tables, Unicode tables, strings, fonts);
   a lower bound for pointer-bearing tables (absolute addresses differ between the two builds). 7,930,577 B (84 %) of the pinned data were
   attributed this way; the result agrees with step 1 wherever both apply.

### 5.2 Identified blobs (exact, from step 1 and 2)

| blob | bytes in pinned data | gzip -9 | brotli 11 | source / why it is there |
|---|---:|---:|---:|---|
| hayagriva CSL **styles** archive, 79 distinct `.cbor` (91 files on disk, 12 are byte-identical duplicates merged by LLVM) | 1,712,581 | 150,533 | 59,166 | `hayagriva/archive/styles/*.cbor`, feature `archive` (default), used by typst-library `bibliography(style: …)` |
| hayagriva CSL **locales**, 63 distinct `.cbor` (64 on disk) | 1,103,049 | 133,627 | 78,015 | `hayagriva/archive/locales/*.cbor` |
| hypher hyphenation tries, 35 matched files + 13 files < 1 KiB not searched (3,743 B) = all 48 languages, 1,166,722 B on disk; cross-check confirms 1,164,508 B | 1,162,979 | 856,596 | 782,099 | `hypher/tries/*.bin` (hu 353,883; de 206,263; no 156,375; nl 64,293; af 61,243; cs 40,726; ru 33,344; en 26,947; sv 23,595; uk 21,312; is 21,074; et 18,774; pl 15,530; es 13,649; sk 13,069; bg 12,328; sr 12,313; ka 11,192; …), typst-layout hyphenation; hypher's `full` feature (default) enables every language |
| two-face `syntaxes-fancy-no-newlines.bin` (pre-built, flate-compressed syntect syntax set; the other 3 dumps are not linked) | 920,515 | 832,186 | 799,126 | typst-library `raw` highlighting, two-face feature `syntect-fancy` |
| Foxit standard-14 PDF fonts (14 `.pfb`) | 264,741 | 233,632 | 213,522 | `typst-assets/files/fonts/Foxit*.pfb`, referenced by typst-svg's `pdf_to_svg` (and typst-render) as hayro's standard-font fallback; linked because reflexo-typst2vec calls `typst_svg::pdf_to_svg` (section 6) |
| lipsum `liber-primus.txt` | 49,068 | 19,548 | 18,299 | typst-library `lorem()` |
| `icu_cj_segment.postcard` | 30,135 | 7,800 | 6,891 | typst-assets, typst-layout CJ line breaking (icu_provider_blob) |
| ICC `CMYK-to-XYZ.icc` + 6 small ICC profiles (sRGB/Gray/Lab, 360–736 B each, krilla + typst-assets) | 8,464 + 3,172 | 7,902 | 7,748 | colour management for PDF output |
| **sum of identified files** | **5,254,704** (55.9 %) | | | |

Not found in the binary: typst-assets fonts other than the Foxit PDF fonts (no `fonts` feature → no embedded text fonts), syntect's own
`default_*.packdump`/`default.themedump` (syntect `default-syntaxes`/`default-themes` off), two-face `themes.bin` and the three other
syntax dumps, any PNG/JPEG/TTF/OTF/WOFF2 blob.

### 5.3 The remaining 4,142,524 B, attributed by byte-matching non-LTO chunks (step 3)

| crate | non-LTO data (chunks ≥ 256 B) | found byte-identical in pinned | what it is |
|---|---:|---:|---|
| hayagriva | 2,831,280 | 2,817,584 | the CSL archive above (cross-check of 5.2) |
| hypher | 1,164,508 | 1,164,508 | tries (cross-check of 5.2) |
| **icu_collator** | 1,077,585 | **1,066,804** | baked `icu_collator_data` (root collation 394 KB of source + tailorings); only user: hayagriva's bibliography sorting (`<str as hayagriva::csl::sort::CollationOrd>::collation_cmp` ← `BibliographyDriver::finish` ← `typst_library::model::bibliography::Works::generate`) |
| two_face | 920,515 | 920,515 | syntax dump (cross-check) |
| **typst_library** | 560,072 | 446,800 (lower bound) | Typst docstrings (`#[func]`/`#[elem]` docs: 595 KB of printable text in the non-LTO build incl. lipsum 49 KB, e.g. "Raw text with optional syntax highlighting…", "Arranges content in a grid…"), element/function metadata tables, symbol tables (codex), CMYK ICC |
| **icu_segmenter** | 330,687 | **329,919** | baked LSTM line-break models (Thai/Lao/Khmer/Burmese: f32 weight matrices, 17,280 B each) + rule tables; present because typst-layout uses `LineSegmenter::new_lstm` |
| typst_svg | 265,064 | 264,741 | the Foxit fonts (cross-check) |
| **regex_syntax** | 299,400 | 207,384 (lower bound) | Unicode property/script/class tables for regex (Typst `regex` type and syntect's fancy-regex) |
| unicode_normalization | 111,276 | 111,276 | NFC/NFD tables (typst-library, biblatex) |
| icu_normalizer | 69,726 | 69,726 | baked normalizer data (icu_collator, idna via `url`) |
| rustybuzz | 81,535 | 63,363 | shaping machine tables |
| pxfm | 60,696 | 60,696 | log/exp/pow tables (moxcms colour maths) |
| core | 45,685 | 45,685 | float formatting, Unicode case tables |
| typst_layout | 46,387 | 45,391 | `icu_cj_segment.postcard` + small tables |
| unicode_segmentation | 42,624 | 42,624 | grapheme/word break tables |
| unicode_properties | 40,896 | 40,896 | |
| idna_adapter | 34,516 | 34,516 | UTS-46 mapping tables (the `url` crate, via hayagriva/citationberg) |
| unicode_script | 27,444 | 27,444 | |
| unicode_math_class | 21,888 | 21,888 | |
| unicode_bidi | 18,828 | 18,828 | |
| crc32fast / zlib_rs / zmij / ryu / unicode_ident / libm / serde_json / fdeflate | ≈ 80,000 | ≈ 74,000 | checksum and float tables |
| hayro_interpret | 188,372 | 16,032 (pointer-bearing; non-LTO shows 266 KB incl. 70,528 + 44,352 B name/encoding tables) | PDF glyph-name/encoding tables; undercounted here, present (hayro_interpret code is in the LTO build) |

Everything else (~1.4 MB) is pointer-bearing: vtables, `&'static str` slices and `&[T]` tables that embed addresses, wasm-ld's merged
string-literal pool (`<internal>` 127,869 B in the non-LTO build, holding short literals from every crate: panic messages, format strings,
web-sys/js-sys names, wasmi diagnostics), and the 62,676 B `.data` segment of mutable statics. A 2 KiB-window classification of the
unattributed bytes gives: ~604 KB text-like, ~332 KB pointer-table-like (≥ 30 % of words are data addresses), ~14 KB zero, ~3.2 MB other
binary (the ICU/Unicode/regex tables above are the bulk of this).

Compressibility (pinned data section, gzip -9 / brotli 11): whole data section 4,008,488 / 3,282,707. Of the 2.8 MB CSL archive only
284 KB / 137 KB survive compression, while the hyphenation tries (857 KB / 782 KB) and the already-compressed syntax dump (832 KB / 799 KB)
are nearly incompressible — these two 1.0 + 0.9 MB blobs are about 19 % of the gzip'd artifact and 24 % of the brotli'd artifact.
The unattributed remainder compresses to 1,757,502 / 1,301,343 B.

## 6. Dependency paths (`cargo +1.92.0 tree --locked --offline -p typst-ts-web-compiler --no-default-features --features web,pdf --target wasm32-unknown-unknown -e normal -i <crate>`; raw output in `analysis/tree/`, feature-edge output in `analysis/tree/features-*.txt`, notes in `analysis/dependency-notes.md`)

Direct dependencies of `typst-ts-web-compiler` (`packages/compiler/Cargo.toml`): `reflexo-typst` (features `web`), `reflexo-typst2vec`,
`reflexo-vec2svg` (**unconditional**, although only used under `cfg(feature = "svg")` and in tests), `typst`, wasm-bindgen/js-sys/web-sys,
serde(-wasm-bindgen/json), base64, comemo, ansi-to-html, console_error_panic_hook; `typst-assets` only with the `fonts` feature (off).
Features: `web` = `reflexo-typst/web` → `web-render` + `browser-compile` → `glyph2vec`, `tinymist-world/browser`+`web`; `pdf` = `reflexo-typst/pdf` = `tinymist-task/pdf`.
`svg`, `incr`, `ast`, `semantic_tokens`, `fonts` are off. The compiler does expose `compile(kind=1)` = HTML compilation (`do_compile_html`), so `typst-html` is live code.

| crate | pulled in by | class |
|---|---|---|
| typst-pdf, krilla (features raster-images, comemo, rayon, **pdf**=hayro-write), krilla-svg, subsetter, write-fonts, read-fonts, skrifa, pdf-writer, xmp-writer | tinymist-task (unconditional dep) and typst-bundle ← tinymist-world; reflexo-typst's own `typst-pdf` is optional | **(a) required for PDF output** |
| usvg (features `text`), resvg (`raster-images`), tiny-skia, tiny-skia-path, fontdb, roxmltree, svgtypes, simplecss | krilla-svg ← typst-pdf (SVG images are converted/filters rasterised into the PDF); usvg also directly by typst-library (`image("x.svg")`); tiny-skia also by reflexo-typst2vec and typst-render | **(a)**; usvg/resvg/tiny-skia stay as long as SVG images in PDFs are supported |
| image (png, jpeg, gif, webp), png, zune-jpeg, gif, image-webp, imagesize, color_quant, weezl | typst-library (raster images), krilla `raster-images`, hayro, resvg, reflexo-typst2vec | **(a)** |
| hayro-syntax (+ hayro-jbig2, hayro-jpeg2000, hayro-ccitt, hayro-cmap, hayro-postscript), hayro-write | typst-library (`image("x.pdf")` decoding; `Stream::decoded_image` is the 9th largest function), krilla `pdf` feature (embedding PDF pages) | **(a)/(c)**: needed for PDF images in PDF output; no upstream feature flag |
| **hayro (hayro-interpret, hayro-svg), vello_cpu, vello_common, fearless_simd, moxcms, pxfm, Foxit fonts** | typst-render (DCE'd) and **typst-svg `pdf_to_svg`**, which reflexo-typst2vec calls in `convert.rs` (`ImageKind::Pdf(pdf) => pdf_to_svg(pdf)`); typst-svg itself comes from reflexo-typst2vec, tinymist-task, typst-bundle and typst-html. twiggy `paths` on the LTO build: `hayro_svg::convert ← FnOnce::call_once (reflexo-typst2vec closure) ← elem[0] (indirect-call table)`; `hayro_interpret::interpret::interpret ← … ← hayro_svg::convert`; `moxcms::profile::ColorProfile::new_from_slice ← hayro_interpret::color::Lab::new ← … ← hayro_svg::convert` | **(b) only reached through typst.ts's vector export path**; a dedicated binding without reflexo-typst2vec would drop it |
| typst-html | `typst` umbrella crate (non-optional), typst-bundle, tinymist-std (`typst` feature), tinymist-task, reflexo-typst2vec (uses `typst_html::{HtmlElement, HtmlNode}`); also live via the compiler's `compile(kind=1)` | (b)/(c): linked regardless (umbrella crate), DCE removes it only if nothing calls HTML compilation |
| typst-render, pixglyph | tinymist-task and typst-bundle (unconditional) | (b), but **already 0 B after LTO** |
| reflexo-vec2svg, reflexo-typst2vec | direct deps of the compiler crate; reflexo-typst2vec also via reflexo-typst | (b); vec2svg is 0 B after LTO, typst2vec survives only as inlined closures (the `pdf_to_svg` path above) |
| tokio (`macros,sync`), notify, tar, lsp-types (`proposed`), rkyv, rayon | tinymist-project/tinymist-task (tokio, notify), reflexo-typst/tinymist-world/tinymist-package (tar), tinymist-std/tinymist-world (lsp-types), reflexo `flat-vector` (rkyv), everywhere (rayon) | (b) in the graph, **≈ 0 B after LTO** (tokio/notify/lsp-types 0; tinymist_* 27 KB) |
| syntect (features parsing, regex-fancy, plist-load, yaml-load), two-face (`syntect-fancy`), fancy-regex, plist, yaml-rust, bincode, serde_yaml | typst-library `raw` (custom `.sublime-syntax`/`.tmTheme` support explains plist/yaml-load) | **(c) interpreter, upstream only** |
| regex, regex-automata, regex-syntax, aho-corasick | typst-library `regex` type; fancy-regex | (c) |
| hayagriva (`archive`), citationberg (+ quick-xml, serde_path_to_error), biblatex, ciborium, unic-langid, icu_collator (+icu_collator_data), icu_locale, icu_normalizer, url/idna | typst-library `bibliography`/`cite`; icu_collator **only** via hayagriva | **(c) upstream only** |
| hypher (all 48 languages via `full`) | typst-layout | (c) upstream only (hypher has per-language features; typst enables the default `full`) |
| icu_segmenter (default: `compiled_data`, `auto`/`lstm`) + icu_segmenter_data, icu_provider_blob, icu_properties (+data), icu_collections, zerovec, zerotrie | typst-layout `LineSegmenter::new_lstm` and the CJ blob provider; icu_properties also typst-library and icu_collator/idna | (c) |
| wasmi (`simd`), wasmi_ir/core/collections, wasmparser | typst-library `plugin()` | (c) upstream only |
| codex (+ chinese-number), lipsum, csv, toml/toml_edit/winnow, time, rust_decimal, glidesort | typst-library/typst-eval/typst-syntax | (c) |
| unicode-bidi, unicode-script, unicode-segmentation, unicode-normalization, unicode-math-class, rustybuzz, ttf-parser | typst-layout/typst-library (shaping), usvg, rustybuzz, biblatex | (a)/(c) |

Classification summary: (a) required for PDF output: typst core, typst-pdf + krilla stack, usvg/resvg/tiny-skia, raster decoders, shaping,
hayro-syntax (+jbig2/jpeg2000/ccitt) and hayro-write (PDF images). (b) typst.ts/reflexo-only: hayro-interpret/hayro-svg/moxcms/pxfm/Foxit fonts
(via `pdf_to_svg`), typst-html's HTML compile path, the small glue; typst-render/vec2svg/tokio/notify/lsp-types/tar are in the graph but already
eliminated by LTO. (c) reachable from the interpreter regardless of binding: bibliography stack incl. icu_collator, highlighting + two-face dump,
hyphenation data, ICU LSTM segmenter data, wasmi plugins, codex/lipsum, docstrings — removable only with upstream feature flags or patches
(typst 0.15 has none of these behind features).

## 7. What is plausibly removable, and roughly how much (pinned raw size 24,404,191 B; code from the named-LTO build, data byte-matched)

| item | raw bytes (code + data) | ≈ share | gzip effect | how | confidence |
|---|---:|---:|---|---|---|
| Bibliography stack: hayagriva + citationberg + biblatex + ciborium + serde_path_to_error + quick_xml + url/idna (1.65 MB code) + CSL archive 2.82 MB + icu_collator data 1.07 MB + icu_normalizer data 0.07 MB (shared with idna) | ≈ 5.6 MB | ≈ 23 % | archive compresses to ~0.28 MB gzip; collator/normalizer tables and code maybe ~1 MB → ≈ 1.2–1.5 MB gzip saving (estimate) | upstream patch (no feature flag in typst-library); a smaller first step is dropping `icu_collator` sorting or the `archive` feature (styles would have to be supplied by the application) | high on attribution (byte-matched), medium on compressed saving |
| Plugins: wasmi + wasmparser (+wasmi_ir/core) | ≈ 1.02 MB code + ~0.05 MB data | ≈ 4.4 % | mostly code, compresses ~3× → ≈ 0.35 MB gzip | upstream patch (typst-library `plugin`) | high |
| Hyphenation tries, all 48 languages | 1,166,722 B data | 4.8 % | **≈ 0.86 MB gzip / 0.78 MB brotli** (incompressible) — the single largest compressed-size lever | hypher has one feature per language; a patched typst-layout dependency on `hypher` with only the needed languages keeps the feature set small (hu alone is 354 KB, de 206 KB, no 156 KB) | high |
| Syntax highlighting: two-face dump 920,515 B data + syntect/fancy-regex/plist/yaml-rust/unsafe-libyaml/bincode ≈ 0.30–0.35 MB code (regex_automata 314 KB + regex_syntax tables stay for Typst's `regex` type) | ≈ 1.25 MB | ≈ 5 % | dump is ≈ 0.83 MB gzip (incompressible) → ≈ 0.9–1.0 MB gzip | upstream patch (typst-library `raw` highlighting) | high for the dump, medium for the code split |
| PDF-as-image rasteriser reached only via typst.ts: hayro_interpret 275 KB + hayro_svg 51 KB + moxcms 134 KB + pxfm 40 KB code, + Foxit fonts 265 KB + hayro_interpret tables ~0.19–0.27 MB + pxfm tables 61 KB | ≈ 1.0 MB | ≈ 4 % | ≈ 0.5 MB gzip (fonts 234 KB alone) | **dedicated minimal binding** that does not link reflexo-typst2vec (its `pdf_to_svg` closure is the only retaining path); hayro-syntax/jbig2/jpeg2000/ccitt (~0.55 MB code) stay for `image("x.pdf")` and krilla's PDF embedding | medium (the retaining path is confirmed by twiggy; whether nothing else re-pins hayro_interpret after removal is an expectation) |
| Typst docstrings and function metadata text (`NativeFuncData.docs`) | ≈ 0.45–0.6 MB data | ≈ 2 % | ≈ 0.15–0.2 MB gzip | upstream patch (no feature flag) | medium (595 KB of printable text in typst_library's non-LTO data incl. 49 KB lipsum; 447 KB matched in pinned) |
| ICU LSTM line-break models | ≈ 325 KB data | 1.3 % | ≈ 0.25 MB gzip (float weights) | upstream: `LineSegmenter::new_dictionary`/non-complex instead of `new_lstm` would change Thai/Lao/Khmer/Burmese breaking | medium-high |
| HTML export path (typst_html 81 KB code + ~60 KB data) | ≈ 0.14 MB | 0.6 % | small | dedicated binding without `compile(kind=1)` | low-medium |
| lipsum text | 49 KB | 0.2 % | 20 KB gzip | upstream | high |
| typst.ts/tinymist glue proper (typst_ts_web_compiler 33 KB + tinymist 27 KB + reflexo 1 KB) | ≈ 0.06 MB | 0.3 % | negligible | dedicated binding | high — i.e. the glue itself is **not** where the size goes; a dedicated binding pays off only through the hayro/HTML items above |
| wasm-opt / further stripping | – | – | function names are already stripped (name section 294 B); docs say wasm-opt shrinks raw but grows gzip/brotli | – | – |
| Not removable while PDF output with images/SVG/fonts is the goal: typst core 3.3 MB, generic std/core/alloc instantiations 2.5 MB, krilla+font stack 1.5 MB, usvg/resvg/tiny-skia 0.8 MB, raster decoders 0.53 MB, shaping 0.36 MB, serde 0.28 MB, regex core 0.31 MB | ≈ 9.6 MB code + ~0.8 MB tables | ≈ 43 % | | | |

Rounded total for everything in rows 1–7 (all requiring upstream patches except row 5): ≈ 10 MB raw, ≈ 4–4.5 MB gzip of the 8.95 MB.
Rows reachable with a dedicated binding alone (5, 8, 10): ≈ 1.2 MB raw, ≈ 0.6 MB gzip — the repository's statement that a dedicated minimal
binding is not yet proven to be much smaller is consistent with these numbers; the big levers are inside Typst's own dependency choices.

## 8. Files

- Report: `/tmp/claude-0/-home-user-typfolio/1c0be84b-aa31-5442-982b-25bbb7e3e225/scratchpad/wasm-size-report.md` (this file)
- Pinned artifact copy + analysis: `analysis/pinned-compiler_bg.wasm`, `analysis/pinned/{sections.json,objdump.txt,twiggy-top200.txt,twiggy-top-all.json,by-crate.txt,data-blobs.txt,data-blobs.json}`
- Named-LTO build: `analysis/named/{compiler_bg.wasm,compiler.js,twiggy-top200.txt,twiggy-top-all.json,by-crate.txt,by-crate.json,by-family.txt,by-family.md,paths.txt}`
- Non-LTO map build: `analysis/link.map`, `analysis/link-map-by-crate.{txt,json}`, `analysis/link-map-by-family.{txt,md}`, `analysis/map-data-kinds.txt`, `analysis/nonlto/{sections.json,twiggy-top300.txt,twiggy-top-all.json,by-crate.txt}`
- Data cross-check: `analysis/data-crosscheck.{txt,json}`; dependency trees: `analysis/tree/*.txt`, `analysis/dependency-notes.md`; markdown tables: `analysis/report-tables.md`
- Scripts: `scripts/wasm-sections.mjs`, `scripts/twiggy-by-crate.py`, `scripts/by-family.py`, `scripts/data-blobs.py`, `scripts/parse-link-map.py`, `scripts/map-data-kinds.py`, `scripts/data-crosscheck.py`, `scripts/analysis-build.sh`, `scripts/named-lto-build.sh`, `scripts/analyze-pinned.sh`
- Logs: `logs/{npm-ci,setup-toolchain,install-analysis-tools,build-wasm,analysis-build,named-lto-build,analyze-pinned,twiggy-nonlto}.log`
- Build trees (gitignored): `.build/target` (pinned, 1.1 GB), `.build/target-analysis` (1.3 GB), `.build/target-named` (2.3 GB), `.build/upstream`, `.build/source.git`, `.build/tools/bin/wasm-bindgen`
