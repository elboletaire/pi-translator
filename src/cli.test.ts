import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Writable } from "node:stream"

import { afterEach, describe, expect, it } from "vitest"

import {
  HELP_TEXT,
  HelpRequestedError,
  buildPiCommand,
  main,
  parseArgs,
} from "./cli"
import { flattenJson, parseCsvEntries, serializeCsvEntries } from "./io"
import { translateBatches } from "./translator"
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
      allowExtensions: false,
    })

    expect(command).toEqual([
      "pi",
      "--provider",
      "openai",
      "--model",
      "gpt-5.4",
      "--no-session",
      "--print",
      "-nc",
      "-ns",
      "-np",
      "-ne",
    ])
  })

  it("includes api key when set", () => {
    const command = buildPiCommand({
      piCmd: "pi",
      provider: undefined,
      model: "openai/gpt-5.4",
      apiKey: "abc123",
      allowExtensions: false,
    })

    expect(command).toEqual([
      "pi",
      "--model",
      "openai/gpt-5.4",
      "--api-key",
      "abc123",
      "--no-session",
      "--print",
      "-nc",
      "-ns",
      "-np",
      "-ne",
    ])
  })

  it("omits -ne when extensions are allowed", () => {
    const command = buildPiCommand({
      piCmd: "pi",
      provider: "pi-claude-cli",
      model: "claude-opus-4-8",
      apiKey: undefined,
      allowExtensions: true,
    })

    expect(command).toEqual([
      "pi",
      "--provider",
      "pi-claude-cli",
      "--model",
      "claude-opus-4-8",
      "--no-session",
      "--print",
      "-nc",
      "-ns",
      "-np",
    ])
  })

  it("uses stdout provider mode", () => {
    const command = buildPiCommand({
      piCmd: "pi",
      provider: "stdout",
      model: "ignored",
      apiKey: "ignored",
      allowExtensions: false,
    })

    expect(command).toEqual(["stdout"])
  })
})

describe("help flag", () => {
  it("--help throws HelpRequestedError", () => {
    expect(() => parseArgs(["--help"])).toThrow(HelpRequestedError)
  })

  it("-h throws HelpRequestedError", () => {
    expect(() => parseArgs(["-h"])).toThrow(HelpRequestedError)
  })

  it("--help takes precedence over missing required args", () => {
    expect(() => parseArgs(["--help"])).toThrow(HelpRequestedError)
  })

  it("--help mixed with other flags still throws HelpRequestedError", () => {
    expect(() =>
      parseArgs(["in.txt", "out.txt", "--setup-context", "ctx", "--help"]),
    ).toThrow(HelpRequestedError)
  })

  it("HELP_TEXT contains all flags", () => {
    const flags = [
      "--setup-context",
      "--setup-context-file",
      "--batch-size",
      "--input-format",
      "--mode",
      "--timeout-seconds",
      "--pi-cmd",
      "--pi-mono-cmd",
      "--provider",
      "--model",
      "--api-key",
      "--stdin-end-token",
      "--help",
    ]
    for (const flag of flags) {
      expect(HELP_TEXT).toContain(flag)
    }
  })

  it("HELP_TEXT lists all --input-format values", () => {
    expect(HELP_TEXT).toContain("plain")
    expect(HELP_TEXT).toContain("csv3")
    expect(HELP_TEXT).toContain("json")
  })

  it("HELP_TEXT lists all --mode values", () => {
    expect(HELP_TEXT).toContain("translate")
    expect(HELP_TEXT).toContain("missing")
    expect(HELP_TEXT).toContain("review")
  })

  it("main prints HELP_TEXT to stdout and returns 0 for --help", async () => {
    const written: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: string | Uint8Array) => {
      written.push(chunk.toString())
      return true
    }
    try {
      const code = await main(["--help"])
      expect(code).toBe(0)
      expect(written.join("")).toBe(HELP_TEXT)
    } finally {
      process.stdout.write = origWrite
    }
  })

  it("main prints HELP_TEXT to stdout and returns 0 for -h", async () => {
    const written: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: string | Uint8Array) => {
      written.push(chunk.toString())
      return true
    }
    try {
      const code = await main(["-h"])
      expect(code).toBe(0)
      expect(written.join("")).toBe(HELP_TEXT)
    } finally {
      process.stdout.write = origWrite
    }
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

  it("auto-detects json format from .json extension", () => {
    const args = parseArgs([
      "input.json",
      "output.json",
      "--setup-context",
      "ctx",
    ])
    expect(args.inputFormat).toBe("json")
  })

  it("auto-detects csv3 format from .csv extension", () => {
    const args = parseArgs([
      "input.csv",
      "output.csv",
      "--setup-context",
      "ctx",
    ])
    expect(args.inputFormat).toBe("csv3")
  })

  it("defaults to plain format for unknown extensions", () => {
    const args = parseArgs([
      "input.txt",
      "output.txt",
      "--setup-context",
      "ctx",
    ])
    expect(args.inputFormat).toBe("plain")
  })

  it("explicit --input-format overrides auto-detection", () => {
    const args = parseArgs([
      "input.json",
      "output.json",
      "--setup-context",
      "ctx",
      "--input-format",
      "plain",
    ])
    expect(args.inputFormat).toBe("plain")
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

  it("accepts json input format", () => {
    const args = parseArgs([
      "in.json",
      "out.json",
      "--setup-context",
      "ctx",
      "--input-format",
      "json",
    ])
    expect(args.inputFormat).toBe("json")
  })

  it("rejects unknown input format with updated error message", () => {
    expect(() =>
      parseArgs([
        "in.json",
        "out.json",
        "--setup-context",
        "ctx",
        "--input-format",
        "invalid",
      ]),
    ).toThrow("--input-format must be one of: plain, csv3, json")
  })

  it("rejects when neither --setup-context nor --setup-context-file are given", () => {
    expect(() => parseArgs(["in.json", "out.json"])).toThrow(
      "--setup-context or --setup-context-file is required",
    )
  })

  it("accepts --setup-context-file and stores the path", () => {
    const args = parseArgs([
      "input.json",
      "output.json",
      "--setup-context-file",
      "/some/context.md",
    ])
    expect(args.setupContextFile).toBe("/some/context.md")
    expect(args.setupContext).toBe("")
  })

  it("rejects when both --setup-context and --setup-context-file are given", () => {
    expect(() =>
      parseArgs([
        "input.json",
        "output.json",
        "--setup-context",
        "ctx",
        "--setup-context-file",
        "/some/context.md",
      ]),
    ).toThrow("--setup-context and --setup-context-file are mutually exclusive")
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

  it("preserves csv header row in csv3 mode", async () => {
    const dir = makeTempDir()
    const inputFile = path.join(dir, "in.csv")
    const outputFile = path.join(dir, "out.csv")

    const header = "ID,Text,Comment\n"
    const sourceEntries: TranslationEntry[] = [
      { key: "k1", sentence: "s1", context: "c1" },
      { key: "k2", sentence: "s2", context: "c2" },
    ]
    fs.writeFileSync(
      inputFile,
      header + serializeCsvEntries(sourceEntries),
      "utf8",
    )

    const exitCode = await main(
      [
        inputFile,
        outputFile,
        "--setup-context",
        "ctx",
        "--input-format",
        "csv3",
      ],
      {
        stderr: new StringWritable(),
        translateTextUnitsBatch: async ({ entries }) =>
          entries.map((entry) => `t-${entry.key}`),
      },
    )

    expect(exitCode).toBe(0)
    const content = fs.readFileSync(outputFile, "utf8")
    expect(content).toMatch(/^ID,Text,Comment\n/u)
    const outEntries = parseCsvEntries(content)
    expect(outEntries).toHaveLength(2)
    expect(outEntries[0]).toEqual({
      key: "k1",
      sentence: "t-k1",
      context: "c1",
    })
  })

  it("preserves csv header row in plain mode", async () => {
    const dir = makeTempDir()
    const inputFile = path.join(dir, "in.csv")
    const outputFile = path.join(dir, "out.csv")

    fs.writeFileSync(
      inputFile,
      "ID,Text,Comment\nk1,sentence one,ctx one\nk2,sentence two,ctx two\n",
      "utf8",
    )

    const seenLines: string[][] = []
    const exitCode = await main(
      [
        inputFile,
        outputFile,
        "--setup-context",
        "ctx",
        "--input-format",
        "plain",
      ],
      {
        stderr: new StringWritable(),
        translateBatches: async ({ lines }) => {
          seenLines.push([...lines])
          return lines.map((l) => l.replace("sentence", "translated"))
        },
      },
    )

    // Header must NOT be sent to the LLM
    expect(seenLines[0]).not.toContainEqual(expect.stringContaining("ID,Text"))
    // Header must appear as first line of output
    const content = fs.readFileSync(outputFile, "utf8")
    expect(content).toMatch(/^ID,Text,Comment\n/u)
    expect(content).toContain("translated")
  })

  it("strips markdown fences from plain mode llm output", async () => {
    const dir = makeTempDir()
    const inputFile = path.join(dir, "in.txt")
    const outputFile = path.join(dir, "out.txt")
    fs.writeFileSync(inputFile, "line one\nline two\n", "utf8")

    const exitCode = await main(
      [inputFile, outputFile, "--setup-context", "ctx"],
      {
        stderr: new StringWritable(),
        translateBatches: async () => {
          // Simulate LLM wrapping output in a code fence
          const raw = "```\nline one\nline two\n```\n"
          const { splitKeepNewlines, stripMarkdownFences } =
            await import("./io")
          return splitKeepNewlines(stripMarkdownFences(raw))
        },
      },
    )

    expect(exitCode).toBe(0)
    const content = fs.readFileSync(outputFile, "utf8")
    expect(content).not.toContain("```")
    expect(content).toContain("line one")
    expect(content).toContain("line two")
  })
})

describe("main orchestration - setup context file", () => {
  it("reads setup context from file when --setup-context-file is given", async () => {
    const dir = makeTempDir()
    const inputFile = path.join(dir, "input.txt")
    const outputFile = path.join(dir, "output.txt")
    const contextFile = path.join(dir, "context.md")
    fs.writeFileSync(inputFile, "hello\n", "utf8")
    fs.writeFileSync(contextFile, "Translate to German", "utf8")

    let capturedSetupContext = ""
    const stderr = new StringWritable()

    const fakeBatches: typeof translateBatches = async (opts) => {
      capturedSetupContext = opts.setupContext
      return ["hallo\n"]
    }

    await main([inputFile, outputFile, "--setup-context-file", contextFile], {
      stderr,
      translateBatches: fakeBatches,
    })

    expect(capturedSetupContext).toBe("Translate to German")
  })

  it("throws when --setup-context-file points to an empty file", async () => {
    const dir = makeTempDir()
    const inputFile = path.join(dir, "input.txt")
    const outputFile = path.join(dir, "output.txt")
    const contextFile = path.join(dir, "context.md")
    fs.writeFileSync(inputFile, "hello\n", "utf8")
    fs.writeFileSync(contextFile, "   \n", "utf8")

    await expect(
      main([inputFile, outputFile, "--setup-context-file", contextFile]),
    ).rejects.toThrow("file is empty")
  })
})

describe("main orchestration - json format", () => {
  it("json branch: happy path translates nested JSON and writes output", async () => {
    const dir = makeTempDir()
    const inputFile = path.join(dir, "in.json")
    const outputFile = path.join(dir, "out.json")

    const originalObj = {
      actions: { cancel: "Cancel", end: "End" },
      count: 42,
    }
    fs.writeFileSync(inputFile, JSON.stringify(originalObj), "utf8")

    const stderr = new StringWritable()

    const exitCode = await main(
      [
        inputFile,
        outputFile,
        "--setup-context",
        "ctx",
        "--input-format",
        "json",
        "--batch-size",
        "10",
      ],
      {
        stderr,
        flattenJson: (obj) => flattenJson(obj),
        readJsonFile: (path) => JSON.parse(fs.readFileSync(path, "utf8")),
        translateTextUnitsBatch: async ({ entries }) =>
          entries.map((e) => `translated-${e.key}`),
      },
    )

    expect(exitCode).toBe(0)
    const resultObj = JSON.parse(fs.readFileSync(outputFile, "utf8"))
    expect(resultObj).toEqual({
      actions: {
        cancel: "translated-actions.cancel",
        end: "translated-actions.end",
      },
      count: 42,
    })
  })

  it("json branch: checkpoint resume loads partial translations and continues", async () => {
    const dir = makeTempDir()
    const inputFile = path.join(dir, "in.json")
    const outputFile = path.join(dir, "out.json")
    const checkpointFile = `${outputFile}.part`

    const originalObj = {
      actions: { cancel: "Cancel", end: "End", pause: "Pause" },
    }
    fs.writeFileSync(inputFile, JSON.stringify(originalObj), "utf8")

    // Pre-create checkpoint with first entry already translated
    const checkpointEntries = [
      { key: "actions.cancel", sentence: "Annuler", context: "" },
    ]
    fs.writeFileSync(
      checkpointFile,
      serializeCsvEntries(checkpointEntries),
      "utf8",
    )

    const stderr = new StringWritable()
    let callCount = 0

    const exitCode = await main(
      [
        inputFile,
        outputFile,
        "--setup-context",
        "ctx",
        "--input-format",
        "json",
        "--batch-size",
        "10",
      ],
      {
        stderr,
        flattenJson: (obj) => flattenJson(obj),
        readJsonFile: (path) => JSON.parse(fs.readFileSync(path, "utf8")),
        translateTextUnitsBatch: async ({ entries }) => {
          callCount += 1
          return entries.map((e) => `translated-${e.key}`)
        },
      },
    )

    expect(exitCode).toBe(0)
    expect(callCount).toBe(1) // Should only translate remaining 2 entries
    const resultObj = JSON.parse(fs.readFileSync(outputFile, "utf8"))
    expect(resultObj).toEqual({
      actions: {
        cancel: "Annuler",
        end: "translated-actions.end",
        pause: "translated-actions.pause",
      },
    })
  })

  it("json branch: checkpoint key mismatch throws error", async () => {
    const dir = makeTempDir()
    const inputFile = path.join(dir, "in.json")
    const outputFile = path.join(dir, "out.json")
    const checkpointFile = `${outputFile}.part`

    const originalObj = { actions: { cancel: "Cancel" } }
    fs.writeFileSync(inputFile, JSON.stringify(originalObj), "utf8")

    // Pre-create checkpoint with wrong key
    const checkpointEntries = [
      { key: "wrong.key", sentence: "Wrong", context: "actions" },
    ]
    fs.writeFileSync(
      checkpointFile,
      serializeCsvEntries(checkpointEntries),
      "utf8",
    )

    const stderr = new StringWritable()

    await expect(
      main(
        [
          inputFile,
          outputFile,
          "--setup-context",
          "ctx",
          "--input-format",
          "json",
        ],
        {
          stderr,
          flattenJson: (obj) => flattenJson(obj),
          readJsonFile: (path) => JSON.parse(fs.readFileSync(path, "utf8")),
          translateTextUnitsBatch: async ({ entries }) =>
            entries.map((e) => `translated-${e.key}`),
        },
      ),
    ).rejects.toThrow("checkpoint key mismatch")
  })
})

describe("main orchestration - review mode", () => {
  it("json: sends existing translations and returns reviewed result", async () => {
    const dir = makeTempDir()
    const inputFile = path.join(dir, "in.json")
    const outputFile = path.join(dir, "out.json")

    fs.writeFileSync(
      inputFile,
      JSON.stringify({ a: "Hello", b: "World" }),
      "utf8",
    )
    fs.writeFileSync(
      outputFile,
      JSON.stringify({ a: "Hallo", b: "Welt" }),
      "utf8",
    )

    let capturedExisting: Map<string, string> | undefined
    await main(
      [inputFile, outputFile, "--setup-context", "ctx", "--mode", "review"],
      {
        stderr: new StringWritable(),
        translateTextUnitsBatchReview: async ({
          entries,
          existingTranslations,
        }) => {
          capturedExisting = existingTranslations
          return entries.map((e) => `reviewed-${e.key}`)
        },
      },
    )

    expect(capturedExisting?.get("a")).toBe("Hallo")
    expect(capturedExisting?.get("b")).toBe("Welt")
    const result = JSON.parse(fs.readFileSync(outputFile, "utf8"))
    expect(result).toEqual({ a: "reviewed-a", b: "reviewed-b" })
  })

  it("json: throws if output file does not exist", async () => {
    const dir = makeTempDir()
    const inputFile = path.join(dir, "in.json")
    const outputFile = path.join(dir, "out.json")
    fs.writeFileSync(inputFile, JSON.stringify({ a: "Hello" }), "utf8")

    await expect(
      main(
        [inputFile, outputFile, "--setup-context", "ctx", "--mode", "review"],
        { stderr: new StringWritable() },
      ),
    ).rejects.toThrow("requires an existing output file")
  })
})

describe("main orchestration - missing mode", () => {
  it("json: skips already-translated entries and fills gaps", async () => {
    const dir = makeTempDir()
    const inputFile = path.join(dir, "in.json")
    const outputFile = path.join(dir, "out.json")

    fs.writeFileSync(
      inputFile,
      JSON.stringify({
        a: "Hello",
        b: "World",
        c: "Goodbye",
      }),
      "utf8",
    )
    fs.writeFileSync(
      outputFile,
      JSON.stringify({
        a: "",
        b: "Welt",
        c: "",
      }),
      "utf8",
    )

    const translated: string[][] = []
    await main(
      [inputFile, outputFile, "--setup-context", "ctx", "--mode", "missing"],
      {
        stderr: new StringWritable(),
        translateTextUnitsBatch: async ({ entries }) => {
          translated.push(entries.map((e) => e.key))
          return entries.map((e) => `tr-${e.key}`)
        },
      },
    )

    expect(translated.flat()).toEqual(["a", "c"])
    const result = JSON.parse(fs.readFileSync(outputFile, "utf8"))
    expect(result).toEqual({ a: "tr-a", b: "Welt", c: "tr-c" })
  })

  it("json: works when output file does not exist (translates everything)", async () => {
    const dir = makeTempDir()
    const inputFile = path.join(dir, "in.json")
    const outputFile = path.join(dir, "out.json")
    fs.writeFileSync(inputFile, JSON.stringify({ x: "Translate me" }), "utf8")

    await main(
      [inputFile, outputFile, "--setup-context", "ctx", "--mode", "missing"],
      {
        stderr: new StringWritable(),
        translateTextUnitsBatch: async ({ entries }) =>
          entries.map(() => "translated"),
      },
    )

    const result = JSON.parse(fs.readFileSync(outputFile, "utf8"))
    expect(result).toEqual({ x: "translated" })
  })

  it("parseArgs: accepts --mode missing", () => {
    const args = parseArgs([
      "in.json",
      "out.json",
      "--setup-context",
      "ctx",
      "--mode",
      "missing",
    ])
    expect(args.mode).toBe("missing")
  })

  it("parseArgs: rejects unknown mode", () => {
    expect(() =>
      parseArgs([
        "in.json",
        "out.json",
        "--setup-context",
        "ctx",
        "--mode",
        "bogus",
      ]),
    ).toThrow("--mode must be one of")
  })

  it("parseArgs: defaults mode to translate", () => {
    const args = parseArgs(["in.json", "out.json", "--setup-context", "ctx"])
    expect(args.mode).toBe("translate")
  })
})

describe("main orchestration - missing mode (csv3 + plain)", () => {
  it("csv3: skips already-translated entries and fills gaps", async () => {
    const dir = makeTempDir()
    const inputFile = path.join(dir, "in.csv")
    const outputFile = path.join(dir, "out.csv")

    const inputEntries = [
      { key: "k1", sentence: "Hello", context: "" },
      { key: "k2", sentence: "World", context: "" },
      { key: "k3", sentence: "Bye", context: "" },
    ]
    const outputEntries = [
      { key: "k1", sentence: "Hallo", context: "" },
      { key: "k2", sentence: "", context: "" },
      { key: "k3", sentence: "Tschüss", context: "" },
    ]
    fs.writeFileSync(inputFile, serializeCsvEntries(inputEntries), "utf8")
    fs.writeFileSync(outputFile, serializeCsvEntries(outputEntries), "utf8")

    const translatedKeys: string[] = []
    await main(
      [inputFile, outputFile, "--setup-context", "ctx", "--mode", "missing"],
      {
        stderr: new StringWritable(),
        translateTextUnitsBatch: async ({ entries }) => {
          translatedKeys.push(...entries.map((e) => e.key))
          return entries.map((e) => `tr-${e.key}`)
        },
      },
    )

    expect(translatedKeys).toEqual(["k2"])
    const result = parseCsvEntries(fs.readFileSync(outputFile, "utf8"))
    expect(result.find((e) => e.key === "k1")?.sentence).toBe("Hallo")
    expect(result.find((e) => e.key === "k2")?.sentence).toBe("tr-k2")
    expect(result.find((e) => e.key === "k3")?.sentence).toBe("Tschüss")
  })

  it("plain: skips non-empty lines and fills blank lines", async () => {
    const dir = makeTempDir()
    const inputFile = path.join(dir, "in.txt")
    const outputFile = path.join(dir, "out.txt")

    fs.writeFileSync(inputFile, "line one\nline two\nline three\n", "utf8")
    fs.writeFileSync(outputFile, "\nZeile zwei\n\n", "utf8")

    const seenLines: string[] = []
    await main(
      [
        inputFile,
        outputFile,
        "--setup-context",
        "ctx",
        "--mode",
        "missing",
        "--input-format",
        "plain",
      ],
      {
        stderr: new StringWritable(),
        translateBatches: async ({ lines }) => {
          seenLines.push(...lines)
          return lines.map((l) => `tr:${l}`)
        },
      },
    )

    expect(seenLines).toEqual(["line one\n", "line three\n"])
    const result = fs.readFileSync(outputFile, "utf8")
    expect(result).toBe("tr:line one\nZeile zwei\ntr:line three\n")
  })
})

describe("main orchestration - review mode (csv3 + plain)", () => {
  it("csv3: sends existing translations to LLM for review", async () => {
    const dir = makeTempDir()
    const inputFile = path.join(dir, "in.csv")
    const outputFile = path.join(dir, "out.csv")

    const inputEntries = [
      { key: "k1", sentence: "Hello", context: "" },
      { key: "k2", sentence: "World", context: "" },
    ]
    const outputEntries = [
      { key: "k1", sentence: "Hallo", context: "" },
      { key: "k2", sentence: "Welt", context: "" },
    ]
    fs.writeFileSync(inputFile, serializeCsvEntries(inputEntries), "utf8")
    fs.writeFileSync(outputFile, serializeCsvEntries(outputEntries), "utf8")

    let capturedExisting: Map<string, string> | undefined
    await main(
      [inputFile, outputFile, "--setup-context", "ctx", "--mode", "review"],
      {
        stderr: new StringWritable(),
        translateTextUnitsBatchReview: async ({
          entries,
          existingTranslations,
        }) => {
          capturedExisting = existingTranslations
          return entries.map((e) => `rev-${e.key}`)
        },
      },
    )

    expect(capturedExisting?.get("k1")).toBe("Hallo")
    expect(capturedExisting?.get("k2")).toBe("Welt")
    const result = parseCsvEntries(fs.readFileSync(outputFile, "utf8"))
    expect(result.find((e) => e.key === "k1")?.sentence).toBe("rev-k1")
  })

  it("plain: sends output file content (not input) to translateBatches for review", async () => {
    const dir = makeTempDir()
    const inputFile = path.join(dir, "in.txt")
    const outputFile = path.join(dir, "out.txt")

    fs.writeFileSync(inputFile, "original one\noriginal two\n", "utf8")
    fs.writeFileSync(outputFile, "translated one\ntranslated two\n", "utf8")

    const seenLines: string[] = []
    await main(
      [
        inputFile,
        outputFile,
        "--setup-context",
        "ctx",
        "--mode",
        "review",
        "--input-format",
        "plain",
      ],
      {
        stderr: new StringWritable(),
        translateBatches: async ({ lines }) => {
          seenLines.push(...lines)
          return lines
        },
      },
    )

    expect(seenLines).toEqual(["translated one\n", "translated two\n"])
  })
})
