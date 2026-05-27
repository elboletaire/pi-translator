# pi-translator

Batch translator for large files using `pi`.

## What it does

- Reads input in batches (`--batch-size`)
- Calls `pi` once per batch with a fresh prompt
- Reuses fixed `--setup-context` on every batch
- Writes merged translated output to a new file

Progress is printed to stderr as `processing batch X/Y`.

`pi-translator` invokes `pi` with `--no-session` by default, so per-batch calls do not appear in `/resume`.

## Recovery behavior (csv3)

- Checkpoints are written to `<output_file>.part` after each translated row
- If execution fails, rerun the same command to resume
- On success, output is finalized atomically via `<output_file>.tmp` rename, then `.part` is removed

## Install

```bash
pnpm install
```

## Usage

Plain text mode:

```bash
pnpm start -- input.txt output.txt \
  --setup-context "Translate from Spanish to English. Keep character names unchanged." \
  --provider openai \
  --model gpt-5.4 \
  --batch-size 40
```

CSV mode (`key,text,context`):

```bash
pnpm start -- input.csv output.csv \
  --input-format csv3 \
  --setup-context "Translate column 2 to English. Keep key and context untouched." \
  --provider github-copilot \
  --model claude-sonnet-4.5 \
  --batch-size 25
```

Manual mode (`stdout` provider, no API credits):

```bash
pnpm start -- input.csv output.csv \
  --input-format csv3 \
  --provider stdout \
  --batch-size 25 \
  --stdin-end-token "<NEXT>" \
  --setup-context "$(cat translation-context.md)"
```

In manual mode, each batch prompt is printed to stdout, then the tool waits for your pasted model response on stdin.
Finish each response with the end token on its own line (example: `<NEXT>`).

## Options

- `--setup-context` (required): fixed translation instructions for every batch
- `--batch-size` (default: `50`): lines per batch (or CSV rows per API call in `csv3`)
- `--input-format` (default: `plain`): `plain` or `csv3`
- `--timeout-seconds` (default: `120`): timeout per `pi` call
- `--pi-cmd` (default: `pi`): command used to invoke pi
- `--provider`: provider id passed to pi
- `--model`: model id passed to pi
- `--api-key`: optional API key passed to pi
- `--stdin-end-token` (default: `__NEXT_BATCH__`): used only with `--provider stdout`

Compatibility alias: `--pi-mono-cmd` is accepted and mapped to `--pi-cmd`.

## Development

```bash
pnpm test
pnpm build
pnpm format
```
