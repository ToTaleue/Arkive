# 备用媒体处理工具

2026-10-15 下载保存，供后续接入。来源、版本、SHA-256、许可证文件及未确认事项统一记录在同目录 `manifest.json`。

| 程序 | 版本 | 来源 |
| --- | --- | --- |
| `pngquant` | 3.0.3，Universal（含 ARM64） | pngquant 官网 macOS 二进制包 |
| `ssimulacra2` | 0.5.2，ARM64 | rust-av/ssimulacra2 固定 commit 的本地 release 构建 |

这些是独立程序，执行时不需要其他应用授权。未修改下载所得的可执行文件。

两个程序均已通过版本查询；ARM64 动态库检查仅发现系统依赖，没有 Homebrew 绝对路径。Mach-O 声明最低 macOS 11.0，尚未在其他系统版本实测。

`ssimulacra2` 为 2.4 MB 的自包含 Rust CLI（仅使用 macOS 系统库），支持 PNG、JPEG 和 WebP 的静态图片比较。Rust 版本用于产品内评估，Cloudinary/libjxl 的 C++ 版本保留为分数校准参考；两者在同一 RGB PNG 样本上的结果接近，但仍应在接入时固定实现和阈值。

本机临时样本检查已通过：pngquant 输出 PNG，输出尺寸可读取。当前目录只记录仍随包提供的图片工具；PDF 工具 qpdf 的来源和许可见交付目录中的第三方说明。

目录内的 pngquant 和 ssimulacra2 已接入图片压缩。Ghostscript 不在当前随包资源中。现有 electron-builder 的 `extraResources` 会将本目录复制到应用 `Contents/Resources/tools`，签名、公证和安装后运行尚未验证。
