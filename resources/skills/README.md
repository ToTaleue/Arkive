# Arkive 内置场景 Skills

产品 Agent 的运行资源，权威正文保存在本目录，不安装到开发助手的 `.agents/skills/`。演唱会、微信及共用契约来自用户提供的 2026-10 微信附件，已按实际工具修订；Lightroom 照片场景由用户确认替换 Mail 后新增。原附件未修改。`references/arkive-tools.md` 是共用契约，不是第四个 Skill。

| 快捷命令   | Skill                     | 适用范围                                                 |
| ---------- | ------------------------- | -------------------------------------------------------- |
| `/concert` | `concert-video-archive`   | 演唱会／大疆本地录像检查、压缩、备份、归档与找回         |
| `/wechat`  | `wechat-file-archive`     | 用户指定的微信可读文件、视频；独立图片保留原位           |
| `/photos`  | `lightroom-photo-archive` | Lightroom 等导出的照片；默认建议保持 JPEG 格式、质量优先 |

输入 `/` 可筛选和选择场景，支持方向键、Enter／Tab、Escape 与点击；选中后补充路径或需求，再发送。选择本身不发送消息，也不授权文件修改。也支持 Pi 原生命令 `/skill:lightroom-photo-archive` 等；不使用命令时，模型可按场景描述选择并读取 Skill。

## 接入与修订

- 使用项目锁定的 Pi SDK 1.2.0 的 `loadSkills` 和原生命令展开。`src/shared/agent-skills.ts` 是唯一注册清单；`session.ts` 保持其他资源发现关闭，仅加载本目录三个显式入口。工具启用范围不变。
- `resources/**` 沿用现有 electron-builder 的资源收集与 `asarUnpack` 配置；从 `app.getAppPath()/resources/skills` 读取，不依赖微信附件路径。
- 微信独立图片跳过，默认账号发现仅定位 `msg/file` 与 `msg/video`。内部附件默认先提出独立副本方案；这不会减少微信原始占用。
- 照片只处理用户选定的导出目录，没有固定的 Lightroom 导出路径。JPEG 用 `preserveFormat: true`、新 JPG 输出；不承诺无损、固定压缩率、全部元数据保留或印刷效果。普通压缩有收益后移动完整原件到 Backup，写操作前说明目录变化。
- Mail 因本机来源访问受限及用户不接受完全磁盘访问授权，已从注册清单、菜单和运行资源移除。没有 `/mail` 入口。
- 共用契约区分有损处理、备份、无收益、Office 替换失败、按记录 ID 续做、标签及实际磁盘释放量。参数和结果以注册 schema 与业务返回值为准。
- Skill 是流程指导，不新增图库连接器、解密、OCR、人物识别或程序级审批沙箱。

## 验证

先 `rtk proxy pnpm run build`，再运行 `rtk proxy node scripts/check-agent-ui.mjs --skills`。该检查使用本地固定 HTTP 模型响应，经过真实页面、preload、IPC、Pi SDK、资源文件和 `read` 工具，验证候选选择、短命令与原生命令展开、参数保留、相对引用可读、Mail 排除及项目 Skill 不被发现。它不证明真实模型遵循整个流程，也不替代真实素材业务验收。照片实测结果见文档仓库的 `proposals/agent-skills.md`。
