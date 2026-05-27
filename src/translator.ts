import { spawn } from "node:child_process"
import readline from "node:readline"

import { parseCsvRows, splitKeepNewlines } from "./io"
import type { TranslationEntry } from "./types"

export interface ExchangeIo {
  stdin?: NodeJS.ReadableStream
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
}

export type ExchangeFn = (params: {
  prompt: string
  command: string[]
  timeoutSeconds: number
  io?: ExchangeIo
  stdinEndToken?: string
}) => Promise<string>

export function chunkLines(lines: string[], batchSize: number): string[][] {
  if (batchSize <= 0) {
    throw new Error("batch_size must be > 0")
  }
  const chunks: string[][] = []
  for (let index = 0; index < lines.length; index += batchSize) {
    chunks.push(lines.slice(index, index + batchSize))
  }
  return chunks
}

export function buildPrompt(
  setupContext: string,
  chunkLines_: string[],
  chunkIndex: number,
  totalChunks: number,
): string {
  const chunkText = chunkLines_.join("")
  return (
    "You are a translation engine.\n" +
    "Follow the setup context exactly.\n\n" +
    `Setup context:\n${setupContext.trim()}\n\n` +
    `Chunk ${chunkIndex}/${totalChunks}\n` +
    "Translate the following lines preserving order and line breaks.\n" +
    "Return only translated lines, with no explanations.\n\n" +
    chunkText
  )
}

export async function translateBatches(params: {
  lines: string[]
  batchSize: number
  setupContext: string
  command: string[]
  timeoutSeconds: number
  progressCallback?: (current: number, total: number) => void
  stdinEndToken?: string
  exchange?: ExchangeFn
  io?: ExchangeIo
}): Promise<string[]> {
  const {
    lines,
    batchSize,
    setupContext,
    command,
    timeoutSeconds,
    progressCallback,
    stdinEndToken = "__NEXT_BATCH__",
    exchange = exchangeWithProvider,
    io,
  } = params

  const allChunks = chunkLines(lines, batchSize)
  const translated: string[] = []

  for (let index = 0; index < allChunks.length; index += 1) {
    const chunkIndex = index + 1
    const chunk = allChunks[index]
    progressCallback?.(chunkIndex, allChunks.length)
    const prompt = buildPrompt(
      setupContext,
      chunk,
      chunkIndex,
      allChunks.length,
    )
    const rawOutput = await exchange({
      prompt,
      command,
      timeoutSeconds,
      io,
      stdinEndToken,
    })
    translated.push(...splitKeepNewlines(rawOutput))
  }

  return translated
}

export async function translateTextUnit(params: {
  translationKey: string
  sentence: string
  context?: string
  setupContext: string
  command: string[]
  timeoutSeconds: number
  stdinEndToken?: string
  exchange?: ExchangeFn
  io?: ExchangeIo
}): Promise<string> {
  const {
    translationKey,
    sentence,
    context,
    setupContext,
    command,
    timeoutSeconds,
    stdinEndToken = "__NEXT_BATCH__",
    exchange = exchangeWithProvider,
    io,
  } = params

  const contextBlock = context ? context.trim() : ""
  const prompt =
    "You are translating one localization unit.\n" +
    "Do not translate the key.\n" +
    "Use context only as guidance.\n" +
    "Return only the translated sentence.\n\n" +
    `Setup context:\n${setupContext.trim()}\n\n` +
    `Translation key (do not translate):\n${translationKey}\n\n` +
    `Sentence to translate:\n${sentence}\n\n` +
    `Optional context (do not translate):\n${contextBlock}\n`

  const rawOutput = await exchange({
    prompt,
    command,
    timeoutSeconds,
    io,
    stdinEndToken,
  })

  return rawOutput.replace(/\n+$/u, "")
}

export async function translateTextUnitsBatch(params: {
  entries: TranslationEntry[]
  setupContext: string
  command: string[]
  timeoutSeconds: number
  batchIndex: number
  totalBatches: number
  stdinEndToken?: string
  exchange?: ExchangeFn
  io?: ExchangeIo
}): Promise<string[]> {
  const {
    entries,
    setupContext,
    command,
    timeoutSeconds,
    batchIndex,
    totalBatches,
    stdinEndToken = "__NEXT_BATCH__",
    exchange = exchangeWithProvider,
    io,
  } = params

  if (entries.length === 0) {
    return []
  }

  const payload = entries.map((entry) => ({
    key: entry.key,
    sentence: entry.sentence,
    context: entry.context,
  }))

  const prompt =
    "You are translating localization entries.\n" +
    "Do not translate keys.\n" +
    "Use context only as guidance.\n" +
    `Batch ${batchIndex}/${totalBatches}\n` +
    `Return ONLY a JSON array with exactly ${entries.length} translated strings.\n` +
    "Keep the same order as input.\n\n" +
    `Setup context:\n${setupContext.trim()}\n\n` +
    `Entries:\n${JSON.stringify(payload)}\n`

  const rawOutput = await exchange({
    prompt,
    command,
    timeoutSeconds,
    io,
    stdinEndToken,
  })

  const parsed = parseBatchOutput(rawOutput)
  if (parsed.length !== entries.length) {
    throw new Error("model returned unexpected number of translated entries")
  }
  return normalizeBatchItems(parsed, rawOutput, entries)
}

function parseBatchOutput(text: string): unknown[] {
  try {
    return parseJsonArrayOutput(text)
  } catch {
    return parseCsvOutput(text)
  }
}

function parseJsonArrayOutput(text: string): unknown[] {
  const raw = text.trim()
  if (!raw) {
    throw new Error("model returned empty output")
  }

  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed
    }
  } catch {
    // continue recovery
  }

  const fencedPattern = /```(?:json)?\s*([\s\S]*?)\s*```/giu
  for (const match of raw.matchAll(fencedPattern)) {
    const block = match[1]?.trim()
    if (!block) {
      continue
    }
    try {
      const parsed = JSON.parse(block)
      if (Array.isArray(parsed)) {
        return parsed
      }
    } catch {
      // continue scanning
    }
  }

  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== "[") {
      continue
    }
    const candidate = extractBalancedArray(raw, index)
    if (!candidate) {
      continue
    }
    try {
      const parsed = JSON.parse(candidate)
      if (Array.isArray(parsed)) {
        return parsed
      }
    } catch {
      // continue scanning
    }
  }

  const preview = raw.slice(0, 200).replaceAll("\n", "\\n")
  throw new Error(`model output is not a parseable JSON array: ${preview}`)
}

function extractBalancedArray(text: string, start: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === "[") {
      depth += 1
      continue
    }

    if (char === "]") {
      depth -= 1
      if (depth === 0) {
        return text.slice(start, index + 1)
      }
      continue
    }
  }

  return null
}

function parseCsvOutput(text: string): unknown[] {
  const raw = text.trim()
  if (!raw) {
    throw new Error("model returned empty output")
  }

  const candidates = [raw]
  const fencedPattern = /```(?:csv)?\s*([\s\S]*?)\s*```/giu
  for (const match of raw.matchAll(fencedPattern)) {
    const block = match[1]?.trim()
    if (block) {
      candidates.push(block)
    }
  }

  for (const candidate of candidates) {
    const rows = parseCsvRows(candidate).filter((row) => row.length > 0)
    if (rows.length === 0) {
      continue
    }

    const first = rows[0].map((cell) => cell.trim().toLowerCase())
    const hasHeader =
      first.length >= 2 &&
      new Set(["key", "id"]).has(first[0]) &&
      new Set(["sentence", "translation", "text", "value"]).has(first[1])

    const bodyRows = hasHeader ? rows.slice(1) : rows
    if (bodyRows.length === 0 || bodyRows.some((row) => row.length < 2)) {
      continue
    }

    return bodyRows
  }

  const preview = raw.slice(0, 200).replaceAll("\n", "\\n")
  throw new Error(
    `model output is not parseable as JSON array or CSV rows: ${preview}`,
  )
}

function normalizeBatchItems(
  parsed: unknown[],
  rawOutput: string,
  expectedEntries: TranslationEntry[],
): string[] {
  if (parsed.every((item) => typeof item === "string")) {
    return parsed as string[]
  }

  const normalized: string[] = []

  parsed.forEach((item, index) => {
    const expectedKey =
      index < expectedEntries.length ? expectedEntries[index].key : ""

    if (Array.isArray(item)) {
      const translation = pickTranslationFromCsvRow(item, expectedKey)
      if (translation !== null) {
        normalized.push(translation)
        return
      }
    }

    if (item && typeof item === "object") {
      const itemRecord = item as Record<string, unknown>
      const keyValue = itemRecord.key
      if (
        typeof keyValue === "string" &&
        expectedKey &&
        keyValue !== expectedKey
      ) {
        const rawPreview = rawOutput.slice(0, 1000).replaceAll("\n", "\\n")
        throw new Error(
          "model returned mismatched key in translation object; " +
            `expected=${JSON.stringify(expectedKey)} got=${JSON.stringify(keyValue)}; raw output=${rawPreview}`,
        )
      }

      for (const field of ["sentence", "translation", "text"]) {
        const value = itemRecord[field]
        if (typeof value === "string") {
          normalized.push(value)
          return
        }
      }
    }

    const rawPreview = rawOutput.slice(0, 1000).replaceAll("\n", "\\n")
    throw new Error(
      "model returned non-string translations; " +
        `parsed=${JSON.stringify(parsed)}; raw output=${rawPreview}`,
    )
  })

  return normalized
}

function pickTranslationFromCsvRow(
  row: unknown[],
  expectedKey: string,
): string | null {
  if (row.length === 0) {
    return null
  }

  const stringCells = row.filter(
    (cell): cell is string => typeof cell === "string",
  )
  if (stringCells.length === 1) {
    return stringCells[0]
  }
  if (stringCells.length === 0) {
    return null
  }

  const first = stringCells[0].trim()
  if (expectedKey && first === expectedKey) {
    if (stringCells.length >= 3 && stringCells[1].trim() === expectedKey) {
      return stringCells[2]
    }
    if (stringCells.length >= 2) {
      return stringCells[1]
    }
  }

  if (stringCells.length >= 2) {
    return stringCells[1]
  }

  return null
}

async function readUntilToken(
  input: NodeJS.ReadableStream,
  token: string,
): Promise<string> {
  const rl = readline.createInterface({
    input,
    crlfDelay: Number.POSITIVE_INFINITY,
    terminal: false,
  })

  const lines: string[] = []
  try {
    for await (const line of rl) {
      if (line === token) {
        break
      }
      lines.push(`${line}\n`)
    }
  } finally {
    rl.close()
  }

  return lines.join("")
}

export async function exchangeWithProvider(params: {
  prompt: string
  command: string[]
  timeoutSeconds: number
  io?: ExchangeIo
  stdinEndToken?: string
}): Promise<string> {
  const {
    prompt,
    command,
    timeoutSeconds,
    io,
    stdinEndToken = "__NEXT_BATCH__",
  } = params

  if (command.length === 0) {
    throw new Error("command must not be empty")
  }

  if (command[0] === "stdout") {
    const input = io?.stdin ?? process.stdin
    const output = io?.stdout ?? process.stdout
    const error = io?.stderr ?? process.stderr

    output.write("-----BEGIN BATCH PROMPT-----\n")
    output.write(prompt)
    if (!prompt.endsWith("\n")) {
      output.write("\n")
    }
    output.write("-----END BATCH PROMPT-----\n")

    error.write(
      `Paste model output, then write ${stdinEndToken} on its own line.\n`,
    )

    return readUntilToken(input, stdinEndToken)
  }

  return new Promise<string>((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let settled = false

    const fail = (error: Error): void => {
      if (settled) {
        return
      }
      settled = true
      reject(error)
    }

    const succeed = (output: string): void => {
      if (settled) {
        return
      }
      settled = true
      resolve(output)
    }

    const timeout =
      timeoutSeconds > 0
        ? setTimeout(() => {
            child.kill("SIGKILL")
            fail(
              new Error(`provider command timed out after ${timeoutSeconds}s`),
            )
          }, timeoutSeconds * 1000)
        : null

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })

    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })

    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout)
      }
      fail(error)
    })

    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout)
      }
      if (settled) {
        return
      }
      if (code === 0) {
        succeed(stdout)
        return
      }
      const stderrSnippet = stderr.trim().slice(0, 500)
      fail(
        new Error(
          `provider command failed with exit code ${code ?? "null"}${
            stderrSnippet ? `: ${stderrSnippet}` : ""
          }`,
        ),
      )
    })

    child.stdin.setDefaultEncoding("utf8")
    child.stdin.write(prompt)
    child.stdin.end()
  })
}
