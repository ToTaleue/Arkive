# 备用媒体处理工具

2026-10-15 下载保存，供后续接入。来源、版本、SHA-256、许可证文件及未确认事项统一记录在同目录 `manifest.json`。

| 程序 | 版本 | 来源 |
| --- | --- | --- |
| `pngquant` | 3.0.3，Universal（含 ARM64） | pngquant 官网 macOS 二进制包 |
| `jpegoptim` | 1.5.7beta，ARM64 | Clop v3.5.0 工具包，固定提交 |
| `gs`（Ghostscript） | 10.09.0 GIT PRERELEASE，ARM64 | 同上 |

Clop 工具包的 SHA-256 已与固定提交的 Git LFS 指针核对。这些是独立程序，执行时不需要 Clop 或 Pro 授权。未修改下载所得的可执行文件。

三个程序均已通过版本查询；ARM64 动态库检查仅发现系统依赖，没有 Homebrew 绝对路径。Mach-O 声明最低 macOS 11.0，尚未在其他系统版本实测。

本机临时样本检查已通过：pngquant 输出 PNG、jpegoptim 输出 JPEG，输出尺寸均可读取；Ghostscript 在清理 PATH、HOME 和 GS 环境变量的环境下生成并重写带文字的 PDF，字体从内置 `%rom%` 加载，结果通过已有 qpdf 的 `--check`。这些检查不代表画质、完整内容或所有字体和输入格式均已验证。

当前只保存工具，未接入业务。jpegoptim 和 Ghostscript 是预发布构建，正式选版时需重新决定。随包分发前还需核实对应源码、构建信息及第三方声明；保留许可证文件不代表已完成分发审核。现有 electron-builder 的 `extraResources` 会将本目录复制到应用 `Contents/Resources/tools`，签名、公证和安装后运行尚未验证。
