import AppKit
import Darwin
import Foundation

typealias PIDCallback = @convention(block) (Int32) -> Void
typealias PIDFunction = @convention(c) (DispatchQueue, PIDCallback) -> Void
typealias PlayingCallback = @convention(block) (Bool) -> Void
typealias PlayingFunction = @convention(c) (DispatchQueue, PlayingCallback) -> Void

struct PlaybackState: Encodable {
    let isPlaying: Bool
    let bundleIdentifier: String
    let applicationName: String
}

func emit(_ state: PlaybackState) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(state) else {
        print(#"{"applicationName":"","bundleIdentifier":"","isPlaying":false}"#)
        return
    }
    print(String(decoding: data, as: UTF8.self))
}

guard let framework = dlopen(
    "/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote",
    RTLD_LAZY
) else {
    emit(PlaybackState(isPlaying: false, bundleIdentifier: "", applicationName: ""))
    exit(0)
}

let queue = DispatchQueue(label: "computer.remember.media-playback")
let group = DispatchGroup()
var applicationPID: Int32 = 0
var isPlaying = false

if let symbol = dlsym(framework, "MRMediaRemoteGetNowPlayingApplicationPID") {
    let function = unsafeBitCast(symbol, to: PIDFunction.self)
    group.enter()
    function(queue, { pid in
        applicationPID = pid
        group.leave()
    })
}

if let symbol = dlsym(framework, "MRMediaRemoteGetNowPlayingApplicationIsPlaying") {
    let function = unsafeBitCast(symbol, to: PlayingFunction.self)
    group.enter()
    function(queue, { playing in
        isPlaying = playing
        group.leave()
    })
}

_ = group.wait(timeout: .now() + 2)
let application = NSRunningApplication(processIdentifier: applicationPID)
emit(
    PlaybackState(
        isPlaying: isPlaying,
        bundleIdentifier: application?.bundleIdentifier ?? "",
        applicationName: application?.localizedName ?? ""
    )
)
