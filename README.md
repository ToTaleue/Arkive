# arkive

An Electron application with React and TypeScript

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

### Build

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```
