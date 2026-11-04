import AVFoundation
import Foundation
import SoundAnalysis

struct ClassificationOutput: Encodable {
    let windowCount: Int
    let speechWindowShare: Double
    let musicDominantWindowShare: Double
    let averageSpeechConfidence: Double
    let averageMusicConfidence: Double
    let averageSingingConfidence: Double
}

final class ClassificationObserver: NSObject, SNResultsObserving {
    private let completion = DispatchSemaphore(value: 0)
    private(set) var windowCount = 0
    private(set) var speechWindows = 0
    private(set) var musicDominantWindows = 0
    private(set) var speechConfidenceTotal = 0.0
    private(set) var musicConfidenceTotal = 0.0
    private(set) var singingConfidenceTotal = 0.0
    private(set) var error: Error?

    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult else { return }

        let speech = maximumConfidence(in: result, matching: isSpeech)
        let music = maximumConfidence(in: result, matching: isMusic)
        let singing = maximumConfidence(in: result, matching: isSinging)
        let musicOrSinging = max(music, singing)

        windowCount += 1
        speechConfidenceTotal += speech
        musicConfidenceTotal += music
        singingConfidenceTotal += singing

        if speech >= 0.15 && speech >= musicOrSinging * 0.55 {
            speechWindows += 1
        }
        if musicOrSinging >= 0.25 && musicOrSinging > speech * 1.2 {
            musicDominantWindows += 1
        }
    }

    func request(_ request: SNRequest, didFailWithError error: Error) {
        self.error = error
        completion.signal()
    }

    func requestDidComplete(_ request: SNRequest) {
        completion.signal()
    }

    func wait(timeout: TimeInterval) -> Bool {
        completion.wait(timeout: .now() + timeout) == .success
    }

    private func maximumConfidence(
        in result: SNClassificationResult,
        matching predicate: (String) -> Bool
    ) -> Double {
        result.classifications.reduce(0) { confidence, classification in
            let identifier = classification.identifier.lowercased()
            return predicate(identifier) ? max(confidence, classification.confidence) : confidence
        }
    }

    private func isSpeech(_ identifier: String) -> Bool {
        identifier.contains("speech") ||
            identifier.contains("conversation") ||
            identifier.contains("narration") ||
            identifier.contains("talking")
    }

    private func isMusic(_ identifier: String) -> Bool {
        identifier == "music" ||
            identifier.contains("musical_instrument") ||
            identifier.contains("background_music")
    }

    private func isSinging(_ identifier: String) -> Bool {
        identifier.contains("singing") || identifier.contains("choir") || identifier.contains("chant")
    }
}

guard CommandLine.arguments.count == 2 else {
    fputs("usage: music-classifier <audio.wav>\n", stderr)
    exit(2)
}

do {
    let observer = ClassificationObserver()
    let analyzer = try SNAudioFileAnalyzer(url: URL(fileURLWithPath: CommandLine.arguments[1]))
    let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
    request.windowDuration = CMTime(seconds: 1.5, preferredTimescale: 600)
    request.overlapFactor = 0.5
    try analyzer.add(request, withObserver: observer)
    analyzer.analyze()

    guard observer.wait(timeout: 90) else {
        throw NSError(domain: "RememberMusicClassifier", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "sound classification timed out"
        ])
    }
    if let error = observer.error { throw error }

    let count = max(observer.windowCount, 1)
    let output = ClassificationOutput(
        windowCount: observer.windowCount,
        speechWindowShare: Double(observer.speechWindows) / Double(count),
        musicDominantWindowShare: Double(observer.musicDominantWindows) / Double(count),
        averageSpeechConfidence: observer.speechConfidenceTotal / Double(count),
        averageMusicConfidence: observer.musicConfidenceTotal / Double(count),
        averageSingingConfidence: observer.singingConfidenceTotal / Double(count)
    )
    let data = try JSONEncoder().encode(output)
    print(String(decoding: data, as: UTF8.self))
} catch {
    fputs("music classification failed: \(error.localizedDescription)\n", stderr)
    exit(1)
}
