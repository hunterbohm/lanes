// Update check for downloaded (signed, notarized) copies of Lanes. A source build has no team id in its Info.plist,
// so it never checks and never updates itself. An update is installed only if the downloaded app is this app
// (same bundle id), at the version GitHub's release names, signed through Apple by the same team that signed the
// running app, and accepted by Gatekeeper as notarized.
import Foundation

struct ReleaseVersion: Comparable, Equatable {
    let parts: [Int]

    /// "v1.2.3" or "1.2.3" (one to three numbers), nil for anything else.
    init?(tag: String) {
        let text = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
        let pieces = text.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...3).contains(pieces.count) else { return nil }
        var numbers: [Int] = []
        for piece in pieces {
            guard !piece.isEmpty, piece.count <= 6, piece.allSatisfy({ ("0"..."9").contains($0) }), let number = Int(piece) else { return nil }
            numbers.append(number)
        }
        parts = numbers + Array(repeating: 0, count: 3 - numbers.count)
    }

    var text: String { parts.map(String.init).joined(separator: ".") }

    static func < (lhs: Self, rhs: Self) -> Bool { lhs.parts.lexicographicallyPrecedes(rhs.parts) }
}

/// The newest release, read from GitHub's `releases/latest` answer.
struct Release: Equatable {
    let version: ReleaseVersion
    let tag: String
    let url: URL
}

/// What the running app is allowed to update to. Nil for a source build: it has no `LanesTeamID`.
struct UpdateChannel: Equatable {
    static let repo = "hunterbohm/lanes"
    static let teamKey = "LanesTeamID"

    let teamID: String
    let bundleID: String
    let current: ReleaseVersion
    let app: URL

    init(teamID: String, bundleID: String, current: ReleaseVersion, app: URL) {
        self.teamID = teamID; self.bundleID = bundleID; self.current = current; self.app = app
    }

    init?(info: [String: Any]?, app: URL) {
        guard let info, let team = info[Self.teamKey] as? String, Self.isTeamID(team),
              let bundleID = info["CFBundleIdentifier"] as? String, Self.isBundleID(bundleID),
              let current = (info["CFBundleShortVersionString"] as? String).flatMap({ ReleaseVersion(tag: $0) }) else { return nil }
        self.init(teamID: team, bundleID: bundleID, current: current, app: app)
    }

    /// What every update's signature must meet: a Developer ID Application certificate (issued through Apple), this
    /// team's, for this bundle id.
    var requirement: String {
        "anchor apple generic and identifier \"\(bundleID)\" and certificate leaf[subject.OU] = \"\(teamID)\""
            + " and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */"
            + " and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */"
    }

    static func isTeamID(_ text: String) -> Bool {
        text.count == 10 && text.allSatisfy { ("A"..."Z").contains($0) || ("0"..."9").contains($0) }
    }

    static func isBundleID(_ text: String) -> Bool {
        !text.isEmpty && text.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") }
    }

    static let latestURL = URL(string: "https://api.github.com/repos/\(repo)/releases/latest")!

    /// The release to offer: a published, non-prerelease tag newer than `current`, with `Lanes-<tag>.zip` attached and
    /// served from this repo's release downloads. Nil for anything else.
    func offer(from data: Data) -> Release? {
        guard let release = Self.parseRelease(data), release.version > current else { return nil }
        return release
    }

    static func parseRelease(_ data: Data) -> Release? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["draft"] as? Bool != true, json["prerelease"] as? Bool != true,
              let tag = json["tag_name"] as? String, let version = ReleaseVersion(tag: tag),
              tag.hasPrefix("v"), let assets = json["assets"] as? [[String: Any]] else { return nil }
        let prefix = "https://github.com/\(repo)/releases/download/\(tag)/"
        for asset in assets where asset["name"] as? String == "Lanes-\(tag).zip" {
            guard let text = asset["browser_download_url"] as? String, text == prefix + "Lanes-\(tag).zip",
                  let url = URL(string: text) else { return nil }
            return Release(version: version, tag: tag, url: url)
        }
        return nil
    }
}

struct UpdateError: Error, CustomStringConvertible {
    let description: String
}

struct CommandResult { let status: Int32; let output: String }

/// Runs a command, merging stderr into the output, and kills it after `timeout` seconds.
func runCommand(_ executable: String, _ arguments: [String], timeout: TimeInterval = 120) async -> CommandResult {
    await withCheckedContinuation { continuation in
        DispatchQueue.global().async {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            do { try process.run() } catch {
                return continuation.resume(returning: CommandResult(status: 127, output: "\(error)"))
            }
            let killer = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            killer.cancel()
            let text = String(decoding: data.prefix(2000), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            continuation.resume(returning: CommandResult(status: process.terminationStatus, output: text))
        }
    }
}

enum Updater {
    static let checkInterval: TimeInterval = 24 * 3600
    static let maxDownload = 100 << 20

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 10 * 60
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }

    /// Asks GitHub for the latest release; nil when it is not newer or the answer is unusable.
    static func check(_ channel: UpdateChannel) async -> Release? {
        var request = URLRequest(url: UpdateChannel.latestURL)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("Lanes", forHTTPHeaderField: "User-Agent")
        guard let (data, response) = try? await session().data(for: request), (response as? HTTPURLResponse)?.statusCode == 200,
              data.count < (1 << 20) else { return nil }
        return channel.offer(from: data)
    }

    /// Downloads `release` and returns the unpacked app, once it passes every check. Throws what failed.
    static func download(_ release: Release, channel: UpdateChannel, into folder: URL) async throws -> URL {
        let archive = folder.appendingPathComponent("Lanes.zip")
        let (temporary, response) = try await session().download(from: release.url)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw UpdateError(description: "the download failed") }
        try? FileManager.default.removeItem(at: archive)
        try FileManager.default.moveItem(at: temporary, to: archive)
        let size = (try? FileManager.default.attributesOfItem(atPath: archive.path)[.size] as? Int) ?? 0
        guard size > 0, size <= maxDownload else { throw UpdateError(description: "the download is \(size) bytes") }

        let unpacked = folder.appendingPathComponent("unpacked")
        try FileManager.default.createDirectory(at: unpacked, withIntermediateDirectories: true)
        let unzip = await runCommand("/usr/bin/ditto", ["-x", "-k", archive.path, unpacked.path], timeout: 300)
        guard unzip.status == 0 else { throw UpdateError(description: "the download is not a usable zip: \(unzip.output)") }
        let items = try FileManager.default.contentsOfDirectory(atPath: unpacked.path).filter { !$0.hasPrefix(".") && $0 != "__MACOSX" }
        guard items == ["Lanes.app"] else { throw UpdateError(description: "expected only Lanes.app, found \(items.sorted())") }
        let app = unpacked.appendingPathComponent("Lanes.app")

        guard let data = FileManager.default.contents(atPath: app.appendingPathComponent("Contents/Info.plist").path),
              let info = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else {
            throw UpdateError(description: "the downloaded app has no Info.plist")
        }
        let id = info["CFBundleIdentifier"] as? String ?? "unknown"
        guard id == channel.bundleID else { throw UpdateError(description: "the downloaded app is \(id), not this app") }
        let shown = info["CFBundleShortVersionString"] as? String ?? "unknown"
        guard ReleaseVersion(tag: shown) == release.version else {
            throw UpdateError(description: "the downloaded app says it is \(shown), not \(release.version.text)")
        }

        let signature = await runCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", "=" + channel.requirement, app.path])
        guard signature.status == 0 else {
            throw UpdateError(description: "the downloaded app is not signed by this app's developer: \(signature.output)")
        }
        let gatekeeper = await runCommand("/usr/sbin/spctl", ["--assess", "--type", "execute", "-vv", app.path])
        guard gatekeeper.status == 0, gatekeeper.output.contains("source=Notarized Developer ID") else {
            throw UpdateError(description: "macOS does not accept the downloaded app as notarized: \(gatekeeper.output)")
        }
        return app
    }

    /// Replaces the installed app with the checked one. The running copy keeps running until it quits.
    static func install(_ app: URL, over destination: URL) throws {
        _ = try FileManager.default.replaceItemAt(destination, withItemAt: app)
    }
}
