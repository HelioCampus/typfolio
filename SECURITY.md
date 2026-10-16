# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately. Do not open a public issue, pull request or discussion for them.

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Only the maintainers can see the report, and we can discuss and fix it there before anything is public.

Include, as far as you can:

- the affected package (`@typfolio/core`, `@typfolio/workers`, `@typfolio/react`, `@typfolio/dev-tools` or `@typfolio/wasm`) and version, or the commit;
- what the issue lets an attacker do and under which conditions;
- steps or a minimal template and input that reproduce it;
- the environment (browser or Node version, operating system, bundler);
- any suggested fix, if you have one.

We will acknowledge a report, assess it and keep you informed about the fix and the disclosure. We ask that you give us a reasonable time to release a fix before you disclose the issue publicly.

## Supported versions

Security fixes are made in the latest release line only. If you use an older version, upgrade to the latest release to receive fixes.

## Scope

The packages compile Typst templates and JSON data to PDF, in the browser or in Node. Reports about the compile boundary are in scope, for example a template reading files or reaching the network, a request escaping its isolation, or the packed artifacts differing from their pinned build. Vulnerabilities in the upstream Typst compiler or in typst.ts should be reported to those projects; tell us too if Typfolio's pinned build is affected.

There is no bug bounty programme, and we cannot offer rewards for reports.
