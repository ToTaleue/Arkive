# ab-av1 随包运行

- 固定版本：0.11.7，macOS ARM64，MIT。版权与许可全文见 `licenses/ab-av1-MIT.txt`。
- 从 Homebrew 官方 Sonoma ARM64 bottle 提取；下载地址、包和二进制 SHA-256 见 `manifest.json`。解压前已核对包校验和。二进制 2,129,888 字节，未修改。
- `otool` 显示最低 macOS 11.0，仅链接系统 libiconv 和 libSystem；不需要 Homebrew 或 Rust 运行时。其他系统版本仍需实际验证。
- 现有 electron-builder `mac.extraResources` 将本目录复制到 `Contents/Resources/tools`；与 FFmpeg、FFprobe 一起分发。

主进程经 `src/execution/process.ts` 启动 `ab-av1 crf-search`。子进程 PATH 优先指向随包工具，复用本目录 FFmpeg/FFprobe 与 libvmaf，不依赖用户安装的版本。试压和最终编码均指定 `hevc_videotoolbox`、`allow_sw=0`，硬件不可用时报错。

业务目标和参数集中在视频压缩 Service：三档暂用抽样 VMAF 98/95/90；搜索范围 20～100、步长 5；两个 1 秒片段，每十二帧评估一次、VMAF 八线程，不主动降低评估分辨率。该配置已用 DJI Pocket 3 均衡档样本验证，其他素材与档位继续标定，不保证固定搜索轮数或耗时。短片可能由上游自动切换为整片分析。搜索关闭跨任务缓存，临时数据都放入任务私有目录；取消同时结束 ab-av1 和其 FFmpeg 子进程，再清理临时目录。

只采用搜索返回的质量参数。正式压缩仍由 Arkive Service 完成，沿用轨道保留、结构与完整解码校验和原件保护。抽样均值不是整片最低分或视觉无损保证；三个目标仍需更多素材标定。分析耗时未知时显示已用时间，不伪造总进度或 ETA。

来源：[项目](https://github.com/alexheretic/ab-av1/tree/v0.11.7)、[Homebrew](https://formulae.brew.sh/formula/ab-av1)。

验证命令（须在主代码仓库运行）：

```sh
rtk proxy node scripts/check-video-compression.mjs
rtk proxy node scripts/check-video-compression.mjs --dji
rtk proxy node scripts/check-video-compression.mjs --ui
```

在 `pnpm run build` 和 macOS ARM64 目录打包后，可给这些检查追加 `--packaged-tools dist/mac-arm64/arkive.app/Contents/Resources/tools`，让其直接使用 `.app` 内的二进制。DJI 检查需要桌面测试目录中的 Pocket 3 原片，会记录参数、样本评分、体积和各阶段耗时，并保留成功输出供查看。
