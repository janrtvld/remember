export const SPEECH_MODEL_DIRECTORY = 'parakeet-tdt-0.6b-v3-int8'
export const SPEECH_MODEL_FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']

export function speechRecognizerConfig(dir: string) {
  return {
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: `${dir}/encoder.int8.onnx`,
        decoder: `${dir}/decoder.int8.onnx`,
        joiner: `${dir}/joiner.int8.onnx`,
      },
      modelType: 'nemo_transducer',
      tokens: `${dir}/tokens.txt`,
      numThreads: 4,
      provider: 'cpu',
      debug: false,
    },
    decodingMethod: 'greedy_search',
  }
}
