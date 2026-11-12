import Foundation
import Testing
@testable import Untether

@Suite("Application Mover Tests")
@MainActor
struct ApplicationMoverTests {
    private let homeDirectory = "/Users/tester"
    private let currentIdentity = ApplicationMover.ApplicationIdentity(
        bundleIdentifier: "com.nachx639.untether",
        buildVersion: "100")

    @Test
    func installedSystemApplicationSuppressesMoveOffer() {
        let shouldOffer = self.shouldOffer(
            bundlePath: "/Users/tester/Downloads/Untether.app",
            installedIdentities: ["/Applications/Untether.app": self.currentIdentity])

        #expect(!shouldOffer)
    }

    @Test
    func installedUserApplicationSuppressesMoveOffer() {
        let shouldOffer = self.shouldOffer(
            bundlePath: "/Volumes/Untether/Untether.app",
            installedIdentities: ["/Users/tester/Applications/Untether.app": self.currentIdentity],
            isRunningFromDMG: true)

        #expect(!shouldOffer)
    }

    @Test
    func temporaryApplicationWithoutInstallationOffersMove() {
        let shouldOffer = self.shouldOffer(bundlePath: "/Users/tester/Downloads/Untether.app")

        #expect(shouldOffer)
    }

    @Test
    func applicationAlreadyRunningFromApplicationsDoesNotOfferMove() {
        let shouldOffer = self.shouldOffer(bundlePath: "/Applications/Untether.app")

        #expect(!shouldOffer)
    }

    @Test
    func differentInstalledBuildStillOffersReplacement() {
        let installedIdentity = ApplicationMover.ApplicationIdentity(
            bundleIdentifier: "com.nachx639.untether",
            buildVersion: "90")
        let shouldOffer = self.shouldOffer(
            bundlePath: "/Volumes/Untether/Untether.app",
            installedIdentities: ["/Applications/Untether.app": installedIdentity],
            isRunningFromDMG: true)

        #expect(shouldOffer)
    }

    @Test
    func newerInstalledBuildSuppressesDowngradeOffer() {
        let installedIdentity = ApplicationMover.ApplicationIdentity(
            bundleIdentifier: "com.nachx639.untether",
            buildVersion: "110")
        let shouldOffer = self.shouldOffer(
            bundlePath: "/Volumes/Untether/Untether.app",
            installedIdentities: ["/Applications/Untether.app": installedIdentity],
            isRunningFromDMG: true)

        #expect(!shouldOffer)
    }

    private func shouldOffer(
        bundlePath: String,
        installedIdentities: [String: ApplicationMover.ApplicationIdentity] = [:],
        isRunningFromDMG: Bool = false) -> Bool
    {
        ApplicationMover.shouldOfferToMove(
            bundlePath: bundlePath,
            appName: "Untether",
            currentIdentity: self.currentIdentity,
            homeDirectory: self.homeDirectory,
            installedIdentity: { installedIdentities[$0] },
            isRunningFromDMG: { _ in isRunningFromDMG })
    }

    // 2026-11-10: the installed app was deleted before the new one was copied.
    @Test
    func aFailedCopyLeavesTheInstalledAppInPlace() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("untether-mover-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let installed = root.appendingPathComponent("Untether.app")
        try FileManager.default.createDirectory(at: installed, withIntermediateDirectories: true)
        try Data("old".utf8).write(to: installed.appendingPathComponent("marker"))

        let missingSource = root.appendingPathComponent("Downloads/Untether.app").path
        #expect(throws: (any Error).self) {
            try ApplicationMover.install(appAt: missingSource, to: installed.path, fileManager: .default)
        }
        #expect(try String(contentsOf: installed.appendingPathComponent("marker"), encoding: .utf8) == "old")
        #expect(!FileManager.default.fileExists(atPath: installed.path + ".installing"))
    }

    @Test
    func theNewAppTakesThePlaceOfTheInstalledOne() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("untether-mover-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let installed = root.appendingPathComponent("Applications/Untether.app")
        try FileManager.default.createDirectory(at: installed, withIntermediateDirectories: true)
        try Data("old".utf8).write(to: installed.appendingPathComponent("marker"))
        try Data("left over".utf8).write(to: installed.appendingPathComponent("only-in-old"))

        let source = root.appendingPathComponent("Downloads/Untether.app")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        try Data("new".utf8).write(to: source.appendingPathComponent("marker"))

        try ApplicationMover.install(appAt: source.path, to: installed.path, fileManager: .default)
        #expect(try String(contentsOf: installed.appendingPathComponent("marker"), encoding: .utf8) == "new")
        #expect(!FileManager.default.fileExists(atPath: installed.appendingPathComponent("only-in-old").path))
        #expect(!FileManager.default.fileExists(atPath: installed.path + ".installing"))
        // The copy the user launched is still there (it is the running app).
        #expect(FileManager.default.fileExists(atPath: source.path))

        // And with nothing installed yet.
        let fresh = root.appendingPathComponent("Applications/Fresh.app")
        try ApplicationMover.install(appAt: source.path, to: fresh.path, fileManager: .default)
        #expect(try String(contentsOf: fresh.appendingPathComponent("marker"), encoding: .utf8) == "new")
    }
}
