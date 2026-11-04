import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

private let pollInterval: TimeInterval = 2
private let heartbeatInterval: TimeInterval = 30
private let idleThreshold: TimeInterval = 5 * 60
private let maximumNodes = 1_500
private let maximumTextCharacters = 40_000

private struct FocusedElementPayload: Encodable {
    let role: String
    let title: String
    let description: String
    let value: String

    var signature: String {
        "\(role)\u{0}\(title)\u{0}\(description)\u{0}\(value)"
    }
}

private struct ContextPayload: Encodable {
    let type = "context"
    let timestamp: Int64
    let app_name: String
    let bundle_id: String
    let window_title: String
    let text: String
    let text_source = "accessibility"
    let trigger: String
    let monitor_name = ""
    let screenshot_path = ""
    let url: String
    let focused_element: FocusedElementPayload?
    let input_idle_seconds: TimeInterval
}

private struct PermissionsPayload: Encodable {
    let type = "permissions"
    let accessibility: Bool
    let input_monitoring: Bool
}

private struct StatusPayload: Encodable {
    let type: String
}

private struct ErrorPayload: Encodable {
    let type = "error"
    let code: String
    let message: String
}

private struct Snapshot {
    let appName: String
    let bundleId: String
    let windowTitle: String
    let text: String
    let url: String
    let focusedElement: FocusedElementPayload?
    let inputIdleSeconds: TimeInterval

    var signature: String {
        "\(bundleId)\u{0}\(windowTitle)\u{0}\(url)\u{0}\(focusedElement?.signature ?? "")\u{0}\(text)\u{0}\(inputIdleSeconds >= idleThreshold)"
    }
}

private func emit<T: Encodable>(_ payload: T) {
    guard
        let data = try? JSONEncoder().encode(payload),
        let line = String(data: data, encoding: .utf8)
    else {
        return
    }
    print(line)
    fflush(stdout)
}

private func isAccessibilityGranted(prompt: Bool) -> Bool {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
}

private func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name, &value) == .success else {
        return nil
    }
    return value
}

private func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String {
    attribute(element, name) as? String ?? ""
}

private func children(_ element: AXUIElement) -> [AXUIElement] {
    attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
}

private func appendText(_ value: String, to output: inout [String], seen: inout Set<String>, characters: inout Int) {
    let normalized = value
        .replacingOccurrences(of: "\u{00a0}", with: " ")
        .split(whereSeparator: \.isWhitespace)
        .joined(separator: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard normalized.count >= 2, !seen.contains(normalized), characters < maximumTextCharacters else {
        return
    }

    let remaining = maximumTextCharacters - characters
    let retained = String(normalized.prefix(remaining))
    guard !retained.isEmpty else {
        return
    }
    seen.insert(normalized)
    output.append(retained)
    characters += retained.count
}

private func collectText(from root: AXUIElement) -> String {
    var queue = [root]
    var output: [String] = []
    var seen = Set<String>()
    var visited = 0
    var characters = 0

    while !queue.isEmpty, visited < maximumNodes, characters < maximumTextCharacters {
        let element = queue.removeFirst()
        visited += 1
        let role = stringAttribute(element, kAXRoleAttribute as CFString)
        if role == "AXSecureTextField" {
            continue
        }

        appendText(stringAttribute(element, kAXTitleAttribute as CFString), to: &output, seen: &seen, characters: &characters)
        appendText(stringAttribute(element, kAXValueAttribute as CFString), to: &output, seen: &seen, characters: &characters)
        appendText(
            stringAttribute(element, kAXDescriptionAttribute as CFString),
            to: &output,
            seen: &seen,
            characters: &characters
        )
        queue.append(contentsOf: children(element))
    }

    return output.joined(separator: "\n")
}

private func findURL(from root: AXUIElement) -> String {
    var queue = [root]
    var visited = 0
    while !queue.isEmpty, visited < maximumNodes {
        let element = queue.removeFirst()
        visited += 1
        let role = stringAttribute(element, kAXRoleAttribute as CFString)
        if role == "AXSecureTextField" { continue }
        if let value = attribute(element, kAXURLAttribute as CFString) {
            if let url = value as? URL, !url.absoluteString.isEmpty { return url.absoluteString }
            if let url = value as? String, !url.isEmpty { return url }
        }
        queue.append(contentsOf: children(element))
    }
    return ""
}

private func focusedElement(from application: AXUIElement) -> FocusedElementPayload? {
    guard let value = attribute(application, kAXFocusedUIElementAttribute as CFString) else { return nil }
    let element = unsafeBitCast(value, to: AXUIElement.self)
    let role = stringAttribute(element, kAXRoleAttribute as CFString)
    if role == "AXSecureTextField" { return nil }
    let payload = FocusedElementPayload(
        role: String(role.prefix(120)),
        title: String(stringAttribute(element, kAXTitleAttribute as CFString).prefix(500)),
        description: String(stringAttribute(element, kAXDescriptionAttribute as CFString).prefix(500)),
        value: String(stringAttribute(element, kAXValueAttribute as CFString).prefix(2_000))
    )
    return [payload.role, payload.title, payload.description, payload.value].allSatisfy(\.isEmpty) ? nil : payload
}

private func currentSnapshot() -> Snapshot? {
    let idleSeconds = [
        CGEventType.mouseMoved,
        .leftMouseDown,
        .rightMouseDown,
        .keyDown,
        .scrollWheel,
        .flagsChanged,
    ].map {
        CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0)
    }.min() ?? 0
    guard let application = NSWorkspace.shared.frontmostApplication else {
        return nil
    }

    let appElement = AXUIElementCreateApplication(application.processIdentifier)
    guard let focusedWindow = attribute(appElement, kAXFocusedWindowAttribute as CFString) else {
        return Snapshot(
            appName: application.localizedName ?? application.bundleIdentifier ?? "Unknown",
            bundleId: application.bundleIdentifier ?? "",
            windowTitle: "",
            text: "",
            url: "",
            focusedElement: focusedElement(from: appElement),
            inputIdleSeconds: idleSeconds
        )
    }

    let window = unsafeBitCast(focusedWindow, to: AXUIElement.self)
    return Snapshot(
        appName: application.localizedName ?? application.bundleIdentifier ?? "Unknown",
        bundleId: application.bundleIdentifier ?? "",
        windowTitle: stringAttribute(window, kAXTitleAttribute as CFString),
        text: collectText(from: window),
        url: findURL(from: window),
        focusedElement: focusedElement(from: appElement),
        inputIdleSeconds: idleSeconds
    )
}

private func runCollector() {
    guard isAccessibilityGranted(prompt: false) else {
        emit(ErrorPayload(code: "accessibility-permission", message: "Accessibility permission is required"))
        return
    }

    emit(StatusPayload(type: "ready"))
    var shouldStop = false
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    let terminateSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    interruptSource.setEventHandler { shouldStop = true }
    terminateSource.setEventHandler { shouldStop = true }
    interruptSource.resume()
    terminateSource.resume()

    var previousSignature = ""
    var previousAppName = ""
    var previousFocusedElementSignature = ""
    var lastEmission = Date.distantPast

    while !shouldStop {
        autoreleasepool {
            guard AXIsProcessTrusted() else {
                emit(ErrorPayload(code: "accessibility-permission", message: "Accessibility permission was revoked"))
                shouldStop = true
                return
            }
            guard let snapshot = currentSnapshot() else {
                return
            }
            let now = Date()
            let didChange = snapshot.signature != previousSignature
            let isHeartbeat = now.timeIntervalSince(lastEmission) >= heartbeatInterval
            guard didChange || isHeartbeat else {
                return
            }

            let trigger: String
            if snapshot.appName != previousAppName {
                trigger = "app-change"
            } else if snapshot.focusedElement?.signature != previousFocusedElementSignature {
                trigger = "focus-change"
            } else if isHeartbeat && !didChange {
                trigger = "heartbeat"
            } else {
                trigger = "content-change"
            }
            emit(
                ContextPayload(
                    timestamp: Int64(now.timeIntervalSince1970 * 1_000),
                    app_name: snapshot.appName,
                    bundle_id: snapshot.bundleId,
                    window_title: snapshot.windowTitle,
                    text: snapshot.text,
                    trigger: trigger,
                    url: snapshot.url,
                    focused_element: snapshot.focusedElement,
                    input_idle_seconds: snapshot.inputIdleSeconds
                )
            )
            previousSignature = snapshot.signature
            previousAppName = snapshot.appName
            previousFocusedElementSignature = snapshot.focusedElement?.signature ?? ""
            lastEmission = now
        }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: pollInterval))
    }
}

let arguments = Set(CommandLine.arguments.dropFirst())
if arguments.contains("--permission-status") || arguments.contains("--request-permissions") {
    let request = arguments.contains("--request-permissions")
    let accessibility = isAccessibilityGranted(prompt: request)
    let inputMonitoring = CGPreflightListenEventAccess()
    emit(PermissionsPayload(accessibility: accessibility, input_monitoring: inputMonitoring))
} else {
    runCollector()
}
