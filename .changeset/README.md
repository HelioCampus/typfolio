# Changesets

Each pull request that changes a published package adds a changeset: a small Markdown file here that names the
packages it affects, the bump (`patch`, `minor` or `major`) and the release note. Run `npm run changeset` to
create one. The release workflow collects them into a "Version Packages" pull request; merging that pull request
publishes to npm. See [CONTRIBUTING.md](../CONTRIBUTING.md#versioning-and-changesets).
