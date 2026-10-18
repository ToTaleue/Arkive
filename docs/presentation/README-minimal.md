# Arkive · 简约图解与动效版

保留暗绿色、团队分工、10 页主讲与 3 页隐藏答辩附录，替换此前的 3D AI 主视觉，去掉各页左下角的比赛与项目名称。

## 当前交付

- `Arkive-Techathon2026-minimal-motion.pptx`：当前修订稿，文字、图形、连接线和表格均可编辑，带原生淡入与转场。
- `index.html`：当前网页预览，支持分步图形淡入、重播、动效开关与全屏。
- `演讲稿与答辩提示-简约版.md`：本版讲稿、300 秒时间分配和来源。
- `highlights-minimal.png`：重点页面总览。
- `overview-minimal.png`：13 页总览。
- `previews-minimal/`：完整静态预览及动画背景帧。
- `diagram-spec.json`：用于网页同步预览的图形层；PPTX 中对应内容是原生对象。

上一版 `Arkive-Techathon2026-forest-final.pptx` 及其预览保留，便于比较。当前版本没有引用旧的 AI 生成背景。

## 图形变化

封面与痛点页使用线性文件、文件夹和归档盒；原件与副本页使用带 Backup 分支的处理流程；APFS 页使用两条路径共享内容的关系图；Agent 页与架构页使用图标节点及连接线。第 3、7、9 页保留产品界面来源，功能状态与数据口径保持不变。

## 动效

- PPTX：13 页使用淡入转场，7 页图形按阶段自动淡入；单个对象 320 毫秒，页面图解约 1–1.4 秒完成。不自动切换下一页。
- PPTX 中 11–13 页仍为隐藏附录。
- 网页：同一图形顺序淡入，附轻微上移；R 重播，M 开关动效，F 全屏。
- 网页遵循系统“减少动态效果”设置，关闭动效后直接显示完整静态页面。
- PPTX 的动画结构、对象引用与包结构已经检查；尚未在 Microsoft PowerPoint 放映模式中实机检查。不同演示软件可能以不同方式呈现动效，静态内容始终完整保留。

原生动画使用 PresentationML 的 transition 与 timing 表达，参考 [Microsoft 动画说明](https://learn.microsoft.com/en-us/office/open-xml/presentation/working-with-animation) 和 [AnimateEffect](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.presentation.animateeffect?view=openxml-3.0.1)。

业务与验证信息继续参考既有项目资料；本轮仅修改展示文件，没有修改产品源码或重跑产品功能测试。构建及验证中间文件位于 `C:\Users\steph\Desktop\arkive-test\pitch-simple-20261017`。
