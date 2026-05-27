import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Writable } from "node:stream"

import { afterEach, describe, expect, it } from "vitest"

import { buildPiCommand, main, parseArgs } from "./cli"
import { parseCsvEntries, serializeCsvEntries } from "./io"
import type { TranslationEntry } from "./types"

class StringWritable extends Writable {
  public data = ""

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.data += chunk.toString()
    callback()
  }
}

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-translator-cli-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("build command", () => {
  it("includes provider and model flags", () => {
    const command = buildPiCommand({
      piCmd: "pi",
      provider: "openai",
      model: "gpt-5.4",
      apiKey: undefined,
    })

    expect(command).toEqual([
      "pi",
      "--provider",
      "openai",
      "--model",
      "gpt-5.4",
      "--print",
    ])
  })

  it("includes api key when set", () => {
    const command = buildPiCommand({
      piCmd: "pi",
      provider: undefined,
      model: "openai/gpt-5.4",
      apiKey: "abc123",
    })

    expect(command).toEqual([
      "pi",
      "--model",
      "openai/gpt-5.4",
      "--api-key",
      "abc123",
      "--print",
    ])
  })

  it("uses stdout provider mode", () => {
    const command = buildPiCommand({
      piCmd: "pi",
      provider: "stdout",
      model: "ignored",
      apiKey: "ignored",
    })

    expect(command).toEqual(["stdout"])
  })
})

describe("parse args", () => {
  it("accepts csv3 input format and default stdin end token", () => {
    const args = parseArgs([
      "in.csv",
      "out.csv",
      "--setup-context",
      "ctx",
      "--input-format",
      "csv3",
    ])
    expect(args.inputFormat).toBe("csv3")
    expect(args.stdinEndToken).toBe("__NEXT_BATCH__")
  })

  it("accepts argv with a leading -- separator", () => {
    const args = parseArgs([
      "--",
      "in.csv",
      "out.csv",
      "--setup-context",
      "ctx",
    ])
    expect(args.inputFile).toBe("in.csv")
    expect(args.outputFile).toBe("out.csv")
  })
})

describe("main orchestration", () => {
  it("logs progress in plain mode", async () => {
    const dir = makeTempDir()
    const inputFile = path.join(dir, "in.txt")
    const outputFile = path.join(dir, "out.txt")
    fs.writeFileSync(inputFile, "a\nb\nc\nd\n", "utf8")

    const stderr = new StringWritable()

    const exitCode = await main(
      [inputFile, outputFile, "--setup-context", "ctx", "--batch-size", "2"],
      {
        stderr,
        translateBatches: async ({ progressCallback }) => {
          progressCallback?.(1, 2)
          progressCallback?.(2, 2)
          return ["A\n", "B\n", "C\n", "D\n"]
        },
      },
    )

    expect(exitCode).toBe(0)
    expect(stderr.data).toContain("processing batch 1/2")
    expect(stderr.data).toContain("processing batch 2/2")
    expect(fs.readFileSync(outputFile, "utf8")).toBe("A\nB\nC\nD\n")
  })

  it("resumes csv3 from checkpoint and writes final output atomically", async () => {
    const dir = makeTempDir()
    const inputFile = path.join(dir, "in.csv")
    const outputFile = path.join(dir, "out.csv")
    const checkpointFile = `${outputFile}.part`

    const sourceEntries: TranslationEntry[] = [
      { key: "k1", sentence: "s1", context: "c1" },
      { key: "k2", sentence: "s2", context: "c2" },
      { key: "k3", sentence: "s3", context: "c3" },
    ]
    const checkpointEntries: TranslationEntry[] = [
      { key: "k1", sentence: "t1", context: "c1" },
    ]

    fs.writeFileSync(inputFile, serializeCsvEntries(sourceEntries), "utf8")
    fs.writeFileSync(
      checkpointFile,
      serializeCsvEntries(checkpointEntries),
      "utf8",
    )

    let callCount = 0
    const stderr = new StringWritable()

    const exitCode = await main(
      [
        inputFile,
        outputFile,
        "--setup-context",
        "ctx",
        "--batch-size",
        "2",
        "--input-format",
        "csv3",
        "--provider",
        "anthropic",
        "--model",
        "claude",
      ],
      {
        stderr,
        translateTextUnitsBatch: async ({ entries }) => {
          callCount += 1
          return entries.map((entry) => `translated-${entry.key}`)
        },
      },
    )

    expect(exitCode).toBe(0)
    expect(callCount).toBe(1)
    expect(stderr.data).toContain("processing batch 1/1")
    expect(fs.existsSync(checkpointFile)).toBe(false)

    const outEntries = parseCsvEntries(fs.readFileSync(outputFile, "utf8"))
    expect(outEntries).toEqual([
      { key: "k1", sentence: "t1", context: "c1" },
      { key: "k2", sentence: "translated-k2", context: "c2" },
      { key: "k3", sentence: "translated-k3", context: "c3" },
    ])
  })

  it("honors batch size in csv mode", async () => {
    const dir = makeTempDir()
    const inputFile = path.join(dir, "in.csv")
    const outputFile = path.join(dir, "out.csv")

    const sourceEntries: TranslationEntry[] = [
      { key: "k1", sentence: "s1", context: "c1" },
      { key: "k2", sentence: "s2", context: "c2" },
      { key: "k3", sentence: "s3", context: "c3" },
      { key: "k4", sentence: "s4", context: "c4" },
      { key: "k5", sentence: "s5", context: "c5" },
    ]

    fs.writeFileSync(inputFile, serializeCsvEntries(sourceEntries), "utf8")

    const batchSizes: number[] = []

    const exitCode = await main(
      [
        inputFile,
        outputFile,
        "--setup-context",
        "ctx",
        "--batch-size",
        "2",
        "--input-format",
        "csv3",
      ],
      {
        stderr: new StringWritable(),
        translateTextUnitsBatch: async ({ entries }) => {
          batchSizes.push(entries.length)
          return entries.map((entry) => `t-${entry.key}`)
        },
      },
    )

    expect(exitCode).toBe(0)
    expect(batchSizes).toEqual([2, 2, 1])
  })
})
