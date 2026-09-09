# Documentor 结构模板 ⇄ 样式模板关联方案（已实施）

> 状态：**已实施**（commit `9dfb16a refactor: 模板体系——外部分发 + 结构-样式 1:N 配对软校验`）。
> 目标：消除"导出时任意选样式 → 结构无对应样式 → 成品格式错乱"的隐患，
> 并显式支持「结构模板 1:N 样式模板」与「多结构共享同一样式」。

---

## 1. 问题与现状

### 1.1 现状

- 结构模板顶层 `styleTemplate: "xxx-stylemap"`（**单值**，指向样式映射文件 key）——只能表达 1:1；
- manifest.json 中 structures / styles 为**两个独立列表**，无任何关联声明；
- 导出对话框的"样式模板"下拉列出**全部样式模板**，用户可任选；
- 样式映射（stylemap）的 `styleMap` 是开放键集：不同结构树实际需要的逻辑键（heading.1..7、subtitle.1..3、body、
  table.*、figure.caption、list.*）**未必齐备**。

### 1.2 会出什么问题

1. **键缺失**：结构树用到 heading.4，所选样式无此键 → 段落无 pStyle → Word 回退正文样式，层级/编号全乱（"必然出问题"）；
2. **styleId 不存在**：逻辑键有、但骨架 styles.xml 没有对应 styleId（样式包不完整）→ 同上；
3. **语义错配**：A 结构的"表题注"约定样式在 B 包里被定义为其他用途 → 排版错位。

### 1.3 约束（用户意向）

- 结构模板可配**多个**样式模板（1:N），但**不能随意选**——导出可选集合必须由结构模板声明；
- **不支持隐式"通用"样式/结构**：配对关系必须显式；
- "至少 1:1 必须有"：结构模板至少要有一个可用的样式模板（否则该结构模板视为无效/不可用）。

---

## 2. 方案总览

```
结构模板 JSON（唯一真源）
├── styleTemplate: "438c-srs-stylemap"        # 默认样式（必须 ∈ 下方集合）
└── styleTemplates: ["438c-srs-stylemap",     # 可用样式集合（1:N）
                     "438c-srs-stylemap-alt"]

加载期（TemplateManager）：
  对每个 (结构, 样式) 配对做两道校验：
  ① fileKey 存在性         —— 样式已注册（name/fileKey 双 key）
  ② 样式键完整性           —— 结构树"所需逻辑键集合" ⊆ 样式映射键集
                             且每个实体 styleId 存在于骨架 styles.xml（现有 validate）
  不通过 → 该配对标记不可用（保留 + 日志 + missingKeys 明细）
  剔除后集合为空 → **软校验**：结构模板照常加载（可编辑/保存），导出入口禁用并提示明细

运行期（导出）：
  导出可用集合 = 该工程结构模板的（已校验）样式集合
  对话框只列集合内样式（默认选中 styleTemplate）；集合为空 → 导出禁用 + 提示
  serializer 对 lookup 不到键的段落：警告 + 导出结果附 warnings（不再静默）
```

### 2.1 数据形态（兼容旧模板）

| 字段 | 语义 | 兼容 |
|---|---|---|
| 顶层 `styleTemplate` | 默认样式（单值），**必须 ∈ styleTemplates** | 旧格式保留，自动视为集合元素 |
| 新增顶层 `styleTemplates: string[]` | 可用样式集合（结构侧声明） | 缺省时自动回退 `[styleTemplate]`（单元素集合） |

- 旧模板（现状 438C / 合成 demo）**零迁移**：无 `styleTemplates` 时自动获得单元素集合；
- **1:N 新增**：结构 JSON 加数组并在 manifest 注册其它样式即可；多结构可引用同一样式（`styleTemplates` 出现于多个结构 → 实现多结构共享样式，**显式声明式共享**，不是隐式通用机制）；
- 样式模板**不反向声明**适配结构（单一真源，避免双向声明漂移）。

### 2.2 "所需逻辑键集合"推导规则（结构树静态分析）

| 结构树特征 | 要求键 |
|---|---|
| 任意非 subtitle 节点（标题级别 L） | `heading.L` |
| subtitle 链最深深度 D（树内最大 subTitleDepth） | `subtitle.1` … `subtitle.D` |
| 含 text/formula/code/image/mermaid 任意块 | `body` |
| 含 table 块 | `table.caption`、`table.header`、`table.body` |
| 含 image 或 mermaid 块 | `figure.caption` |
| 含 orderedList 块 | `list.ordered.1` |
| 含 unorderedList 块 | `list.unordered.1` |

> 列表仅用一级（serializer 现状）；subtitle 取全深度链。骨架侧再叠加现有
> `validateStyleTemplate`（styleId ∈ styles.xml）。

### 2.3 加载失败策略（分级、不静默）

| 情况 | 策略 |
|---|---|
| 样式集合所有配对均不通过校验 | **软校验**：结构模板照常加载（可编辑）；`styleCandidatesForStructure` 全不可用 → 导出按钮禁用 + 提示缺失键明细 |
| 部分配对不通过 | 不通过的绑定剔除；可用的保留；日志列出剔除明细 |
| 配对中样式映射键齐但骨架 styleId 缺失 | 同"不通过"处理（骨架校验现有能力） |

### 2.4 UI 与 CLI 行为

- **导出对话框**：样式下拉 = 结构模板可用集合（名称+版本），默认选中 `styleTemplate`；
  不再出现"全部样式模板"。集合为空（理论被加载期拦截）→ 导出按钮禁用 + 提示"该模板无可用样式"。
- **新建向导**：不变（结构模板维度；其样式集合仅在导出时约束）。
- **CLI `--test-export`**：basedOn 命中结构 → 样式按结构集合解析：`styleTemplate` 字段 ∈ 集合则用，
  否则**回退默认样式**并输出 WARN（与现状"任意按名匹配"收紧为集合校验）。
- **实例 JSON**：`styleTemplate` 字段仅作"期望样式"提示（仍走集合校验）。

### 2.5 运行期防御（透明化，不静默）

- `serializeToInstructions` 增加可选返回 `warnings`（缺失键逐条列出）；
- 导出结果 `ExportDocxResult` 增加 `warnings: string[]`，对话框/状态栏提示
  "部分样式缺失，以下段落已按正文样式输出（N 处）"；
- docx writer 保留骨架校验（加载期已查，运行期双保险仅警告）。

---

## 3. 方案评估

| 关注点 | 结论 |
|---|---|
| 用户"不能任意选" | ✅ 导出集合 = 结构声明的可用集合，越权选择在加载期即被剔除 |
| 1:N 支持 | ✅ `styleTemplates` 数组；默认值分离（styleTemplate） |
| 多结构共享样式 | ✅ 显式声明于各结构的集合中（无隐式通用） |
| "不支持通用" | ✅ 不引入通用机制；需要"通用样式包"即把它声明进各结构集合 |
| 至少 1:1 | ✅ 结构性要求（软校验落地）：无可用样式的结构模板仍可编辑，导出被禁用并提示原因 |
| 旧模板兼容 | ✅ 无 styleTemplates 时回退单元素集合，零迁移 |
| 诊断友好 | ✅ 加载报告 / 模板目录 skipped 明细 / 导出 warnings 三层透出 |

**权衡记录**
- 硬校验选择"剔除+记录"而非"运行期兜底为主"：把问题提前到加载期（可修复、可重装），
  运行期防御只作透明化兜底；
- 关联声明放结构模板 JSON（而非 manifest）：结构 = 内容格式，声明"我需要什么版式组合"语义内聚；
  manifest 保持纯注册表职责；样式包保持"纯资源"可被多结构复用；
- 未来若出现"同结构多默认/按分类切换样式"需求（如 A4/自定义纸型双版式），
  在集合内扩展 `styles: [{fileKey, label, isDefault}]`（对象化），本次先实现数组形态并保留扩展位。

---

## 4. 实施清单（已落地）

1. ✅ **templates 包**：结构模板解析 `styleTemplates` + 兼容回退；`styleCandidatesForStructure(def)`、
   `requiredStyleKeys(structDef)`、配对校验（复用 validateStyleTemplate 骨架校验）；
   加载流程计算候选可用性（软校验，不拒载）；导出相关入口按候选可用性收敛。
2. ✅ **docx 包**：`serializeToInstructions` 增 `warnings` 输出（lookup 空键收集）。
3. ✅ **desktop**：
   - 导出对话框样式下拉改按结构集合（含默认选中与空态禁用）；
   - `ExportDocxResult.warnings` 接入 toast/对话框提示。
   - CLI 按集合校验（不匹配 → 回退默认 + WARN）。
4. ✅ **测试**：配对校验单测（键缺失剔除 / 1:N 可用 / 旧格式回退 / 全部失败不加载）；
   合成测试模板含"键不全的备选样式"与"完整备选样式"两条路径。
5. ✅ **文档**：PLAN-01 §4 模板定义说明已随模板剥离一并更新；本方案归档。
