#!/bin/bash

# Untether Logging Utility
# Simplifies access to Untether logs using macOS unified logging system

set -euo pipefail

# Configuration
SUBSYSTEM="com.nachx639.untether"
DEFAULT_LEVEL="info"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to handle sudo password errors
handle_sudo_error() {
    echo -e "\n${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}⚠️  Password Required for Log Access${NC}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
    echo -e "utlog needs to use sudo to show complete log data (Apple hides sensitive info by default)."
    echo -e "\nTo avoid password prompts, configure passwordless sudo for the log command:"
    echo -e "See: ${BLUE}apple/docs/logging-private-fix.md${NC}\n"
    echo -e "Quick fix:"
    echo -e "  1. Run: ${GREEN}sudo visudo${NC}"
    echo -e "  2. Add: ${GREEN}$(whoami) ALL=(ALL) NOPASSWD: /usr/bin/log${NC}"
    echo -e "  3. Save and exit (:wq)\n"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
    exit 1
}

# Default values
STREAM_MODE=false
TIME_RANGE="5m"  # Default to last 5 minutes
CATEGORY=""
LOG_LEVEL="$DEFAULT_LEVEL"
SEARCH_TEXT=""
OUTPUT_FILE=""
ERRORS_ONLY=false
TAIL_LINES=50  # Default number of lines to show
SHOW_TAIL=true

# Function to show usage
show_usage() {
    cat << EOF
utlog - Untether Logging Utility

USAGE:
    utlog [OPTIONS]

DESCRIPTION:
    View Untether logs with full details (bypasses Apple's privacy redaction).
    Requires sudo access configured for /usr/bin/log command.

LOG FLOW ARCHITECTURE:
    Untether logs flow through multiple layers:
    
    1. Web Frontend (Browser) → Uses console.log/error
       ↓
    2. Node.js Server → Logs prefixed with server component names
       ↓
    3. macOS System Logs → Captured by this tool
    
    This tool captures ALL logs from the entire stack in one unified view.

LOG PREFIX SYSTEM:
    To identify where logs originate, Untether uses these prefixes:
    
    • [FE] module-name    - Frontend (browser) logs forwarded from the web UI
    • [SRV] module-name   - Server-side logs from Node.js/Bun components
    • [category-name]     - Native Mac app logs (no prefix needed)
    
    Examples:
    • [FE] terminal       - Terminal component in the browser
    • [SRV] api          - Server API endpoint handler
    • [ServerManager]     - Native Swift component

LOG PREFIXES BY COMPONENT:
    • [ServerManager]     - Server lifecycle and configuration
    • [TerminalLauncher]  - Terminal spawning and control
    • [UnixSocket]        - Unix socket communication
    • [WindowTracker]     - Window focus and tracking
    • [ServerOutput]      - Raw Node.js server console output
    • [GitAppLauncher]    - Git app integration

QUICK START:
    utlog -n 100             Show last 100 lines from all components
    utlog -f                 Follow logs in real-time
    utlog -e                 Show only errors
    utlog -c ServerManager   Show logs from ServerManager only

OPTIONS:
    -h, --help              Show this help message
    -f, --follow            Stream logs continuously (like tail -f)
    -n, --lines NUM         Number of lines to show (default: 50)
    -l, --last TIME         Time range to search (default: 5m)
                           Examples: 5m, 1h, 2d, 1w
    -c, --category CAT      Filter by category (e.g., ServerManager, SessionService)
    -e, --errors            Show only error messages
    -d, --debug             Show debug level logs (more verbose)
    -s, --search TEXT       Search for specific text in log messages
    -o, --output FILE       Export logs to file
    --server                Show only server output logs
    --all                   Show all logs without tail limit
    --list-categories       List all available log categories
    --json                  Output in JSON format

EXAMPLES:
    utlog                   Show last 50 lines from past 5 minutes (default)
    utlog -f                Stream logs continuously
    utlog -n 100            Show last 100 lines
    utlog -e                Show only recent errors
    utlog -l 30m -n 200     Show last 200 lines from past 30 minutes
    utlog -c ServerManager  Show recent ServerManager logs
    utlog -s "fail"         Search for "fail" in recent logs
    utlog --server -e       Show recent server errors
    utlog -f -d             Stream debug logs continuously

CATEGORIES:
    Common categories include:
    - ServerManager         - Server lifecycle and configuration
    - TerminalLauncher      - Terminal spawning and control
    - GitRepositoryMonitor  - Git integration features
    - UnixSocket           - Unix socket communication
    - WindowTracker        - Window tracking and focus
    - NgrokService         - Ngrok tunnel management
    - ServerOutput         - Node.js server output

TIME FORMATS:
    - 5m  = 5 minutes       - 1h  = 1 hour
    - 2d  = 2 days         - 1w  = 1 week

EOF
}

# Function to list categories
list_categories() {
    echo -e "${BLUE}Fetching Untether log categories from the last hour...${NC}\n"
    
    # Get unique categories from recent logs
    log show --predicate "subsystem == \"$SUBSYSTEM\"" --last 1h 2>/dev/null | \
        grep -E "category: \"[^\"]+\"" | \
        sed -E 's/.*category: "([^"]+)".*/\1/' | \
        sort | uniq | \
        while read -r cat; do
            echo "  • $cat"
        done
    
    echo -e "\n${YELLOW}Note: Only categories with recent activity are shown${NC}"
}

# Show help if no arguments provided
if [[ $# -eq 0 ]]; then
    show_usage
    exit 0
fi

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_usage
            exit 0
            ;;
        -f|--follow)
            STREAM_MODE=true
            SHOW_TAIL=false
            shift
            ;;
        -n|--lines)
            TAIL_LINES="$2"
            shift 2
            ;;
        -l|--last)
            TIME_RANGE="$2"
            shift 2
            ;;
        -c|--category)
            CATEGORY="$2"
            shift 2
            ;;
        -e|--errors)
            ERRORS_ONLY=true
            shift
            ;;
        -d|--debug)
            LOG_LEVEL="debug"
            shift
            ;;
        -s|--search)
            SEARCH_TEXT="$2"
            shift 2
            ;;
        -o|--output)
            OUTPUT_FILE="$2"
            shift 2
            ;;
        --server)
            CATEGORY="ServerOutput"
            shift
            ;;
        --list-categories)
            list_categories
            exit 0
            ;;
        --json)
            STYLE_ARGS="--style json"
            shift
            ;;
        --all)
            SHOW_TAIL=false
            shift
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            echo "Use -h or --help for usage information"
            exit 1
            ;;
    esac
done

# A value inside the predicate's double quotes: backslashes and double quotes escaped.
predicate_value() {
    local value=${1//\\/\\\\}
    printf '%s' "${value//\"/\\\"}"
}

# Build the predicate
PREDICATE="subsystem == \"$SUBSYSTEM\""

# Add category filter if specified
if [[ -n "$CATEGORY" ]]; then
    PREDICATE="$PREDICATE AND category == \"$(predicate_value "$CATEGORY")\""
fi

# Add error filter if specified
if [[ "$ERRORS_ONLY" == true ]]; then
    PREDICATE="$PREDICATE AND (eventType == \"error\" OR messageType == \"error\" OR eventMessage CONTAINS \"ERROR\" OR eventMessage CONTAINS \"[31m\")"
fi

# Add search filter if specified
if [[ -n "$SEARCH_TEXT" ]]; then
    PREDICATE="$PREDICATE AND eventMessage CONTAINS[c] \"$(predicate_value "$SEARCH_TEXT")\""
fi

# Build the command - always use sudo with --info to show private data.
# An argument list, never a string to eval: a search text with an apostrophe broke the command
# and a crafted one ran as a command (2026-11-10).
if [[ "$STREAM_MODE" == true ]]; then
    # Streaming mode
    CMD=(sudo log stream --predicate "$PREDICATE" --level "$LOG_LEVEL" --info)
    
    echo -e "${GREEN}Streaming Untether logs continuously...${NC}"
    echo -e "${YELLOW}Press Ctrl+C to stop${NC}\n"
else
    # Show mode
    CMD=(sudo log show --predicate "$PREDICATE")
    
    # Add log level for show command
    if [[ "$LOG_LEVEL" == "debug" ]]; then
        CMD+=(--debug)
    else
        CMD+=(--info)
    fi
    
    # Add time range
    CMD+=(--last "$TIME_RANGE")
    
    if [[ "$SHOW_TAIL" == true ]]; then
        echo -e "${GREEN}Showing last $TAIL_LINES log lines from the past $TIME_RANGE${NC}"
    else
        echo -e "${GREEN}Showing all logs from the past $TIME_RANGE${NC}"
    fi
    
    # Show applied filters
    if [[ "$ERRORS_ONLY" == true ]]; then
        echo -e "${RED}Filter: Errors only${NC}"
    fi
    if [[ -n "$CATEGORY" ]]; then
        echo -e "${BLUE}Category: $CATEGORY${NC}"
    fi
    if [[ -n "$SEARCH_TEXT" ]]; then
        echo -e "${YELLOW}Search: \"$SEARCH_TEXT\"${NC}"
    fi
    echo ""  # Empty line for readability
fi

# Add style arguments if specified
if [[ -n "${STYLE_ARGS:-}" ]]; then
    # shellcheck disable=SC2206 # two words on purpose: --style json
    CMD+=($STYLE_ARGS)
fi

# Execute the command
if [[ -n "$OUTPUT_FILE" ]]; then
    # First check if sudo works without password for the log command
    if sudo -n /usr/bin/log show --last 1s 2>&1 | grep -q "password"; then
        handle_sudo_error
    fi
    
    echo -e "${BLUE}Exporting logs to: $OUTPUT_FILE${NC}\n"
    if [[ "$SHOW_TAIL" == true ]] && [[ "$STREAM_MODE" == false ]]; then
        "${CMD[@]}" 2>&1 | tail -n "$TAIL_LINES" > "$OUTPUT_FILE"
    else
        "${CMD[@]}" > "$OUTPUT_FILE" 2>&1
    fi
    
    # Check if file was created and has content
    if [[ -s "$OUTPUT_FILE" ]]; then
        LINE_COUNT=$(wc -l < "$OUTPUT_FILE" | tr -d ' ')
        echo -e "${GREEN}✓ Exported $LINE_COUNT lines to $OUTPUT_FILE${NC}"
    else
        echo -e "${YELLOW}⚠ No logs found matching the criteria${NC}"
    fi
else
    # Run interactively
    # First check if sudo works without password for the log command
    if sudo -n /usr/bin/log show --last 1s 2>&1 | grep -q "password"; then
        handle_sudo_error
    fi
    
    if [[ "$SHOW_TAIL" == true ]] && [[ "$STREAM_MODE" == false ]]; then
        # Apply tail for non-streaming mode
        "${CMD[@]}" 2>&1 | tail -n "$TAIL_LINES"
        echo -e "\n${YELLOW}Showing last $TAIL_LINES lines. Use --all or -n to see more.${NC}"
    else
        "${CMD[@]}"
    fi
fi