#!/bin/bash
# Run all code quality checks
# Format and lint checks run in parallel (read-only)
# Type checking runs in parallel as it doesn't modify files

# Create temporary files for capturing output
FORMAT_OUT=$(mktemp)
LINT_OUT=$(mktemp)
LINT_TYPEAWARE_OUT=$(mktemp)
TYPECHECK_OUT=$(mktemp)
UT_OUT=$(mktemp)
LOCK_OUT=$(mktemp)
NPM_MANIFEST_OUT=$(mktemp)

# Track PIDs for parallel tasks
declare -a pids=()

# An interrupted check takes its parallel jobs and temporary files with it.
cleanup() {
    for pid in "${pids[@]}"; do
        kill "$pid" 2>/dev/null
    done
    rm -f "$FORMAT_OUT" "$LINT_OUT" "$LINT_TYPEAWARE_OUT" "$TYPECHECK_OUT" "$UT_OUT" "$LOCK_OUT" "$NPM_MANIFEST_OUT"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Run format CHECK (read-only) in parallel
{
    if ! pnpm run format:check > "$FORMAT_OUT" 2>&1; then
        echo "Format check failed:"
        cat "$FORMAT_OUT"
        exit 1
    fi
} &
pids+=($!)

# Run lint CHECK (with Biome check, not write) in parallel
{
    if ! pnpm run lint > "$LINT_OUT" 2>&1; then
        echo "Lint check failed:"
        cat "$LINT_OUT"
        exit 1
    fi
} &
pids+=($!)

# Run type-aware lint CHECK in parallel
{
    if ! pnpm run lint:typeaware > "$LINT_TYPEAWARE_OUT" 2>&1; then
        echo "Type-aware lint check failed:"
        cat "$LINT_TYPEAWARE_OUT"
        exit 1
    fi
} &
pids+=($!)

# Run typecheck in parallel (doesn't modify files)
{
    if ! pnpm run typecheck > "$TYPECHECK_OUT" 2>&1; then
        echo "Typecheck failed:"
        cat "$TYPECHECK_OUT"
        exit 1
    fi
} &
pids+=($!)

# The lockfile matches package.json (2026-10-20: a dependency update left the overrides behind
# and the Mac app's Release build, which installs with --frozen-lockfile, failed). Read-only.
{
    if ! pnpm install --frozen-lockfile --lockfile-only > "$LOCK_OUT" 2>&1; then
        echo "Lockfile check failed (run pnpm install --lockfile-only):"
        cat "$LOCK_OUT"
        exit 1
    fi
} &
pids+=($!)

# package.npm.json (the published manifest) carries the same dependency versions as package.json
# (2026-11-10: seven had drifted after dependency updates and `pnpm run build:npm` only said so
# at its step 6, after the whole build). Read-only.
{
    if ! node scripts/check-npm-manifest.js > "$NPM_MANIFEST_OUT" 2>&1; then
        echo "npm manifest check failed:"
        cat "$NPM_MANIFEST_OUT"
        exit 1
    fi
} &
pids+=($!)

# Run ut script tests in parallel
{
    if ! pnpm run test:ut > "$UT_OUT" 2>&1; then
        echo "UT script test failed:"
        cat "$UT_OUT"
        exit 1
    fi
} &
pids+=($!)

# Wait for all parallel processes
failed=false
for pid in "${pids[@]}"; do
    if ! wait "$pid"; then
        failed=true
    fi
done

# Exit with appropriate code
if [ "$failed" = true ]; then
    exit 1
fi
