export interface TranslationEntry {
  key: string
  sentence: string
  context: string
}

export type InputFormat = "plain" | "csv3" | "json"
export type TranslationMode = "translate" | "missing" | "review"
export type Tool = "pi" | "claude"
export type Program = "llm-translate" | "pi-translate" | "claude-translate"

export interface CliArgs {
  inputFile: string
  outputFile: string
  setupContext: string
  setupContextFile?: string
  batchSize: number
  inputFormat: InputFormat
  mode: TranslationMode
  timeoutSeconds: number
  tool: Tool
  program: Program
  piCmd: string
  claudeCmd: string
  provider?: string
  model?: string
  apiKey?: string
  stdinEndToken: string
  maxRetries: number
  allowExtensions: boolean
}
