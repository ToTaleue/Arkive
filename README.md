# arkive

An Electron + React + TypeScript app for local compression, original backup and archive.

## Compression and archive UI

The left rail opens image, video, document compression and the archive catalog.
Document compression supports PDF (lossless / balanced / size) and ordinary DOCX /
PPTX embedded media. Office requires an explicit whole-document replacement check;
the complete old document goes to Backup before publication at its original path.
Images and PDFs accept Finder drops through Electron's `webUtils` file-path bridge.
The document workspace also provides read-only folder duplicate detection, including
groups, partial-scan warnings and cancellation. It never deletes duplicate files.

Successful results can be archived with optional tags. The catalog's record-state
selector exposes pending compression results after reload or restart, so later
archiving does not require the previous chat or another encode. Ordinary compression
with savings moves the complete original to `~/Arkive Backup`; Archive is an
additional copy. No-savings leaves the source in place. Folder batch compression,
APFS clone orchestration, OCR/content classification and persistent chat history
are not implemented.

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
`ARKIVE_AI_BASE_URL` empty for the official endpoint. The configured DeepSeek V4.1
Flash model is declared with its 1M context window and 384K maximum output; other
OpenAI-compatible model IDs keep a conservative fallback until their limits are
verified. Arkive still bounds displayed tool details and retry-summary input so a
long tool run remains readable. Other API protocols need their matching adapter.

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
- The workspace file panel is a placeholder; the agent can read and search files,
  then use connected compression and file-operation tools within user authorization.
  On smaller windows, the workspace starts collapsed.

Pi enables the native `read`, `grep`, `find` and `ls` tools, plus Arkive's compression,
archive, tag, file-operation and Mole tools. `edit`, `write` and shell tools are disabled.
There are 33 enabled tools, including `inspect_image`, `inspect_video`, `inspect_pdf`,
`inspect_office`, `scan_duplicates` and `open_archive` (open or Finder reveal by archive
record ID). `search_archives` accepts `state: 'pending'` for later archive/retry.
Chat shows each tool's running/returned/error state. A returned result can still
contain partial business failures; stopping generation does not undo committed files.
Office uses `inspect_office` for read-only package inspection and `compress_office`
for DOCX/PPTX embedded media compression with whole-original backup and replacement
at the original path. It accepts `inputPath` and optional `preset`, without a separate
output path. Check `replacementStatus` as well as compression and backup status;
archive successful replacements through `archive_file` using `catalog.id`.
See [Office module details](src/main/modules/office-compression/README.md).
The Mole tool shares `runMoleDryRun` with the preview button and runs only
`clean --dry-run`, with a two-minute timeout and the Agent's cancellation signal.
It accepts no command arguments and returns bounded stdout/stderr plus exit status
and truncation flags. Preview results are not actual reclaimed space. Actual cleanup
is not exposed. The system prompt
requires user authorization for file access, confirmation before modifying user
files, and preservation of originals; these are prompt instructions, not a filesystem
sandbox or an enforced confirmation dialog. Shell tools are disabled. Pi does not
discover local extensions, Skills or project instructions. It explicitly loads three
bundled scenario Skills from [resources/skills](resources/skills/README.md).
Type `/` in the chat composer to choose a scenario, or send `/concert`, `/wechat`
or `/photos` followed by a path or request. Native `/skill:<name>` commands also work.
Selecting a scenario fills the composer without sending or authorizing file operations.
SDK examples: https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/sdk

Run `rtk proxy node scripts/check-agent.mts` (Node 22.19+ with TypeScript stripping)
to verify the real Pi SDK against a
local streaming fixture: the tool allowlist, actual file tool execution in a
temporary directory, Mole preview arguments/results/failure/cancellation using a
temporary executable fixture, multiple turns, isolated conversations, cancellation,
request errors, configuration validation and key redaction. It also drives Office
inspection, actual in-place document replacement, original backup, subsequent archive,
no-savings and publication failure through the registered tools. It does not call a
real model service or require credentials, and does not scan or clean the user's Mac.

Additional integration checks (run `rtk proxy pnpm run build` first):

```sh
rtk proxy node scripts/check-processing-ui.mjs
rtk proxy node scripts/check-agent-ui.mjs
rtk proxy node scripts/check-agent-ui.mjs --skills
rtk proxy node scripts/check-agent-live.mjs
rtk proxy node scripts/check-packaged-runtime.mjs
```

The first two use real Electron/preload/IPC/Services and isolated generated files in
`~/Desktop/arkive-test`; native dialog choices or model HTTP responses are fixtures.
The Agent UI check also drives Mole's actual UI/IPC/parser against a synthetic
external process, checking streamed chapters, duplicate clicks and abnormal exit.
`ARKIVE_NATIVE_UI_CHECK=1` on the processing UI script instead leaves a visible window
for a bounded native open/save/compress/archive check. The live Agent script uses the
configured model and records its prompts, tool activity and generated-file results;
it requires a reachable configured endpoint and may incur model usage. It fails if
model selection or any scenario fails, rather than falling back to fixture responses.
As of 2026-10-17 the configured model host fails DNS resolution; the live-model
scenarios remain unverified. No credentials are written to the test report.

The packaged runtime check requires an existing `dist/mac-arm64/arkive.app` and runs
its binary in Electron's Node mode: SQLite, Sharp, Finder tags, seven tool binaries
and Pi SDK loading. To test the packaged renderer/preload/resources with isolated
business state, run `ARKIVE_PACKAGED_RESOURCES="$PWD/dist/mac-arm64/arkive.app/Contents/Resources"`
with the processing UI check. Build, package and then test sequentially; do not
write to `out` while Electron Builder is constructing the ASAR. These checks do
not certify signing, notarization, installation or production-entry GUI startup.

## Bundled tools (macOS Apple Silicon)

FFmpeg, FFprobe, Mole, pngquant, Ghostscript, qpdf and czkawka_cli are included in
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
`mole`, `pngquant`, `ghostscript`, `qpdf` and `czkawka_cli`.
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
Agent tool is exposed. sharp is a Node library used by the image Service, not a
bundled CLI.

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
