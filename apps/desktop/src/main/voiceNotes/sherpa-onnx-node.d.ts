// The native sherpa-onnx-node package ships no TypeScript declarations; this
// describes the small offline-recognition slice used by the app.
declare module 'sherpa-onnx-node' {
  interface OfflineRecognizerConfig {
    featConfig?: { sampleRate: number; featureDim: number }
    modelConfig: {
      transducer: {
        encoder: string
        decoder: string
        joiner: string
      }
      modelType: string
      tokens: string
      numThreads?: number
      provider?: string
      debug?: boolean
    }
    decodingMethod?: string
  }
  interface OfflineStream {
    acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void
  }
  interface VadConfig {
    sileroVad: {
      model: string
      threshold: number
      minSpeechDuration: number
      minSilenceDuration: number
      maxSpeechDuration: number
      windowSize: number
    }
    sampleRate: number
    numThreads?: number
    provider?: string
    debug?: boolean
  }
  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig)
    createStream(): OfflineStream
    decode(stream: OfflineStream): void
    getResult(stream: OfflineStream): { text: string; lang?: string; ys_log_probs?: number[] }
  }
  export class Vad {
    readonly config: VadConfig
    constructor(config: VadConfig, bufferSizeInSeconds: number)
    acceptWaveform(samples: Float32Array): void
    isEmpty(): boolean
    isDetected(): boolean
    front(): { start: number; samples: Float32Array }
    pop(): void
    flush(): void
    reset(): void
  }
}
