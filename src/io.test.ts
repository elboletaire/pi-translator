import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { TranslationEntry } from "./types"

import {
  flattenJson,
  isHeaderRow,
  parseCsvEntries,
  readJsonFile,
  serializeCsvEntries,
  stripMarkdownFences,
  unflattenJson,
  writeCsvEntries,
  writeJsonFile,
} from "./io"

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-translator-io-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("isHeaderRow", () => {
  it("detects standard ID/Text/Comment header", () => {
    expect(isHeaderRow(["ID", "Text", "Comment"])).toBe(true)
  })

  it("detects case-insensitive variants", () => {
    expect(isHeaderRow(["id", "text"])).toBe(true)
    expect(isHeaderRow(["Key", "Sentence", "ctx"])).toBe(true)
    expect(isHeaderRow(["ID", "Translation"])).toBe(true)
    expect(isHeaderRow(["KEY", "VALUE"])).toBe(true)
  })

  it("rejects non-header rows", () => {
    expect(isHeaderRow(["Bot.BeaversPerished", "Some text"])).toBe(false)
    expect(isHeaderRow(["ID"])).toBe(false)
    expect(isHeaderRow([])).toBe(false)
  })
})

describe("stripMarkdownFences", () => {
  it("strips csv code fences", () => {
    const input = "```csv\nline1\nline2\n```"
    expect(stripMarkdownFences(input)).toBe("line1\nline2")
  })

  it("strips generic code fences", () => {
    const input = "```\nline1\nline2\n```"
    expect(stripMarkdownFences(input)).toBe("line1\nline2")
  })

  it("strips fences with trailing newline", () => {
    const input = "```csv\nline1\nline2\n```\n"
    expect(stripMarkdownFences(input)).toBe("line1\nline2")
  })

  it("leaves plain text unchanged", () => {
    const input = "line1\nline2\n"
    expect(stripMarkdownFences(input)).toBe("line1\nline2\n")
  })

  it("leaves text with no closing fence unchanged", () => {
    const input = "no fences here\n"
    expect(stripMarkdownFences(input)).toBe("no fences here\n")
  })
})

describe("csv parser", () => {
  it("parses and serializes entries with multiline text", () => {
    const rawCsv =
      'Bot.BeaversPerished,"Ni tan sols em facis començar amb els castors.\n' +
      "Ho tenien tot. Aire fresc, aigua neta.\n" +
      'Ara només en queda un record llunyà.","Context sentence."\n'

    const entries = parseCsvEntries(rawCsv)

    expect(entries).toEqual([
      {
        key: "Bot.BeaversPerished",
        sentence:
          "Ni tan sols em facis començar amb els castors.\n" +
          "Ho tenien tot. Aire fresc, aigua neta.\n" +
          "Ara només en queda un record llunyà.",
        context: "Context sentence.",
      },
    ])

    const csvOut = serializeCsvEntries(entries)
    expect(csvOut).toContain("Bot.BeaversPerished")
    expect(csvOut).toContain("Context sentence.")
    expect(csvOut).toContain("Aire fresc, aigua neta.")
  })

  it("skips the header row when present", () => {
    const rawCsv =
      "ID,Text,Comment\n" +
      "k1,sentence one,ctx one\n" +
      "k2,sentence two,ctx two\n"

    const entries = parseCsvEntries(rawCsv)

    expect(entries).toHaveLength(2)
    expect(entries[0].key).toBe("k1")
    expect(entries[1].key).toBe("k2")
  })

  it("writes header row when provided to writeCsvEntries", () => {
    const dir = makeTempDir()
    const file = path.join(dir, "out.csv")
    const header = ["ID", "Text", "Comment"]
    const entries = [
      { key: "k1", sentence: "s1", context: "c1" },
      { key: "k2", sentence: "s2", context: "c2" },
    ]

    writeCsvEntries(file, entries, header)

    const content = fs.readFileSync(file, "utf8")
    expect(content).toMatch(/^ID,Text,Comment\n/u)
    expect(content).toContain("k1,s1,c1")
    expect(content).toContain("k2,s2,c2")
  })

  it("writeCsvEntries without header writes no header row", () => {
    const dir = makeTempDir()
    const file = path.join(dir, "out.csv")
    const entries = [{ key: "k1", sentence: "s1", context: "c1" }]

    writeCsvEntries(file, entries)

    const content = fs.readFileSync(file, "utf8")
    expect(content).toBe("k1,s1,c1\n")
  })
})

describe("flattenJson", () => {
  it("flattens a flat object with all strings", () => {
    const obj = { k1: "v1", k2: "v2" }
    const entries = flattenJson(obj)
    expect(entries).toEqual([
      { key: "k1", sentence: "v1", context: "" },
      { key: "k2", sentence: "v2", context: "" },
    ])
  })

  it("flattens a nested object with dot notation keys", () => {
    const obj = { actions: { cancel: "Cancel", end: "End" } }
    const entries = flattenJson(obj)
    expect(entries).toEqual([
      { key: "actions.cancel", sentence: "Cancel", context: "actions" },
      { key: "actions.end", sentence: "End", context: "actions" },
    ])
  })

  it("skips numbers, booleans, and null", () => {
    const obj = { name: "test", count: 42, active: true, disabled: null }
    const entries = flattenJson(obj)
    expect(entries).toEqual([{ key: "name", sentence: "test", context: "" }])
  })

  it("handles arrays of strings with numeric indices", () => {
    const obj = { items: ["first", "second"] }
    const entries = flattenJson(obj)
    expect(entries).toEqual([
      { key: "items.0", sentence: "first", context: "items" },
      { key: "items.1", sentence: "second", context: "items" },
    ])
  })

  it("handles deeply nested structures", () => {
    const obj = { a: { b: { c: "deep" } } }
    const entries = flattenJson(obj)
    expect(entries).toEqual([
      { key: "a.b.c", sentence: "deep", context: "a.b" },
    ])
  })

  it("handles empty object", () => {
    const obj = {}
    const entries = flattenJson(obj)
    expect(entries).toEqual([])
  })

  it("preserves i18next {{ placeholder }} strings unchanged", () => {
    const obj = { greeting: "Hello, {{ name }}!", count: "{{ count }} items" }
    const entries = flattenJson(obj)
    expect(entries).toEqual([
      { key: "greeting", sentence: "Hello, {{ name }}!", context: "" },
      { key: "count", sentence: "{{ count }} items", context: "" },
    ])
  })

  it("handles mixed nested objects and arrays", () => {
    const obj = {
      actions: ["start", "stop"],
      config: { enabled: true, label: "Config" },
    }
    const entries = flattenJson(obj)
    expect(entries).toEqual([
      { key: "actions.0", sentence: "start", context: "actions" },
      { key: "actions.1", sentence: "stop", context: "actions" },
      { key: "config.label", sentence: "Config", context: "config" },
    ])
  })
})

describe("unflattenJson", () => {
  it("restores original shape and values from translations", () => {
    const original = { actions: { cancel: "Cancel", end: "End" } }
    const translations = [
      { key: "actions.cancel", sentence: "Annuler", context: "actions" },
      { key: "actions.end", sentence: "Terminer", context: "actions" },
    ]
    const result = unflattenJson(original, translations)
    expect(result).toEqual({ actions: { cancel: "Annuler", end: "Terminer" } })
  })

  it("preserves non-string values (numbers/booleans) unchanged", () => {
    const original = { name: "test", count: 42, active: true }
    const translations = [{ key: "name", sentence: "nom", context: "" }]
    const result = unflattenJson(original, translations)
    expect(result).toEqual({ name: "nom", count: 42, active: true })
  })

  it("falls back to original value when translation key is missing", () => {
    const original = { a: "A", b: "B" }
    const translations = [{ key: "a", sentence: "AA", context: "" }]
    const result = unflattenJson(original, translations)
    expect(result).toEqual({ a: "AA", b: "B" })
  })

  it("preserves {{ placeholder }} strings when translation is missing", () => {
    const original = { greeting: "Hello, {{ name }}!" }
    const translations: TranslationEntry[] = []
    const result = unflattenJson(original, translations)
    expect(result).toEqual({ greeting: "Hello, {{ name }}!" })
  })

  it("handles arrays with numeric indices", () => {
    const original = { items: ["first", "second"] }
    const translations = [
      { key: "items.0", sentence: "premier", context: "items" },
      { key: "items.1", sentence: "deuxième", context: "items" },
    ]
    const result = unflattenJson(original, translations)
    expect(result).toEqual({ items: ["premier", "deuxième"] })
  })

  it("handles deeply nested structures", () => {
    const original = { a: { b: { c: "deep" } } }
    const translations = [{ key: "a.b.c", sentence: "profond", context: "a.b" }]
    const result = unflattenJson(original, translations)
    expect(result).toEqual({ a: { b: { c: "profond" } } })
  })

  it("handles mixed objects and arrays", () => {
    const original = {
      actions: ["start", "stop"],
      config: { enabled: true, label: "Config" },
    }
    const translations = [
      { key: "actions.0", sentence: "démarrer", context: "actions" },
      { key: "config.label", sentence: "Configuration", context: "config" },
    ]
    const result = unflattenJson(original, translations)
    expect(result).toEqual({
      actions: ["démarrer", "stop"],
      config: { enabled: true, label: "Configuration" },
    })
  })

  it("full roundtrip: flatten then unflatten with all translations", () => {
    const original = {
      actions: { cancel: "Cancel", end: "End" },
      count: 42,
      items: ["a", "b"],
    }
    const flattened = flattenJson(original)
    const result = unflattenJson(original, flattened)
    expect(result).toEqual(original)
  })
})

describe("readJsonFile and writeJsonFile", () => {
  it("writes an object and reads it back with roundtrip", () => {
    const dir = makeTempDir()
    const file = path.join(dir, "test.json")
    const obj = { name: "test", nested: { value: 123 } }

    writeJsonFile(file, obj)
    const readBack = readJsonFile(file)

    expect(readBack).toEqual(obj)
  })
})
