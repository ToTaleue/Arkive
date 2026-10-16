# arkive

An Electron application with React and TypeScript

## Pi chat

Run `pnpm dev` to open Arkive. The chat uses `@assistant-ui/react` with Electron IPC
and Pi SDK `1.2.0` in the main process. Each real conversation keeps an independent
Pi session for multiple turns, with streamed replies and a stop button.

Copy `.env.example` to `.env.local` in the project root (an empty local template may
already exist), fill in your own values, then restart `pnpm dev`:

```dotenv
ARKIVE_AI_PROVIDER=openai-compatible
ARKIVE_AI_BASE_URL=https://your-provider.example/v1
ARKIVE_AI_MODEL=your-model-id
ARKIVE_AI_API_KEY=your-api-key
```

Use `openai-compatible` only for endpoints implementing streaming Chat Completions.
The URL is the API root, not `/chat/completions`. For native Pi providers such as
`openai`, `anthropic` or `google`, set that provider and its exact model ID; leave
`ARKIVE_AI_BASE_URL` empty for the official endpoint. The compatible integration
uses a conservative 32K context budget and 4096 maximum output tokens; native
providers use Pi's model catalog. Other API protocols need their matching adapter.

`.env.local` is ignored by Git and read only by the main process at development
startup. Do not prefix keys with `VITE_` or `MAIN_VITE_`, put them in renderer code,
or commit them. Existing process environment variables take precedence. Packaged
apps use runtime environment variables; an end-user credentials UI is not added yet.

- The left rail stays visible. The conversation sidebar and right workspace panel
  can be collapsed and reopened independently using the panel buttons.
- Create or switch conversations, fill the composer from a suggestion, and send
  with Enter or the arrow button. Shift+Enter inserts a newline.
- Seeded examples are read-only and never sent to the model. New conversations use
  the real configured provider. Messages, Pi context and drafts live in memory and
  reset on page reload, window close or restart; durable history is not implemented.
- Missing configuration and request errors appear in the chat. Provider messages
  may be sent over the network; no API key is exposed by the preload interface.
- The workspace panel is a placeholder. No files are scanned, compressed, moved,
  or deleted. On smaller windows, the workspace starts collapsed.

Pi has no tools enabled and does not discover local extensions, Skills or project
instructions. SDK examples: https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/sdk

Run `rtk proxy node scripts/check-agent.mts` (Node 22.19+ with TypeScript stripping)
to verify the real Pi SDK against a
local streaming fixture: multiple turns, isolated conversations, cancellation,
request errors, configuration validation and key redaction. It does not call a
real model service or require credentials.

## Bundled tools (macOS Apple Silicon)

FFmpeg, FFprobe, Mole, pngquant, jpegoptim, Ghostscript, qpdf and czkawka_cli are included in
`resources/tools/darwin-arm64`. No system installation or local compilation is needed.
Mole includes its upstream Bash runtime and precompiled `analyze-go` / `status-go` helpers.
Versions, download hashes, sources and licenses are recorded in
[the tool manifest](resources/tools/darwin-arm64/manifest.json).

Electron Builder copies this directory to `Contents/Resources/tools`, outside `app.asar`.
Use an arm64 build: `pnpm exec electron-builder --mac --arm64` after `pnpm build`.
Tool payloads for other platforms are not included.

Main-process tool execution lives in `src/execution/process.ts`. Both entry points
accept a registered tool name, a raw argument array and optional `cwd` / `signal`.
Arguments pass through unchanged, without a shell. Tool names are `ffmpeg`, `ffprobe`,
`mole`, `pngquant`, `jpegoptim`, `ghostscript`, `qpdf` and `czkawka_cli`.
Paths preserve the bundled directory layout, including qpdf's adjacent library.

```ts
import { runBundledTool } from '../execution/process' // example caller in src/main

const result = await runBundledTool('qpdf', ['--check', inputPath], { signal })
// Inspect result.exitCode, result.signal, result.stdout and result.stderr.
```

`runBundledTool` drains both streams and returns UTF-8 text after the process closes.
Nonzero exits resolve with the actual exit code; path/startup errors and cancellation
reject. Each stream retains at most 1,048,576 UTF-16 code units by default; use
`maxOutputChars` to change the limit (zero discards all output). Check
`stdoutTruncated` / `stderrTruncated` before parsing captured output. Tool-specific
exit codes and output validation belong to the caller.

`spawnBundledTool` returns the child process for streaming or binary output. Callers
must consume both streams and handle `error` / `close`; cancellation uses `AbortSignal`.
Existing `spawnFfmpeg` (adds `-nostdin`), `spawnFfprobe`, `spawnMoleAnalysis` and
`spawnMoleStatus` remain available. Mole adapters use JSON mode for analysis and status.

These entry points are internal to the main process. Renderer and product Agent
access should go through business operations, which enforce confirmation, path
protection and original-file preservation. The generic runner does not enforce
those policies or interpret destructive tool options. No generic execution IPC or
Agent tool is exposed. sharp is a Node library, not a bundled CLI; its adapter
remains unimplemented.

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ pnpm install
```

### Development

```bash
$ pnpm dev
```

### Lint and type checking

TypeScript uses the [strict type-checked ESLint preset](https://typescript-eslint.io/users/configs/#strict-type-checked)
on top of the Electron Toolkit defaults. Both Node and renderer TSConfigs supply type information;
shared contracts are included in the Node project.

Both TSConfigs explicitly enable compiler `strict` and `noImplicitAny`, overriding
the Electron Toolkit template's `noImplicitAny: false`. Compiler strict checks and
the ESLint strict preset are both required.

Additional error-level rules prohibit `eval`, string timers, `Function` constructors,
`javascript:` URLs, `__proto__`, native prototype extensions and React's
`dangerouslySetInnerHTML`. Keep Prettier responsible for formatting.

```bash
rtk proxy pnpm run lint
rtk proxy pnpm run typecheck
```

### Build

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```
