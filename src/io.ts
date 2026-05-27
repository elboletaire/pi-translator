import fs from "node:fs"

import type { TranslationEntry } from "./types"

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
  const entries: TranslationEntry[] = []
  for (const row of rows) {
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

export function writeCsvEntries(
  path: string,
  entries: TranslationEntry[],
): void {
  fs.writeFileSync(path, serializeCsvEntries(entries), "utf8")
}

export function readLines(path: string): string[] {
  const content = fs.readFileSync(path, "utf8")
  return splitKeepNewlines(content)
}

export function writeLines(path: string, lines: Iterable<string>): void {
  fs.writeFileSync(path, Array.from(lines).join(""), "utf8")
}
