// Tests for Sources/Update.swift. Run: app/test.sh (needs macOS and the Xcode command line tools).
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String, line: Int = #line) {
    if !ok { failures += 1; print("FAIL line \(line): \(what)") }
}

func release(tag: String = "v1.2.0", draft: Bool = false, prerelease: Bool = false, name: String? = nil, url: String? = nil) -> Data {
    let asset = name ?? "Lanes-\(tag).zip"
    let link = url ?? "https://github.com/hunterbohm/lanes/releases/download/\(tag)/\(asset)"
    let json: [String: Any] = ["tag_name": tag, "draft": draft, "prerelease": prerelease,
                               "assets": [["name": asset, "browser_download_url": link]]]
    return try! JSONSerialization.data(withJSONObject: json)
}

let channel = UpdateChannel(teamID: "ABCDE12345", bundleID: "io.example.lanes", current: ReleaseVersion(tag: "1.1.0")!,
                            app: URL(fileURLWithPath: "/Applications/Lanes.app"))

@main struct UpdateTests {
    static func main() {
        // versions
        check(ReleaseVersion(tag: "v1.2.3")!.parts == [1, 2, 3], "tag with v")
        check(ReleaseVersion(tag: "1.2")!.parts == [1, 2, 0], "two numbers")
        check(ReleaseVersion(tag: "1.2.3.4") == nil, "four numbers")
        check(ReleaseVersion(tag: "v1.x") == nil, "letters")
        check(ReleaseVersion(tag: "") == nil, "empty")
        check(ReleaseVersion(tag: "1.10.0")! > ReleaseVersion(tag: "1.9.9")!, "numeric, not text, order")
        check(ReleaseVersion(tag: "v1.2.0") == ReleaseVersion(tag: "1.2"), "v and short form are equal")

        // which release is offered
        check(channel.offer(from: release())?.version.text == "1.2.0", "newer release is offered")
        check(channel.offer(from: release(tag: "v1.1.0")) == nil, "same version is not offered")
        check(channel.offer(from: release(tag: "v1.0.0")) == nil, "older version is not offered")
        check(channel.offer(from: release(draft: true)) == nil, "draft is not offered")
        check(channel.offer(from: release(prerelease: true)) == nil, "prerelease is not offered")
        check(channel.offer(from: release(tag: "1.2.0")) == nil, "tag without v is not offered")
        check(channel.offer(from: release(name: "Other.zip")) == nil, "wrong asset name")
        check(channel.offer(from: release(url: "https://evil.example/Lanes-v1.2.0.zip")) == nil, "foreign download host")
        check(channel.offer(from: release(url: "http://github.com/hunterbohm/lanes/releases/download/v1.2.0/Lanes-v1.2.0.zip")) == nil, "plain http")
        check(channel.offer(from: release(url: "https://github.com/other/lanes/releases/download/v1.2.0/Lanes-v1.2.0.zip")) == nil, "other repo")
        check(channel.offer(from: Data("not json".utf8)) == nil, "garbage")
        check(channel.offer(from: Data("{}".utf8)) == nil, "empty object")

        // the signing requirement
        check(channel.requirement.contains("identifier \"io.example.lanes\""), "requirement names the bundle id")
        check(channel.requirement.contains("certificate leaf[subject.OU] = \"ABCDE12345\""), "requirement names the team")
        check(channel.requirement.hasPrefix("anchor apple generic"), "requirement is Apple-issued")

        // the channel exists only for a stamped app
        let info: [String: Any] = ["LanesTeamID": "ABCDE12345", "CFBundleIdentifier": "io.example.lanes", "CFBundleShortVersionString": "1.1.0"]
        let app = URL(fileURLWithPath: "/Applications/Lanes.app")
        check(UpdateChannel(info: info, app: app) == channel, "stamped app has a channel")
        var unstamped = info; unstamped["LanesTeamID"] = nil
        check(UpdateChannel(info: unstamped, app: app) == nil, "source build has no channel")
        var badTeam = info; badTeam["LanesTeamID"] = "abc"
        check(UpdateChannel(info: badTeam, app: app) == nil, "malformed team id has no channel")
        check(UpdateChannel(info: nil, app: app) == nil, "no Info.plist has no channel")

        print(failures == 0 ? "all update tests passed" : "\(failures) failed")
        exit(failures == 0 ? 0 : 1)
    }
}
