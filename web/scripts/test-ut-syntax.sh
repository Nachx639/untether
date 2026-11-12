#!/bin/bash
# Test script to validate ut command syntax and basic functionality
# This can be run as part of the build process to catch issues early

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
UT_SCRIPT="$PROJECT_ROOT/bin/ut"

echo "Testing ut command syntax and functionality..."

# Test 1: Check if ut script exists
if [ ! -f "$UT_SCRIPT" ]; then
    echo "❌ ERROR: ut script not found at $UT_SCRIPT"
    exit 1
fi
echo "✅ ut script exists"

# Test 2: Check if ut script is executable
if [ ! -x "$UT_SCRIPT" ]; then
    echo "❌ ERROR: ut script is not executable"
    exit 1
fi
echo "✅ ut script is executable"

# Test 3: Validate bash syntax
if ! bash -n "$UT_SCRIPT" 2>/dev/null; then
    echo "❌ ERROR: ut script has syntax errors"
    bash -n "$UT_SCRIPT" # Show the actual errors
    exit 1
fi
echo "✅ ut script has valid bash syntax"

# Test 4: Check if ut script contains required functions
if ! grep -q "show_help()" "$UT_SCRIPT"; then
    echo "❌ ERROR: ut script missing show_help() function"
    exit 1
fi
echo "✅ ut script contains show_help() function"

if ! grep -q "resolve_command()" "$UT_SCRIPT"; then
    echo "❌ ERROR: ut script missing resolve_command() function"
    exit 1
fi
echo "✅ ut script contains resolve_command() function"

# Test 5: Check for empty if statements (the bug we fixed)
# Use a simpler approach that works on macOS
if awk '/if.*then/{start=NR; in_if=1; has_content=0} in_if && !/^[[:space:]]*#/ && !/^[[:space:]]*$/ && !/if.*then/ && !/fi$/{has_content=1} /^[[:space:]]*fi$/ && in_if{if(!has_content) print "Empty if at line " start; in_if=0}' "$UT_SCRIPT" | grep -q .; then
    echo "❌ ERROR: ut script contains empty if statements"
    exit 1
fi
echo "✅ ut script has no empty if statements"

# Test 6: Check that package.json does NOT include ut in bin section
# (ut is installed conditionally via postinstall script to avoid conflicts)
PACKAGE_JSON="$PROJECT_ROOT/package.json"
if [ -f "$PACKAGE_JSON" ]; then
    if grep -q '"ut".*:.*"./bin/ut"' "$PACKAGE_JSON"; then
        echo "❌ ERROR: package.json should NOT include ut in bin section"
        echo "   ut must be installed conditionally via postinstall to avoid conflicts"
        exit 1
    fi
    echo "✅ package.json correctly omits ut from bin section (installed conditionally)"
fi

# Test 7: Basic functionality test (help command)
# Skip if already inside an Untether session (recursive sessions not supported)
if [ -n "$UNTETHER_SESSION_ID" ]; then
    echo "⚠️  Skipping ut --help test (already inside Untether session)"
else
    TEST_BIN=$(mktemp "${TMPDIR:-/tmp}/untether-test-bin.XXXXXX")
    trap 'rm -f "$TEST_BIN"' EXIT
    cat > "$TEST_BIN" <<'EOF'
#!/bin/sh
if [ "$1" = "--version" ]; then
    echo "Untether Server test"
    echo "Built: test"
    echo "Platform: test"
fi
EOF
    chmod +x "$TEST_BIN"

    # Use gtimeout if available, otherwise skip timeout
    if command -v gtimeout >/dev/null 2>&1; then
        if ! UNTETHER_BIN="$TEST_BIN" gtimeout 5 "$UT_SCRIPT" --help >/dev/null 2>&1; then
            echo "❌ ERROR: ut --help command failed or timed out"
            exit 1
        fi
    else
        # On macOS without gtimeout, just test that it doesn't immediately fail
        if ! UNTETHER_BIN="$TEST_BIN" "$UT_SCRIPT" --help >/dev/null 2>&1; then
            echo "❌ ERROR: ut --help command failed"
            exit 1
        fi
    fi
    echo "✅ ut --help command works"
fi

echo "🎉 All ut command tests passed!"
