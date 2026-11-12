# CLAUDE.md - iOS App

This file provides guidance to Claude Code when working with the iOS companion app for Untether.

## Project Overview

The iOS app is a companion application to Untether that allows viewing and managing terminal sessions from iOS devices.

## Development Setup

1. Open the project in Xcode:
```bash
open ios/Untether-iOS.xcodeproj
```

2. Select your development team in project settings
3. Build and run on simulator or device

## Architecture

- SwiftUI for the user interface
- WebSocket client for real-time terminal data

## Key Files

- `Untether/App/UntetherApp.swift` - Main app entry point
- `Untether/App/ContentView.swift` - Primary UI
- `Untether/Views/Terminal/TerminalView.swift` - Terminal display component
- `Untether/Services/APIClient.swift` - REST communication with the server
- `Untether/Services/BufferWebSocketClient.swift` - Terminal stream over WebSocket

## Building

```bash
# From ios/. The only shared scheme is Untether-iOS.
# Build for simulator
xcodebuild -project Untether-iOS.xcodeproj -scheme Untether-iOS -sdk iphonesimulator

# Build for device
xcodebuild -project Untether-iOS.xcodeproj -scheme Untether-iOS -sdk iphoneos
```

## Testing

```bash
# Run tests (from ios/; pick an installed simulator: `xcrun simctl list devices available`)
xcodebuild test -project Untether-iOS.xcodeproj -scheme Untether-iOS -destination 'platform=iOS Simulator,id=<simulator-udid>'
```

## Viewing Logs

Use the provided script to view iOS app logs with unredacted private data:

```bash
# Last 100 lines (without arguments the script only prints its help)
./ios/scripts/utlog.sh -n 100

# Filter by category
./ios/scripts/utlog.sh -c NetworkMonitor

# Search for specific terms
./ios/scripts/utlog.sh -s "connection"
```

If prompted for password when viewing logs, see [apple/docs/logging-private-fix.md](../apple/docs/logging-private-fix.md) for setup instructions.

## Common Issues

### Simulator Connection Issues
- Ensure the Mac app server is running
- Check that simulator can reach localhost:4020
- Verify no firewall blocking connections

### Device Testing
- Device must be on same network as Mac
- Use Mac's IP address instead of localhost
- Check network permissions in iOS settings