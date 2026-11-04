import AppKit
import Foundation

struct Application: Codable {
    let name: String
    let bundleId: String
}

let fileManager = FileManager.default
let roots = [
    URL(fileURLWithPath: "/Applications", isDirectory: true),
    URL(fileURLWithPath: "/System/Applications", isDirectory: true),
    fileManager.homeDirectoryForCurrentUser.appendingPathComponent("Applications", isDirectory: true),
]
var applications: [String: Application] = [:]

for root in roots where fileManager.fileExists(atPath: root.path) {
    guard let enumerator = fileManager.enumerator(
        at: root,
        includingPropertiesForKeys: [.isApplicationKey, .localizedNameKey],
        options: [.skipsHiddenFiles, .skipsPackageDescendants]
    ) else { continue }

    for case let url as URL in enumerator {
        guard url.pathExtension.lowercased() == "app", let bundle = Bundle(url: url), let bundleId = bundle.bundleIdentifier else {
            continue
        }
        let values = try? url.resourceValues(forKeys: [.localizedNameKey])
        let name = values?.localizedName ?? url.deletingPathExtension().lastPathComponent
        applications[bundleId] = Application(name: name, bundleId: bundleId)
    }
}

let sorted = applications.values.sorted {
    $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
}
guard let data = try? JSONEncoder().encode(sorted) else { exit(1) }
FileHandle.standardOutput.write(data)
