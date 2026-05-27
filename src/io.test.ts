import { describe, expect, it } from "vitest"

import { parseCsvEntries, serializeCsvEntries } from "./io"

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
})
