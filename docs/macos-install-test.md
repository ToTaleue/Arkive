# 在借来的 Mac 上安装和测试 Arkive

这份指南针对项目源码的 Apple 芯片 Mac 测试流程。仓库包含白色 UI、Windows 测试脚本和报告。此前生成的源码包不包含 Windows 的 node_modules、构建结果、Git 历史或 `.env.local` 密钥；它是打包时的快照，不会自动同步后续修复。

## 1. 确认电脑

在 Mac 的“终端”运行：

```sh
uname -m
sw_vers -productVersion
```

完整测试需要 **Apple 芯片 + macOS 15 或更新系统**。当前资源只包含 `darwin-arm64`；其中随包 qpdf 的 Mach-O 标记最低系统版本为 15.0，APFS helper 标记为 13.0。Intel Mac 无法直接运行这套随包工具；旧系统可能能预览界面，但不能按本文完成全量测试。

使用已获借用授权的独立测试账户更方便隔离资料。测试只使用自己复制的样本；邮件、微信及系统清理留到最后，先不要扫描电脑主人的真实资料。

## 2. 放入源码，安装 Node.js

把 `arkive-macos-source.zip` 复制到 Mac 的 Downloads 文件夹。用 macOS 自带的解压方式；终端示例：

```sh
mkdir -p "$HOME/Developer/arkive-mac-test"
ditto -x -k "$HOME/Downloads/arkive-macos-source.zip" "$HOME/Developer/arkive-mac-test"
cd "$HOME/Developer/arkive-mac-test/arkive-demo"
```

选择一个新的解压目录，避免混入以前的依赖。如需本次提交后的完整修复，优先从当前工作分支获取最新源码：

```sh
git clone --branch feat/agent-and-service https://github.com/ToTaleue/arkive-demo.git
cd arkive-demo
```

从 https://nodejs.org/en/download 安装 **Node.js 24 LTS、macOS ARM64**。已安装合适版本可以直接使用。安装后重新打开终端，进入项目目录，确认：

```sh
node --version
node -p 'process.platform + "-" + process.arch'
```

预期为 `v24.x` 和 `darwin-arm64`。Apple 芯片 Mac 如果显示 `darwin-x64`，先换成 ARM64 Node，避免通过 Rosetta 安装出 x64 依赖。

以下通过 npx 使用已验证的 pnpm 10.34.7，不要求全局安装 pnpm。项目的安装脚本白名单仍使用 pnpm 10 的配置方式。

## 3. 预检、安装、启动

在项目目录依次运行：

```sh
node scripts/prepare-macos-test.mjs
npx --yes pnpm@10.34.7 install --frozen-lockfile
npx --yes pnpm@10.34.7 run build
npx --yes pnpm@10.34.7 run dev
```

预检会创建当前用户的 `~/Desktop/arkive-test`，将测试文件中写死的 `/Users/hu1hui/Desktop/arkive-test` 改为当前用户的测试目录，恢复随包工具的执行权限，检查工具版本并生成 `macos-preflight.json`。只修改本项目内的测试文件，不修改产品业务服务，也不会运行 Mole 清理或提权。

测试脚本中的 `rtk proxy` 是命令包装；本文可以直接运行 `node` 和 `npx pnpm` 命令。

启动后先检查白色界面、四个导航页、侧栏收起/展开、窗口缩放、日夜模式和键盘焦点。新应用第一次请求 Desktop 文件夹权限时，仅授予本轮测试所需的访问；借用者不要替电脑主人开启全盘扫描或系统清理权限。

关闭开发版请使用 **⌘Q**，或者在对应终端按 Ctrl+C。Mac 上只关闭窗口通常不会退出 Electron 进程。运行构建/测试时先退出开发版，避免混淆两个窗口及其业务库。

## 4. 先运行不需要真实模型的测试

另开终端并进入同一个项目目录。先跑基础检查：

```sh
npx --yes pnpm@10.34.7 run typecheck
npx --yes pnpm@10.34.7 run lint
node scripts/check-tasks.mjs --ipc
node scripts/check-mole.mjs
node scripts/check-chat-markdown.mjs
node scripts/check-tag-recommendation.mjs
```

再按顺序测试 Mac 实际业务能力：

```sh
node scripts/check-image-compression.mts
node scripts/check-pdf-compression.mjs
node scripts/check-office-compression.mjs
node scripts/check-video-compression.mjs
node scripts/check-duplicate-detection.mjs
node scripts/check-catalog.mjs
node scripts/check-archive-links.mjs
node scripts/check-compression-tasks.mjs
node scripts/check-scheduled-services.mjs
node scripts/check-agent.mts
node scripts/check-agent-ui.mjs
node scripts/check-processing-ui.mjs
```

这些脚本通常生成自己的样本。Agent 和标签推荐的这一组使用本地 HTTP 响应夹具，不需要真实 API Key。Catalog、压缩等测试会对生成的样本实际编码、备份、归档、改标签或移动到回收站。

每条命令单独运行和看结果；出错时先保留第一条完整错误。部分 UI 集成脚本依赖旧页面选择器，失败也可能是测试脚本尚未跟上当前 UI，需要根据错误定位，不能直接认定业务能力通过或失败。Windows 测试报告中的五类兼容问题也需要在 Mac 重新验证，不能预先当作 Mac 缺陷。

记录日志的示例：

```sh
mkdir -p "$HOME/Desktop/arkive-test/logs"
node scripts/check-image-compression.mts > "$HOME/Desktop/arkive-test/logs/image.log" 2>&1
echo "exit=$?"
tail -n 40 "$HOME/Desktop/arkive-test/logs/image.log"
```

如果失败，把退出码和日志一并保留；不要仅凭生成了输出文件判断测试成功。

## 5. 再测试真实 Agent

预检已在文件不存在时复制 `.env.example` 为 `.env.local`。使用代码编辑器填写本人的配置，例如：

```dotenv
ARKIVE_AI_PROVIDER=openai-compatible
ARKIVE_AI_BASE_URL=https://你的服务地址/v1
ARKIVE_AI_MODEL=你的模型ID
ARKIVE_AI_API_KEY=你的API密钥
```

`BASE_URL` 是 API 根地址，不要写到 `/chat/completions`。不要把密钥填入前端，也不要提交或把 `.env.local` 发给别人。保存后重启应用。

然后运行：

```sh
node scripts/check-agent-live.mjs
```

它使用真实模型，可能产生 API 费用；测试使用生成样本和隔离的 Catalog。基础版本通过后，再按需要运行更多场景：

```sh
node scripts/check-agent-live.mjs --extended
```

真实模型验收重点：多轮对话、停止生成、只读检查时不写入、文件内指令不构成授权、批量授权后不反复确认、归档失败只重试归档、正确区分体积缩小和实际释放空间。扩展版涉及临时目录中的更多文件操作和 Mole 分析，应阅读输出并核对测试证据。

## 6. 大疆素材与 APFS

大疆专用回归不是任意 MP4 通用测试；当前用例针对 Pocket 3 的 4K/59.94fps、特定音频和辅助流结构。若手上正是对应样本，把副本命名为：

```text
~/Desktop/arkive-test/video-dji-4k.MP4
```

然后运行：

```sh
node scripts/check-video-compression.mjs --dji
```

素材规格不匹配时可能因预期结构不符失败。一般视频可以先用应用手动选择自己的测试副本，分别测试三个档位，检查播放、音轨、尺寸、帧率、色彩、元数据和原件备份。

APFS 去重需在同一个 APFS 卷上的测试副本中验证。先查看开发工具是否已安装：

```sh
xcode-select -p
```

`check-clone-deduplication.mjs` 的深度恢复用例会用 `/usr/bin/clang` 编译测试 helper；缺少时先按 Apple 的 Command Line Tools 安装流程安装，再运行：

```sh
node scripts/check-clone-deduplication.mjs
node scripts/check-clone-deduplication.mjs --agent
```

日常运行已有随包 helper 不要求重新编译；不要把这些回归测试直接指向真实资料。

## 7. 最后测试 .app 安装包

开发测试通过后再构建本机测试包，构建、打包、运行依次执行：

```sh
npx --yes pnpm@10.34.7 run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx --yes pnpm@10.34.7 exec electron-builder --mac --arm64 --publish never
node scripts/check-packaged-runtime.mjs
```

这样不会自动使用借用电脑上的开发者签名身份；此产物用于本机测试。当前配置 `notarize: false`，这一步不代表正式签名、公证或可公开发布。

构建产物包括 `dist/mac-arm64/arkive.app`，DMG 在 `dist/`。可以先打开 `.app`，再用 DMG 复制到当前用户的 `~/Applications`，验证首次启动、退出重启、拖放、压缩、备份、归档、Finder 标签和取消。

打包版不会读取项目中的 `.env.local`，也没有最终用户密钥配置界面。要测试打包版 Agent，可在应用已完全退出时，从终端直接启动二进制并在这个进程中提供环境变量：

```sh
node --input-type=module - <<'NODE'
import { loadEnvFile } from 'node:process'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
loadEnvFile('.env.local')
const child = spawn(resolve('dist/mac-arm64/arkive.app/Contents/MacOS/arkive'), [], {
  env: process.env,
  stdio: 'inherit'
})
child.on('error', console.error)
child.on('exit', code => { process.exitCode = code ?? 1 })
NODE
```

这会避免把 API Key 写进 shell 命令历史，或把配置文件当作 shell 代码执行。

## 8. 归还电脑前

先带走日志、结果和测试样本目录；退出所有 Arkive 进程，移除自己的 `.env.local` 密钥、项目副本、测试用应用及由自己产生的测试数据。开发版手动操作可能写入测试账户下的 `~/Arkive Backup`、`~/Arkive Archive` 和 `~/Library/Application Support/arkive`；核对归属后再清理。使用独立测试账户时可由电脑主人按需要删除该账户。

## 验证范围和参考

指南、准备脚本及源码包在 Windows 上完成静态检查和压缩包检查；macOS 运行、系统权限提示、工具预检和整套 Mac 测试仍待你在借来的电脑上执行。

- Node.js 下载：https://nodejs.org/en/download
- pnpm 10 安装方式：https://pnpm.io/10.x/installation
- Apple 文件夹权限：https://support.apple.com/guide/mac-help/control-access-to-files-and-folders-on-mac-mchld5a35146/mac
- Apple 用户账户：https://support.apple.com/en-ie/guide/mac-help/mtusr001/mac
