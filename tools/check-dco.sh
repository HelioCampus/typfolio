#!/usr/bin/env bash
# Fails when a commit in a revision range has no Signed-off-by trailer (Developer Certificate of Origin).
#
#   tools/check-dco.sh origin/main..HEAD
#
# Merge commits are skipped. A trailer counts only when it is in the commit message's trailer block, as
# `git interpret-trailers` reads it, and has the form `Signed-off-by: Name <email>`.
set -euo pipefail

range="${1:?usage: tools/check-dco.sh <revision-range>, for example origin/main..HEAD}"
commits="$(git rev-list --no-merges "$range")"

checked=0
missing=()
for commit in $commits; do
  checked=$((checked + 1))
  if ! git log -1 --format=%B "$commit" | git interpret-trailers --parse | grep -Eiq '^Signed-off-by: .+ <[^<>]+>[[:space:]]*$'; then
    missing+=("$commit")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "${#missing[@]} of $checked commit(s) in $range lack a Signed-off-by trailer:" >&2
  for commit in "${missing[@]}"; do
    git log -1 --format='  %h %s' "$commit" >&2
    echo "::error title=Missing DCO sign-off::$(git log -1 --format='%h %s' "$commit") has no Signed-off-by trailer"
  done
  {
    echo
    echo "Sign off with 'git commit -s'. To add it to the commits already made on this branch:"
    echo "  git rebase --signoff <base branch>   (then force-push the branch)"
    echo "See CONTRIBUTING.md and https://developercertificate.org."
  } >&2
  exit 1
fi

echo "All $checked commit(s) in $range carry a Signed-off-by trailer."
