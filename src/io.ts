import fs from "node:fs"

import type { TranslationEntry } from "./types"

export function isHeaderRow(row: string[]): boolean {
  if (row.length < 2) {
    return false
  }
  const first = row[0].trim().toLowerCase()
  const second = row[1].trim().toLowerCase()
  return (
    new Set(["key", "id"]).has(first) &&
    new Set(["sentence", "translation", "text", "value"]).has(second)
  )
}

export function stripMarkdownFences(text: string): string {
  if (!text.startsWith("```")) {
    return text
  }
  return text.replace(/^```[a-zA-Z]*\n/u, "").replace(/\n```\s*\n?$/u, "")
}

export function splitKeepNewlines(text: string): string[] {
  if (!text) {
    return []
  }
  const lines: string[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      lines.push(text.slice(start, index + 1))
      start = index + 1
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start))
  }
  return lines
}

export function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let inQuotes = false

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index]

    if (char === '"') {
      if (inQuotes && csvText[index + 1] === '"') {
        cell += '"'
        index += 1
        continue
      }
      inQuotes = !inQuotes
      continue
    }

    if (!inQuotes && char === ",") {
      row.push(cell)
      cell = ""
      continue
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && csvText[index + 1] === "\n") {
        index += 1
      }
      row.push(cell)
      cell = ""
      if (!(row.length === 1 && row[0] === "")) {
        rows.push(row)
      }
      row = []
      continue
    }

    cell += char
  }

  if (inQuotes) {
    throw new Error("CSV contains unterminated quoted field")
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    if (!(row.length === 1 && row[0] === "")) {
      rows.push(row)
    }
  }

  return rows
}

export function parseCsvEntries(csvText: string): TranslationEntry[] {
  const rows = parseCsvRows(csvText)
  const startIndex = rows.length > 0 && isHeaderRow(rows[0]) ? 1 : 0
  const entries: TranslationEntry[] = []
  for (const row of rows.slice(startIndex)) {
    if (row.length < 2) {
      throw new Error("CSV row must contain at least key and sentence columns")
    }
    entries.push({
      key: row[0],
      sentence: row[1],
      context: row.length > 2 ? row[2] : "",
    })
  }
  return entries
}

function escapeCsvCell(cell: string): string {
  if (/[,"\n\r]/.test(cell)) {
    return `"${cell.replaceAll('"', '""')}"`
  }
  return cell
}

export function serializeCsvEntries(entries: TranslationEntry[]): string {
  return (
    entries
      .map((entry) =>
        [entry.key, entry.sentence, entry.context].map(escapeCsvCell).join(","),
      )
      .join("\n") + (entries.length > 0 ? "\n" : "")
  )
}

export function readCsvEntries(path: string): TranslationEntry[] {
  const content = fs.readFileSync(path, "utf8")
  return parseCsvEntries(content)
}

export function readCsvHeader(path: string): string[] | null {
  const content = fs.readFileSync(path, "utf8")
  const rows = parseCsvRows(content)
  return rows.length > 0 && isHeaderRow(rows[0]) ? rows[0] : null
}

export function writeCsvEntries(
  path: string,
  entries: TranslationEntry[],
  header?: string[] | null,
): void {
  const headerLine = header ? `${header.map(escapeCsvCell).join(",")}\n` : ""
  fs.writeFileSync(path, headerLine + serializeCsvEntries(entries), "utf8")
}

export function readLines(path: string): string[] {
  const content = fs.readFileSync(path, "utf8")
  return splitKeepNewlines(content)
}

export function writeLines(path: string, lines: Iterable<string>): void {
  fs.writeFileSync(path, Array.from(lines).join(""), "utf8")
}

export function flattenJson(
  obj: unknown,
  prefix: string = "",
): TranslationEntry[] {
  const entries: TranslationEntry[] = []

  if (obj === null || typeof obj !== "object") {
    // Skip primitives
    return entries
  }

  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      if (typeof item === "string") {
        entries.push({
          key: prefix ? `${prefix}.${index}` : String(index),
          sentence: item,
          context: prefix || "",
        })
      } else if (Array.isArray(item) || typeof item === "object") {
        // Recurse into nested arrays/objects
        entries.push(
          ...flattenJson(item, prefix ? `${prefix}.${index}` : String(index)),
        )
      }
      // Skip primitives (numbers, booleans, null)
    })
  } else if (typeof obj === "object") {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string") {
        entries.push({
          key: prefix ? `${prefix}.${key}` : key,
          sentence: value,
          context: prefix || "",
        })
      } else if (Array.isArray(value) || typeof value === "object") {
        // Recurse into nested structures
        entries.push(...flattenJson(value, prefix ? `${prefix}.${key}` : key))
      }
      // Skip primitives (numbers, booleans, null)
    }
  }

  return entries
}

export function unflattenJson(
  original: unknown,
  translations: TranslationEntry[],
): unknown {
  const translationMap = new Map<string, string>()
  for (const entry of translations) {
    translationMap.set(entry.key, entry.sentence)
  }

  function substituteStrings(
    node: unknown,
    prefix: string,
    map: Map<string, string>,
  ): unknown {
    if (typeof node === "string") {
      return map.get(prefix) ?? node
    }
    if (Array.isArray(node)) {
      return node.map((item, index) =>
        substituteStrings(
          item,
          prefix ? `${prefix}.${index}` : String(index),
          map,
        ),
      )
    }
    if (typeof node === "object" && node !== null) {
      const result: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(node)) {
        result[key] = substituteStrings(
          value,
          prefix ? `${prefix}.${key}` : key,
          map,
        )
      }
      return result
    }
    // Primitives (number, boolean, null) pass through unchanged
    return node
  }

  return substituteStrings(original, "", translationMap)
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(fs.readFileSync(path, "utf8"))
}

export function writeJsonFile(path: string, obj: unknown): void {
  fs.writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8")
}
