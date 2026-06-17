import { Readable, Writable } from "node:stream"
import { describe, expect, it } from "vitest"

import type { TranslationEntry } from "./types"
import {
  buildPrompt,
  chunkLines,
  exchangeWithProvider,
  STYLE_RULES,
  translateBatches,
  translateTextUnit,
  translateTextUnitsBatch,
  translateTextUnitsBatchReview,
} from "./translator"

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

describe("chunking", () => {
  it("groups lines by batch size", () => {
    const lines = ["a\n", "b\n", "c\n", "d\n", "e\n"]
    const chunks = chunkLines(lines, 2)
    expect(chunks).toEqual([["a\n", "b\n"], ["c\n", "d\n"], ["e\n"]])
  })
})

describe("prompts", () => {
  it("includes setup context and chunk details", () => {
    const prompt = buildPrompt(
      "Always use formal tone.",
      ["line 1\n", "line 2\n"],
      3,
      8,
    )
    expect(prompt).toContain("Always use formal tone.")
    expect(prompt).toContain("Chunk 3/8")
    expect(prompt).toContain("line 1\nline 2\n")
  })

  it("hardcodes the no-em-dash style rule", () => {
    expect(STYLE_RULES).toContain("em dash")

    const batchPrompt = buildPrompt("ctx", ["line\n"], 1, 1)
    expect(batchPrompt).toContain(STYLE_RULES.trim())
  })

  it("includes the style rule in every prompt builder", async () => {
    const prompts: string[] = []
    const capture: typeof exchangeWithProvider = async ({ prompt }) => {
      prompts.push(prompt)
      return '["t1"]\n'
    }
    const entries: TranslationEntry[] = [
      { key: "k1", sentence: "s1", context: "c1" },
    ]

    await translateTextUnit({
      translationKey: "k1",
      sentence: "s1",
      setupContext: "ctx",
      command: ["pi"],
      timeoutSeconds: 30,
      exchange: async ({ prompt }) => {
        prompts.push(prompt)
        return "t1\n"
      },
    })
    await translateTextUnitsBatch({
      entries,
      setupContext: "ctx",
      command: ["pi"],
      timeoutSeconds: 30,
      batchIndex: 1,
      totalBatches: 1,
      exchange: capture,
    })
    await translateTextUnitsBatchReview({
      entries,
      existingTranslations: new Map([["k1", "current"]]),
      setupContext: "ctx",
      command: ["pi"],
      timeoutSeconds: 30,
      batchIndex: 1,
      totalBatches: 1,
      exchange: capture,
    })

    expect(prompts).toHaveLength(3)
    for (const prompt of prompts) {
      expect(prompt).toContain(STYLE_RULES.trim())
    }
  })
})

describe("translation engine", () => {
  it("calls provider once per chunk with fresh context", async () => {
    const outputs = ["A1\nA2\n", "A3\nA4\n"]
    const prompts: string[] = []
    let cursor = 0

    const result = await translateBatches({
      lines: ["l1\n", "l2\n", "l3\n", "l4\n"],
      batchSize: 2,
      setupContext: "Keep names untranslated.",
      command: ["pi"],
      timeoutSeconds: 30,
      exchange: async ({ prompt }) => {
        prompts.push(prompt)
        return outputs[cursor++]
      },
    })

    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain("Keep names untranslated.")
    expect(prompts[1]).toContain("Keep names untranslated.")
    expect(prompts[0]).toContain("Chunk 1/2")
    expect(prompts[1]).toContain("Chunk 2/2")
    expect(result).toEqual(["A1\n", "A2\n", "A3\n", "A4\n"])
  })

  it("reports progress for each batch", async () => {
    const progressCalls: Array<[number, number]> = []
    await translateBatches({
      lines: ["l1\n", "l2\n", "l3\n", "l4\n"],
      batchSize: 2,
      setupContext: "Keep names untranslated.",
      command: ["pi"],
      timeoutSeconds: 30,
      progressCallback: (current, total) => {
        progressCalls.push([current, total])
      },
      exchange: async ({ prompt }) =>
        prompt.includes("Chunk 1/2") ? "A1\nA2\n" : "A3\nA4\n",
    })

    expect(progressCalls).toEqual([
      [1, 2],
      [2, 2],
    ])
  })

  it("translates one text unit using key, sentence and context", async () => {
    let prompt = ""
    const translated = await translateTextUnit({
      translationKey: "Bot.BeaversPerished",
      sentence: "Original multiline\nsentence.",
      context: "Game over state when all beavers die.",
      setupContext: "Translate to English",
      command: ["pi"],
      timeoutSeconds: 30,
      exchange: async ({ prompt: value }) => {
        prompt = value
        return "Translated text\n"
      },
    })

    expect(prompt).toContain("Bot.BeaversPerished")
    expect(prompt).toContain("Original multiline\nsentence.")
    expect(prompt).toContain("Game over state when all beavers die.")
    expect(translated).toBe("Translated text")
  })

  it("returns ordered batch translations", async () => {
    let prompt = ""
    const translated = await translateTextUnitsBatch({
      entries: [
        { key: "k1", sentence: "s1", context: "c1" },
        { key: "k2", sentence: "s2", context: "c2" },
      ],
      setupContext: "ctx",
      command: ["pi"],
      timeoutSeconds: 30,
      batchIndex: 1,
      totalBatches: 2,
      exchange: async ({ prompt: value }) => {
        prompt = value
        return '["t1","t2"]\n'
      },
    })

    expect(prompt).toContain("Batch 1/2")
    expect(prompt).toContain("k1")
    expect(translated).toEqual(["t1", "t2"])
  })

  it("accepts markdown fenced json", async () => {
    const translated = await translateTextUnitsBatch({
      entries: [
        { key: "k1", sentence: "s1", context: "c1" },
        { key: "k2", sentence: "s2", context: "c2" },
      ],
      setupContext: "ctx",
      command: ["pi"],
      timeoutSeconds: 30,
      batchIndex: 1,
      totalBatches: 1,
      exchange: async () => '```json\n["t1","t2"]\n```\n',
    })

    expect(translated).toEqual(["t1", "t2"])
  })

  it("accepts prefixed text before json array", async () => {
    const translated = await translateTextUnitsBatch({
      entries: [
        { key: "k1", sentence: "s1", context: "c1" },
        { key: "k2", sentence: "s2", context: "c2" },
      ],
      setupContext: "ctx",
      command: ["pi"],
      timeoutSeconds: 30,
      batchIndex: 1,
      totalBatches: 1,
      exchange: async () => 'Done. Output:\n["t1","t2"]\n',
    })

    expect(translated).toEqual(["t1", "t2"])
  })

  it("accepts fenced csv rows", async () => {
    const translated = await translateTextUnitsBatch({
      entries: [
        { key: "k1", sentence: "s1", context: "c1" },
        { key: "k2", sentence: "s2", context: "c2" },
      ],
      setupContext: "ctx",
      command: ["pi"],
      timeoutSeconds: 30,
      batchIndex: 1,
      totalBatches: 1,
      exchange: async () => '```csv\nk1,"t1","c1"\nk2,"t2","c2"\n```\n',
    })

    expect(translated).toEqual(["t1", "t2"])
  })

  it("accepts csv rows with duplicated key column", async () => {
    const translated = await translateTextUnitsBatch({
      entries: [
        { key: "k1", sentence: "s1", context: "c1" },
        { key: "k2", sentence: "s2", context: "c2" },
      ],
      setupContext: "ctx",
      command: ["pi"],
      timeoutSeconds: 30,
      batchIndex: 1,
      totalBatches: 1,
      exchange: async () =>
        '```csv\nk1,"k1","translated one","c1"\nk2,"k2","translated two","c2"\n```\n',
    })

    expect(translated).toEqual(["translated one", "translated two"])
  })

  it("accepts object items with sentence field", async () => {
    const translated = await translateTextUnitsBatch({
      entries: [
        { key: "k1", sentence: "s1", context: "c1" },
        { key: "k2", sentence: "s2", context: "c2" },
      ],
      setupContext: "ctx",
      command: ["pi"],
      timeoutSeconds: 30,
      batchIndex: 1,
      totalBatches: 1,
      exchange: async () =>
        '[{"key":"k1","sentence":"t1","context":"c1"},{"key":"k2","sentence":"t2","context":"c2"}]\n',
    })

    expect(translated).toEqual(["t1", "t2"])
  })

  it("accepts object items with translation field", async () => {
    const translated = await translateTextUnitsBatch({
      entries: [
        { key: "k1", sentence: "s1", context: "c1" },
        { key: "k2", sentence: "s2", context: "c2" },
      ],
      setupContext: "ctx",
      command: ["pi"],
      timeoutSeconds: 30,
      batchIndex: 1,
      totalBatches: 1,
      exchange: async () =>
        '[{"key":"k1","translation":"t1"},{"key":"k2","translation":"t2"}]\n',
    })

    expect(translated).toEqual(["t1", "t2"])
  })

  it("accepts object items with current field (review mode response)", async () => {
    const translated = await translateTextUnitsBatch({
      entries: [
        { key: "k1", sentence: "s1", context: "c1" },
        { key: "k2", sentence: "s2", context: "c2" },
      ],
      setupContext: "ctx",
      command: ["pi"],
      timeoutSeconds: 30,
      batchIndex: 1,
      totalBatches: 1,
      exchange: async () =>
        '[{"key":"k1","original":"s1","current":"t1"},{"key":"k2","original":"s2","current":"t2"}]\n',
    })

    expect(translated).toEqual(["t1", "t2"])
  })

  it("accepts object items with reviewed field (review mode response)", async () => {
    const translated = await translateTextUnitsBatch({
      entries: [
        { key: "k1", sentence: "s1", context: "c1" },
        { key: "k2", sentence: "s2", context: "c2" },
      ],
      setupContext: "ctx",
      command: ["pi"],
      timeoutSeconds: 30,
      batchIndex: 1,
      totalBatches: 1,
      exchange: async () =>
        '[{"key":"k1","original":"s1","reviewed":"t1"},{"key":"k2","original":"s2","reviewed":"t2"}]\n',
    })

    expect(translated).toEqual(["t1", "t2"])
  })

  it("accepts object items with unknown field name via fallback", async () => {
    const translated = await translateTextUnitsBatch({
      entries: [
        { key: "k1", sentence: "s1", context: "c1" },
        { key: "k2", sentence: "s2", context: "c2" },
      ],
      setupContext: "ctx",
      command: ["pi"],
      timeoutSeconds: 30,
      batchIndex: 1,
      totalBatches: 1,
      exchange: async () =>
        '[{"key":"k1","original":"s1","result":"t1"},{"key":"k2","original":"s2","result":"t2"}]\n',
    })

    expect(translated).toEqual(["t1", "t2"])
  })

  it("includes raw output in type errors", async () => {
    await expect(
      translateTextUnitsBatch({
        entries: [
          { key: "k1", sentence: "s1", context: "c1" },
          { key: "k2", sentence: "s2", context: "c2" },
        ],
        setupContext: "ctx",
        command: ["pi"],
        timeoutSeconds: 30,
        batchIndex: 1,
        totalBatches: 1,
        exchange: async () => '[{"text":1},{"text":"t2"}]\n',
      }),
    ).rejects.toThrow(/non-string translations/)

    await expect(
      translateTextUnitsBatch({
        entries: [
          { key: "k1", sentence: "s1", context: "c1" },
          { key: "k2", sentence: "s2", context: "c2" },
        ],
        setupContext: "ctx",
        command: ["pi"],
        timeoutSeconds: 30,
        batchIndex: 1,
        totalBatches: 1,
        exchange: async () => '[{"text":1},{"text":"t2"}]\n',
      }),
    ).rejects.toThrow(/raw output/)
  })

  it("stdout provider mode reads until end token", async () => {
    const input = Readable.from([
      "model response line 1\n",
      "model response line 2\n",
      "<NEXT>\n",
    ])
    const output = new StringWritable()
    const error = new StringWritable()

    const result = await exchangeWithProvider({
      prompt: "PROMPT BODY",
      command: ["stdout"],
      timeoutSeconds: 30,
      stdinEndToken: "<NEXT>",
      io: {
        stdin: input,
        stdout: output,
        stderr: error,
      },
    })

    expect(result).toBe("model response line 1\nmodel response line 2\n")
    expect(output.data).toContain("BEGIN BATCH PROMPT")
    expect(output.data).toContain("PROMPT BODY")
    expect(error.data).toContain("<NEXT>")
  })
})

describe("translation engine review", () => {
  it("translateTextUnitsBatchReview: sends original and current translation in prompt", async () => {
    let capturedPrompt = ""
    const entries = [
      { key: "a", sentence: "Hello", context: "" },
      { key: "b", sentence: "World", context: "" },
    ]
    const existingTranslations = new Map([
      ["a", "Hallo"],
      ["b", "Welt"],
    ])

    await translateTextUnitsBatchReview({
      entries,
      existingTranslations,
      setupContext: "ctx",
      command: ["pi"],
      timeoutSeconds: 30,
      batchIndex: 1,
      totalBatches: 1,
      exchange: async ({ prompt }) => {
        capturedPrompt = prompt
        return '["Hallo", "Welt"]'
      },
    })

    expect(capturedPrompt).toContain("reviewing an existing translation")
    expect(capturedPrompt).toContain('"original":"Hello"')
    expect(capturedPrompt).toContain('"current":"Hallo"')
  })
})
