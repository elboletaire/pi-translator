import fs from "node:fs"

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
import { translateBatches, translateTextUnitsBatch } from "./translator"
import type { CliArgs, InputFormat, TranslationEntry } from "./types"

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

export function parseArgs(argv: string[]): CliArgs {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv

  if (normalizedArgv.length < 2) {
    throw new Error(
      "Usage: pi-translator <input_file> <output_file> --setup-context <text>|--setup-context-file <path> [options]",
    )
  }

  const [inputFile, outputFile, ...rest] = normalizedArgv
  const args: CliArgs = {
    inputFile,
    outputFile,
    setupContext: "",
    batchSize: 50,
    inputFormat: inferInputFormat(inputFile),
    timeoutSeconds: 120,
    piCmd: "pi",
    stdinEndToken: "__NEXT_BATCH__",
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
      case "--no-autodetect-format":
        args.inputFormat = "plain"
        break
      case "--timeout-seconds": {
        const timeout = Number.parseInt(getValue(), 10)
        if (!Number.isFinite(timeout) || timeout <= 0) {
          throw new Error("--timeout-seconds must be a positive integer")
        }
        args.timeoutSeconds = timeout
        break
      }
      case "--pi-cmd":
      case "--pi-mono-cmd":
        args.piCmd = getValue()
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

export function buildPiCommand(
  args: Pick<CliArgs, "piCmd" | "provider" | "model" | "apiKey">,
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
  command.push("--no-session", "--print", "-nc", "-ne", "-ns", "-np")
  return command
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
): string {
  const model = args.model ?? "pi default"
  const provider = args.provider ? ` via ${args.provider}` : ""
  const resumeNote =
    entries < totalBatches * args.batchSize ? " (resuming)" : ""
  return (
    `pi-translate: ${args.inputFormat} • ` +
    `${entries} entries • ` +
    `${totalBatches} batches of ${args.batchSize}${resumeNote} • ` +
    `model: ${model}${provider}`
  )
}

export async function main(
  argv: string[] = process.argv.slice(2),
  partialDeps: Partial<CliDeps> = {},
): Promise<number> {
  const deps: CliDeps = { ...defaultDeps, ...partialDeps }
  const args = parseArgs(argv)
  if (args.setupContextFile) {
    args.setupContext = deps.readFile(args.setupContextFile)
    if (!args.setupContext.trim()) {
      throw new Error(
        `--setup-context-file: file is empty: ${args.setupContextFile}`,
      )
    }
  }
  const command = buildPiCommand(args)

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
    deps.stderr.write(startupInfo(args, entries.length, totalBatches) + "\n")

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
    deps.stderr.write(startupInfo(args, entries.length, totalBatches) + "\n")

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
    startupInfo(args, contentLines.length, totalPlainBatches) + "\n",
  )

  const translated = await deps.translateBatches({
    lines: contentLines,
    batchSize: args.batchSize,
    setupContext: args.setupContext,
    command,
    timeoutSeconds: args.timeoutSeconds,
    stdinEndToken: args.stdinEndToken,
    progressCallback: (current, total) =>
      deps.stderr.write(`processing batch ${current}/${total}\n`),
  })

  deps.writeLines(args.outputFile, [...headerLines, ...translated])
  return 0
}

const isDirectExecution = process.argv[1]
  ? import.meta.url === new URL(`file://${process.argv[1]}`).href
  : false

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
