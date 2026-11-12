#!/bin/bash
set -euo pipefail

# Script to run iOS tests with code coverage using xcodebuild

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Running Untether iOS Tests with Coverage${NC}"

# Check if we're in the right directory
if [ ! -f "Untether-iOS.xcodeproj/project.pbxproj" ]; then
    echo -e "${RED}Error: Must run from ios/ directory${NC}"
    exit 1
fi

# Clean build directory
echo -e "${YELLOW}Cleaning build directory...${NC}"
rm -rf build

# Use the first available iPhone simulator. `simctl` prints
# "    iPhone 17 (UDID) (Shutdown)", so the UDID is matched by its shape.
SIMULATOR_ID=$(xcrun simctl list devices available | grep "iPhone" | grep -oE '[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}' | head -1 || true)
if [ -z "$SIMULATOR_ID" ]; then
    echo -e "${RED}Error: no available iPhone simulator found${NC}"
    exit 1
fi

echo -e "${GREEN}Using simulator: $SIMULATOR_ID${NC}"

# xcbeautify only prettifies the output: without it the raw log is shown
if command -v xcbeautify >/dev/null 2>&1; then
    FORMATTER=xcbeautify
else
    FORMATTER=cat
fi

# Build and test with coverage
echo -e "${YELLOW}Building and testing...${NC}"
set +e
xcodebuild test \
    -scheme Untether-iOS \
    -project Untether-iOS.xcodeproj \
    -destination "platform=iOS Simulator,id=$SIMULATOR_ID" \
    -enableCodeCoverage YES \
    -derivedDataPath build \
    -resultBundlePath build/TestResults.xcresult \
    | $FORMATTER
TEST_STATUS=${PIPESTATUS[0]}
set -e

# Check if tests passed
if [ "$TEST_STATUS" -eq 0 ]; then
    echo -e "${GREEN}✓ Tests passed!${NC}"
else
    echo -e "${RED}✗ Tests failed!${NC}"
    exit 1
fi

# Extract coverage data
echo -e "${YELLOW}Extracting coverage data...${NC}"
xcrun xccov view --report --json build/TestResults.xcresult > build/coverage.json

# Calculate coverage percentage
COVERAGE=$(cat build/coverage.json | jq -r '.lineCoverage' | awk '{printf "%.1f", $1 * 100}')
echo -e "${GREEN}Line Coverage: ${COVERAGE}%${NC}"

# Generate human-readable coverage report
echo -e "${YELLOW}Generating coverage report...${NC}"
xcrun xccov view --report build/TestResults.xcresult > build/coverage.txt

# Show coverage summary
echo -e "\n${GREEN}Coverage Summary:${NC}"
xcrun xccov view --report build/TestResults.xcresult | head -20

# Optional: Open coverage report in Xcode
echo -e "\n${YELLOW}To view detailed coverage in Xcode, run:${NC}"
echo "open build/TestResults.xcresult"

# Check if coverage meets threshold (75% as per CI)
THRESHOLD=75
if (( $(echo "$COVERAGE < $THRESHOLD" | bc -l) )); then
    echo -e "\n${RED}⚠️  Coverage ${COVERAGE}% is below threshold of ${THRESHOLD}%${NC}"
    exit 1
else
    echo -e "\n${GREEN}✓ Coverage ${COVERAGE}% meets threshold of ${THRESHOLD}%${NC}"
fi