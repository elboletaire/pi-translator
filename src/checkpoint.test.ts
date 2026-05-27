import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  loadCheckpointIfAny,
  finalizeCsvOutput,
  checkpointPath,
} from "./checkpoint"
import { serializeCsvEntries } from "./io"
import type { TranslationEntry } from "./types"

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-translator-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("checkpoint", () => {
  it("loads empty checkpoint when no .part exists", () => {
    const dir = makeTempDir()
    const source: TranslationEntry[] = [
      { key: "k1", sentence: "s1", context: "c1" },
    ]

    const loaded = loadCheckpointIfAny(path.join(dir, "out.csv.part"), source)
    expect(loaded).toEqual([])
  })

  it("validates and loads existing checkpoint", () => {
    const dir = makeTempDir()
    const checkpointFile = path.join(dir, "out.csv.part")

    const source: TranslationEntry[] = [
      { key: "k1", sentence: "s1", context: "c1" },
      { key: "k2", sentence: "s2", context: "c2" },
    ]
    const checkpoint: TranslationEntry[] = [
      { key: "k1", sentence: "t1", context: "c1" },
    ]

    fs.writeFileSync(checkpointFile, serializeCsvEntries(checkpoint), "utf8")

    const loaded = loadCheckpointIfAny(checkpointFile, source)
    expect(loaded).toEqual(checkpoint)
  })

  it("fails when checkpoint key mismatches source", () => {
    const dir = makeTempDir()
    const checkpointFile = path.join(dir, "out.csv.part")

    const source: TranslationEntry[] = [
      { key: "k1", sentence: "s1", context: "c1" },
    ]
    const checkpoint: TranslationEntry[] = [
      { key: "k2", sentence: "t1", context: "c1" },
    ]

    fs.writeFileSync(checkpointFile, serializeCsvEntries(checkpoint), "utf8")

    expect(() => loadCheckpointIfAny(checkpointFile, source)).toThrow(
      /checkpoint key mismatch/,
    )
  })

  it("finalizes output atomically and removes .part file", () => {
    const dir = makeTempDir()
    const outputFile = path.join(dir, "out.csv")
    const partFile = checkpointPath(outputFile)

    fs.writeFileSync(partFile, "stale checkpoint", "utf8")

    const translated: TranslationEntry[] = [
      { key: "k1", sentence: "t1", context: "c1" },
      { key: "k2", sentence: "t2", context: "c2" },
    ]

    finalizeCsvOutput(outputFile, translated)

    expect(fs.existsSync(outputFile)).toBe(true)
    expect(fs.readFileSync(outputFile, "utf8")).toBe(
      serializeCsvEntries(translated),
    )
    expect(fs.existsSync(partFile)).toBe(false)
    expect(fs.existsSync(`${outputFile}.tmp`)).toBe(false)
  })
})
