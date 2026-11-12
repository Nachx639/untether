#!/usr/bin/env bash
# The public repository's own rules, on GitHub's side: they hold from any computer, with or
# without the hooks of this one.
#
# 2026-11-12: the working repository is private and the public one receives a clean copy
# (scripts/public-export.sh). The hooks that keep the working history out of the public
# repository live in each clone; these rulesets live in the repository itself, with an
# empty bypass list (nobody is exempt, administrators included):
#
#   1. every branch but main    cannot be created, updated or deleted: a branch of the working
#                               repository cannot be pushed there.
#   2. main                     no force-push and no deletion. The working history shares no
#                               commit with the copy, so a plain push of it is not a
#                               fast-forward and is refused.
#   3. tags that are not v*     cannot be created, updated or deleted.
#   4. release tags (v*)        can be created, and never moved or deleted: a published version
#                               stays what it was.
#
# 2026-11-12: until there were public releases no tag could be created at all. A release
# (mac/scripts/release.sh, by hand) tags a commit of the clean copy as v<version>, so rule 3
# now leaves v* out and rule 4 pins them. The branch rules are what they were.
#
# Usage: scripts/public-repo-rules.sh --check    reads the rules and says what is missing
#        scripts/public-repo-rules.sh --apply    creates or corrects them, then checks again
#        ... --repo <owner>/<name>               another repository than the "homepage" of
#                                                web/package.json
#
# Exit: 0  the rulesets are in place
#       1  one is missing or differs (--check), or could not be written (--apply)
#       2  usage
#       3  cannot tell: no gh, no node, no network, not signed in, or no such repository
#       4  the repository is private and GitHub's plan has no rulesets for private ones
#          ("Upgrade to GitHub Pro or make this repository public"): nothing to apply yet. Run
#          --apply right after making it public.
#
# It talks to GitHub through `gh api` only, and runs it again as often as wanted: a ruleset
# that is already right is left alone.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode=""
repo=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check | --apply)
      [ -z "$mode" ] || { echo "public-repo-rules: --check or --apply, not both" >&2; exit 2; }
      mode="${1#--}"
      shift
      ;;
    --repo)
      [ $# -ge 2 ] || { echo "public-repo-rules: --repo needs <owner>/<name>" >&2; exit 2; }
      repo="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "public-repo-rules: unknown argument $1" >&2
      exit 2
      ;;
  esac
done
[ -n "$mode" ] || { echo "usage: scripts/public-repo-rules.sh --check | --apply [--repo <owner>/<name>]" >&2; exit 2; }

if [ -z "$repo" ]; then
  repo="$(sed -n 's|^[[:space:]]*"homepage":[[:space:]]*"https://github\.com/\([^"]*\)".*|\1|p' "$root/web/package.json" 2>/dev/null | head -1)"
fi
if ! [[ "$repo" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$ ]]; then
  echo "public-repo-rules: no public repository: web/package.json needs \"homepage\": \"https://github.com/<owner>/<name>\" (or pass --repo)" >&2
  exit 2
fi

for tool in gh node; do
  if ! command -v "$tool" > /dev/null 2>&1; then
    echo "public-repo-rules: cannot tell: $tool is not installed"
    exit 3
  fi
done

work="$(mktemp -d "${TMPDIR:-/tmp}/public-repo-rules.XXXXXX")"
trap 'rm -rf "$work"' EXIT
export GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1

# One call to GitHub: the answer in $work/out, what gh said about a failure in $work/err.
api() { gh api "$@" > "$work/out" 2> "$work/err"; }
failure() { cat "$work/err" "$work/out" 2>/dev/null | tr '\n' ' ' | cut -c1-300; }

if ! api "repos/$repo"; then
  if grep -q 'HTTP 404' "$work/err"; then
    echo "public-repo-rules: cannot tell: $repo does not exist or this account cannot see it"
  else
    echo "public-repo-rules: cannot tell: GitHub did not answer for $repo ($(failure))"
  fi
  exit 3
fi
cp "$work/out" "$work/repo.json"
visibility="$(node -e '
  const repo = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(repo.visibility ?? (repo.private ? "private" : "public"));
  console.log(repo.default_branch ?? "");
' "$work/repo.json")"
default_branch="$(printf '%s\n' "$visibility" | sed -n 2p)"
visibility="$(printf '%s\n' "$visibility" | sed -n 1p)"

if ! api "repos/$repo/rulesets?per_page=100&includes_parents=false"; then
  if grep -q 'Upgrade to GitHub Pro' "$work/err" "$work/out" 2>/dev/null; then
    echo "public-repo-rules: $repo is $visibility, and on this plan GitHub has rulesets for public repositories only (\"Upgrade to GitHub Pro or make this repository public\")."
    echo "public-repo-rules: nothing is in place yet. Run scripts/public-repo-rules.sh --apply right after making it public."
    exit 4
  fi
  echo "public-repo-rules: cannot tell: the rulesets of $repo could not be read ($(failure))"
  exit 3
fi
cp "$work/out" "$work/list.json"

# What must be there, what is there, and what to do about each: the plan, one line per ruleset
# (`ok`, `create`, `update <id>` or `delete <id>`, then the file with the body to send, then name
# and reason).
#
# 2026-11-12: rulesets are found by name, and the tag ruleset changed its name ("no tags yet"
# became two). An earlier ruleset of this script that is no longer wanted would stay, still
# refusing every tag, with --check saying all is well: every ruleset named "untether: ..." that
# is not in the list below is one of ours to retire, so --check reports it and --apply deletes it.
cat > "$work/plan.js" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [dir, step] = process.argv.slice(2);
const read = (file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const EVERYTHING = ['creation', 'update', 'deletion'];
const WANTED = [
  {
    name: 'untether: only main exists',
    target: 'branch',
    include: ['~ALL'],
    exclude: ['refs/heads/main'],
    rules: EVERYTHING,
  },
  {
    name: 'untether: main only moves forward',
    target: 'branch',
    include: ['refs/heads/main'],
    exclude: [],
    rules: ['non_fast_forward', 'deletion'],
  },
  {
    name: 'untether: only release tags',
    target: 'tag',
    include: ['~ALL'],
    exclude: ['refs/tags/v*'],
    rules: EVERYTHING,
  },
  {
    name: 'untether: release tags never move',
    target: 'tag',
    include: ['refs/tags/v*'],
    exclude: [],
    rules: ['update', 'deletion'],
  },
];
const list = read('list.json');
if (!Array.isArray(list)) throw new Error('the list of rulesets is not a list');
const found = (wanted) => list.find((ruleset) => ruleset.name === wanted.name);

if (step === 'ids') {
  // The rulesets to read whole: the list carries neither rules nor conditions.
  for (const wanted of WANTED) {
    const ruleset = found(wanted);
    if (ruleset) console.log(ruleset.id);
  }
  return;
}

const same = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...b].sort());
WANTED.forEach((wanted, index) => {
  const body = `want-${index}.json`;
  fs.writeFileSync(
    path.join(dir, body),
    JSON.stringify({
      name: wanted.name,
      target: wanted.target,
      enforcement: 'active',
      bypass_actors: [],
      conditions: { ref_name: { include: wanted.include, exclude: wanted.exclude } },
      rules: wanted.rules.map((type) => ({ type })),
    })
  );
  const listed = found(wanted);
  if (!listed) {
    console.log(`create\t-\t${body}\t${wanted.name}\tmissing`);
    return;
  }
  const have = read(`have-${listed.id}.json`);
  const wrong = [];
  if (have.target !== wanted.target) wrong.push(`target is ${have.target}`);
  if (have.enforcement !== 'active') wrong.push(`enforcement is ${have.enforcement}`);
  if ((have.bypass_actors ?? []).length > 0) wrong.push(`${have.bypass_actors.length} bypass actor(s)`);
  const refs = have.conditions?.ref_name ?? {};
  if (!same(refs.include, wanted.include)) wrong.push(`covers ${JSON.stringify(refs.include ?? [])}`);
  if (!same(refs.exclude, wanted.exclude)) wrong.push(`leaves out ${JSON.stringify(refs.exclude ?? [])}`);
  const types = (have.rules ?? []).map((rule) => rule.type);
  if (!same(types, wanted.rules)) wrong.push(`rules are ${JSON.stringify(types.sort())}`);
  if (wrong.length) console.log(`update\t${listed.id}\t${body}\t${wanted.name}\t${wrong.join('; ')}`);
  else console.log(`ok\t${listed.id}\t${body}\t${wanted.name}\t`);
});
for (const ruleset of list) {
  if (!String(ruleset.name).startsWith('untether: ')) continue;
  if (WANTED.some((wanted) => wanted.name === ruleset.name)) continue;
  console.log(`delete\t${ruleset.id}\t-\t${ruleset.name}\tan earlier rule of this script, replaced`);
}
NODE

read_plan() {
  local id
  for id in $(node "$work/plan.js" "$work" ids); do
    if ! api "repos/$repo/rulesets/$id"; then
      echo "public-repo-rules: cannot tell: ruleset $id of $repo could not be read ($(failure))"
      exit 3
    fi
    cp "$work/out" "$work/have-$id.json"
  done
  if ! node "$work/plan.js" "$work" plan > "$work/plan" 2> "$work/plan.err"; then
    echo "public-repo-rules: cannot tell: GitHub's answer could not be read ($(tr '\n' ' ' < "$work/plan.err" | cut -c1-300))"
    exit 3
  fi
}

# Prints the state of each ruleset; fails when one is not right.
report() {
  local pending=0 action id body name reason
  while IFS=$'\t' read -r action id body name reason; do
    if [ "$action" = ok ]; then
      echo "ok       $name"
    elif [ "$action" = delete ]; then
      echo "STALE    $name ($reason)"
      pending=$((pending + 1))
    else
      echo "MISSING  $name ($reason)"
      pending=$((pending + 1))
    fi
  done < "$work/plan"
  # The first two rulesets tell main from the rest by its name.
  if [ "$default_branch" != main ]; then
    echo "MISSING  the default branch of $repo is '${default_branch:-?}', and the rules protect 'main'"
    pending=$((pending + 1))
  fi
  [ "$pending" -eq 0 ]
}

read_plan
echo "public-repo-rules: $repo ($visibility)"

if [ "$mode" = check ]; then
  if report; then
    echo "public-repo-rules: the rulesets are in place, with no bypass list"
    exit 0
  fi
  echo "public-repo-rules: not protected yet: run scripts/public-repo-rules.sh --apply"
  exit 1
fi

while IFS=$'\t' read -r action id body name reason; do
  case "$action" in
    ok) continue ;;
    create) call=(-X POST "repos/$repo/rulesets") ;;
    update) call=(-X PUT "repos/$repo/rulesets/$id") ;;
    delete) call=(-X DELETE "repos/$repo/rulesets/$id") ;;
    *) echo "public-repo-rules: unknown step $action" >&2; exit 1 ;;
  esac
  [ "$action" = delete ] || call+=(--input "$work/$body")
  if ! api "${call[@]}"; then
    echo "public-repo-rules: could not $action '$name' ($(failure))" >&2
    exit 1
  fi
  echo "$action   $name ($reason)"
done < "$work/plan"

# What was written is read back: the answer is GitHub's, not this script's hope.
if ! api "repos/$repo/rulesets?per_page=100&includes_parents=false"; then
  echo "public-repo-rules: written, but could not be read back ($(failure))" >&2
  exit 1
fi
cp "$work/out" "$work/list.json"
read_plan
if report; then
  echo "public-repo-rules: the rulesets are in place, with no bypass list"
  exit 0
fi
echo "public-repo-rules: still not right after writing" >&2
exit 1
