# Untether iOS Tests

This directory contains the test suite for the Untether iOS application using Swift Testing framework.

## Test Structure

```
UntetherTests/
├── Mocks/        # Test doubles (keychain, network monitor, URL protocol, WebSocket…)
├── Models/       # Data model tests
├── Services/     # Service layer tests
├── Utilities/    # TestFixtures.swift, TestTags.swift
├── Utils/        # JSONValue and Logger tests
├── ViewModels/   # View model tests
└── Views/        # View and terminal view model tests
```

The folder is a file-system-synchronized group of the `UntetherTests` target in
`Untether-iOS.xcodeproj`: every Swift file in it is compiled, and tests reach the
app with `@testable import Untether`. There is no Swift package, so `swift test`
does not work here.

## Running Tests

### Command Line
```bash
cd ios
./scripts/quick-test.sh            # run the suite on an installed simulator
./scripts/test-with-coverage.sh    # same, with the coverage report (75% threshold)
```

### Xcode
1. Open `Untether-iOS.xcodeproj`
2. Select the `Untether-iOS` scheme
3. Press `Cmd+U` or choose Product → Test

### CI
Tests run automatically in GitHub Actions on every push and pull request.

## Test Tags

Tests are organized with tags for selective execution:
- `@Tag.critical` - Core functionality tests
- `@Tag.networking` - Network-related tests
- `@Tag.websocket` - WebSocket functionality
- `@Tag.models` - Data model tests
- `@Tag.persistence` - Data persistence tests
- `@Tag.integration` - Integration tests

## Writing Tests

This project uses Swift Testing (not XCTest). Key differences:
- Use `@Test` attribute instead of `test` prefix
- Use `#expect()` instead of `XCTAssert`
- Use `@Suite` to group related tests
- Tests run in parallel by default

Example:
```swift
@Suite("MyFeature Tests", .tags(.critical))
struct MyFeatureTests {
    @Test("Does something correctly")
    func testFeature() async throws {
        // Arrange
        let sut = MyFeature()
        
        // Act
        let result = try await sut.doSomething()
        
        // Assert
        #expect(result == expectedValue)
    }
}
```
