# 05 VSDX 形状写实与 OLE 激活首帧渲染

> 场景：把 mmd2vsdx 产出的 vsdx 嵌进 docx，双击对象在 Visio 里打开时显示不对。
> 本文给实测依据与**生成侧要改成什么样**，结论是"每个 shape 必须把自己的
> `Geometry` / `Connection` 写实，不能靠 master 继承"。
> 依据是 2026-09-23 的实测，文件与脚本见文末。

## 现象

**同一份 vsdx，两条路径表现不一样：**

1. **单独打开**（双击 vsdx 文件）：正常。
2. **从 docx 里双击对象激活**（Word → Visio）：**每个节点的选中框位置与大小都对，
   但画出来的背景框尺寸离谱（高度/宽度差一个量级）；缩放一次就恢复正常。**
   Word 里那份 docx 也不显示图（这一条是呈现缓存的事，见 04，与本条无关）。

关键特征是"**选中框对、背景框不对、重绘后恢复**"：选中框读的是 Cell 值，
背景框走的是渲染路径，说明**首帧渲染没有用上该 shape 自己的几何**。

## 依据

### 1. 数据本身没问题（先排除掉的三件事）

| 排查项 | 实测 | 结论 |
| --- | --- | --- |
| 嵌入件里的 vsdx 是不是被改坏了 | 逐部件比对：只有 `visio/pages/pages.xml` 的页面尺寸被改写，几何一字未动 | 排除 |
| 交给 Visio 渲染会不会不同 | 把内嵌件里的 vsdx 与源 vsdx 分别交给 Visio 导出 PNG：**逐字节相同**（同 sha），形状数、粘接数一致 | 排除 |
| OLE 容器（Compound File）写法 | 与旧版导出件、与原生嵌入件逐流对照；激活后 Visio 读到的形状数/粘接数与内嵌件一致 | 排除 |

**注意**：`Page.Export` 导出会强制重绘，所以**导出的图片看不出这个首帧问题**，
必须靠结构比对 + 人工在 Visio 窗口里看。

### 2. 结构差异：节点 shape 是"空壳"

同一个 `complex` 用例（17 个 shape：8 个节点 + 9 条连线），
把工具产出与 **Visio 重存一次**（打开读写 → SaveAs，等价于手动粘贴时的重算）相比：

| | 工具产出 | Visio 修复态 |
| --- | --- | --- |
| 节点 shape 的 Cell 数 | 9 个（PinX/PinY/Width/Height/LocPinX/LocPinY/Angle/FlipX/FlipY） | 26~71 个 |
| 节点 shape 的 Section | **一个都没有** | `Connection` + `Geometry`（个别还有 `User`/`Control`） |
| 连线 shape | 有 `Geometry`/`Control` | `Geometry`/`Control`（行数与 cell 更全） |
| `visio/pages/page1.xml` | 21734 字节 | 34547 字节 |
| `<Connect>` 粘接 | 18 条 | 18 条（不变） |

节点 shape 里的 Cell 就这些，**几何全靠 `Master="100"` 继承**：

```xml
<Shape ID="1" Type="Shape" NameU="Mermaid Shape" Master="100" LineStyle="3" FillStyle="3" TextStyle="3">
  <Cell N="PinX" V="0.0980734375" U="IN"/>
  <Cell N="PinY" V="0.510508333333" U="IN"/>
  <Cell N="Width" V="0.185546875" U="IN"/>
  <Cell N="Height" V="0.28125" U="IN"/>
  <Cell N="LocPinX" V="0.0927734375" U="IN" F="Width*0.5"/>
  <Cell N="LocPinY" V="0.140625" U="IN" F="Height*0.5"/>
  <Cell N="Angle" V="0" U="DEG"/>
  <Cell N="FlipX" V="0"/><Cell N="FlipY" V="0"/>
  <Text><cp IX="0"/>A</Text>
</Shape>
```

Visio 重存后，同一个 shape 多出这两段（**值都是相对该 shape 自己的局部坐标**）：

```xml
<Section N='Connection'>
  <Row T='Connection' IX='0'><Cell N='X' V='0.0927734375' U='IN' F='Inh'/><Cell N='Y' V='0' U='IN' F='Inh'/></Row>
  <Row T='Connection' IX='1'><Cell N='X' V='0.185546875' U='IN' F='Inh'/><Cell N='Y' V='0.140625' U='IN' F='Inh'/></Row>
  <Row T='Connection' IX='2'><Cell N='X' V='0.0927734375' U='IN' F='Inh'/><Cell N='Y' V='0.28125' U='IN' F='Inh'/></Row>
  <Row T='Connection' IX='3'><Cell N='X' V='0' U='IN' F='Inh'/><Cell N='Y' V='0.140625' U='IN' F='Inh'/></Row>
  <Row T='Connection' IX='4'><Cell N='X' V='0.0927734375' U='IN' F='Inh'/><Cell N='Y' V='0.140625' U='IN' F='Inh'/></Row>
</Section>
<Section N='Geometry' IX='0'>
  <Row T='MoveTo' IX='1'><Cell N='X' V='0' U='IN' F='Inh'/><Cell N='Y' V='0' U='IN' F='Inh'/></Row>
  <Row T='LineTo' IX='2'><Cell N='X' V='0.185546875' U='IN' F='Inh'/><Cell N='Y' V='0' U='IN' F='Inh'/></Row>
  <Row T='LineTo' IX='3'><Cell N='X' V='0.185546875' U='IN' F='Inh'/><Cell N='Y' V='0.28125' U='IN' F='Inh'/></Row>
  <Row T='LineTo' IX='4'><Cell N='X' V='0' U='IN' F='Inh'/><Cell N='Y' V='0.28125' U='IN' F='Inh'/></Row>
</Section>
```

`Width`/`Height` = 0.185546875 / 0.28125 英寸，几何顶点正是 `0` 与这两个值的组合 ——
**几何被写实成"这个 shape 自己的矩形"**。

### 3. 原因

OLE 激活路径下，Visio 打开的是"还没解析 master 继承"的文档：首帧按 **master 的几何**
（master 是通用大方框）画背景框，而**选中框读的是 Cell 里的 PinX/PinY/Width/Height**，
所以位置大小是对的；等一次重绘（缩放、滚动、切页）之后才用上解析后的真实几何，于是恢复正常。

**同一个坑本工程 1.0 阶段踩过**，旧脚本 `standardize_vsdx.py` 的原话是：

> 保留工具的坐标/内容值（PinX/PinY/BeginX/EndX/文本等），但把 Cell 配置（公式、Cell 集合、
> **Geometry 结构**）对齐到样本 —— 样本是 **Visio 粘贴时路由/修复完成的状态**，
> OLE 激活路径下可正常显示直角折线。

当时是在**嵌入侧**（导出前预处理 vsdx）绕过的，配套 `resave_vsdx.ps1`（批量 Visio 重存）、
`resave2/3.ps1`、`strip_conn_cells.py`（删连接点 Row 里的 `DirX/DirY/Type/AutoGen/Prompt`）、
`freeze_conn.py`（把 Visio 重算后的连接器状态写回）。**这一次改在生成侧，属于根治。**

## 生成侧要改的清单

1. **每个节点 shape 写出自己的 `<Section N='Geometry' IX='0'>`**：矩形就是
   `MoveTo(0,0)` → `LineTo(W,0)` → `LineTo(W,H)` → `LineTo(0,H)`；
   两列 Cell 各写 `V`（值本身）与 `F="Inh"`，单位 `U="IN"`。
   **坐标是相对该 shape 自己的局部坐标**（0..W、0..H），不是页面坐标。
2. **每个节点 shape 写出自己的 `<Section N='Connection'>`**：四边中点 + 中心共 5 个连接点
   （不写就是"没有连接点"，连线的粘接会落到 master 的定义上）。
   行里**只写 `X`/`Y`**，不要把 `DirX/DirY/Type/AutoGen/Prompt` 带上——原生样本里没有这些。
3. **连线的 Geometry 同样写实**（工具已经写了 `Geometry`/`Control`，保持并核对
   行坐标落在连线自己的框内）。
4. **别依赖 master 做首帧**：`Master="100"` 可以留着（样式来源），但几何与连接点要落在 shape 自己身上。
5. **同一份文件里别混单位**：实测见过同一页里一部分 Cell 写 `U="MM"`、另一部分不带 `U`
   （缺省表示按页面默认单位 = 英寸）。下游只能猜，猜错就是"页面被压成 3mm、图变成 8.5pt 的小点"
   这类事故（见"我们这边修过的"第 2 条）。**同一种量要么都带单位，要么都缺省。**

## 自检

改完后拿任意一份产出去核（判据，可脚本化）：

1. 每个**节点** shape（有 `Master`、不带 `BeginX`）都有自己的 `Section N='Geometry'`；
2. 节点的 Geometry 顶点落在自己的框内：`0 ≤ X ≤ Width`、`0 ≤ Y ≤ Height`（留 1% 余量）；
3. 每个节点有自己的 `Section N='Connection'`；
4. 每条连线有 `Section N='Geometry'`（**不判越界**：连线的 Geometry 坐标系与节点不同、
   `Width/Height` 可为负表示方向，连 Visio 自己的产物都不满足"落在框内"）。

本机脚本 `temp/check-vsdx-materialized.cjs <x.vsdx>` 就是按这四条写的，实测对照：

| 输入 | 结果 |
| --- | --- |
| 工具产出的 vsdx（block-beta 6 节点 / complex 8 节点 + 9 连线） | ✗ 12 条 / 16 条问题：节点**没有 Geometry 与 Connection Section** |
| 同一份经 Visio 重存后的"修复态" | **✓ 已是修复态**（Geometry 6/6、17/17；Connection 6/6、8/8） |

**人工确认**（脚本看不出首帧）：把改后的 vsdx 嵌进 docx，双击对象在 Visio 里打开，
**不要缩放**，直接看背景框是否与选中框一致。

## 我们这边修过的（供参考，不用生成侧管）

同一次排查里在**嵌入侧**修掉的三件，都已入库（分支已并入 `main`）：

| 问题 | 现象 | 修法 |
| --- | --- | --- |
| 对象框按假比例算 | 258 张图里 64 张的框宽高比与页面比例不符（最多差 83%），Word 非等比拉伸 → 线宽、箭头、字号全变形 | 框改用图的自然尺寸（页面 × 72pt），只超宽/超高时等比缩小；比例取页面真实比例；写 `aspectratio="t"` 与 `w:dxaOrig/w:dyaOrig` |
| 包围盒取数漏形状 | 要求 `U` 属性必须存在，整批缺省单位（英寸）的形状被漏掉，页面被压到 3mm，图成了 8.5pt 的小点 | 缺省按页面默认单位（英寸）算 |
| 页面尺寸写错单位 | 把英寸值写进 `U="MM"` 的格子，A4 页被缩成 4.7mm | 按格子自己的单位换算后再写 |

## 参考文件

| 文件 | 是什么 |
| --- | --- |
| `temp/embed-A-blockbeta.vsdx` / `embed-B-complex.vsdx` | 工具产出（后者含 8 节点 + 9 连线） |
| `temp/bb-Visio重存.vsdx` / `complex-Visio重存.vsdx` | 同上，经 Visio 重存后的"修复态" |
| `temp/bb-嵌入件.vsdx` | 从导出的 docx 里抠出来的内嵌件 |
| `temp/shape-dump.cjs` | 打印某个 shape 的完整 XML（含 pages.xml / windows.xml） |
| `temp/sections-of.cjs` | 列出每个 shape 有哪些 Section，并统计 |
| `temp/check-vsdx-materialized.cjs` | 上面四条判据的自检 |
| `temp/visio-resave.ps1` | Visio 读写打开 + SaveAs（复刻"手动粘贴时的重算"），可顺带导首帧图 |
| `temp/visio-render-compare.ps1` | 两份 vsdx 交给 Visio 渲染并比 PNG |
| `temp/diff-vsdx.cjs` | 两份 vsdx 逐部件差异 |
