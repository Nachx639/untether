#!/usr/bin/env bash
# The public repository's address: one value, in web/package.json ("homepage").
#
# 2026-11-11: the name of the public repository was not decided yet, and its address is written
# in about thirty files of every kind (documents, package.json, docs.json, the apps' "About" and
# settings screens, version.xcconfig, the release scripts, the Dockerfile). They all follow the
# one in web/package.json; web/src/test/unit/repo-config.test.ts fails when one does not.
#
# Usage: scripts/repo-url.sh                   prints the address and every file that holds it
#        scripts/repo-url.sh <owner>/<name>    writes the new address in all of them
#
# It only edits tracked files of the working tree: look at `git diff`, then commit. Bundle
# identifiers (com.<owner>.untether…) are not the repository's address and stay as they are.
set -euo pipefail

cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

current="$(sed -n 's|^[[:space:]]*"homepage":[[:space:]]*"https://github\.com/\([^"]*\)".*|\1|p' web/package.json)"
case "$current" in
  */*) ;;
  *)
    echo "repo-url: web/package.json has no \"homepage\": \"https://github.com/<owner>/<name>\"" >&2
    exit 1
    ;;
esac

# Every tracked file that names it (never a longer name that starts the same).
holders() {
  git grep -l -I -E "github\.com[/:]${current//./\\.}([^A-Za-z0-9_.-]|\.git|\$)" -- . ':!web/pnpm-lock.yaml' || true
}

if [ $# -eq 0 ]; then
  echo "https://github.com/$current"
  holders | sed 's/^/  /'
  exit 0
fi

new="${1#https://github.com/}"
new="${new%.git}"
if [ $# -ne 1 ] || ! [[ "$new" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$ ]]; then
  echo "usage: scripts/repo-url.sh [<owner>/<name>]" >&2
  exit 2
fi
if [ "$new" = "$current" ]; then
  echo "repo-url: already https://github.com/$new"
  exit 0
fi

count=0
while IFS= read -r file; do
  [ -n "$file" ] || continue
  OLD="$current" NEW="$new" perl -pi -e 's{(github\.com[/:])\Q$ENV{OLD}\E(?![A-Za-z0-9_-])(?!\.(?!git\b)[A-Za-z0-9])}{$1$ENV{NEW}}g' "$file"
  count=$((count + 1))
done < <(holders)
echo "repo-url: https://github.com/$current -> https://github.com/$new in $count files (git diff to review)"
