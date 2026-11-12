#!/bin/bash
set -euo pipefail

# Quick test script for iOS - runs tests without full xcodebuild output

echo "🧪 Running iOS tests..."

# Check if we're in the right directory
if [ ! -f "Untether-iOS.xcodeproj/project.pbxproj" ]; then
    echo "❌ Error: Must run from ios/ directory"
    exit 1
fi

# Select the last available iPhone from the newest installed iOS 26 runtime.
SIMULATOR_INFO=$(
    xcrun simctl list devices available |
        awk '
            /^-- iOS 26([.][0-9]+)* --$/ {
                runtime = $0
                sub(/^-- iOS /, "", runtime)
                sub(/ --$/, "", runtime)
                in_runtime = 1
                next
            }
            /^-- / {
                in_runtime = 0
            }
            in_runtime {
                line = $0
                sub(/[[:space:]]+$/, "", line)
            }
            in_runtime && line ~ /iPhone/ && line ~ / \((Shutdown|Booted)\)$/ {
                name = line
                sub(/^[[:space:]]+/, "", name)
                sub(/ \([0-9A-F-]+\) \((Shutdown|Booted)\)$/, "", name)

                id = line
                sub(/ \((Shutdown|Booted)\)$/, "", id)
                sub(/^.*\(/, "", id)
                sub(/\)$/, "", id)

                candidate = runtime "\t" name "\t" id
            }
            END {
                print candidate
            }
        '
)
IFS=$'\t' read -r SIMULATOR_RUNTIME SIMULATOR_NAME SIMULATOR_ID <<< "$SIMULATOR_INFO"

if [ -z "$SIMULATOR_ID" ]; then
    echo "❌ No iOS 26 iPhone simulator available"
    exit 1
fi

echo "📱 Simulator: $SIMULATOR_NAME (iOS $SIMULATOR_RUNTIME, $SIMULATOR_ID)"

RESULT_BUNDLE_PATH="build/TestResults.xcresult"
mkdir -p build
rm -rf "$RESULT_BUNDLE_PATH"

# Run tests with minimal output (but preserve xcodebuild exit code)
set +e
xcodebuild test \
    -scheme Untether-iOS \
    -project Untether-iOS.xcodeproj \
    -destination "platform=iOS Simulator,id=$SIMULATOR_ID" \
    -enableCodeCoverage YES \
    -quiet \
    -resultBundlePath "$RESULT_BUNDLE_PATH" \
    2>&1 | tee /tmp/untether-ios-xcodebuild-test.log | grep -E "Test Suite|\\*\\* TEST|failed|error:"
xcodebuild_status=${PIPESTATUS[0]}
set -e

# Check result
if [ "$xcodebuild_status" -eq 0 ]; then
    echo "✅ All tests passed!"
    
    # Quick coverage check
    if [ -d "$RESULT_BUNDLE_PATH" ]; then
        COVERAGE=$(xcrun xccov view --report --json "$RESULT_BUNDLE_PATH" 2>/dev/null | jq -r '.lineCoverage' 2>/dev/null | awk '{printf "%.1f", $1 * 100}' || echo "N/A")
        echo "📊 Coverage: ${COVERAGE}%"
    fi
else
    echo "❌ Tests failed!"
    echo "Last xcodebuild output:"
    tail -n 120 /tmp/untether-ios-xcodebuild-test.log || true
    exit 1
fi
