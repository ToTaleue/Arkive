# arkive

An Electron application with React and TypeScript

## Bundled tools (macOS Apple Silicon)

FFmpeg 9.0.2, FFprobe 9.0.2 and Mole 1.59.1 are included in
`resources/tools/darwin-arm64`. No system installation or local compilation is needed.
Mole includes its upstream Bash runtime and precompiled `analyze-go` / `status-go` helpers.
Versions, download hashes, sources and licenses are recorded in
[the tool manifest](resources/tools/darwin-arm64/manifest.json).

Electron Builder copies this directory to `Contents/Resources/tools`, outside `app.asar`.
Use an arm64 build: `pnpm exec electron-builder --mac --arm64` after `pnpm build`.
Tool payloads for other platforms are not included.

Main-process adapters live in `src/execution`: `spawnFfmpeg`, `spawnFfprobe`,
`spawnMoleAnalysis` and `spawnMoleStatus`. They return child processes; callers must
consume stdout/stderr, handle `error` and `close`, and can pass an `AbortSignal`.
Mole adapters use JSON mode for disk analysis and status. Cleanup and deletion
are not connected to the renderer or Agent.

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
