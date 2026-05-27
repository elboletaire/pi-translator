import fs from "node:fs"

import { readCsvEntries, writeCsvEntries } from "./io"
import type { TranslationEntry } from "./types"

export function checkpointPath(outputFile: string): string {
  return `${outputFile}.part`
}

export function tmpOutputPath(outputFile: string): string {
  return `${outputFile}.tmp`
}

export function loadCheckpointIfAny(
  checkpointFile: string,
  sourceEntries: TranslationEntry[],
): TranslationEntry[] {
  if (!fs.existsSync(checkpointFile)) {
    return []
  }

  const checkpointEntries = readCsvEntries(checkpointFile)
  if (checkpointEntries.length > sourceEntries.length) {
    throw new Error("checkpoint contains more rows than source input")
  }

  checkpointEntries.forEach((checkpointEntry, index) => {
    const sourceEntry = sourceEntries[index]
    if (checkpointEntry.key !== sourceEntry.key) {
      throw new Error(`checkpoint key mismatch at row ${index + 1}`)
    }
    if (checkpointEntry.context !== sourceEntry.context) {
      throw new Error(`checkpoint context mismatch at row ${index + 1}`)
    }
  })

  return checkpointEntries
}

export function writeCheckpoint(
  checkpointFile: string,
  entries: TranslationEntry[],
): void {
  writeCsvEntries(checkpointFile, entries)
}

export function finalizeCsvOutput(
  outputFile: string,
  entries: TranslationEntry[],
): void {
  const tmpFile = tmpOutputPath(outputFile)
  const checkpointFile = checkpointPath(outputFile)

  writeCsvEntries(tmpFile, entries)
  fs.renameSync(tmpFile, outputFile)

  if (fs.existsSync(checkpointFile)) {
    fs.unlinkSync(checkpointFile)
  }
}
