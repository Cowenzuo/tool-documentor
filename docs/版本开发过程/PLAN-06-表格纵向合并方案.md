# PLAN-06 表格纵向合并方案（已实现）

> 状态：**已实现并实测通过**（提交见仓库日志）。需求原话：
> "如果一个表格内某一列中，连续几个字符内容一致，将其自动合并，软件内支持这个能力，然后导出时也自动适配支持，这应该是一个开关。"

---

## 1. 需求口径

示例（试验工况表）：

| 序号 | 工况模型 | 试验工况 |
|---|---|---|
| 1 | 上游1.5m-下游0.5m | 开度30% |
| 2 | 上游1.5m-下游0.5m | 开度40% |
| 3 | 上游1.5m-下游0.5m | 开度50% |
| 4 | 上游1.5m-下游1m | 开度30% |

→ 第 2 列前 3 行合并为一格。判定口径：

- **只在数据行内**判定，**表头行不参与**；
- 同一列中**连续**若干行，单元格内容 **trim 后非空且完全相同** → 合并；
- **空串不合并**（避免大片空白被合成一格）；
- 不连续（中间夹了别的值或空串）即使内容相同也各自成组；
- 纵向合并（同列上下），**不含横向合并**。

## 2. 开关位置与数据模型

| 位置 | 字段 | 说明 |
|---|---|---|
| 内容块（工程 DB `props_json`） | `mergeVertical?: boolean` | **每张表独立开关**，缺省关闭；仅在开启时写入 JSON，老数据缺键=关闭 |
| 模板 JSON（`*-structure.json` 的 contentBlocks） | `mergeVertical?: boolean` | 新建工程时随模板预置 |

`packages/core/src/blocks.ts`：`TableBlockProps.mergeVertical?` + `blockFromDb` 仅在 `true` 时写回；`packages/templates`：`TemplateContentBlockDef.mergeVertical?` + `templateBlockToContentBlock` 透传。

## 3. 判定算法（单一实现，三处共用）

`packages/core/src/table-merge.ts`：

```ts
computeVerticalMerges(data) → TableMergeCell[][]   // { rowSpan, covered }
countVerticalMerges(merges) → number              // UI 提示「已检测到 N 处合并」
```

- 纯函数、无 IO，返回与 `data` 同形状矩阵：起点格 `rowSpan>1`，被覆盖格 `covered=true`；
- 参差行（各行长度不一致）按缺列空串处理，不抛错；
- 通过 `@documentor/core/table-merge` 子路径导出——**渲染进程不能从 core 根入口导入**（根入口含 `node:sqlite`）。

三处消费同一结果，保证"预览什么样、导出就什么样"：

| 位置 | 消费方式 |
|---|---|
| 编辑区（`BlockEditors.tsx`） | 开关 + 「已检测到 N 处合并」提示；续格输入框加 `.be-table-cell-merged` 弱化样式（仍可编辑） |
| 预览（`PreviewPage.tsx`） | 起点格渲染 `rowSpan`，被覆盖格不渲染 |
| 导出（`packages/docx`） | 序列化器把开关放进 `InsertTable.mergeVertical`；writer 转成 OOXML 纵向合并 |

## 4. 导出映射（OOXML）

`packages/docx/src/writer.ts` → `renderTable`：

```xml
<w:tc><w:tcPr>
  <w:tcW w:w="3024" w:type="dxa"/>
  <w:vMerge w:val="restart"/>      <!-- 合并块起点；续格为 <w:vMerge/> -->
  <w:vAlign w:val="center"/>       <!-- 起点格垂直居中，长文本观感更好 -->
</w:tcPr><w:p>…原内容…</w:p></w:tc>

<w:tc><w:tcPr><w:tcW …/><w:vMerge/></w:tcPr><w:p/></w:tc>   <!-- 续格留空段 -->
```

要点：

- `w:vMerge` 必须排在 `w:tcW` 之后（`CT_TcPr` 顺序：`cnfStyle, tcW, gridSpan, hMerge, vMerge, …, vAlign`），否则 Word 可能忽略；
- 续格必须是空段（内容只在起点格出现一次），否则 Word 显示重复文本；
- 表头行不加 `vMerge`。

## 5. 默认值依据（素材原文）

素材 docx 实测：`脉动压力特征值`表（表头 `试验工况|指标|P1..P8`）原文即用纵向合并（上游1.5米工况表 restart=9/续格=27，即每组 4 行）；`试验工况表`原文未合并，但本工程按用户口径需要合并（`上游1.5m-下游0.5m` 连续 3 行）。

因此 `xsk-pressure` 结构模板（version 2.2）的 8 张表定义全部预置 `mergeVertical: true`；已建工程由数据侧脚本补齐开关（本仓库 `localtest/` 为本地数据，不入库）。

## 6. 非目标

- 不做横向合并（同列连续判定已覆盖用户场景）；
- 不做跨页断行的"合并格跟随"控制（Word 自身行为，必要时后续用 `w:cantSplit` 处理）；
- 不做表头行合并；
- 不改 `rows/cols` 与实际数据的同步策略（仍以 `data` 为准）。

## 7. 验证清单

| 层 | 用例 |
|---|---|
| core | 连续相同合并/不连续不合并/空串不合并/trim 比较/参差行/三行以上单组 |
| docx writer | `vMerge restart/续格/vAlign` 计数、内容只出现一次、表头无 `vMerge`、`tcW` 在 `vMerge` 之前、开关关闭时无 `vMerge` |
| 真实工程 | 38 张表全部开启：产物 `restart=148 续格=473`；Word 回读首表 `rows=10 cols=3 cells=25`，row2 跨 3 行、row5 跨 4 行，唯一值不合并 |
| 应用内 | 开关默认勾选、提示「已检测到 2 处合并」、预览 `rowspan=[3,4]`、界面导出产物与 CLI 一致 |
