import CoreAudio
import Foundation

private let targetSampleRate = 16_000
private let defaultChunkDurationMs = 60_000
private let tapPropertyReadAttempts = 40
private let tapPropertyRetryInterval = 0.1
private let excludedBundleIdentifiers = [
    "computer.remember.app",
    "com.github.Electron",
    "com.apple.Music",
    "com.spotify.client",
    "com.apple.podcasts",
    "com.apple.TV",
]

private struct ReadyPayload: Encodable {
    let type = "ready"
    let sample_rate: Int
    let excluded_apps: [String]
}

private struct ChunkPayload: Encodable {
    let type = "chunk"
    let path: String
    let started_at: Int64
    let duration_ms: Int
    let average_level: Double
    let capture_epoch_id: String
    let sequence: Int
    let sample_count: Int
    let first_sample_time: Double?
}

private struct LevelPayload: Encodable {
    let type = "level"
    let rms: Double
}

private struct ErrorPayload: Encodable {
    let type = "error"
    let code: String
    let message: String
}

private enum CaptureError: Error, CustomStringConvertible {
    case coreAudio(String, OSStatus)
    case unsupportedFormat
    case missingOutputDirectory

    var description: String {
        switch self {
        case let .coreAudio(operation, status):
            return "\(operation) failed (\(status))"
        case .unsupportedFormat:
            return "Core Audio tap returned an unsupported PCM format"
        case .missingOutputDirectory:
            return "--output-dir requires a directory"
        }
    }
}

private final class SampleBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var samples: [Float] = []
    private var squareTotal: Double = 0
    private var meterSquares: Double = 0
    private var meterCount: Int = 0
    private var startedAt = Date()
    private var firstSampleTime: Double?

    func append(_ values: [Float], sampleTime: Double?) {
        guard !values.isEmpty else {
            return
        }
        lock.lock()
        if samples.isEmpty {
            startedAt = Date()
            firstSampleTime = sampleTime
        }
        samples.append(contentsOf: values)
        for value in values {
            squareTotal += Double(value * value)
            meterSquares += Double(value * value)
        }
        meterCount += values.count
        lock.unlock()
    }

    func meterLevel() -> Double {
        lock.lock()
        defer { lock.unlock() }
        let rms = meterCount > 0 ? sqrt(meterSquares / Double(meterCount)) : 0
        meterSquares = 0
        meterCount = 0
        return rms.isFinite ? min(1, max(0, rms)) : 0
    }

    func drain() -> (samples: [Float], squareTotal: Double, startedAt: Date, firstSampleTime: Double?) {
        lock.lock()
        defer { lock.unlock() }
        let drained = (samples, squareTotal, startedAt, firstSampleTime)
        samples = []
        squareTotal = 0
        startedAt = Date()
        firstSampleTime = nil
        return drained
    }
}

private final class CoreAudioTapCapture {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private let sampleBuffer: SampleBuffer
    private(set) var format = AudioStreamBasicDescription()

    init(sampleBuffer: SampleBuffer) {
        self.sampleBuffer = sampleBuffer
    }

    deinit {
        stop()
    }

    func start() throws {
        guard #available(macOS 14.2, *) else {
            throw CaptureError.coreAudio("Core Audio process taps require macOS 14.2", -1)
        }

        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.name = "Remember system audio"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        if #available(macOS 26.0, *) {
            description.bundleIDs = excludedBundleIdentifiers
            description.isExclusive = true
            description.isProcessRestoreEnabled = true
        }

        try requireSuccess(AudioHardwareCreateProcessTap(description, &tapID), "Create process tap")
        format = try readTapFormat(tapID)
        guard
            format.mFormatID == kAudioFormatLinearPCM,
            format.mBitsPerChannel == 32,
            format.mFormatFlags & kAudioFormatFlagIsFloat != 0
        else {
            throw CaptureError.unsupportedFormat
        }

        let tapUID = try readTapUID(tapID)
        let aggregateUID = "computer.remember.system-audio.\(UUID().uuidString)"
        let tapConfiguration: [String: Any] = [
            kAudioSubTapUIDKey: tapUID,
            kAudioSubTapDriftCompensationKey: true,
        ]
        let aggregateDescription: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Remember System Audio",
            kAudioAggregateDeviceUIDKey: aggregateUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [tapConfiguration],
        ]
        try requireSuccess(
            AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateDeviceID),
            "Create aggregate device"
        )

        let streamFormat = format
        let buffer = sampleBuffer
        try requireSuccess(
            AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateDeviceID, nil) {
                _, inputData, inputTime, _, _ in
                let sampleTime = inputTime.pointee.mFlags.contains(.sampleTimeValid) ? inputTime.pointee.mSampleTime : nil
                buffer.append(monoSamples(from: inputData, format: streamFormat), sampleTime: sampleTime)
            },
            "Create audio callback"
        )
        try requireSuccess(AudioDeviceStart(aggregateDeviceID, ioProcID), "Start audio capture")
    }

    func stop() {
        if aggregateDeviceID != kAudioObjectUnknown, let ioProcID {
            AudioDeviceStop(aggregateDeviceID, ioProcID)
            AudioDeviceDestroyIOProcID(aggregateDeviceID, ioProcID)
            self.ioProcID = nil
        }
        if aggregateDeviceID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            aggregateDeviceID = kAudioObjectUnknown
        }
        if tapID != kAudioObjectUnknown {
            if #available(macOS 14.2, *) {
                AudioHardwareDestroyProcessTap(tapID)
            }
            tapID = kAudioObjectUnknown
        }
    }
}

private func emit<T: Encodable>(_ payload: T) {
    guard let data = try? JSONEncoder().encode(payload), let line = String(data: data, encoding: .utf8) else {
        return
    }
    print(line)
    fflush(stdout)
}

private func requireSuccess(_ status: OSStatus, _ operation: String) throws {
    if status != noErr {
        throw CaptureError.coreAudio(operation, status)
    }
}

private func propertyAddress(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
}

private func readTapUID(_ tapID: AudioObjectID) throws -> String {
    for attempt in 0..<tapPropertyReadAttempts {
        var address = propertyAddress(kAudioTapPropertyUID)
        var size = UInt32(MemoryLayout<CFString?>.size)
        var value: CFString?
        let status = withUnsafeMutablePointer(to: &value) {
            AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, $0)
        }
        if status == noErr, let value {
            return value as String
        }
        if status != kAudioHardwareBadObjectError || attempt == tapPropertyReadAttempts - 1 {
            throw CaptureError.coreAudio("Read tap UID", status)
        }
        Thread.sleep(forTimeInterval: tapPropertyRetryInterval)
    }
    throw CaptureError.coreAudio("Read tap UID", kAudioHardwareBadObjectError)
}

private func readTapFormat(_ tapID: AudioObjectID) throws -> AudioStreamBasicDescription {
    for attempt in 0..<tapPropertyReadAttempts {
        var address = propertyAddress(kAudioTapPropertyFormat)
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var format = AudioStreamBasicDescription()
        let status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &format)
        if status == noErr {
            return format
        }
        if status != kAudioHardwareBadObjectError || attempt == tapPropertyReadAttempts - 1 {
            throw CaptureError.coreAudio("Read tap format", status)
        }
        Thread.sleep(forTimeInterval: tapPropertyRetryInterval)
    }
    throw CaptureError.coreAudio("Read tap format", kAudioHardwareBadObjectError)
}

private func monoSamples(
    from inputData: UnsafePointer<AudioBufferList>,
    format: AudioStreamBasicDescription
) -> [Float] {
    let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
    let isNonInterleaved = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
    let channelCount = max(1, Int(format.mChannelsPerFrame))

    if isNonInterleaved {
        guard let first = buffers.first, first.mData != nil else {
            return []
        }
        let frameCount = Int(first.mDataByteSize) / MemoryLayout<Float>.size
        var output = [Float](repeating: 0, count: frameCount)
        let usedBuffers = buffers.prefix(channelCount)
        for audioBuffer in usedBuffers {
            guard let data = audioBuffer.mData else {
                continue
            }
            let values = data.assumingMemoryBound(to: Float.self)
            for frame in 0 ..< frameCount {
                output[frame] += values[frame] / Float(usedBuffers.count)
            }
        }
        return output
    }

    guard let audioBuffer = buffers.first, let data = audioBuffer.mData else {
        return []
    }
    let sampleCount = Int(audioBuffer.mDataByteSize) / MemoryLayout<Float>.size
    let frameCount = sampleCount / channelCount
    let values = data.assumingMemoryBound(to: Float.self)
    var output = [Float](repeating: 0, count: frameCount)
    for frame in 0 ..< frameCount {
        var total: Float = 0
        for channel in 0 ..< channelCount {
            total += values[frame * channelCount + channel]
        }
        output[frame] = total / Float(channelCount)
    }
    return output
}

private func resample(_ input: [Float], from sourceRate: Double, to targetRate: Int) -> [Float] {
    guard !input.isEmpty, sourceRate > 0 else {
        return []
    }
    if abs(sourceRate - Double(targetRate)) < 1 {
        return input
    }
    let outputCount = Int(Double(input.count) * Double(targetRate) / sourceRate)
    guard outputCount > 0 else {
        return []
    }
    return (0 ..< outputCount).map { index in
        let sourcePosition = Double(index) * sourceRate / Double(targetRate)
        let lower = min(input.count - 1, Int(sourcePosition))
        let upper = min(input.count - 1, lower + 1)
        let fraction = Float(sourcePosition - Double(lower))
        return input[lower] + (input[upper] - input[lower]) * fraction
    }
}

private func wavData(samples: [Float], sampleRate: Int) -> Data {
    var data = Data()
    func append<T>(_ value: T) {
        var mutable = value
        withUnsafeBytes(of: &mutable) { data.append(contentsOf: $0) }
    }
    data.append("RIFF".data(using: .ascii)!)
    append(UInt32(36 + samples.count * 2).littleEndian)
    data.append("WAVEfmt ".data(using: .ascii)!)
    append(UInt32(16).littleEndian)
    append(UInt16(1).littleEndian)
    append(UInt16(1).littleEndian)
    append(UInt32(sampleRate).littleEndian)
    append(UInt32(sampleRate * 2).littleEndian)
    append(UInt16(2).littleEndian)
    append(UInt16(16).littleEndian)
    data.append("data".data(using: .ascii)!)
    append(UInt32(samples.count * 2).littleEndian)
    for sample in samples {
        let clamped = max(-1, min(1, sample))
        append(Int16(clamped < 0 ? clamped * 32_768 : clamped * 32_767).littleEndian)
    }
    return data
}

private func argumentValue(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), CommandLine.arguments.indices.contains(index + 1) else {
        return nil
    }
    return CommandLine.arguments[index + 1]
}

private func flush(
    sampleBuffer: SampleBuffer,
    sourceRate: Double,
    outputDirectory: URL,
    captureEpochId: String,
    sequence: inout Int
) {
    let drained = sampleBuffer.drain()
    guard !drained.samples.isEmpty else {
        return
    }
    let samples = resample(drained.samples, from: sourceRate, to: targetSampleRate)
    guard !samples.isEmpty else {
        return
    }
    let averageLevel = sqrt(drained.squareTotal / Double(drained.samples.count))
    let startedAt = Int64(drained.startedAt.timeIntervalSince1970 * 1_000)
    let currentSequence = sequence
    sequence += 1
    let file = outputDirectory.appendingPathComponent("\(startedAt)-system.wav")
    do {
        try wavData(samples: samples, sampleRate: targetSampleRate).write(to: file, options: .atomic)
        emit(
            ChunkPayload(
                path: file.path,
                started_at: startedAt,
                duration_ms: Int(Double(samples.count) / Double(targetSampleRate) * 1_000),
                average_level: averageLevel,
                capture_epoch_id: captureEpochId,
                sequence: currentSequence,
                sample_count: samples.count,
                first_sample_time: drained.firstSampleTime
            )
        )
    } catch {
        emit(ErrorPayload(code: "storage-failed", message: error.localizedDescription))
    }
}

private func run() throws {
    guard let outputPath = argumentValue("--output-dir") else {
        throw CaptureError.missingOutputDirectory
    }
    let outputDirectory = URL(fileURLWithPath: outputPath, isDirectory: true)
    try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
    let chunkDurationMs = Int(argumentValue("--chunk-ms") ?? "") ?? defaultChunkDurationMs
    let captureEpochId = UUID().uuidString
    var captureSequence = 0
    let sampleBuffer = SampleBuffer()
    let capture = CoreAudioTapCapture(sampleBuffer: sampleBuffer)
    try capture.start()
    emit(ReadyPayload(sample_rate: targetSampleRate, excluded_apps: excludedBundleIdentifiers))

    var shouldStop = false
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    let terminateSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    interruptSource.setEventHandler { shouldStop = true }
    terminateSource.setEventHandler { shouldStop = true }
    interruptSource.resume()
    terminateSource.resume()

    var nextFlush = Date(timeIntervalSinceNow: Double(chunkDurationMs) / 1_000)
    while !shouldStop {
        RunLoop.current.run(until: min(nextFlush, Date(timeIntervalSinceNow: 0.2)))
        emit(LevelPayload(rms: sampleBuffer.meterLevel()))
        if Date() >= nextFlush {
            flush(
                sampleBuffer: sampleBuffer,
                sourceRate: capture.format.mSampleRate,
                outputDirectory: outputDirectory,
                captureEpochId: captureEpochId,
                sequence: &captureSequence
            )
            nextFlush = Date(timeIntervalSinceNow: Double(chunkDurationMs) / 1_000)
        }
    }
    capture.stop()
    emit(LevelPayload(rms: 0))
    flush(
        sampleBuffer: sampleBuffer,
        sourceRate: capture.format.mSampleRate,
        outputDirectory: outputDirectory,
        captureEpochId: captureEpochId,
        sequence: &captureSequence
    )
}

do {
    try run()
} catch {
    emit(ErrorPayload(code: "system-audio-capture-failed", message: String(describing: error)))
    exit(1)
}
