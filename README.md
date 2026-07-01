# pi-translator

Batch translator for large files using [`pi`](https://github.com/earendil-works/pi) or [`claude`](https://github.com/anthropics/claude-code).

## What it does

- Reads input in batches (`--batch-size`)
- Calls the backend CLI once per batch with a fresh prompt
- Reuses fixed `--setup-context` on every batch
- Writes merged translated output to a new file

Progress is printed to stderr as `processing batch X/Y`.

## Choosing a backend

The tool ships two commands that share the same code:

- `pi-translate` — uses [`pi`](https://github.com/earendil-works/pi) (default). Invokes `pi` with `--no-session`, so per-batch calls do not appear in `/resume`.
- `claude-translate` — uses [`claude`](https://github.com/anthropics/claude-code). Invokes `claude -p` with tools disabled, using your existing Claude CLI authentication (no API key or `--bare` needed).

The invoked command name picks the backend. You can also force it explicitly with `--tool <pi|claude>` (useful when running from source via `pnpm start`). Under `--tool claude`, the pi-only flags (`--provider`, `--api-key`, `--allow-extensions`) are ignored with a warning.

## Recovery behavior (csv3)

- Checkpoints are written to `<output_file>.part` after each translated row
- If execution fails, rerun the same command to resume
- On success, output is finalized atomically via `<output_file>.tmp` rename, then `.part` is removed

## Requirements

- Node.js >= 18
- The backend CLI you intend to use, installed and available in your `PATH`:
  [`pi`](https://github.com/earendil-works/pi) for `pi-translate`, or
  [`claude`](https://github.com/anthropics/claude-code) (logged in) for `claude-translate`

## Install

```bash
npm install -g pi-translator
```

## Usage

Plain text mode:

```bash
pi-translate input.txt output.txt \
  --setup-context "Translate from Spanish to English. Keep character names unchanged." \
  --provider openai \
  --model gpt-4o \
  --batch-size 40
```

Same, but with the Claude CLI as the backend:

```bash
claude-translate input.txt output.txt \
  --setup-context "Translate from Spanish to English. Keep character names unchanged." \
  --model sonnet \
  --batch-size 40
```

CSV mode (`key,text,context`):

```bash
pi-translate input.csv output.csv \
  --input-format csv3 \
  --setup-context "Translate column 2 to English. Keep key and context untouched." \
  --provider github-copilot \
  --model claude-sonnet-4-5 \
  --batch-size 25
```

JSON mode:

```bash
pi-translate input.json output.json \
  --setup-context "Translate all string values from Spanish to English." \
  --provider openai \
  --model gpt-4o \
  --batch-size 30
```

Manual mode (`stdout` provider, no API credits):

```bash
pi-translate input.csv output.csv \
  --input-format csv3 \
  --provider stdout \
  --batch-size 25 \
  --stdin-end-token "<NEXT>" \
  --setup-context "$(cat translation-context.md)"
```

In manual mode, each batch prompt is printed to stdout, then the tool waits for your pasted model response on stdin.
Finish each response with the end token on its own line (example: `<NEXT>`).

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--setup-context <text>` | _(required)_ | Fixed translation instructions for every batch (mutually exclusive with `--setup-context-file`) |
| `--setup-context-file <path>` | _(required)_ | File containing the translation instructions |
| `--batch-size <n>` | `50` | Lines per batch (or CSV/JSON rows per API call) |
| `--input-format <fmt>` | `plain` | `plain`, `csv3`, or `json` (auto-detected from file extension) |
| `--mode <mode>` | `translate` | `translate`, `missing` (only empty/absent rows), or `review` |
| `--timeout-seconds <n>` | `120` | Timeout per backend call |
| `--tool <tool>` | invoked name | Backend CLI: `pi` or `claude` (defaults from the command name) |
| `--pi-cmd <cmd>` | `pi` | Command used to invoke pi |
| `--claude-cmd <cmd>` | `claude` | Command used to invoke claude |
| `--provider <id>` | | Provider ID passed to pi (ignored with `--tool claude`) |
| `--model <id>` | | Model ID passed to the backend (pi: `gpt-4o`; claude: `sonnet`, `opus`) |
| `--api-key <key>` | | API key passed to pi (ignored with `--tool claude`) |
| `--allow-extensions` | | Keep pi extension discovery enabled (ignored with `--tool claude`) |
| `--stdin-end-token <token>` | `__NEXT_BATCH__` | Used only with `--provider stdout` |

Compatibility alias: `--pi-mono-cmd` is accepted and mapped to `--pi-cmd`.

## License

[GPL-3.0](./LICENSE) © Òscar Casajuana

## Development

```bash
pnpm install
pnpm test
pnpm build
pnpm format
```

