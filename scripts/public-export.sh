#!/usr/bin/env bash
# Public export: a clean copy of this repository's tracked tree, as a git repository of its own.
#
# 2026-11-11: the working repository stays private (thousands of commits, 1.1 GB, a real home
# folder in old commits). What is published is a copy with none of that history: the tree of
# HEAD, minus what scripts/public-export.rules leaves out, committed by a neutral author.
#
# Usage: scripts/public-export.sh [--source <repository>] <destination folder>
#
#   First time    <destination> does not exist (or is an empty folder): it becomes a new git
#                 repository with ONE commit, branch main, no remotes.
#   Next times    <destination> is a clone of the public repository (clean, on the branch to
#                 publish): its tree is replaced by the new export and ONE commit is added on
#                 top, so the public history is one commit per publication. Nothing to change
#                 means no commit.
#
# It never pushes and never creates a remote: publishing is `git push` in <destination>, by hand.
# Every export (2026-11-12) also writes the copy's push guard, scripts/public-export.pre-push, as
# <destination>/.git/hooks/pre-push: from there only the exporter's own commits leave, and only
# towards the public repository (the "homepage" of web/package.json).
#
# What travels is `git archive HEAD` (never the folder: nothing untracked, nothing uncommitted).
# The copy is built and checked in a temporary folder next to <destination>, which is only
# touched when every check has passed; on any failure the temporary folder is removed and the
# exit status is not 0. The checks:
#
#   - the rules themselves (an `exclude` that matches nothing is stale);
#   - nothing the rules `forbid` (local configuration, keys, galleries, reports), unless an
#     `allow` rule names that very file;
#   - no GitHub Actions workflow or action, whatever the rules say;
#   - every image or media file is one somebody looked at (`media-ok`);
#   - no personal trace (scripts/personal-trace.mjs, the working repository's own guard);
#   - no secret trufflehog finds, when it is installed (a clear warning when it is not);
#   - no file above `fail-over-mb` (those above `list-over-mb` are listed);
#   - LICENSE is there and keeps both copyright lines;
#   - web/package.json names the public repository ("homepage"): the push guard needs it.
#
# Environment: PUBLIC_EXPORT_AUTHOR_NAME and PUBLIC_EXPORT_AUTHOR_EMAIL replace the neutral
# author (for the account's GitHub no-reply address, <id>+<login>@users.noreply.github.com).
set -euo pipefail

AUTHOR_NAME="${PUBLIC_EXPORT_AUTHOR_NAME:-Untether contributors}"
AUTHOR_EMAIL="${PUBLIC_EXPORT_AUTHOR_EMAIL:-contributors@untether.invalid}"
RULES_PATH="scripts/public-export.rules"
GUARD_PATH="scripts/public-export.pre-push"
MEDIA_EXTENSIONS="png jpg jpeg gif webp avif heic bmp tif tiff svg ico icns psd ai sketch fig pdf mp4 mov m4v webm mp3 wav m4a aiff"
COPYRIGHTS=("Untether contributors" "Amantus Machina")

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_repo="$(cd "$script_dir/.." && pwd)"
dest=""

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --source)
      [ $# -ge 2 ] || { echo "public-export: --source needs a folder" >&2; exit 2; }
      source_repo="$(cd "$2" && pwd)"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "public-export: unknown option $1" >&2
      exit 2
      ;;
    *)
      [ -z "$dest" ] || { echo "public-export: one destination folder only" >&2; exit 2; }
      dest="$1"
      shift
      ;;
  esac
done
[ -n "$dest" ] || { usage >&2; exit 2; }

say() { printf '%s\n' "$*"; }
problems=0
problem() {
  printf 'FAIL  %s\n' "$*" >&2
  problems=$((problems + 1))
}

source_repo="$(git -C "$source_repo" rev-parse --show-toplevel)"
source_rev="$(git -C "$source_repo" rev-parse --short=12 HEAD)"

# The destination: absolute, and outside the working repository.
mkdir -p "$(dirname "$dest")"
dest="$(cd "$(dirname "$dest")" && pwd -P)/$(basename "$dest")"
source_real="$(cd "$source_repo" && pwd -P)"
case "$dest/" in
  "$source_real"/*)
    echo "public-export: the destination must be outside the repository ($source_real)" >&2
    exit 2
    ;;
esac

mode=new
if [ -e "$dest" ]; then
  if [ ! -d "$dest" ]; then
    echo "public-export: $dest exists and is not a folder" >&2
    exit 2
  elif [ -e "$dest/.git" ]; then
    mode=update
    if [ -n "$(git -C "$dest" status --porcelain)" ]; then
      echo "public-export: $dest has uncommitted changes; commit or discard them first" >&2
      exit 2
    fi
  elif [ -n "$(ls -A "$dest")" ]; then
    echo "public-export: $dest is neither empty nor a git repository; not touching it" >&2
    exit 2
  fi
fi

if [ -n "$(git -C "$source_repo" status --porcelain)" ]; then
  say "note  the working tree has uncommitted changes: they do not travel, only HEAD ($source_rev) does"
fi

# Everything is built here; the destination is only touched at the very end.
work="$(mktemp -d "${dest}.export.XXXXXX")"
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT TERM HUP
stage="$work/tree"
meta="$work/meta.git"
mkdir "$stage"

# No configuration of this machine or this person reaches the copy's repository.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_TERMINAL_PROMPT=0
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

# The index of the copy lives outside it, so that the checks read the copy and nothing else.
sgit() { git --git-dir="$meta" --work-tree="$stage" "$@"; }

rules_file="$work/rules"
if ! git -C "$source_repo" show "HEAD:$RULES_PATH" > "$rules_file" 2>/dev/null; then
  echo "public-export: $RULES_PATH is not in HEAD of $source_repo" >&2
  exit 1
fi

guard_file="$work/pre-push"
if ! git -C "$source_repo" show "HEAD:$GUARD_PATH" > "$guard_file" 2>/dev/null; then
  echo "public-export: $GUARD_PATH is not in HEAD of $source_repo" >&2
  exit 1
fi

# The rules of one verb, one per line, comments and blanks gone.
rules() {
  sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' "$rules_file" |
    awk -v verb="$1" '$1 == verb { sub(/^[^[:space:]]+[[:space:]]+/, ""); print }'
}
rule_number() {
  local value
  value="$(rules "$1" | tail -1)"
  case "$value" in
    '' | *[!0-9]*)
      echo "public-export: $RULES_PATH needs '$1 <whole number>'" >&2
      exit 1
      ;;
  esac
  printf '%s' "$value"
}
unknown="$(sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' "$rules_file" |
  awk '$1 !~ /^(exclude|forbid|allow|media-ok|secret-ok|list-over-mb|fail-over-mb)$/ { print $1 }' | sort -u)"
if [ -n "$unknown" ]; then
  echo "public-export: unknown rule in $RULES_PATH: $(echo "$unknown" | tr '\n' ' ')" >&2
  exit 1
fi
list_over_mb="$(rule_number list-over-mb)"
fail_over_mb="$(rule_number fail-over-mb)"

say "==> Exporting HEAD ($source_rev) of $source_repo"
git -C "$source_repo" archive --format=tar HEAD | tar -x -C "$stage"
git init --quiet --initial-branch=main "$meta" --bare
# --force: a tracked file that .gitignore names travels too, and is checked like any other.
sgit add -A --force

# --- Left out -------------------------------------------------------------------------------
excluded_list="$work/excluded"
: > "$excluded_list"
while IFS= read -r pattern; do
  matched="$(sgit ls-files -- ":(glob)$pattern")"
  if [ -z "$matched" ]; then
    problem "exclude $pattern: matches no tracked file (stale rule: remove it)"
    continue
  fi
  printf '%s\n' "$matched" >> "$excluded_list"
  sgit rm -r --quiet --force -- ":(glob)$pattern"
done < <(rules exclude)
# Folders left empty by an exclusion.
find "$stage" -mindepth 1 -type d -empty -delete
excluded_count="$(grep -c . "$excluded_list" || true)"
say "==> Left out by the rules: $excluded_count files"

# --- Never in a public copy -----------------------------------------------------------------
allow_specs=()
while IFS= read -r pattern; do
  allow_specs+=(":(glob)$pattern")
done < <(rules allow)
: > "$work/allowed"
[ ${#allow_specs[@]} -eq 0 ] || sgit ls-files -- "${allow_specs[@]}" | sort > "$work/allowed"
while IFS= read -r pattern; do
  while IFS= read -r file; do
    [ -n "$file" ] && problem "forbidden file ($pattern): $file"
  done < <(sgit ls-files -- ":(glob)$pattern" | sort | comm -23 - "$work/allowed")
done < <(rules forbid)

# No GitHub Actions workflow or action (2026-11-11): in a public repository they run for anybody
# who opens an issue or a pull request, with whatever permissions and secrets the repository has.
# Not a rule: no `allow` lets one through.
while IFS= read -r file; do
  [ -n "$file" ] && problem "GitHub Actions file: $file (none travels; exclude it in $RULES_PATH)"
done < <(sgit ls-files -- ':(glob)**/.github/workflows/**' ':(glob)**/.github/actions/**')

# --- Media looked at ------------------------------------------------------------------------
media_specs=()
for extension in $MEDIA_EXTENSIONS; do
  media_specs+=(":(glob,icase)**/*.$extension")
done
media_ok_specs=()
while IFS= read -r pattern; do
  media_ok_specs+=(":(glob)$pattern")
done < <(rules media-ok)
sgit ls-files -- "${media_specs[@]}" | sort > "$work/media"
if [ ${#media_ok_specs[@]} -gt 0 ]; then
  sgit ls-files -- "${media_ok_specs[@]}" | sort > "$work/media-ok"
else
  : > "$work/media-ok"
fi
while IFS= read -r file; do
  [ -n "$file" ] && problem "media nobody looked at: $file (look at it, then media-ok or exclude it in $RULES_PATH)"
done < <(comm -23 "$work/media" "$work/media-ok")
say "==> Media in the copy: $(grep -c . "$work/media" || true) files, each covered by a media-ok rule"

# --- Personal traces ------------------------------------------------------------------------
say "==> Personal-trace guard"
if ! command -v node > /dev/null 2>&1; then
  problem "node is not on PATH: the personal-trace guard cannot run"
elif ! GIT_DIR="$meta" GIT_WORK_TREE="$stage" node "$script_dir/personal-trace.mjs" "$stage" > "$work/traces" 2> "$work/traces.err"; then
  while IFS= read -r line; do
    problem "personal trace: $line"
  done < "$work/traces"
  [ -s "$work/traces" ] || problem "the personal-trace guard did not run: $(tr '\n' ' ' < "$work/traces.err")"
fi

# --- Secrets --------------------------------------------------------------------------------
if command -v trufflehog > /dev/null 2>&1; then
  say "==> trufflehog ($(trufflehog --version 2>&1 | head -1))"
  # Without verification: nothing found here is sent anywhere, and every finding counts.
  if ! (cd "$stage" && trufflehog filesystem . --no-verification --no-update --json) \
    > "$work/secrets.json" 2> "$work/secrets.err"; then
    problem "trufflehog failed: $(tail -3 "$work/secrets.err" | tr '\n' ' ')"
  else
    rules secret-ok > "$work/secret-ok"
    secrets_read=0
    node - "$work/secrets.json" "$work/secret-ok" > "$work/secrets.out" 2> "$work/secrets-read.err" <<'NODE' || secrets_read=$?
const fs = require('node:fs');
const [findingsFile, okFile] = process.argv.slice(2);
const ok = fs.readFileSync(okFile, 'utf8').split('\n').filter(Boolean).map((line) => line.trim().split(/\s+/));
const used = new Set();
const seen = new Set();
for (const line of fs.readFileSync(findingsFile, 'utf8').split('\n')) {
  if (!line.startsWith('{')) continue;
  // A line that cannot be read is not "no finding": it throws, and the export fails.
  const finding = JSON.parse(line);
  if (!finding.DetectorName) continue;
  const where = finding.SourceMetadata?.Data?.Filesystem ?? {};
  const file = String(where.file ?? '?').replace(/^\.\//, '');
  const rule = ok.findIndex(([path, detector]) => path === file && detector === finding.DetectorName);
  if (rule >= 0) {
    used.add(rule);
    continue;
  }
  // Never the secret itself: its place and its kind.
  const text = `secret: ${file}${where.line ? `:${where.line}` : ''} (${finding.DetectorName})`;
  if (!seen.has(text)) console.log(text);
  seen.add(text);
}
ok.forEach(([path, detector], index) => {
  if (!used.has(index)) console.log(`secret-ok ${path} ${detector}: trufflehog finds nothing there any more (stale rule: remove it)`);
});
NODE
    while IFS= read -r line; do
      [ -n "$line" ] && problem "$line"
    done < "$work/secrets.out"
    # Fails closed: findings nobody could read are findings.
    if [ "$secrets_read" -ne 0 ]; then
      problem "trufflehog's findings could not be read (exit $secrets_read): $(tail -3 "$work/secrets-read.err" | tr '\n' ' ')"
    fi
  fi
else
  say "WARN  trufflehog is NOT installed: the copy was NOT scanned for secrets."
  say "WARN  Install it (brew install trufflehog) and export again before publishing."
  secrets_skipped=1
fi

# --- Size -----------------------------------------------------------------------------------
say "==> Files above ${list_over_mb} MB (limit: ${fail_over_mb} MB)"
while IFS= read -r file; do
  [ -n "$file" ] || continue
  [ -f "$stage/$file" ] && [ ! -L "$stage/$file" ] || continue
  bytes="$(wc -c < "$stage/$file" | tr -d ' ')"
  if [ "$bytes" -gt $((list_over_mb * 1024 * 1024)) ]; then
    say "      $(awk -v b="$bytes" 'BEGIN { printf "%.1f MB", b / 1048576 }')  $file"
    if [ "$bytes" -gt $((fail_over_mb * 1024 * 1024)) ]; then
      problem "file above ${fail_over_mb} MB: $file"
    fi
  fi
done < <(sgit ls-files)

# --- License --------------------------------------------------------------------------------
if [ ! -f "$stage/LICENSE" ]; then
  problem "LICENSE is missing from the copy"
else
  for holder in "${COPYRIGHTS[@]}"; do
    grep -Eq "^Copyright \(c\) [0-9]{4}.* ${holder}\$" "$stage/LICENSE" ||
      problem "LICENSE lost its copyright line of ${holder}"
  done
fi

# --- The push guard -------------------------------------------------------------------------
# The public repository is the one the copy itself names; its hook lets nothing out elsewhere.
public_repo="$(sed -n 's|^[[:space:]]*"homepage":[[:space:]]*"https://github\.com/\([A-Za-z0-9-]*/[A-Za-z0-9._-]*\)".*|\1|p' "$stage/web/package.json" 2>/dev/null | head -1 | tr '[:upper:]' '[:lower:]')"
if [ -z "$public_repo" ]; then
  problem "web/package.json has no \"homepage\": \"https://github.com/<owner>/<name>\": the copy's push guard cannot be written"
elif ! grep -q '@PUBLIC_REPO@' "$guard_file"; then
  problem "$GUARD_PATH lost its @PUBLIC_REPO@ marker"
fi
# 2026-11-12: this hook was put by hand in one clone; now every export writes it, in the hooks
# folder git reads (a core.hooksPath of the clone's own configuration would switch it off).
install_push_guard() {
  local hooks
  hooks="$(cd "$1" && cd "$(git rev-parse --git-common-dir)" && pwd -P)/hooks"
  mkdir -p "$hooks"
  sed "s|@PUBLIC_REPO@|$public_repo|g" "$guard_file" > "$hooks/pre-push.new"
  chmod 755 "$hooks/pre-push.new"
  mv -f "$hooks/pre-push.new" "$hooks/pre-push"
  # As git will be told: relative to the copy's folder (so it follows the folder when it is
  # renamed) unless the copy is a worktree whose repository lives elsewhere.
  [ -d "$1/.git" ] && hooks=".git/hooks"
  # git runs the hooks of core.hooksPath when any configuration file sets it (the person's
  # global one, the clone's, a worktree's): the hook just written would sit there and never run.
  # The clone's own configuration names this very folder, which wins over global and system
  # ones, and a worktree-level value (the only thing above it) is removed.
  if [ "$(git -C "$1" config --local --get core.hooksPath 2>/dev/null || true)" != "$hooks" ]; then
    git -C "$1" config --local --get core.hooksPath > /dev/null 2>&1 &&
      say "note  $1 had core.hooksPath set to another folder: now its own hooks folder, or its push guard would not run"
    git -C "$1" config --local --replace-all core.hooksPath "$hooks"
  fi
  if git -C "$1" config --worktree --get core.hooksPath > /dev/null 2>&1 &&
    [ "$(git -C "$1" config --get core.hooksPath)" != "$hooks" ]; then
    git -C "$1" config --worktree --unset-all core.hooksPath
  fi
  # Read back as git will read it when it pushes.
  if [ "$(git -C "$1" config --get core.hooksPath 2>/dev/null || true)" != "$hooks" ]; then
    echo "public-export: git would not run the push guard of $1 (core.hooksPath is '$(git -C "$1" config --get core.hooksPath 2>/dev/null || true)')" >&2
    exit 1
  fi
}

if [ "$problems" -gt 0 ]; then
  echo >&2
  echo "public-export: $problems problem(s); nothing was written to $dest" >&2
  exit 1
fi

# --- The commit -----------------------------------------------------------------------------
version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$stage/web/package.json" 2>/dev/null | head -1)"
message="Untether${version:+ $version}

Source snapshot made by scripts/public-export.sh (source revision $source_rev)."
commit() {
  TZ=UTC GIT_AUTHOR_NAME="$AUTHOR_NAME" GIT_AUTHOR_EMAIL="$AUTHOR_EMAIL" \
    GIT_COMMITTER_NAME="$AUTHOR_NAME" GIT_COMMITTER_EMAIL="$AUTHOR_EMAIL" \
    git -C "$1" -c commit.gpgsign=false -c core.hooksPath=/dev/null commit --quiet --no-verify -m "$message"
}

file_count="$(sgit ls-files | grep -c . || true)"
rm -rf "$meta"

# The commit is made in the checked copy itself, from exactly the files that were checked.
git init --quiet --initial-branch=main "$stage"
git -C "$stage" add -A --force
checked_tree="$(git -C "$stage" write-tree)"

if [ "$mode" = new ]; then
  commit "$stage"
  [ "$(git -C "$stage" rev-list --count HEAD)" = 1 ] || { echo "public-export: the copy does not have exactly one commit" >&2; exit 1; }
  [ "$(git -C "$stage" rev-parse 'HEAD^{tree}')" = "$checked_tree" ] || { echo "public-export: the commit is not the tree that was checked" >&2; exit 1; }
  [ -z "$(git -C "$stage" remote)" ] || { echo "public-export: the copy has a remote" >&2; exit 1; }
  [ -z "$(git -C "$stage" status --porcelain --ignored)" ] || { echo "public-export: the copy is not clean after its commit" >&2; exit 1; }
  [ -d "$dest" ] && rmdir "$dest"
  mv "$stage" "$dest"
  install_push_guard "$dest"
else
  # A clone of the public repository: the checked tree goes on top of its history as one commit.
  # Its working folder is never the source of the commit, so whatever it holds untracked or
  # ignored (2026-11-11 review: `git rm` + copy + `git add` left those in place, unchecked)
  # cannot reach what is published.
  install_push_guard "$dest"
  if [ "$(git -C "$dest" rev-parse 'HEAD^{tree}')" = "$checked_tree" ]; then
    say "==> $dest already holds this tree: nothing to publish, no commit made"
    exit 0
  fi
  commit "$stage"
  git -C "$dest" fetch --quiet --no-tags "$stage" main
  new_commit="$(printf '%s\n' "$message" | TZ=UTC GIT_AUTHOR_NAME="$AUTHOR_NAME" GIT_AUTHOR_EMAIL="$AUTHOR_EMAIL" \
    GIT_COMMITTER_NAME="$AUTHOR_NAME" GIT_COMMITTER_EMAIL="$AUTHOR_EMAIL" \
    git -C "$dest" commit-tree "$checked_tree" -p HEAD)"
  # Fast-forward only: if a file of the clone is in the way, nothing moves and the export fails.
  git -C "$dest" merge --quiet --ff-only "$new_commit"
  [ "$(git -C "$dest" rev-parse 'HEAD^{tree}')" = "$checked_tree" ] || { echo "public-export: the commit is not the tree that was checked" >&2; exit 1; }
  leftover="$(git -C "$dest" status --porcelain --ignored)"
  if [ -n "$leftover" ]; then
    say "note  $dest holds files that are not part of the publication (they are not in the commit):"
    printf '%s\n' "$leftover" | head -20 | sed 's/^/      /'
  fi
fi

say
say "OK    $dest"
say "      mode      $([ "$mode" = new ] && echo "new repository, one commit, no remotes" || echo "one commit added on top of the existing clone")"
say "      commit    $(git -C "$dest" log -1 --format='%h %s | %an <%ae>')"
say "      commits   $(git -C "$dest" rev-list --count HEAD)"
say "      files     $file_count ($excluded_count left out by the rules)"
say "      size      $(du -sh "$dest" | cut -f1) on disk, $(du -sh "$dest/.git" | cut -f1) of it the git repository"
if [ "${secrets_skipped:-0}" = 1 ]; then
  say "WARN  not scanned for secrets (trufflehog missing): do not publish this copy as it is."
fi
say "      guard     .git/hooks/pre-push: only the exporter's commits, only to github.com/$public_repo"
say "Nothing was pushed. To publish: add the remote in $dest and push from there."
