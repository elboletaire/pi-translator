import { readFileSync, writeFileSync, chmodSync } from "node:fs"

const file = "dist/cli.js"
const content = readFileSync(file, "utf8")
if (!content.startsWith("#!/usr/bin/env node")) {
  writeFileSync(file, "#!/usr/bin/env node\n" + content, "utf8")
}
chmodSync(file, 0o755)
