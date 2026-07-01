import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  flattenJson,
  isHeaderRow,
  parseCsvRows,
  readCsvEntries,
  readCsvHeader,
  readJsonFile,
  readLines,
  unflattenJson,
  writeCsvEntries,
  writeJsonFile,
  writeLines,
} from "./io"
import {
  translateBatches,
  translateTextUnitsBatch,
  translateTextUnitsBatchReview,
} from "./translator"
import type {
  CliArgs,
  InputFormat,
  Tool,
  TranslationEntry,
  TranslationMode,
} from "./types"

interface CliDeps {
  flattenJson: typeof flattenJson
  readCsvEntries: typeof readCsvEntries
  readCsvHeader: typeof readCsvHeader
  readJsonFile: typeof readJsonFile
  readLines: typeof readLines
  unflattenJson: typeof unflattenJson
  writeCsvEntries: typeof writeCsvEntries
  writeJsonFile: typeof writeJsonFile
  writeLines: typeof writeLines
  translateBatches: typeof translateBatches
  translateTextUnitsBatch: typeof translateTextUnitsBatch
  translateTextUnitsBatchReview: typeof translateTextUnitsBatchReview
  existsSync: typeof fs.existsSync
  replaceSync: typeof fs.renameSync
  removeSync: typeof fs.unlinkSync
  stderr: Pick<NodeJS.WritableStream, "write">
  readFile: (path: string) => string
}

const defaultDeps: CliDeps = {
  flattenJson,
  readCsvEntries,
  readCsvHeader,
  readJsonFile,
  readLines,
  unflattenJson,
  writeCsvEntries,
  writeJsonFile,
  writeLines,
  translateBatches,
  translateTextUnitsBatch,
  translateTextUnitsBatchReview,
  existsSync: fs.existsSync,
  replaceSync: fs.renameSync,
  removeSync: fs.unlinkSync,
  stderr: process.stderr,
  readFile: (path) => fs.readFileSync(path, "utf8"),
}

function inferInputFormat(inputFile: string): InputFormat {
  if (inputFile.endsWith(".json")) return "json"
  if (inputFile.endsWith(".csv")) return "csv3"
  return "plain"
}

export function buildHelpText(name = "pi-translate"): string {
  return `
Usage: ${name} <input_file> <output_file> [options]

Batch translator for large files using \`pi\` or \`claude\`.

Arguments:
  input_file                       Input file to translate (plain text, CSV, or JSON)
  output_file                      Output file to write translations to

Options:
  --setup-context <text>           Translation instructions sent to the model on every
                                   batch (required unless --setup-context-file is given)
  --setup-context-file <path>      Path to a file containing the translation setup context
                                   (required unless --setup-context is given)
  --batch-size <n>                 Number of lines/entries per batch (default: 50)
  --input-format <format>          Input file format: plain, csv3, json
                                   (default: auto-detected from extension; falls back to plain)
  --mode <mode>                    Translation mode (default: translate):
                                     translate  Translate all entries from scratch
                                     missing    Only translate entries missing in the output
                                     review     Review and improve an existing translation
  --timeout-seconds <n>            Timeout in seconds for each model call (default: 120)
  --tool <tool>                    Backend CLI: pi or claude
                                   (default: claude when invoked as claude-translate, else pi)
  --pi-cmd <cmd>                   Command used to invoke pi (default: pi)
  --pi-mono-cmd <cmd>              Alias for --pi-cmd
  --claude-cmd <cmd>               Command used to invoke claude (default: claude)
  --provider <id>                  Provider ID passed to pi (ignored with --tool claude)
                                   (e.g. openai, github-copilot)
  --allow-extensions               Keep pi extension discovery enabled, so providers
                                   registered by extensions (e.g. pi-claude-cli) work
                                   (ignored with --tool claude)
  --model <id>                     Model ID passed to the backend
                                   (pi: gpt-5.4, claude-sonnet-4.5; claude: opus, sonnet)
  --api-key <key>                  API key passed to pi (ignored with --tool claude)
  --stdin-end-token <token>        Token that signals end of model response when using
                                   --provider stdout (default: __NEXT_BATCH__)
  --max-retries <n>                Number of times to retry a failed batch before aborting
                                   (default: 2)
  -h, --help                       Display this help message

Examples:
  pi-translate input.txt output.txt \\
    --setup-context "Translate from Spanish to English. Keep character names unchanged." \\
    --provider openai --model gpt-5.4 --batch-size 40

  claude-translate input.csv output.csv \\
    --input-format csv3 \\
    --setup-context "Translate column 2 to English. Keep key and context untouched." \\
    --mode missing --model sonnet

  pi-translate input.json output.json \\
    --setup-context-file context.md \\
    --mode review --timeout-seconds 180

  pi-translate input.csv output.csv \\
    --input-format csv3 --provider stdout \\
    --stdin-end-token "<NEXT>" \\
    --setup-context "$(cat context.md)"
`.trimStart()
}

export const HELP_TEXT = buildHelpText()

export function detectTool(invokedAs?: string): Tool {
  const base = invokedAs ? path.basename(invokedAs) : ""
  return /claude/iu.test(base) ? "claude" : "pi"
}

export function programName(invokedAs?: string): string {
  return detectTool(invokedAs) === "claude"
    ? "claude-translate"
    : "pi-translate"
}

export class HelpRequestedError extends Error {
  constructor() {
    super("help requested")
    this.name = "HelpRequestedError"
  }
}

export function parseArgs(
  argv: string[],
  opts: { defaultTool?: Tool } = {},
): CliArgs {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv

  if (normalizedArgv.includes("--help") || normalizedArgv.includes("-h")) {
    throw new HelpRequestedError()
  }

  if (normalizedArgv.length < 2) {
    throw new Error(
      "Usage: pi-translator <input_file> <output_file> --setup-context <text>|--setup-context-file <path> [options]\nRun with --help for full usage information.",
    )
  }

  const [inputFile, outputFile, ...rest] = normalizedArgv
  const args: CliArgs = {
    inputFile,
    outputFile,
    setupContext: "",
    batchSize: 50,
    inputFormat: inferInputFormat(inputFile),
    mode: "translate" as TranslationMode,
    timeoutSeconds: 120,
    tool: opts.defaultTool ?? "pi",
    piCmd: "pi",
    claudeCmd: "claude",
    stdinEndToken: "__NEXT_BATCH__",
    maxRetries: 2,
    allowExtensions: false,
  }

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]
    const getValue = (): string => {
      const value = rest[index + 1]
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for ${flag}`)
      }
      index += 1
      return value
    }

    switch (flag) {
      case "--setup-context":
        args.setupContext = getValue()
        break
      case "--setup-context-file":
        args.setupContextFile = getValue()
        break
      case "--batch-size": {
        const batchSize = Number.parseInt(getValue(), 10)
        if (!Number.isFinite(batchSize) || batchSize <= 0) {
          throw new Error("--batch-size must be a positive integer")
        }
        args.batchSize = batchSize
        break
      }
      case "--input-format": {
        const format = getValue()
        if (format !== "plain" && format !== "csv3" && format !== "json") {
          throw new Error("--input-format must be one of: plain, csv3, json")
        }
        args.inputFormat = format as InputFormat
        break
      }
      case "--mode": {
        const m = getValue()
        if (m !== "translate" && m !== "missing" && m !== "review") {
          throw new Error("--mode must be one of: translate, missing, review")
        }
        args.mode = m as TranslationMode
        break
      }
      case "--no-autodetect-format":
        args.inputFormat = "plain"
        break
      case "--allow-extensions":
        args.allowExtensions = true
        break
      case "--timeout-seconds": {
        const timeout = Number.parseInt(getValue(), 10)
        if (!Number.isFinite(timeout) || timeout <= 0) {
          throw new Error("--timeout-seconds must be a positive integer")
        }
        args.timeoutSeconds = timeout
        break
      }
      case "--tool": {
        const t = getValue()
        if (t !== "pi" && t !== "claude") {
          throw new Error("--tool must be one of: pi, claude")
        }
        args.tool = t as Tool
        break
      }
      case "--pi-cmd":
      case "--pi-mono-cmd":
        args.piCmd = getValue()
        break
      case "--claude-cmd":
        args.claudeCmd = getValue()
        break
      case "--provider":
        args.provider = getValue()
        break
      case "--model":
        args.model = getValue()
        break
      case "--api-key":
        args.apiKey = getValue()
        break
      case "--stdin-end-token":
        args.stdinEndToken = getValue()
        break
      case "--max-retries": {
        const retries = Number.parseInt(getValue(), 10)
        if (!Number.isFinite(retries) || retries < 0) {
          throw new Error("--max-retries must be a non-negative integer")
        }
        args.maxRetries = retries
        break
      }
      default:
        throw new Error(`Unknown argument: ${flag}`)
    }
  }

  if (args.setupContext && args.setupContextFile) {
    throw new Error(
      "--setup-context and --setup-context-file are mutually exclusive",
    )
  }
  if (!args.setupContext && !args.setupContextFile) {
    throw new Error("--setup-context or --setup-context-file is required")
  }

  return args
}

/**
 * Tools denied when driving the `claude` CLI. A translation run should never
 * touch the filesystem or the network, so all built-in tools are disallowed.
 * This does not affect authentication (unlike `--bare`).
 */
export const CLAUDE_DISALLOWED_TOOLS =
  "Bash Edit Write Read WebFetch WebSearch Glob Grep NotebookEdit Task"

export function buildPiCommand(
  args: Pick<
    CliArgs,
    "piCmd" | "provider" | "model" | "apiKey" | "allowExtensions"
  >,
): string[] {
  if (args.provider === "stdout") {
    return ["stdout"]
  }

  const command = [args.piCmd]
  if (args.provider) {
    command.push("--provider", args.provider)
  }
  if (args.model) {
    command.push("--model", args.model)
  }
  if (args.apiKey) {
    command.push("--api-key", args.apiKey)
  }
  command.push("--no-session", "--print", "-nc", "-ns", "-np")
  // -ne (--no-extensions) disables extension discovery, which also drops
  // providers registered by extensions (e.g. pi-claude-cli). Keep extensions
  // enabled when the user opts in so such providers remain available.
  if (!args.allowExtensions) {
    command.push("-ne")
  }
  return command
}

export function buildClaudeCommand(
  args: Pick<CliArgs, "claudeCmd" | "model" | "provider">,
): string[] {
  // stdout is a tool-agnostic paste escape hatch handled by the exchange layer.
  if (args.provider === "stdout") {
    return ["stdout"]
  }

  const command = [args.claudeCmd, "-p", "--output-format", "text"]
  if (args.model) {
    command.push("--model", args.model)
  }
  command.push("--disallowedTools", CLAUDE_DISALLOWED_TOOLS)
  return command
}

export function buildCommand(args: CliArgs): string[] {
  return args.tool === "claude"
    ? buildClaudeCommand(args)
    : buildPiCommand(args)
}

function checkpointPath(outputFile: string): string {
  return `${outputFile}.part`
}

function tmpOutputPath(outputFile: string): string {
  return `${outputFile}.tmp`
}

function loadCheckpointIfAny(
  checkpointFile: string,
  sourceEntries: TranslationEntry[],
  deps: Pick<CliDeps, "existsSync" | "readCsvEntries">,
): TranslationEntry[] {
  if (!deps.existsSync(checkpointFile)) {
    return []
  }

  const checkpointEntries = deps.readCsvEntries(checkpointFile)
  if (checkpointEntries.length > sourceEntries.length) {
    throw new Error("checkpoint contains more rows than source input")
  }

  checkpointEntries.forEach((entry, index) => {
    const sourceEntry = sourceEntries[index]
    if (entry.key !== sourceEntry.key) {
      throw new Error(`checkpoint key mismatch at row ${index + 1}`)
    }
    if (entry.context !== sourceEntry.context) {
      throw new Error(`checkpoint context mismatch at row ${index + 1}`)
    }
  })

  return checkpointEntries
}

function startupInfo(
  args: CliArgs,
  entries: number,
  totalBatches: number,
  resuming: boolean,
): string {
  const model = args.model ?? `${args.tool} default`
  const provider =
    args.tool === "pi" && args.provider ? ` via ${args.provider}` : ""
  const modeNote = args.mode !== "translate" ? ` [${args.mode}]` : ""
  const resumeNote = resuming ? " (resuming)" : ""
  const label = args.tool === "claude" ? "claude-translate" : "pi-translate"
  return (
    `${label}: ${args.inputFormat}${modeNote} • ` +
    `${entries} entries • ` +
    `${totalBatches} batches × ${args.batchSize}${resumeNote} • ` +
    `model: ${model}${provider}`
  )
}

function chunkEntries(
  entries: TranslationEntry[],
  batchSize: number,
): TranslationEntry[][] {
  const chunks: TranslationEntry[][] = []
  for (let i = 0; i < entries.length; i += batchSize) {
    chunks.push(entries.slice(i, i + batchSize))
  }
  return chunks
}

async function runMissingMode(
  args: CliArgs,
  deps: CliDeps,
  command: string[],
): Promise<number> {
  if (args.inputFormat === "json") {
    return runMissingJson(args, deps, command)
  }
  if (args.inputFormat === "csv3") {
    return runMissingCsv3(args, deps, command)
  }
  return runMissingPlain(args, deps, command)
}

async function runMissingJson(
  args: CliArgs,
  deps: CliDeps,
  command: string[],
): Promise<number> {
  const original = deps.readJsonFile(args.inputFile)
  const inputEntries = deps.flattenJson(original)

  const existingMap = new Map<string, string>()
  if (deps.existsSync(args.outputFile)) {
    const existingObj = deps.readJsonFile(args.outputFile)
    for (const e of deps.flattenJson(existingObj)) {
      if (e.sentence.trim() !== "") existingMap.set(e.key, e.sentence)
    }
  }

  const toTranslate = inputEntries.filter((e) => !existingMap.has(e.key))

  const checkpointFile = checkpointPath(args.outputFile)
  const tmpFile = tmpOutputPath(args.outputFile)
  const checkpointEntries = loadCheckpointIfAny(
    checkpointFile,
    toTranslate,
    deps,
  )
  const remaining = toTranslate.slice(checkpointEntries.length)

  const newTranslationsMap = new Map<string, string>(
    checkpointEntries.map((e) => [e.key, e.sentence]),
  )

  const chunks = chunkEntries(remaining, args.batchSize)
  const totalBatches = chunks.length
  deps.stderr.write(
    startupInfo(
      args,
      toTranslate.length,
      Math.ceil(toTranslate.length / args.batchSize),
      checkpointEntries.length > 0,
    ) + "\n",
  )

  for (const [index, chunk] of chunks.entries()) {
    const currentBatch = index + 1
    deps.stderr.write(`processing batch ${currentBatch}/${totalBatches}\n`)
    const sentences = await deps.translateTextUnitsBatch({
      entries: chunk,
      setupContext: args.setupContext,
      command,
      timeoutSeconds: args.timeoutSeconds,
      batchIndex: currentBatch,
      totalBatches,
      stdinEndToken: args.stdinEndToken,
      maxRetries: args.maxRetries,
      onRetry: (attempt, error) =>
        deps.stderr.write(
          `  batch ${currentBatch} failed, retrying (${attempt}/${args.maxRetries}): ${error.message}\n`,
        ),
    })
    chunk.forEach((entry, i) => {
      const translated = {
        key: entry.key,
        sentence: sentences[i],
        context: entry.context,
      }
      checkpointEntries.push(translated)
      newTranslationsMap.set(entry.key, sentences[i])
    })
    deps.writeCsvEntries(checkpointFile, checkpointEntries)
  }

  const allTranslations = inputEntries.map((e) => ({
    key: e.key,
    sentence:
      existingMap.get(e.key) ?? newTranslationsMap.get(e.key) ?? e.sentence,
    context: e.context,
  }))

  const resultObj = deps.unflattenJson(original, allTranslations)
  deps.writeJsonFile(tmpFile, resultObj)
  deps.replaceSync(tmpFile, args.outputFile)
  if (deps.existsSync(checkpointFile)) deps.removeSync(checkpointFile)

  return 0
}

async function runMissingCsv3(
  args: CliArgs,
  deps: CliDeps,
  command: string[],
): Promise<number> {
  const csvHeader = deps.readCsvHeader(args.inputFile)
  const inputEntries = deps.readCsvEntries(args.inputFile)

  const existingMap = new Map<string, string>()
  if (deps.existsSync(args.outputFile)) {
    for (const e of deps.readCsvEntries(args.outputFile)) {
      if (e.sentence.trim() !== "") existingMap.set(e.key, e.sentence)
    }
  }

  const toTranslate = inputEntries.filter((e) => !existingMap.has(e.key))

  const checkpointFile = checkpointPath(args.outputFile)
  const tmpFile = tmpOutputPath(args.outputFile)
  const checkpointEntries = loadCheckpointIfAny(
    checkpointFile,
    toTranslate,
    deps,
  )
  const remaining = toTranslate.slice(checkpointEntries.length)
  const newTranslationsMap = new Map<string, string>(
    checkpointEntries.map((e) => [e.key, e.sentence]),
  )

  const chunks = chunkEntries(remaining, args.batchSize)
  const totalBatches = chunks.length
  deps.stderr.write(
    startupInfo(
      args,
      toTranslate.length,
      Math.ceil(toTranslate.length / args.batchSize),
      checkpointEntries.length > 0,
    ) + "\n",
  )

  for (const [index, chunk] of chunks.entries()) {
    const currentBatch = index + 1
    deps.stderr.write(`processing batch ${currentBatch}/${totalBatches}\n`)
    const sentences = await deps.translateTextUnitsBatch({
      entries: chunk,
      setupContext: args.setupContext,
      command,
      timeoutSeconds: args.timeoutSeconds,
      batchIndex: currentBatch,
      totalBatches,
      stdinEndToken: args.stdinEndToken,
      maxRetries: args.maxRetries,
      onRetry: (attempt, error) =>
        deps.stderr.write(
          `  batch ${currentBatch} failed, retrying (${attempt}/${args.maxRetries}): ${error.message}\n`,
        ),
    })
    chunk.forEach((entry, i) => {
      const translated = {
        key: entry.key,
        sentence: sentences[i],
        context: entry.context,
      }
      checkpointEntries.push(translated)
      newTranslationsMap.set(entry.key, sentences[i])
    })
    deps.writeCsvEntries(checkpointFile, checkpointEntries)
  }

  const allTranslations = inputEntries.map((e) => ({
    key: e.key,
    sentence:
      existingMap.get(e.key) ?? newTranslationsMap.get(e.key) ?? e.sentence,
    context: e.context,
  }))

  deps.writeCsvEntries(tmpFile, allTranslations, csvHeader)
  deps.replaceSync(tmpFile, args.outputFile)
  if (deps.existsSync(checkpointFile)) deps.removeSync(checkpointFile)

  return 0
}

async function runMissingPlain(
  args: CliArgs,
  deps: CliDeps,
  command: string[],
): Promise<number> {
  const allInputLines = deps.readLines(args.inputFile)
  let inputHeader: string[] = []
  let inputLines = allInputLines
  if (allInputLines.length > 0) {
    const firstRow = parseCsvRows(allInputLines[0].replace(/\r?\n$/u, ""))
    if (firstRow.length > 0 && isHeaderRow(firstRow[0])) {
      inputHeader = [allInputLines[0]]
      inputLines = allInputLines.slice(1)
    }
  }

  const outputLines: string[] = []
  if (deps.existsSync(args.outputFile)) {
    const allOut = deps.readLines(args.outputFile)
    const outStart =
      inputHeader.length > 0 &&
      allOut.length > 0 &&
      isHeaderRow(parseCsvRows(allOut[0].replace(/\r?\n$/u, ""))[0] ?? [])
        ? 1
        : 0
    outputLines.push(...allOut.slice(outStart))
  }

  const missingIndices: number[] = []
  for (let i = 0; i < inputLines.length; i += 1) {
    const outLine = outputLines[i] ?? ""
    if (outLine.trim() === "") missingIndices.push(i)
  }

  const missingLines = missingIndices.map((i) => inputLines[i])
  const totalBatches = Math.ceil(missingLines.length / args.batchSize)
  deps.stderr.write(
    startupInfo(args, missingLines.length, totalBatches, false) + "\n",
  )

  const translatedMissing = await deps.translateBatches({
    lines: missingLines,
    batchSize: args.batchSize,
    setupContext: args.setupContext,
    command,
    timeoutSeconds: args.timeoutSeconds,
    stdinEndToken: args.stdinEndToken,
    maxRetries: args.maxRetries,
    onBatchRetry: (batchIndex, attempt, error) =>
      deps.stderr.write(
        `  batch ${batchIndex} failed, retrying (${attempt}/${args.maxRetries}): ${error.message}\n`,
      ),
    progressCallback: (current, total) =>
      deps.stderr.write(`processing batch ${current}/${total}\n`),
  })

  const missingPosMap = new Map(missingIndices.map((idx, pos) => [idx, pos]))
  const finalLines = inputLines.map((_, i) => {
    const missingPos = missingPosMap.get(i)
    if (missingPos !== undefined)
      return translatedMissing[missingPos] ?? inputLines[i]
    return outputLines[i] ?? inputLines[i]
  })

  deps.writeLines(args.outputFile, [...inputHeader, ...finalLines])
  return 0
}

async function runReviewMode(
  args: CliArgs,
  deps: CliDeps,
  command: string[],
): Promise<number> {
  if (args.inputFormat === "json") {
    return runReviewJson(args, deps, command)
  }
  if (args.inputFormat === "csv3") {
    return runReviewCsv3(args, deps, command)
  }
  return runReviewPlain(args, deps, command)
}

async function runReviewJson(
  args: CliArgs,
  deps: CliDeps,
  command: string[],
): Promise<number> {
  if (!deps.existsSync(args.outputFile)) {
    throw new Error(
      `--mode review requires an existing output file: ${args.outputFile} not found`,
    )
  }

  const original = deps.readJsonFile(args.inputFile)
  const inputEntries = deps.flattenJson(original)

  const existingTranslations = new Map<string, string>()
  for (const e of deps.flattenJson(deps.readJsonFile(args.outputFile))) {
    existingTranslations.set(e.key, e.sentence)
  }

  const checkpointFile = checkpointPath(args.outputFile)
  const tmpFile = tmpOutputPath(args.outputFile)
  const checkpointEntries = loadCheckpointIfAny(
    checkpointFile,
    inputEntries,
    deps,
  )
  const remaining = inputEntries.slice(checkpointEntries.length)

  const chunks = chunkEntries(remaining, args.batchSize)
  const totalBatches = chunks.length
  deps.stderr.write(
    startupInfo(
      args,
      inputEntries.length,
      Math.ceil(inputEntries.length / args.batchSize),
      checkpointEntries.length > 0,
    ) + "\n",
  )

  for (const [index, chunk] of chunks.entries()) {
    const currentBatch = index + 1
    deps.stderr.write(`processing batch ${currentBatch}/${totalBatches}\n`)
    const reviewed = await deps.translateTextUnitsBatchReview({
      entries: chunk,
      existingTranslations,
      setupContext: args.setupContext,
      command,
      timeoutSeconds: args.timeoutSeconds,
      batchIndex: currentBatch,
      totalBatches,
      stdinEndToken: args.stdinEndToken,
      maxRetries: args.maxRetries,
      onRetry: (attempt, error) =>
        deps.stderr.write(
          `  batch ${currentBatch} failed, retrying (${attempt}/${args.maxRetries}): ${error.message}\n`,
        ),
    })
    chunk.forEach((entry, i) => {
      checkpointEntries.push({
        key: entry.key,
        sentence: reviewed[i],
        context: entry.context,
      })
    })
    deps.writeCsvEntries(checkpointFile, checkpointEntries)
  }

  const reviewedObj = deps.unflattenJson(original, checkpointEntries)
  deps.writeJsonFile(tmpFile, reviewedObj)
  deps.replaceSync(tmpFile, args.outputFile)
  if (deps.existsSync(checkpointFile)) deps.removeSync(checkpointFile)

  return 0
}

async function runReviewCsv3(
  args: CliArgs,
  deps: CliDeps,
  command: string[],
): Promise<number> {
  if (!deps.existsSync(args.outputFile)) {
    throw new Error(
      `--mode review requires an existing output file: ${args.outputFile} not found`,
    )
  }

  const csvHeader = deps.readCsvHeader(args.inputFile)
  const inputEntries = deps.readCsvEntries(args.inputFile)

  const existingTranslations = new Map<string, string>()
  for (const e of deps.readCsvEntries(args.outputFile)) {
    existingTranslations.set(e.key, e.sentence)
  }

  const checkpointFile = checkpointPath(args.outputFile)
  const tmpFile = tmpOutputPath(args.outputFile)
  const checkpointEntries = loadCheckpointIfAny(
    checkpointFile,
    inputEntries,
    deps,
  )
  const remaining = inputEntries.slice(checkpointEntries.length)

  const chunks = chunkEntries(remaining, args.batchSize)
  const totalBatches = chunks.length
  deps.stderr.write(
    startupInfo(
      args,
      inputEntries.length,
      Math.ceil(inputEntries.length / args.batchSize),
      checkpointEntries.length > 0,
    ) + "\n",
  )

  for (const [index, chunk] of chunks.entries()) {
    const currentBatch = index + 1
    deps.stderr.write(`processing batch ${currentBatch}/${totalBatches}\n`)
    const reviewed = await deps.translateTextUnitsBatchReview({
      entries: chunk,
      existingTranslations,
      setupContext: args.setupContext,
      command,
      timeoutSeconds: args.timeoutSeconds,
      batchIndex: currentBatch,
      totalBatches,
      stdinEndToken: args.stdinEndToken,
      maxRetries: args.maxRetries,
      onRetry: (attempt, error) =>
        deps.stderr.write(
          `  batch ${currentBatch} failed, retrying (${attempt}/${args.maxRetries}): ${error.message}\n`,
        ),
    })
    chunk.forEach((entry, i) => {
      checkpointEntries.push({
        key: entry.key,
        sentence: reviewed[i],
        context: entry.context,
      })
    })
    deps.writeCsvEntries(checkpointFile, checkpointEntries)
  }

  deps.writeCsvEntries(tmpFile, checkpointEntries, csvHeader)
  deps.replaceSync(tmpFile, args.outputFile)
  if (deps.existsSync(checkpointFile)) deps.removeSync(checkpointFile)

  return 0
}

async function runReviewPlain(
  args: CliArgs,
  deps: CliDeps,
  command: string[],
): Promise<number> {
  if (!deps.existsSync(args.outputFile)) {
    throw new Error(
      `--mode review requires an existing output file: ${args.outputFile} not found`,
    )
  }

  const allOutputLines = deps.readLines(args.outputFile)
  let outputHeader: string[] = []
  let outputLines = allOutputLines
  if (allOutputLines.length > 0) {
    const firstRow = parseCsvRows(allOutputLines[0].replace(/\r?\n$/u, ""))
    if (firstRow.length > 0 && isHeaderRow(firstRow[0])) {
      outputHeader = [allOutputLines[0]]
      outputLines = allOutputLines.slice(1)
    }
  }

  const reviewInstruction =
    "Review the following translated lines. " +
    "Only change a line if there is a clear improvement. " +
    "Preserve placeholders and formatting exactly. " +
    "Return each line unchanged if it is acceptable."

  const totalBatches = Math.ceil(outputLines.length / args.batchSize)
  deps.stderr.write(
    startupInfo(args, outputLines.length, totalBatches, false) + "\n",
  )

  const reviewed = await deps.translateBatches({
    lines: outputLines,
    batchSize: args.batchSize,
    setupContext: args.setupContext,
    instruction: reviewInstruction,
    command,
    timeoutSeconds: args.timeoutSeconds,
    stdinEndToken: args.stdinEndToken,
    maxRetries: args.maxRetries,
    onBatchRetry: (batchIndex, attempt, error) =>
      deps.stderr.write(
        `  batch ${batchIndex} failed, retrying (${attempt}/${args.maxRetries}): ${error.message}\n`,
      ),
    progressCallback: (current, total) =>
      deps.stderr.write(`processing batch ${current}/${total}\n`),
  })

  deps.writeLines(args.outputFile, [...outputHeader, ...reviewed])
  return 0
}

export async function main(
  argv: string[] = process.argv.slice(2),
  partialDeps: Partial<CliDeps> = {},
  invokedAs: string | undefined = process.argv[1],
): Promise<number> {
  const deps: CliDeps = { ...defaultDeps, ...partialDeps }
  let args: CliArgs
  try {
    args = parseArgs(argv, { defaultTool: detectTool(invokedAs) })
  } catch (e) {
    if (e instanceof HelpRequestedError) {
      process.stdout.write(buildHelpText(programName(invokedAs)))
      return 0
    }
    throw e
  }
  if (args.setupContextFile) {
    args.setupContext = deps.readFile(args.setupContextFile)
    if (!args.setupContext.trim()) {
      throw new Error(
        `--setup-context-file: file is empty: ${args.setupContextFile}`,
      )
    }
  }
  if (args.tool === "claude") {
    if (args.provider && args.provider !== "stdout") {
      deps.stderr.write("--provider is ignored with --tool claude\n")
    }
    if (args.apiKey) {
      deps.stderr.write("--api-key is ignored with --tool claude\n")
    }
    if (args.allowExtensions) {
      deps.stderr.write("--allow-extensions is ignored with --tool claude\n")
    }
  }
  const command = buildCommand(args)

  if (args.mode === "missing") {
    return runMissingMode(args, deps, command)
  }
  if (args.mode === "review") {
    return runReviewMode(args, deps, command)
  }

  if (args.inputFormat === "csv3") {
    const csvHeader = deps.readCsvHeader(args.inputFile)
    const entries = deps.readCsvEntries(args.inputFile)
    const checkpointFile = checkpointPath(args.outputFile)
    const tmpFile = tmpOutputPath(args.outputFile)
    const translatedEntries = loadCheckpointIfAny(checkpointFile, entries, deps)
    const remainingEntries = entries.slice(translatedEntries.length)

    const chunks: TranslationEntry[][] = []
    let chunkStart = 0
    while (chunkStart < remainingEntries.length) {
      chunks.push(
        remainingEntries.slice(chunkStart, chunkStart + args.batchSize),
      )
      chunkStart += args.batchSize
    }

    const totalBatches = chunks.length
    deps.stderr.write(
      startupInfo(
        args,
        entries.length,
        Math.ceil(entries.length / args.batchSize),
        translatedEntries.length > 0,
      ) + "\n",
    )

    for (const [index, chunk] of chunks.entries()) {
      const currentBatch = index + 1
      deps.stderr.write(`processing batch ${currentBatch}/${totalBatches}\n`)
      const translatedSentences = await deps.translateTextUnitsBatch({
        entries: chunk,
        setupContext: args.setupContext,
        command,
        timeoutSeconds: args.timeoutSeconds,
        batchIndex: currentBatch,
        totalBatches,
        stdinEndToken: args.stdinEndToken,
        maxRetries: args.maxRetries,
        onRetry: (attempt, error) =>
          deps.stderr.write(
            `  batch ${currentBatch} failed, retrying (${attempt}/${args.maxRetries}): ${error.message}\n`,
          ),
      })

      chunk.forEach((entry, sentence) => {
        translatedEntries.push({
          key: entry.key,
          sentence: translatedSentences[sentence],
          context: entry.context,
        })
      })

      deps.writeCsvEntries(checkpointFile, translatedEntries)
    }

    deps.writeCsvEntries(tmpFile, translatedEntries, csvHeader)
    deps.replaceSync(tmpFile, args.outputFile)
    if (deps.existsSync(checkpointFile)) {
      deps.removeSync(checkpointFile)
    }

    return 0
  }

  if (args.inputFormat === "json") {
    const original = deps.readJsonFile(args.inputFile)
    const entries = deps.flattenJson(original)
    const checkpointFile = checkpointPath(args.outputFile)
    const tmpFile = tmpOutputPath(args.outputFile)
    const translatedEntries = loadCheckpointIfAny(checkpointFile, entries, deps)
    const remainingEntries = entries.slice(translatedEntries.length)

    const chunks: TranslationEntry[][] = []
    let chunkStart = 0
    while (chunkStart < remainingEntries.length) {
      chunks.push(
        remainingEntries.slice(chunkStart, chunkStart + args.batchSize),
      )
      chunkStart += args.batchSize
    }

    const totalBatches = chunks.length
    deps.stderr.write(
      startupInfo(
        args,
        entries.length,
        Math.ceil(entries.length / args.batchSize),
        translatedEntries.length > 0,
      ) + "\n",
    )

    for (const [index, chunk] of chunks.entries()) {
      const currentBatch = index + 1
      deps.stderr.write(`processing batch ${currentBatch}/${totalBatches}\n`)
      const translatedSentences = await deps.translateTextUnitsBatch({
        entries: chunk,
        setupContext: args.setupContext,
        command,
        timeoutSeconds: args.timeoutSeconds,
        batchIndex: currentBatch,
        totalBatches,
        stdinEndToken: args.stdinEndToken,
        maxRetries: args.maxRetries,
        onRetry: (attempt, error) =>
          deps.stderr.write(
            `  batch ${currentBatch} failed, retrying (${attempt}/${args.maxRetries}): ${error.message}\n`,
          ),
      })

      chunk.forEach((entry, i) => {
        translatedEntries.push({
          key: entry.key,
          sentence: translatedSentences[i],
          context: entry.context,
        })
      })

      deps.writeCsvEntries(checkpointFile, translatedEntries)
    }

    const translatedObj = deps.unflattenJson(original, translatedEntries)
    deps.writeJsonFile(tmpFile, translatedObj)
    deps.replaceSync(tmpFile, args.outputFile)
    if (deps.existsSync(checkpointFile)) {
      deps.removeSync(checkpointFile)
    }

    return 0
  }

  const allLines = deps.readLines(args.inputFile)
  let headerLines: string[] = []
  let contentLines = allLines

  if (allLines.length > 0) {
    const firstRow = parseCsvRows(allLines[0].replace(/\r?\n$/u, ""))
    if (firstRow.length > 0 && isHeaderRow(firstRow[0])) {
      headerLines = [allLines[0]]
      contentLines = allLines.slice(1)
    }
  }

  const totalPlainBatches = Math.ceil(contentLines.length / args.batchSize)
  deps.stderr.write(
    startupInfo(args, contentLines.length, totalPlainBatches, false) + "\n",
  )

  const translated = await deps.translateBatches({
    lines: contentLines,
    batchSize: args.batchSize,
    setupContext: args.setupContext,
    command,
    timeoutSeconds: args.timeoutSeconds,
    stdinEndToken: args.stdinEndToken,
    maxRetries: args.maxRetries,
    onBatchRetry: (batchIndex, attempt, error) =>
      deps.stderr.write(
        `  batch ${batchIndex} failed, retrying (${attempt}/${args.maxRetries}): ${error.message}\n`,
      ),
    progressCallback: (current, total) =>
      deps.stderr.write(`processing batch ${current}/${total}\n`),
  })

  deps.writeLines(args.outputFile, [...headerLines, ...translated])
  return 0
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    // Resolve symlinks on both sides: when installed via npm the bin is a
    // symlink (pi-translate -> .../dist/cli.js), so argv[1] is the symlink
    // path while import.meta.url is the real file. Compare their realpaths.
    return (
      fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url))
    )
  } catch {
    return false
  }
}

const isDirectExecution = isMainModule()

if (isDirectExecution) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`${message}\n`)
      process.exitCode = 1
    },
  )
}
