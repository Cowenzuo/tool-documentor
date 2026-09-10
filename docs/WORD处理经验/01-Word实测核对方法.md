# Word 实测核对方法

> XML 写对了不等于 Word 认。本页给出用 Word 回读产物的固定动作，逐项确认样式、
> 编号、域、合并与图形。配套脚本在 [scripts/](scripts/)。

## 1. 为什么必须用 Word 回读

同一份 XML，Word 解析后的结果和肉眼读 XML 的结论经常不一致。已知的差异有三类：

- 元素顺序不对时 Word 静默忽略。段落样式写在 `w:jc` 之后，XML 里明明有，Word 当没有；
- 样式是继承来的。看定义看不到最终字体，得看 Word 解析后的实际值；
- 域有缓存值与更新值两态。缓存的编号对了，按 F9 可能变，或者报错。

所以交付前的最后一步固定在 Word 里做，XML 只用来定位问题。

## 2. 打开与修复提示

用 Word 打开产物，不提示修复即通过。出现"文件可能已经损坏"一律当缺陷处理，
常见原因是命名空间重复声明、`mc:Ignorable` 里的前缀没声明、或者多级列表的层级越界。

打开后先看三处：标题编号是否连续、题注编号与章节号是否对得上、图片是否都在。

## 3. 逐项核对

| 核对项 | 取值位置 | 期望 |
| --- | --- | --- |
| 样式名 | 段落的 `Style.NameLocal` | 与样式模板里的中文名一致 |
| 对齐 | `Paragraph.Alignment` | 标题左对齐，题注与图片居中 |
| 中西文字体 | `Range.Font.NameAscii`、`NameFarEast` | 与排版口径一致，逐个样式看 |
| 字号与行距 | `Range.Font.Size`、`Paragraph.LineSpacing` | 单位是磅，行距不再是 240 分之一行 |
| 缩进 | `LeftIndent`、`FirstLineIndent` | 正文首行两字符，标题与题注零缩进 |
| 段前段后 | `SpaceBefore`、`SpaceAfter` | 单位是磅 |
| 标题编号 | `Range.ListFormat.ListString` | `4`、`4.1`、`4.1.1`，逐级看前四个 |
| 内嵌图形 | `InlineShapes.Count` | 等于工程里的图片块数 |
| 表格 | `Tables.Count`、`Range.Cells` | 行列数与合并跨行数 |
| 题注域 | `Fields.Count`、`Field.Type`、`Code.Text`、`Result.Text` | 类型为 STYLEREF 与 SEQ，结果等于编号 |

## 4. 表格的取法有个坑

表格里有纵向合并时，`Table.Rows.Item(r).Cells` 会直接抛异常，提示无法访问单独的行。
这不是产物坏了，是 Word 的集合访问限制。

改用 `Table.Range.Cells` 遍历，按每格的 `RowIndex` 分组统计。合并的起点格归属首行，
被覆盖的行自然少几格，缺的格数就是合并跨度。

## 5. 域的两态核对

打开时看到的是导出时写进去的缓存值，不代表域能算对。核对分两步：

1. 打开后先读一遍编号，确认缓存值正确；
2. 调用 `Fields.Update()` 更新全部域，再读一遍，确认编号不变且没有错误文本。

第二步能抓出两类问题：样式名写错导致 `STYLEREF` 解析不到，以及域的序号重启层级不对。
本机是中文 Word，样式名要用界面上的中文名。

## 6. 脚本用法

PowerShell 5.1 直接调：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\WORD处理经验\scripts\word-typography.ps1 -Path 出.docx
```

四个脚本各有分工：`word-typography.ps1` 看版式，`word-captions.ps1` 看编号与域，
`word-tables.ps1` 看表格与合并，`word-images.ps1` 看图形与图片段落。

包内的核对不必开 Word，用 `docx-check.cjs` 直接读 zip：媒体数、关系数、域数、
合并标记数一次给全，适合放进自动化。

## 7. 写脚本时的两个注意

- 脚本文件里出现中文就必须存成 UTF-8 带 BOM。PowerShell 5.1 无 BOM 时按 ANSI 解码，
  中文注释会变成乱码，严重时影响解析；
- 取内置样式用 COM 常量，别用名字猜。`wdStyleHeading1` 是 -2，标题 2 是 -3，依次递减；
  而 `Styles.Item('标题 3')` 按界面名称索引，按 styleId 取会失败。
