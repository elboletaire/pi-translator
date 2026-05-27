export interface TranslationEntry {
  key: string
  sentence: string
  context: string
}

export type InputFormat = "plain" | "csv3"

export interface CliArgs {
  inputFile: string
  outputFile: string
  setupContext: string
  batchSize: number
  inputFormat: InputFormat
  timeoutSeconds: number
  piCmd: string
  provider?: string
  model?: string
  apiKey?: string
  stdinEndToken: string
}
