# 04 Visio 对象嵌入 docx 的对照与结论

> 场景：把 mmd2vsdx 产出的 vsdx 嵌进 docx。现象是 Word 里那块区域显示不对。
> 本条目给实测对照、结论与要改的清单。依据是 2026-09-23 的一次实测，
> 原始文件与脚本见文末。

## 现象

同一份 vsdx 单独打开正常，嵌进 docx 后 Word 里看不到图。把这份 docx
用 Word 另存为 PDF，对象区域连一条绘制指令都没有：整页 0 个图像对象、
0 条路径，只剩页眉与图注文字。

## 结论

1. **vsdx 数据没问题**。docx 内嵌包与源文件 14 个部件里 12 个逐字节相同；
   两个被改写的部件只差页框 0.0106 英寸与一处 ContentType。把两份文件分别交给
   Visio 打开读值，页面尺寸与 6 个形状的 PinX/PinY/Width/Height 一个数字都不差。
2. **不是 `package` 与 `oleObject` 的关系写法引起的**。关系类型只决定"对象数据
   存在哪儿"，不参与几何，两种写法 Word 都能认出 `ProgID=Visio.Drawing.15`。
3. **真正的原因是缺少呈现缓存**。Word 自己插入 OLE 对象时，会在 `word/media/`
   放一张由 OLE 服务器现场渲染的 EMF，并在 `<v:shape>` 里用 `<v:imagedata r:id>`
   引用它。手工拼 OOXML 时这份缓存没有写，Word 只剩下"现场激活 OLE 服务器"这一条路；
   激活不了或目标机器没装 Visio，那块区域就是空白。
4. **对象框尺寸放大了 8.66 倍**。Word 自己插进去时对象是 54.6×49.2pt，等于 vsdx
   页面 0.73×0.66 英寸；当前导出件写的是 457.8×408.6pt，约 16.15×14.4cm，接近
   A4 正文宽。若这是有意的"缩放到正文宽"，要保证内容随框一起缩放，否则版式会被撑坏。

## 证据

表一，A/B 对照。同一份 vsdx、同一个 457.8×408.6pt 的对象框，只换嵌入写法，
Word 另存 PDF 后统计绘制指令。

| 嵌入写法 | 预览 EMF | PDF 里的绘制 | 结果 |
| --- | --- | --- | --- |
| `oleObject` 关系加 CFB，vsdx 放在 `Package` 流 | 无 | 图像 0、路径 0 | 对象区域空白 |
| `package` 关系加裸 `.vsdx` 部件 | 有 | 图像 1 | 正常画出 |

表二，结构逐项对照。

| 项 | Word 官方插入 | 当前导出件 | 影响 |
| --- | --- | --- | --- |
| 载体 | `word/embeddings/<名>.vsdx`，裸 zip | `word/embeddings/oleObject1.bin`，CFB | 无，两者都能被识别 |
| 关系 | `.../relationships/package` | `.../relationships/oleObject` | 无 |
| 预览 | `word/media/image1.emf` 加 `<v:imagedata>` | 一个都没有 | **有**，Word 无图可画 |
| 对象框 | 54.6×49.2pt，等于 vsdx 页面 | 457.8×408.6pt | **有**，版式被撑 |
| 宽高比锁 | `o:lock aspectratio="t"` | `"f"` | 有，拖框会把图拉变形 |
| 原始尺寸 | 有 `w:dxaOrig/dyaOrig` | 无 | 小 |
| 内嵌包 | 原样透传 | 重新打包，页框被改小 0.0106in，且多了目录条目 | 无，但建议透传 |
| `app.xml` 类型 | `application/vnd.openxmlformats-officedocument.extended-properties+xml` | 写成了命名空间 URL | 无，只影响元数据 |

## 要改的清单

1. **补上呈现缓存**：`word/media/imageN.emf`，加 `<v:shape>` 内的 `<v:imagedata r:id>`，
   关系类型用 `.../relationships/image`。两条路可选，让 Office 生成最省事，
   我们验证过 Word 与 Visio 的 OLE 插入都会自动写好这份缓存；自造则要求 EMF 的
   尺寸与 `v:shape` 的宽高一致，比例取自 vsdx 页面。
2. **核对对象框尺寸**：取 vsdx 页面自然尺寸，英寸乘 72 得 pt；若确实要缩放到正文宽，
   把这条换算写在代码里并保持宽高比。
3. `o:lock aspectratio` 改为 `"t"`，补 `w:dxaOrig` 与 `w:dyaOrig`。
4. `[Content_Types].xml` 里 `docProps/app.xml` 的 ContentType 改回标准 MIME。
5. 内嵌的 vsdx 原样透传，不要重新打包。

## 自检

- docx 里必须有 `word/media/image*.emf`，且 `<v:shape>` 内有 `<v:imagedata>`；
- `v:shape` 的宽高与内嵌 vsdx 的 `PageWidth/PageHeight` 乘 72 的比例一致；
- Word 打开后另存为 PDF，对象区域至少要有一次图像或路径绘制，没有就是空白。

## 参考文件

| 用途 | 路径 |
| --- | --- |
| 出问题的导出件 | `tool-documentor/temp/测试工程-block-beta/测试工程-block-beta.docx` |
| 对照件（Word 官方写法 + 预览 + 同样放大的框） | 临时产物，已随 temp 清掉；要复现就照这一行的三要素另做一份 |
| 源 vsdx | `tool-mmd2vsdx/resources/vsdx-output/01-block-1.vsdx` |
| 实测脚本 | 在 `tool-mmd2vsdx/temp/` 下现做现用（比对内嵌件、深看复合容器、数页数、Word 侧核对），不随仓库留档 |
