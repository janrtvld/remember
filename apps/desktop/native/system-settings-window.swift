import AppKit
import CoreGraphics
import Foundation

struct WindowBounds: Codable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

let bundleIdentifiers = [
  "com.apple.systempreferences",
  "com.apple.SystemSettings",
]

guard let application = bundleIdentifiers
  .lazy
  .compactMap({ NSRunningApplication.runningApplications(withBundleIdentifier: $0).first })
  .first
else {
  exit(1)
}

if CommandLine.arguments.contains("--close") {
  guard application.terminate() else {
    exit(1)
  }

  let deadline = Date().addingTimeInterval(0.75)
  while !application.isTerminated && Date() < deadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
  }
  exit(0)
}

guard let windows = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements],
    CGWindowID(0)
  ) as? [[String: Any]]
else {
  exit(1)
}

let candidates = windows.compactMap { window -> WindowBounds? in
  guard
    let ownerPID = window[kCGWindowOwnerPID as String] as? Int,
    ownerPID == Int(application.processIdentifier),
    let layer = window[kCGWindowLayer as String] as? Int,
    layer == 0,
    let rawBounds = window[kCGWindowBounds as String] as? [String: Any],
    let bounds = CGRect(dictionaryRepresentation: rawBounds as CFDictionary),
    bounds.width >= 600,
    bounds.height >= 400
  else {
    return nil
  }

  return WindowBounds(
    x: Double(bounds.origin.x),
    y: Double(bounds.origin.y),
    width: Double(bounds.width),
    height: Double(bounds.height)
  )
}

guard
  let largestWindow = candidates.max(by: {
    $0.width * $0.height < $1.width * $1.height
  }),
  let encodedBounds = try? JSONEncoder().encode(largestWindow)
else {
  exit(1)
}

FileHandle.standardOutput.write(encodedBounds)
