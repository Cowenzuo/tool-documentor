# 10 - 嵌入时调用 Visio（COM）归一化

> 状态：**已实现（可选加速器）**。有 Visio 时每张图先过一遍 Visio（重存 vsdx + 渲染预览）再嵌入；没装 / 未启用 / 调用失败就**逐张退回**自产预览 + 原样 vsdx，功能不降级。
> 画布与预览的尺寸口径见 11 号（无 Visio 路线）与 12 号（两条路线的差异与"改画布"）。

## 10.1 为什么做

我们过去一直在**复刻 Visio 的求解结果**（选边 → 走线 → 几何），复刻本身就是误差来源：实测 24 个端点里有 11 个落在目标形状边中点的另一个轴上，差值恒为半宽 0.411458in（29.6pt）或半高 0.1875in（13.5pt）。让 Visio 自己算一次，就从"复刻"变成"取真值"——vsdx 的走线/端点/母版、以及预览图都归它。

## 10.2 检测（毫秒级，不动进程）

| 查什么 | 位置 | 用途 |
| --- | --- | --- |
| COM 是否注册 | `HKLM\SOFTWARE\Classes\Visio.Application\CLSID` | 判断能否起 COM，但**不作为唯一依据** |
| 装在哪 | `HKLM\SOFTWARE\Microsoft\Office\<版本>\Visio\InstallRoot` | 找 `VISIO.EXE` 与版本 |
| 版本/位数 | 读 `VISIO.EXE` 文件版本 + 是否在 `Program Files (x86)` | 显示给用户，并进缓存键 |

判定口径：**能定位到一份存在的 VISIO.EXE 才算"有 Visio"**（只有 COM 注册残留不算，否则会走进"以为能归一化、实际起不来"）。探测结果缓存 60 秒，设置页有"重新检测"。

## 10.3 调用清单（`scripts/visio-normalize.ps1`）

进程级：

```
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File scripts/visio-normalize.ps1 -Manifest <清单.json> -PidFile <pid.txt>
超时 = 配置 timeout_ms（默认 180000，夹在 5s~600s）；windowsHide；stdout 上限 4MB
```

COM 级（逐条都是官方接口）：

| 调用 | 参数 | 用途 |
| --- | --- | --- |
| `New-Object -ComObject Visio.Application` | — | **新建**实例；不用 `GetActiveObject`，不接管用户已打开的 Visio |
| `$app.Visible = $false` | — | 不可见 |
| `$app.AlertResponse = 7` | No to All | 弹框一律按"否"，避免无人值守卡死 |
| `$app.EventsEnabled = 0` | — | 关事件 |
| `Documents.OpenEx(路径, 6)` | `visOpenCopy(4)+visOpenRO(2)` | 打开**只读副本**，不碰原文件 |
| `Page.BoundingBox(3, …)` | 绘图坐标范围 | 取真实绘图范围（含走线），见 10.4 |
| `PageSheet` 的 `PageWidth/PageHeight` | 英寸 | 把画布设成该范围（余量 0） |
| 逐个 `Shape` 的 `LockMoveX/LockMoveY` + `PinX/PinY` | 英寸 | **只平移**内容使其落在页内（动态连线由端点驱动，挪不动属正常） |
| `Document.SaveAs(输出.vsdx)` | — | 让 Visio 自己重存一遍（走线/端点/母版由它求解） |
| `Page.Export(输出.emf)` | **只传文件名** | 导出渲染预览；PowerShell 解析不了两参数重载，格式按扩展名推断 |
| `Document.Close()`、`$app.Quit()` | — | 关文档、退出；退出后按 PID 复核，3 秒不退就强杀 |

## 10.4 一次会话对每张图做什么

```
OpenEx（只读副本）
  → 修正画布：页面尺寸 := Visio 的绘图范围，内容整体平移进页面（只平移不缩放）
  → SaveAs：重存 vsdx（页面已是修正后的真值）
  → Export：按页面导出 EMF 真图
  → Close
```

"修正画布"的理由、实测数据与剩余限制见 **12 号文档**；一句话：上游 mmd2vsdx 不许调 Visio，只能按节点包围盒 + 约 10% 余量估画布，那个画布不是真值。

## 10.5 进程、超时与残留（踩过两次）

- 应用被强杀时，脚本里的收尾和 Node 侧兜底都会失效，Visio 会变孤儿 ⇒ 脚本把 PID 写进 `-PidFile`，父进程超时强杀时按它清理；批量开跑前还会清扫 `%TEMP%/doc-visio-*` 里"我们自己记过 PID 且超过 15 分钟"的目录；
- 只清我们自己记过 PID、且**无打开文档**的实例，绝不碰用户正在用的 Visio。

## 10.6 缓存

键 = `sha256(vsdx 内容)[:32] + 脚本内容哈希 + Visio 版本`；落在 `userData/visio-cache`，同名 `.vsdx` / `.emf` / `.json`。
上限 500 条 / 200MB，超出按最旧先删。命中即毫秒级（实测单张 9ms），同内容不重复起 Visio。

## 10.7 现行口径

| 路径 | vsdx | 预览图 |
| --- | --- | --- |
| 检测到 Visio 且启用 | Visio 重存件（走线/端点/母版由 Visio 解） | Visio 导出的 EMF 真图 |
| 没装 / 未启用 / 调用失败 | 原样嵌入生成件 | 嵌入层自产（带示意文字，受五条硬约束，见 07/08） |

三条配套约定：

1. **没有"预览图用谁的"这一档开关**：混着用没有意义（Visio 的 vsdx + 自产的图），配置里只有启用开关、路径与超时；
2. **Visio 的件原样使用**：不改它的设备 dpi、逻辑 dpi、声明矩形（改了就是深度干预别人的产物，实测分别导致"框被撑大"与"内容与声明对不上、靠左上留白"）。来源标记 `previewSource: 'visio'` 只用来**跳过 dpi 告警窗**（它用本机物理 dpi 188.5/189.0，属正常形态），其余两条护栏照旧；
3. 没走 Visio 时首帧偏移与已知瑕疵**按既定口径接受**：不再为它复刻 Visio 的求解结果。

## 10.8 走过的弯路（只留仍能指导决策的部分）

| 弯路 | 结论 |
| --- | --- |
| 改 Visio 件的声明矩形 / 设备 dpi / 逻辑 dpi | 都是深度干预；两次实测都出问题，已全部撤销 |
| 往页面里加整页白底形状，让导出覆盖整页 | 等于加节点、改内容，不允许 |
| 以"Visio 的件自带自洽声明"为由跳过尺寸处理 | 声明与对象框撞成相等时，人工双击实测**框被撑大** |
| 单张图被判"Visio 处理失败" | PowerShell 的 `ConvertTo-Json` 单条输出的是**裸对象**不是数组；解析器只认数组 ⇒ 单张批次全失败，且原始回执被丢弃、查不出原因。现在两种都认，失败必带原始回执 |

**取舍顺序**：已有人工实测的约束（声明 ≠ 框、双击不变大）**优先于**后来推导的不变量（内容 = 声明）；两者冲突时先动手测一次，再决定动谁。
