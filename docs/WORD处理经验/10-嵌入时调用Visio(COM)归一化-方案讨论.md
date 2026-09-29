# 10 - 嵌入时调用 Visio（COM）归一化：方案讨论

> 状态：**待讨论，未实现**。需求方决定：嵌入时用一次 Visio（COM）产出 ① Visio 重存后的 vsdx（走线与端点由 Visio 自己归一化）② Visio 渲染的预览图；**没装 Visio 时退回现有逻辑**（自产预览 + 原样 vsdx）。

## 10.1 为什么值得做（依据本轮结论）

- 连线首帧偏移的根因在 vsdx 的 `page1.xml`：把 Visio 重存件的 page1.xml 换进我们的包，Word 首帧正确；把我们的换进重存件则错。范围进一步收窄到 12 条连线的端点/派生值/几何/Connects（K1 实验）。
- 我们的连线端点里，24 个有 11 个落在目标形状边中点的另一个轴上（基准 Begin 落左右边、End 落上下边），差值恒为半宽 0.411458in（29.6pt）或半高 0.1875in（13.5pt）。
- 也就是说：我们一直在**复刻 Visio 的求解结果**（选边→走线→几何），而复刻本身就是误差来源。让 Visio 自己算一次，就从"复刻"变成"取真值"。

## 10.2 架构落点（保持 postprocess 纯函数）

```
packages/postprocess   纯逻辑，不认识 OS / COM
        ↑ 注入端口
interface VsdxNormalizer {
  /** 归一化一份 vsdx；返回 null 表示本机不可用，调用方走现状 */
  normalize(vsdx: Uint8Array): Promise<{ vsdx: Uint8Array; previewEmf?: Uint8Array } | null>
}
```

- 实现 A：`VisioComNormalizer`（Electron 主进程侧，Windows 且装了 Visio 才有效）
- 实现 B：`null`（现状：自产预览 + 原样 vsdx）——**默认值**，保证零回归
- 探测：启动或首次导出时探测一次并缓存（注册表/`New-Object -ComObject Visio.Application` 试连），探测失败即用 B

## 10.3 调用方式（两选一）

| 方案 | 优点 | 代价 |
| --- | --- | --- |
| **(a) PowerShell + COM**（`New-Object -ComObject Visio.Application`，脚本入 `scripts/`） | 无原生依赖、可单独运行调试、跨 Electron 版本稳定 | 每次进程启动约 0.5~1s；二进制交换要走临时文件 |
| (b) `winax` 等原生 ActiveX 桥 | 调用直接、无需子进程 | 原生模块编译 + Electron ABI 绑定，升级成本高 |

倾向 **(a)**：一次导出只起一个进程，批量处理全部图，摊薄启动开销。

## 10.4 Visio 侧动作（单会话批量）

1. `Visible=false`、`DisplayAlerts=0`（或 `AlertResponse`）、`EventsEnabled=false` —— 不打扰用户、不弹框；
2. 逐图：`Documents.OpenEx(tmpVsdx, visOpenCopy|visOpenRO, 0)` → `Document.SaveAs(tmpOut)` 得到归一化件 → `Page.Export(tmpEmf, "EMF")` 导出预览 → `Close`；
3. 结束 `Quit()`；整体加硬超时（如 60s）与强杀兜底；
4. **一律新建实例**，不用 `GetActiveObject`（会抢用户已打开的 Visio）；用户开着 Visio 不受影响。

## 10.5 产出如何接回现有口径

- **vsdx**：整份替换为 Visio 重存字节。我们的消费端是字节透明的（已验：内嵌 vsdx 与输入逐字节一致），所以替换即生效。
- **预览 EMF**：Visio 导出的件**未必满足**我们那套硬约束（声明尺寸 = 画布 × L ÷ 参考dpi、两轴 dpi 常规且一致、内容物理尺寸 = 声明尺寸）。做法：先用 `normalizePreviewEmf` 只改 `rclFrame` 与参考设备字段、其余字节不动；改完仍不合规就退回自产预览。
- **对象框**：仍按现有 fit 口径算，不因预览来源变化。
- **示意文字**：当初要求"预览不能纯空白、要有示意文字"，是因为自产件画不出真图。用 Visio 渲染后这个约束自然消失（预览就是真图）；但**声明尺寸那套自洽约束仍然必须满足**，否则双击会改框。

## 10.6 风险与对策

| 风险 | 对策 |
| --- | --- |
| 没装 Visio / COM 注册失败 / 被策略拦 | 探测失败即走现状，功能不降级只是不回正 |
| Visio 首次运行/激活弹框卡住 | `DisplayAlerts=0` + 硬超时 + 强杀；失败即回退 |
| 耗时（23 图） | 单会话批量；结果按 mermaid 内容哈希缓存，同内容不重复调 |
| 用户正开着 Visio | 新建实例，不接管既有实例 |
| 并发 | 导出在主进程串行，天然无并发 |
| 分发 | Visio 只作为**可选加速器**，不能成为硬依赖 |

## 10.7 验证计划

1. **A/B 对照**：同一份真实工程，开、关归一化各导一次；
2. 人工判据：双击对象看**首帧**连线是否正位（这是本轮唯一无法自动化的一环）；对象框是否漂移；
3. 自动判据：预览件 23/23 可解析、护栏（声明≈框）0 撞、dpi 越界 0/23、内嵌 vsdx 与归一化输入逐字节一致、导出警告 0；
4. 回退路径：临时把 Visio 探测遮掉，确认导出与现状完全一致；
5. 记录耗时（首图/批量/缓存命中三种）。

## 10.8 已定口径（本轮拍定）

**由设置里的检测决定走哪条路**，和 mmd2vsdx 的「转换服务」一节同一套模式：

- 设置里探测本机有没有 Visio（照 `node-locate.ts` 的形态：候选 + 每个候选的来源/版本/为什么没用上）；
- **没有 Visio** ⇒ 完全走现状：自产预览件 + 原始 vsdx 嵌入，不报错、不阻塞、不提示失败；
- **有 Visio** ⇒ 每张图先过一遍 Visio（重存拿归一化 vsdx，顺手导出渲染预览），再嵌入；
- 检测结果与开关落地在设置页，用户可看可关；默认「检测到就启用」。

导出期若 Visio 调用失败（超时/弹框/权限），**逐张回退**到现状并记一条警告，不让整篇导出失败。

## 10.9 落地清单（按文件，照现有分层）

| 步骤 | 文件 | 内容 |
| --- | --- | --- |
| 1 配置与状态类型 | `packages/desktop/src/shared/project.ts` | 新增 `VisioConfigDto`（enabled、exe_path/prog_id、timeout_ms、用不用它的预览）与 `VisioStatusDto`（found、source、exe、version、bitness、probe{ok,reason,detail,ms}），并加进 `AppConfigDto` |
| 2 探测 | `packages/desktop/src/main/services/visio-locate.ts`（新） | 候选：注册表 `HKCR\Visio.Application\CLSID`、`HKLM\SOFTWARE\Microsoft\Office\*\Visio\InstallRoot`、常见安装路径；每条给 source / version / ok / reason |
| 3 调用 | `packages/desktop/src/main/services/visio-service.ts`（新）+ `scripts/visio-normalize.ps1`（入库） | 快速探测（查注册表，毫秒级）与深度探测（真起一次 COM 再退出，1~3 秒）；批量归一化：单会话、不可见、`DisplayAlerts=0`、硬超时强杀、临时目录交换文件 |
| 4 IPC | `packages/desktop/src/main/ipc.ts` | 设置读写加 `visio` 一节；新增「检测 Visio / 探测详情」通道（照 mmd2vsdx 那节） |
| 5 设置界面 | `packages/desktop/src/renderer/src/pages/SettingsModal.tsx` | 新增「Visio（可选）」一节：检测结果、版本、路径、来源、原因、重新检测按钮、启用开关；文案沿用现有"为什么不生效"的写法 |
| 6 导出链路 | `packages/desktop/src/main/services/project-service.ts` | 拿到上游 vsdx 之后、交给 writer 之前插一次归一化；不可用或失败即原样返回；归一化带回的预览件要先过现有护栏（声明尺寸/dpi），不合规退回自产件 |
| 7 缓存 | userData 下 | 归一化结果按 vsdx 内容的 sha256 缓存，键含 Visio 版本与脚本版本；同内容不重复起 Visio |

## 10.10 仍需你点头的三件小事

1. **检测深度**：设置页给两档 —— 快速检测（查注册表，毫秒级，默认）+ 深度检测（真起一次 COM，1~3 秒，按钮触发）？
2. **预览取舍**：有 Visio 时用它的 EMF（真图，信息量最大、不再需要那行示意文字）；还是保留自产预览件（有示意文字、尺寸完全可控）？我倾向用真图，护栏照过。
3. **归一化范围**：整份重存（推荐：与 K1 实验完全一致，母版/document.xml 也交给 Visio），还是只重写连线部分？

