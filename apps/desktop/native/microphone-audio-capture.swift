import AudioToolbox
import AVFAudio
import CoreAudio
import Foundation

private let targetSampleRate = 16_000
private let defaultChunkDurationMs = 60_000

private struct ReadyPayload: Encodable {
    let type = "ready"
    let sample_rate = targetSampleRate
    let microphone_name: String
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

private struct ErrorPayload: Encodable {
    let type = "error"
    let code: String
    let message: String
}

private enum CaptureError: Error, CustomStringConvertible {
    case coreAudio(String, OSStatus)
    case noInputMicrophone
    case streamDidNotBecomeActive
    case missingOutputDirectory

    var description: String {
        switch self {
        case let .coreAudio(operation, status):
            return "\(operation) failed (\(status))"
        case .noInputMicrophone:
            return "No usable microphone input is available"
        case .streamDidNotBecomeActive:
            return "The microphone stream started but did not deliver audio frames"
        case .missingOutputDirectory:
            return "--output-dir requires a directory"
        }
    }
}

private final class SampleBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private let firstSamples = DispatchSemaphore(value: 0)
    private var samples: [Float] = []
    private var squareTotal: Double = 0
    private var startedAt = Date()
    private var firstSampleTime: Double?
    private var receivedSamples = false

    func append(_ values: [Float], sampleTime: Double?) {
        guard !values.isEmpty else { return }
        lock.lock()
        let shouldSignal = !receivedSamples
        receivedSamples = true
        if samples.isEmpty {
            startedAt = Date()
            firstSampleTime = sampleTime
        }
        samples.append(contentsOf: values)
        for value in values {
            squareTotal += Double(value * value)
        }
        lock.unlock()
        if shouldSignal { firstSamples.signal() }
    }

    func waitUntilActive(timeout: TimeInterval) -> Bool {
        lock.lock()
        let alreadyActive = receivedSamples
        lock.unlock()
        if alreadyActive { return true }
        return firstSamples.wait(timeout: .now() + timeout) == .success
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

private func requireSuccess(_ status: OSStatus, _ operation: String) throws {
    guard status == noErr else { throw CaptureError.coreAudio(operation, status) }
}

private func propertyAddress(
    _ selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: scope,
        mElement: kAudioObjectPropertyElementMain
    )
}

private func readDevices() throws -> [AudioObjectID] {
    var address = propertyAddress(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    try requireSuccess(
        AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size),
        "Read audio device list size"
    )
    var devices = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    try requireSuccess(
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices),
        "Read audio device list"
    )
    return devices
}

private func readUInt32(_ device: AudioObjectID, selector: AudioObjectPropertySelector) -> UInt32? {
    var address = propertyAddress(selector)
    var size = UInt32(MemoryLayout<UInt32>.size)
    var output: UInt32 = 0
    let status = withUnsafeMutablePointer(to: &output) {
        AudioObjectGetPropertyData(device, &address, 0, nil, &size, $0)
    }
    return status == noErr ? output : nil
}

private func readDouble(_ device: AudioObjectID, selector: AudioObjectPropertySelector) -> Double? {
    var address = propertyAddress(selector)
    var size = UInt32(MemoryLayout<Double>.size)
    var output: Double = 0
    let status = withUnsafeMutablePointer(to: &output) {
        AudioObjectGetPropertyData(device, &address, 0, nil, &size, $0)
    }
    return status == noErr ? output : nil
}

private func readName(_ device: AudioObjectID) -> String {
    var address = propertyAddress(kAudioObjectPropertyName)
    var size = UInt32(MemoryLayout<CFString>.size)
    var value: CFString = "" as CFString
    let status = withUnsafeMutablePointer(to: &value) {
        AudioObjectGetPropertyData(device, &address, 0, nil, &size, $0)
    }
    guard status == noErr else {
        return "Built-in microphone"
    }
    return value as String
}

private func hasInputChannels(_ device: AudioObjectID) -> Bool {
    var address = propertyAddress(kAudioDevicePropertyStreamConfiguration, scope: kAudioDevicePropertyScopeInput)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr, size > 0 else {
        return false
    }
    let pointer = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { pointer.deallocate() }
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, pointer) == noErr else {
        return false
    }
    let list = UnsafeMutableAudioBufferListPointer(pointer.assumingMemoryBound(to: AudioBufferList.self))
    return list.reduce(0) { $0 + Int($1.mNumberChannels) } > 0
}

private func selectedMicrophone() throws -> (id: AudioObjectID, name: String, sampleRate: Double) {
    let devices = try readDevices()
    if let builtIn = devices.first(where: { device in
        let transport = readUInt32(device, selector: kAudioDevicePropertyTransportType) ?? UInt32(0)
        return transport == kAudioDeviceTransportTypeBuiltIn && hasInputChannels(device)
    }) {
        let rate = readDouble(builtIn, selector: kAudioDevicePropertyNominalSampleRate) ?? 48_000
        return (builtIn, readName(builtIn), rate)
    }

    let system = AudioObjectID(kAudioObjectSystemObject)
    if let defaultInput = readUInt32(system, selector: kAudioHardwarePropertyDefaultInputDevice),
       defaultInput != kAudioObjectUnknown,
       hasInputChannels(defaultInput) {
        let rate = readDouble(defaultInput, selector: kAudioDevicePropertyNominalSampleRate) ?? 48_000
        return (defaultInput, readName(defaultInput), rate)
    }
    for device in devices where hasInputChannels(device) {
        let rate = readDouble(device, selector: kAudioDevicePropertyNominalSampleRate) ?? 48_000
        return (device, readName(device), rate)
    }
    throw CaptureError.noInputMicrophone
}

private final class MicrophoneCapture {
    private var audioUnit: AudioUnit?
    private let sampleBuffer: SampleBuffer
    let microphoneName: String
    let sampleRate: Double

    init(sampleBuffer: SampleBuffer) throws {
        self.sampleBuffer = sampleBuffer
        let microphone = try selectedMicrophone()
        microphoneName = microphone.name
        sampleRate = microphone.sampleRate

        var description = AudioComponentDescription(
            componentType: kAudioUnitType_Output,
            componentSubType: kAudioUnitSubType_HALOutput,
            componentManufacturer: kAudioUnitManufacturer_Apple,
            componentFlags: 0,
            componentFlagsMask: 0
        )
        guard let component = AudioComponentFindNext(nil, &description) else {
            throw CaptureError.coreAudio("Find HAL audio unit", -1)
        }
        try requireSuccess(AudioComponentInstanceNew(component, &audioUnit), "Create HAL audio unit")
        guard let audioUnit else { throw CaptureError.coreAudio("Create HAL audio unit", -1) }

        var enabled: UInt32 = 1
        var disabled: UInt32 = 0
        var deviceID = microphone.id
        try requireSuccess(
            AudioUnitSetProperty(
                audioUnit,
                kAudioOutputUnitProperty_EnableIO,
                kAudioUnitScope_Input,
                1,
                &enabled,
                UInt32(MemoryLayout<UInt32>.size)
            ),
            "Enable microphone input"
        )
        try requireSuccess(
            AudioUnitSetProperty(
                audioUnit,
                kAudioOutputUnitProperty_EnableIO,
                kAudioUnitScope_Output,
                0,
                &disabled,
                UInt32(MemoryLayout<UInt32>.size)
            ),
            "Disable speaker output"
        )
        try requireSuccess(
            AudioUnitSetProperty(
                audioUnit,
                kAudioOutputUnitProperty_CurrentDevice,
                kAudioUnitScope_Global,
                0,
                &deviceID,
                UInt32(MemoryLayout<AudioObjectID>.size)
            ),
            "Select microphone input"
        )

        var format = AudioStreamBasicDescription(
            mSampleRate: microphone.sampleRate,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagsNativeFloatPacked | kAudioFormatFlagIsNonInterleaved,
            mBytesPerPacket: UInt32(MemoryLayout<Float>.size),
            mFramesPerPacket: 1,
            mBytesPerFrame: UInt32(MemoryLayout<Float>.size),
            mChannelsPerFrame: 1,
            mBitsPerChannel: 32,
            mReserved: 0
        )
        try requireSuccess(
            AudioUnitSetProperty(
                audioUnit,
                kAudioUnitProperty_StreamFormat,
                kAudioUnitScope_Output,
                1,
                &format,
                UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
            ),
            "Set microphone client format"
        )

        var callback = AURenderCallbackStruct(
            inputProc: microphoneInputCallback,
            inputProcRefCon: Unmanaged.passUnretained(self).toOpaque()
        )
        try requireSuccess(
            AudioUnitSetProperty(
                audioUnit,
                kAudioOutputUnitProperty_SetInputCallback,
                kAudioUnitScope_Global,
                0,
                &callback,
                UInt32(MemoryLayout<AURenderCallbackStruct>.size)
            ),
            "Install microphone callback"
        )
        try requireSuccess(AudioUnitInitialize(audioUnit), "Initialize microphone")
    }

    deinit { stop() }

    func start() throws {
        guard let audioUnit else { throw CaptureError.coreAudio("Start microphone", -1) }
        try requireSuccess(AudioOutputUnitStart(audioUnit), "Start microphone")
    }

    func render(
        flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
        timestamp: UnsafePointer<AudioTimeStamp>,
        frames: UInt32
    ) -> OSStatus {
        guard let audioUnit else { return -1 }
        var samples = [Float](repeating: 0, count: Int(frames))
        let status = samples.withUnsafeMutableBytes { bytes -> OSStatus in
            var list = AudioBufferList(
                mNumberBuffers: 1,
                mBuffers: AudioBuffer(
                    mNumberChannels: 1,
                    mDataByteSize: UInt32(bytes.count),
                    mData: bytes.baseAddress
                )
            )
            return AudioUnitRender(audioUnit, flags, timestamp, 1, frames, &list)
        }
        let sampleTime = timestamp.pointee.mFlags.contains(.sampleTimeValid) ? timestamp.pointee.mSampleTime : nil
        if status == noErr { sampleBuffer.append(samples, sampleTime: sampleTime) }
        return status
    }

    func stop() {
        guard let audioUnit else { return }
        AudioOutputUnitStop(audioUnit)
        AudioUnitUninitialize(audioUnit)
        AudioComponentInstanceDispose(audioUnit)
        self.audioUnit = nil
    }
}

private func microphoneInputCallback(
    refCon: UnsafeMutableRawPointer,
    flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
    timestamp: UnsafePointer<AudioTimeStamp>,
    _: UInt32,
    frames: UInt32,
    _: UnsafeMutablePointer<AudioBufferList>?
) -> OSStatus {
    Unmanaged<MicrophoneCapture>.fromOpaque(refCon).takeUnretainedValue().render(
        flags: flags,
        timestamp: timestamp,
        frames: frames
    )
}

private func emit<T: Encodable>(_ payload: T) {
    guard let data = try? JSONEncoder().encode(payload), let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

private func resample(_ input: [Float], from sourceRate: Double) -> [Float] {
    guard !input.isEmpty, sourceRate > 0 else { return [] }
    if abs(sourceRate - Double(targetSampleRate)) < 1 { return input }
    let outputCount = Int(Double(input.count) * Double(targetSampleRate) / sourceRate)
    guard outputCount > 0 else { return [] }
    return (0 ..< outputCount).map { index in
        let sourcePosition = Double(index) * sourceRate / Double(targetSampleRate)
        let lower = min(input.count - 1, Int(sourcePosition))
        let upper = min(input.count - 1, lower + 1)
        let fraction = Float(sourcePosition - Double(lower))
        return input[lower] + (input[upper] - input[lower]) * fraction
    }
}

private func wavData(samples: [Float]) -> Data {
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
    append(UInt32(targetSampleRate).littleEndian)
    append(UInt32(targetSampleRate * 2).littleEndian)
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
    guard !drained.samples.isEmpty else { return }
    let samples = resample(drained.samples, from: sourceRate)
    guard !samples.isEmpty else { return }
    let averageLevel = sqrt(drained.squareTotal / Double(drained.samples.count))
    let startedAt = Int64(drained.startedAt.timeIntervalSince1970 * 1_000)
    let currentSequence = sequence
    sequence += 1
    let file = outputDirectory.appendingPathComponent("\(startedAt)-microphone.wav")
    do {
        try wavData(samples: samples).write(to: file, options: .atomic)
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
    if CommandLine.arguments.contains("--configure-microphone-mode") {
        // macOS retains voice-processing bypass for the responsible app. Chromium
        // owns capture and its software processing; no native input is started.
        let engine = AVAudioEngine()
        try engine.inputNode.setVoiceProcessingEnabled(true)
        engine.inputNode.isVoiceProcessingBypassed = true
        guard engine.inputNode.isVoiceProcessingBypassed, !engine.isRunning else {
            throw CaptureError.coreAudio("Configure microphone mode", -1)
        }
        print("{\"type\":\"configured\",\"voice_processing_bypassed\":true,\"running\":false}")
        return
    }
    guard let outputPath = argumentValue("--output-dir") else { throw CaptureError.missingOutputDirectory }
    let outputDirectory = URL(fileURLWithPath: outputPath, isDirectory: true)
    try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
    let chunkDurationMs = Int(argumentValue("--chunk-ms") ?? "") ?? defaultChunkDurationMs
    let captureEpochId = UUID().uuidString
    var captureSequence = 0
    let sampleBuffer = SampleBuffer()
    let capture = try MicrophoneCapture(sampleBuffer: sampleBuffer)
    try capture.start()
    guard sampleBuffer.waitUntilActive(timeout: 2) else {
        throw CaptureError.streamDidNotBecomeActive
    }
    emit(ReadyPayload(microphone_name: capture.microphoneName))

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
        RunLoop.current.run(until: min(nextFlush, Date(timeIntervalSinceNow: 0.25)))
        if Date() >= nextFlush {
            flush(
                sampleBuffer: sampleBuffer,
                sourceRate: capture.sampleRate,
                outputDirectory: outputDirectory,
                captureEpochId: captureEpochId,
                sequence: &captureSequence
            )
            nextFlush = Date(timeIntervalSinceNow: Double(chunkDurationMs) / 1_000)
        }
    }
    capture.stop()
    flush(
        sampleBuffer: sampleBuffer,
        sourceRate: capture.sampleRate,
        outputDirectory: outputDirectory,
        captureEpochId: captureEpochId,
        sequence: &captureSequence
    )
}

do {
    try run()
} catch {
    emit(ErrorPayload(code: "microphone-capture-failed", message: String(describing: error)))
    exit(1)
}
