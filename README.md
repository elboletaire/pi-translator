# llm-translator

Batch translator for large files using [`pi`](https://github.com/earendil-works/pi) or [`claude`](https://github.com/anthropics/claude-code).

## What it does

- Reads input in batches (`--batch-size`)
- Calls the backend CLI once per batch with a fresh prompt
- Reuses fixed `--setup-context` on every batch
- Writes merged translated output to a new file

Progress is printed to stderr as `processing batch X/Y`.

## Commands

The package installs three commands that share the same code:

- **`pi-translate`** — always uses [`pi`](https://github.com/earendil-works/pi). Invokes `pi` with `--no-session`, so per-batch calls do not appear in `/resume`. Does not accept `--tool`.
- **`claude-translate`** — always uses [`claude`](https://github.com/anthropics/claude-code). Invokes `claude -p` with tools disabled, using your existing Claude CLI authentication (no API key or `--bare` needed). Does not accept `--tool`.
- **`llm-translate`** — the generic command. Pick the backend with `--tool <pi|claude>` (defaults to `pi`).

The single-backend commands (`pi-translate`, `claude-translate`) reject `--tool`; use `llm-translate` when you want to choose the backend at call time.

Under the claude backend, the pi-only flags (`--provider`, `--api-key`, `--allow-extensions`) are ignored with a warning.

## Recovery behavior (csv3)

- Checkpoints are written to `<output_file>.part` after each translated row
- If execution fails, rerun the same command to resume
- On success, output is finalized atomically via `<output_file>.tmp` rename, then `.part` is removed

## Requirements

- Node.js >= 18
- The backend CLI you intend to use, installed and available in your `PATH`:
  [`pi`](https://github.com/earendil-works/pi) for the pi backend, or
  [`claude`](https://github.com/anthropics/claude-code) (logged in) for the claude backend

## Install

```bash
npm install -g llm-translator
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

Or pick the backend at call time with the generic command:

```bash
llm-translate input.txt output.txt \
  --tool claude \
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
| `--tool <tool>` | `pi` | Backend CLI: `pi` or `claude` (**`llm-translate` only**) |
| `--pi-cmd <cmd>` | `pi` | Command used to invoke pi (pi backend only) |
| `--claude-cmd <cmd>` | `claude` | Command used to invoke claude (claude backend only) |
| `--provider <id>` | | Provider ID passed to pi (pi backend only) |
| `--model <id>` | | Model ID passed to the backend (pi: `gpt-4o`; claude: `sonnet`, `opus`) |
| `--api-key <key>` | | API key passed to pi (pi backend only) |
| `--allow-extensions` | | Keep pi extension discovery enabled (pi backend only) |
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

