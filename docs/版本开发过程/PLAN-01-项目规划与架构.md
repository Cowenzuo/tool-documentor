# Documentor 重写 · 项目规划与架构（Node.js + Electron 路线）

> 仓库根：本仓库（全新空仓库）
> 规格基线：旧版 C++/Qt 实现的实测规格 01 到 06（7 份，已通读）
> 决策记录见文末 §9。

---

## 1. 产品定位与目标

> ### ⚠ 定位声明（重要修正）
>
> **Documentor 不是"GJB 438C 编辑器"。** 它的本质是**模板驱动的结构化 DOCX 文档编辑器**：
> 任何可以用 docx 格式化的规范文档，都能通过「结构模板（文档树形状）+
> 样式模板（stylemap + docx 骨架）」组合来编辑与导出。
> GJB 438C 系列（SRS/SDD）只是旧工程随带的内置示例模板，被用作测试案例；
> 未来扩展 = 新增 structure 模板 + 配套 stylemap/骨架，注册进 manifest 即可，无需改代码。
> 因此本重写版所有界面/文档表述均按通用定位书写，438C 仅出现在"内置示例模板"语境中。

### 1.1 总体目标

用 **TypeScript + Electron + React** 重写 documentor——**模板驱动的结构化 DOCX 文档编辑器**
（通用定位；438C 等格式模板不随软件内置——由用户/外部模板目录提供，版权边界见 §8），
**完整复刻现有能力**，同时**重新设计界面**
（不受 Qt 约束，深/浅双主题、现代文档工具观感）。

### 1.2 范围边界（本次决策）

| 内容 | 归属 |
|---|---|
| 文档树模型、8 种内容块、SQLite 工程存储、模板/样式系统、编号系统 | 阶段一：完整复刻 |
| DOCX 纯 OOXML 导出（含 Mermaid 占位段、列表独立编号组） | 阶段一：完整复刻 |
| 欢迎页/主编辑界面/8 种块编辑器/导出/设置/图片预览 — **重新设计** | 阶段一 |
| 深/浅双主题、现代视觉与交互 | 阶段一 |
| 实例 JSON 交换与 `--test-export` 无界面导出 | 阶段一 |
| vsdx OLE 后处理嵌入（embed_vsdx 等价） | **顺延后期** |
| tool-mmd2vsdx 导入/集成 | **最后做**（与上方后处理一起构成"图嵌入交付链路"） |

阶段一产物：DOCX 中 Mermaid 以 `[Mermaid 图表: …]` 占位段存在（与现行为一致），交付链路最后补齐。

---

## 2. 兼容性原则（复刻 ≠ 推倒重来）

1. **工程文件兼容**：`documentor.dproj` 锚点 JSON、SQLite 表结构与 C++ 版一致
   （node / content_block / ui_state），新程序必须能直接打开旧版创建的工程。
   → 用旧版工程的测试工程（documentor.db 与 documentor.dproj）作兼容性回归夹具。
2. **格式语义兼容，模板不外置**：文件格式（dproj/SQLite schema/OOXML 规则）与旧版完全
   兼容；但模板资产（manifest + 结构模板 + 样式骨架）**不随软件分发**（版权考虑）——
   由用户/外部模板目录提供（设置 → 模板目录，manifest 驱动）。本仓库仅含
   resources/test-fixtures/sample-template（自建合成模板，无外部内容，供开发回归）。
3. **实例 JSON 兼容**：`basedOn → styleTemplate → 首模板回退（告警）` 匹配链照旧，UTF-8。
4. **导出等价**：同一骨架 + 同一数据应产生等价 document.xml（编号克隆、
   边框/边距规则与 04/05 文档一致）。
5. 仅在界面、代码形态上自由；文件格式与语义不自由。

---

## 3. 技术架构

### 3.1 进程模型

```
┌─ Electron Main（Node）────────────────────────────┐
│  ProjectStore(better-sqlite3)   TemplateManager     │
│  DocxSerializer → DocxWriter(纯 zip/OOXML)          │
│  Mermaid 渲染服务（可选用页面内渲染）   config 管理   │
│  IPC / contextBridge(preload)                      │
└──────────────▲─────────────────────────────────────┘
               │ IPC（类型化契约，仅 JSON）
┌─ Renderer（React + Vite，浏览器进程）───────────────┐
│  欢迎页 / 主编辑界面 / 8 种块编辑器 / 对话框 / Lightbox │
│  双主题（CSS Variables）  状态管理(UI 层)             │
└────────────────────────────────────────────────────┘
```

- 数据与管线全部在主进程（Node 侧，可直接跑 CLI 测试、无 UI 依赖）。
- 渲染进程不直接碰文件/SQLite，一切经 preload 暴露的类型化 API（如 `window.documentor.*`）。
- **CLI 双入口**：`desktop --test-export <instance.json>` 走与 GUI 完全相同的
  core→templates→docx 管线（headless 可验证），保持旧版 `--test-export` 能力。

### 3.2 Monorepo 结构（pnpm workspaces）

```
tool-rwdoc/
├── pnpm-workspace.yaml
├── packages/
│   ├── core/            # 模型+存储：DocumentTree/Node、ContentBlock×8、
│   │                    #   ProjectStore(SQLite)、实例JSON、编号工具
│   └── templates/       # 模板目录（外部提供，仅用户配置的多目录加载，无内置）
│   └── docx/            # DocxSerializer(树→WriteInstruction)、DocxWriter(指令→OOXML 打包)
├── apps/
│   └── desktop/         # Electron 壳（electron-vite 三段一体）：
│                        #   src/main（窗口/IPC/后续管线宿主）、
│                        #   src/preload（contextBridge 类型化桥）、
│                        #   src/renderer（React+Vite UI，tsconfig.web 独立工程）、
│                        #   src/shared（三段共享 IPC 契约）
├── packages/postprocess/#（后期 M6）OLE/CFB 嵌入、预览；tool-mmd2vsdx 集成点
├── resources/
│   └── test-fixtures/   # 合成回归数据（示例模板/sample-project/样例实例——无外部版权内容）
├── docs/                # 本规划与设计文档
└── scripts/             # 验证/对照脚本（Node，后续替代/镜像旧 Python 诊断）
```

### 3.3 依赖选型

| 用途 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | electron 44（x64 本机） | 已就位：本机缓存离线二进制（44.0.0），版本对齐避免重复下载 |
| 语言 | TypeScript strict | 全程类型化 |
| 渲染 | react 19 + vite 7（electron-vite 5） | electron-vite 三段一体；vite 8 超出其 peer 范围，锁定 7 |
| UI 样式 | CSS Modules + CSS Variables（零 UI 框架依赖起步，设计语言自控） | 深浅主题走 token 层 |
| 存储 | node:sqlite（内建，免 ABI） | **已定稿**（替代 better-sqlite3）：Electron 44/node24 默认可用；测试经 NODE_OPTIONS flag |
| docx 打包 | jszip | 读骨架 zip → 替换 word/document.xml → 按需重写 numbering.xml → 输出 |
| Mermaid | mermaid（npm） | 渲染进程内渲染 PNG/缓存至工程 mermaid/；与旧版 hash 缓存语义一致 |
| 树组件 | 初期原生实现（虚拟化按需再说） | 层级/展开可控性优先 |
| 表格编辑 | 原生 table（自控编辑模型） | 行 0–50 / 列 0–20 |

> 刻意不引入大型组件库：设计语言需要完全自控；8 类块编辑器定制性强，自绘更稳。

---

## 4. 模块职责与关键接口草案

### packages/core
- 类型：`DocumentNode`、`ContentBlock`（8 型判别联合）、`DocumentTree`、工程/实例 JSON 类型。
- `ProjectStore`：open/create/save；node/content_block/ui_state 读写；props_json 序列化。
- 题注文字原样导出：文字里只写标题，编号归样式或题注域，程序不剥离也不改写。口径见 PLAN-07。
- 纯函数、无 I/O 依赖，可单测。

### packages/templates
- `TemplateManager`：模板目录列表（用户配置多个，manifest 驱动，无内置回退；无效目录自动过滤）。
- 结构模板：解析 → 深拷贝实例化（语义与旧版一致：模板树即工程初始树）。
- 样式模板：stylemap 逻辑名→styleId 映射表加载；样式骨架目录定位。

### packages/docx
- `DocxSerializer.serialize(tree, styleTemplate) → WriteInstruction[]`：按 04§5 规则生成指令序列。
- `DocxWriter.write(instructions, styleTemplate, outPath)`：
  - 骨架加载（styles/numbering/settings/theme 等原样）
  - 正文构建（标题样式、表 caption 上/图 caption 下、列表独立 numId 克隆、表格边框 sz=8/4、cellMar 108 dxa、`xmlns:wp` 仅声明一次）
  - 打包输出。
- 编号系统：numId 1/2/4 固定用途；列表组运行时克隆 —— 克隆逻辑需对照骨架 numbering.xml 实测（M4 专项）。

### apps/desktop（main + preload + CLI）
- 工程生命周期（新建向导参数 → create；打开 dproj → load）。
- IPC 契约（类型化，单一 d.ts 供 renderer 消费）：
  `listTemplates / createProject / openProject / saveProject / closeProject /
   getTree/getNode/updateNode/addContentBlock/updateContentBlock/reorder... / exportDocx / settings / dialog(选目录/文件) / mermaid.render` 等（以 renderer 需求收敛）。
- config：默认工程目录、模板目录列表。**存储位置待定**（见 §9 待定项）。

### apps/desktop → src/renderer（React，M0 已落地基础）
- 状态：工程树（只读镜像 + 编辑乐观更新经 IPC 落库），本地 UI 状态（选中/折叠/主题）。
- 编辑模型保留 C++ 语义：**切换节点时 collectEdits 提交**；保存/导出前统一 collect。
- 主题：`ThemeProvider` + CSS 变量双主题（PLAN-02 token 已实现）。

---

## 5. 能力复刻验收矩阵（阶段一 P0）

| # | 能力 | 验收 | 对应规格 |
|---|---|---|---|
| 1 | 启动 → 欢迎页 | 无边框窗口、可主题切换 | 01§1 / 02§1 |
| 2 | 新建工程 | 选工作区/模板/工程名、重名校验、建 dproj+db、模板树入库 | 01§2 |
| 3 | 打开工程 | 读旧版 testproject 工程成功、树全展开、恢复上次选中 | 01§3 |
| 4 | 编辑循环 | 树选中 ↔ 节点编辑；collectEdits 语义；标题改后树刷新 | 01§4 |
| 5 | 8 种内容块 | 增删/上下移/拖拽调高；图片导入复制 uuid 文件；表格行列约束；Mermaid 缓存渲染 | 01§4.1 / 02§5-6 |
| 6 | 节点操作 | 复制(仅 copyable、深拷贝插后)、删除(仅 deletable) | 01§4.2 |
| 7 | 保存 | Ctrl+S；三表落库；props_json | 01§5 |
| 8 | DOCX 导出 | 对话框(样式去重下拉/路径默认)；Serializer+Writer 全规则；对照旧版产物人工抽查 + Word 打开 | 01§6 / 04§5-6 |
| 9 | 设置 | 默认目录/模板目录增删、无效回退 | 01§8 / 02§8 |
| 10 | 图片全屏预览 | Lightbox 滚轮缩放/拖动 | 02§9 |
| 11 | 实例 JSON 导出 | `--test-export` headless 全管线 | 03§3 |
| 12 | 界面重设计 | 双主题、新布局、块编辑器现代交互（详见 PLAN-02） | — |

---

## 6. 里程碑（评审后延长版：P1 增强全量采纳）

> 界面重设计（PLAN-02 定稿）为 M2/M3/M6 的实现基线；每个里程碑结束做旧版对照抽查。

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 骨架** ✅ | pnpm workspace + TS strict + Electron 44 + Vite7/React19 壳、preload 桥、主题切换（深浅双主题 token 层）、无边框自绘标题栏 | **已完成**：typecheck/build 通过；dev 运行自检通过（主题 system⇄dark⇄light 切换、token 色值、IPC 版本桥、组件挂载） |
| **M1 数据层** ✅ | core + templates 全量；SQLite 建/读（含旧 testproject 夹具）；模板实例化 | **已完成**：42+6 单测全绿；打开旧库 41 节点/31 块兼容；模板实例化与旧库一致 |
| **M2 编辑界面** ✅ | 欢迎页（含最近工程）/新建向导/主界面（结构栏+节点页+检查器）；树搜索；8 块编辑器**按 PLAN-02 §4.1 最终交互一次到位**（含 Mermaid 左右分栏、表格就地编辑+键迁移、代码高亮、图片拖拽导入、Lightbox）；collectEdits | **已完成**：主体随 M2 落地，遗留的代码高亮与公式即时预览由 M6 收尾 |
| **M3 存储与设置** ✅ | 保存/恢复选中/设置对话框/config；最近工程列表持久化 | **已完成**：设置对话框双入口、模板目录热重载；保存/恢复选中此前随 M2 落地 |
| **M4 DOCX 导出** ✅ | Serializer/Writer/编号克隆；导出对话框；**与旧版产物对照验证** | **已完成**：docx 包 8 单测、E2E 导出 105 指令/4 克隆组、python XML 校验、与旧交付物同构对照 |
| **M5 实例 JSON + 验证链** ✅ | --test-export；Node 对照/检查脚本（镜像旧 check_* 用途） | **已完成**：core instance 3 单测；CLI 全链路验证（样例实例 15 指令/2 组克隆 + python 断言） |
| **M6 界面收尾** ✅ | 中区预览视图（编辑⇄预览）、主题/对比度/动效走查、可访问性走查、全流程打磨 | **已完成**：静态预览/公式预览/代码高亮全部落地；最终 E2E 全流程回归通过 |
| **M7 图嵌入链路（后期）** ⚠ | 后处理 OLE/CFB 嵌入移植（或调 Python 脚本）+ tool-mmd2vsdx 集成 | **实现已完成，接口待对齐**：上游 2026-09-09 重构致对接失效（静默降级为文本占位）；验收基准不变（交付 docx 双击激活/画布一致）；修复方案见 `docs/PLAN-05-修复方案.md`（P0-1 待执行，门禁已立） |

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| node:sqlite 实验性 API 变化 | 已规避 ABI 双编译；关注 Node 升级行为变化（接口简单，迁移成本低）；如遇破坏再评估 better-sqlite3 |
| OOXML 细节（骨架/编号克隆/命名空间）失准 | 资产零改动复用 + M4 旧版产物 diff 抽查 + Word 实测；脚本化对照 |
| 旧 db schema 有隐含列/约束（模板树存储差异） | M1 先 dump 旧库 schema 与数据样本，按实测定类型，不照文档猜 |
| 中文/路径编码 | 全链路 UTF-8；Node 原生安全；Windows 长路径注意 |
| 界面重设计失控扩张 | PLAN-02 收敛设计 token 与组件清单；P1 项明确标记、不进 M2 阻塞 |
| 8 种块编辑器体验差异大 | 先做文本/表格两类最重的，M2 内部再迭代其余 |
| jszip 对 docx 部件顺序/压缩级别影响 | 保留骨架部件原样条目（compression STORE/DEFLATE 按需），Word 校验打开 |

---

## 8. 资产与模板来源（版权边界）

| 来源 | 是否入本仓库 | 用途/说明 |
|---|---|---|
| 旧版 438C 模板资产（builtin/：manifest+结构+样式骨架） | **否**（仅作为规格/实现参考留在原仓库） | 版权内容剥离分发；新软件不内置模板 |
| 自建合成模板 `resources/test-fixtures/sample-template/` | 是（仅自动化回归） | 单测/E2E 注入使用，无外部版权内容 |
| **本地模板包 `localtest/templates/`** | **否（.gitignore 忽略，本地管理）** | 本地开发/使用的结构与样式模板（自旧仓库复制）；不入库、不随软件分发 |
| 合成样例工程 `sample-project/`（dproj+db） | 是 | 存储兼容回归 |
| （后期）`scripts/embed_vsdx.py、visio_ole.py` 及诊断脚本 | 参考实现 | M7 移植/对照 |
| `docs/NodeJS路线资料/*` | 引用即可（不复制，防双份漂移） | 规格基线 |

> 模板目录由用户通过 设置 → 模板目录 提供（每个目录需含 manifest.json）；
> 软件仅提供文档处理管线。剥离操作会保留在 git 历史中，如需彻底移除历史请另行处理。

---

## 9. 决策记录

已定（用户拍板）：
1. 工程落点 = 本仓库根，空仓起步。
2. 语言 = TypeScript；UI = React + Vite；主题 = 深/浅双主题。
3. vsdx 后处理与 mmd2vsdx 顺延后期；阶段一止于 DOCX 导出（Mermaid 占位）。
4. 主布局 = 结构栏 + 节点文档页 + 检查器（PLAN-02 §2 定稿）。
5. 主色 = C 紫蓝科技（PLAN-02 §3.2/3.3 色板定稿）。
6. PLAN-02 P1 增强项**全量采纳**：树搜索、最近工程、代码高亮、Mermaid 左右分栏、
   表格 Tab/方向键迁移、中区预览视图、Lightbox 缩略图浏览 → 排期并入 M2/M3/M6。
7. **产品定位修正**（§1 声明）：Documentor 是模板驱动的通用 docx 结构化文档编辑器，
   GJB 438C 仅是内置示例模板/测试案例；全部文案按通用定位书写，架构上通过
   structure + stylemap + 骨架扩展新文档格式（模板系统本就数据驱动，无需改代码）。
8. **模板剥离分发（版权决策）**：结构/样式模板不再随软件内置，仅提供处理管线；
   模板由外部目录提供（设置 → 模板目录，manifest 驱动）；仓库内仅保留自建
   合成模板/样例工程供回归（无外部版权内容）；旧版 438C 资产与派生夹具/样例已移除。

待定项结论（已定稿，原 T1–T4 全部闭合）：
- T1 config.json → Electron userData（`%APPDATA%/Documentor/config.json`），字段沿用旧版
  语义（default_project_dir/template_dirs/recents）；模板目录保存即时热重载。
- T2 公式即时预览 → KaTeX（动态 import，display 渲染，错误降级显示）。
- T3 产品名 → app.setName('Documentor')（userData 与窗口标题一致）。
- T4 Mermaid 渲染 → 页面内（懒加载 mermaid 引擎单例 + SVG 预览 + PNG 缓存写盘
  mermaid/<sha16>.png）；CLI 无 UI 渲染需求（导出即占位段，无需渲染）。

## 10. 实施记录

### 模板剥离（版权边界，本次修订）
- 移除 `resources/templates/`（438C 结构/样式资产）与全部 438C 派生数据
  （旧 testproject 工程、db 对照样本、导出样例 docx）。
- 主进程不再内置模板：仅加载 设置 → 模板目录（manifest 驱动）；无模板时
  console 提示并在新建向导展示空态指引。
- CLI `--test-export` 要求外部模板目录（`DOC_TEMPLATES_DIR` 或 `--templates <dir>`）。
- 自建合成模板 `resources/test-fixtures/sample-template/`（含最小 docx 骨架：
  Content_Types/rels/styles/numbering/document）+ 合成样例工程 `sample-project/`；
  全部测试/E2E/CLI 回归改挂合成数据（core 45 / templates 6 / docx 8 单测全绿，
  E2E 含物理点击回归通过）。
- 注意：git 历史仍包含被剥离资产（工作区已删除）；如需彻底清除历史另行处理。

### M0 骨架（完成）
- 仓库骨架落地：pnpm workspace（`apps/*`、`packages/*`）+ TS strict base + 根脚本
  （dev/build/start/typecheck）。
- `apps/desktop` 采用 **electron-vite 三段一体**（main/preload/renderer/shared），
  未拆独立 renderer app —— 与 §3.2 修订后的结构一致。
- 版本定板：electron **44.0.0**（本机缓存离线二进制，避免 GitHub 大文件下载不稳定；
  44 起 npm 包无 postinstall，二进制为首次运行懒下载）、electron-vite 5、vite 7
  （peer 上限）、React 19、TS ~5.9。
- pnpm 11 构建白名单在 `pnpm-workspace.yaml` 的 `allowBuilds`（`electron`/`esbuild: true`）。
- 主进程：无边框窗口（mac hiddenInset 分支）、隐藏默认菜单、窗口控制 IPC、
  最大化状态推送、ready-to-show 防白闪、外链交系统浏览器。
- 渲染层：PLAN-02 token 三件套（common/dark/light）+ 防闪烁引导脚本 +
  ThemeProvider（system/dark/light + localStorage + matchMedia 跟随）、自绘标题栏
  （主题切换 + 最小化/最大化/关闭）、欢迎页（PLAN-02 布局、渐变品牌、双按钮+设置占位）。
- 开发自检：`DOC_M0_DIAG=1` 时主进程注入 DOM 探针（组件挂载/主题切换/色值断言），
  供无头验收复用。

### M1 数据层（完成）
- 资产调研以**实测数据**为准（dump 旧 testproject/documentor.db + 读旧源码语义核对），
  关键事实与规格文档的差异：node.id 为 TEXT（进程内自增数字串，非 int）；
  node 表含 node_type 列（root 专用）；content_block.block_type 为数字字符串 0..7；
  旧库 41 节点/31 块即 SRS 模板深拷贝（模板与 db 完全一致）。
- 回归数据：`resources/test-fixtures/sample-template/`（自建合成模板：manifest + 结构 +
  最小 docx 骨架，无外部版权内容）与 `sample-project/`（合成样例工程）。
- `@documentor/core`：blocks（8 型判别联合 + db props 往返）、tree（DocumentNode/
  DocumentTree 全语义：addChild 校验、deepClone 权限重置、SubTitle 编号链、id 自增）、
  store（ProjectStore：node:sqlite 内建驱动，schema/保存语义对齐旧版）、anchor（dproj
  读写）、captions（stripCaptionNumber）、time（本地 ISO）。42 单测全绿（含旧库兼容）。
- `@documentor/templates`：TemplateManager（manifest 驱动、双 key 样式注册、先加载优先、
  allowedChildLevels 推导、styles.xml styleId 校验）+ instantiate。6 单测全绿。
- **存储选型定稿：node:sqlite**（Electron 44/node24 内建可用；免原生 ABI 双编译；
  测试经 NODE_OPTIONS flag）。决策 T 更新：替代 better-sqlite3。
- **库产物策略定稿**：electron-vite 默认 externalize dependencies → workspace 包
  双条件 exports（require → dist CJS(tsc 编译)；import → src TS(vitest/vite 直用)）；
  库包不设 "type": "module"（dist 为 CJS）。根 dev/build 前自动 build:libs。

### M2a 主进程工程服务（完成）
- shared/project.ts：工程/树/块/对话框/设置 IPC 契约 + DTO + DesktopApi 面。
- 主进程：TemplateManager 装配（仅用户模板目录，无内置兜底；无模板时给出配置指引）、
  ProjectService（create/open/saveAndClose、树变更 node:copy/
  delete/title/description、块 add/remove/move/update、image 导入复制 images/uuid、
  writeProjectFile 路径安全校验、ui_state）、settings（userData config.json 含 recents）、
  ipc.ts 全通道注册（错误统一转 rejection message）；files 读 dataURL 通道（缩略图）。

### M3 设置（完成）
- 设置对话框（欢迎页 + 标题栏双入口）：默认工程目录/模板目录增删 + 浏览；
  保存后主进程**即时重载 TemplateManager**（ProjectService.setManager + template-host 模块化）并 toast 提示。
- 恢复选中（打开工程时按 ui_state.selected_node 选中）、Ctrl+S、退出/切工程自动保存（M2 已含）。

### M4 DOCX 导出（完成）
- `@documentor/docx`：instructions（指令类型 + XML 转义）、serializer（树→指令，全规则
  对齐 C++：heading/subtitle 深度、表题注上/图题注下、题注剥离、列表每块独立组）、
  writer（骨架目录 → numbering 克隆 [styleId→abstractNumId 映射 + 200 起新 id +
  nsid/tmpl 重写] → document.xml 重建 [13 个命名空间单次声明 + sectPr 保留 +
  外 8 内 4 边框 + 左右 108 dxa 边距] → jszip STORE 打包）。8 单测全绿。
- 主进程导出服务（先落库再导出）+ ExportDocx IPC + 另存对话框 + 样式模板默认关联
  工程模板（StructureTemplateDto.styleFileKey）；渲染层导出对话框（DOCX/Markdown 预留禁用）。
- **E2E 验证**：真实 UI 导出 SRS → 105 条指令/4 组克隆，toast 成功；python XML 合法性
  校验（91 段落/14 表/样式分布）通过。
- **与旧版交付物对照**（RG-BJSC-SDD-v3-导出.docx 实测）：克隆 numId 同为 200 起、
  段落样式机制/题注分布同构；Node 版额外完整保留 sectPr（旧版交付物缺失）。
  样例产物存档 resources/test-fixtures/export-sample/srs-export.docx（供 Word 打开验收）。

### M5 实例 JSON 与 CLI（完成）
- core `buildTreeFromInstance`：实例 JSON → 树（对齐旧 main.cpp：heading→文本块、
  mermaid code 取 content、nodeType=subTitle 语义）；3 单测（45 全绿）。
- CLI `apps/desktop/cli/test-export.cjs`（`pnpm cli:test-export -- <instance.json> [out]`）：
  模板匹配链 basedOn → styleTemplate → 首模板（警告）；无参时实例化首模板空树；
  输出默认 cwd/test_output.docx。用样例实例（resources/test-fixtures/instance-sample.json）
  验证：15 条指令/2 克隆组，python 断言题注剥离与表格结构全过；
  产物归档 export-sample/cli-instance-export.docx。

### M6 界面收尾（完成）
- **静态预览视图**：检查器视图切换（受控于 Editor），PreviewPage 以排版感渲染当前节点
  （标题阶梯、正文缩进/行距、表题注上/图题注下且居中、图片/Mermaid/公式实时渲染、
  代码高亮），题注文本剥离（同导出规则）；Lightbox 复用。
- **公式即时预览**：编辑⇄预览切换（KaTeX display 渲染、防抖）。
- **代码语法高亮**：语言 8 项 + 编辑/高亮浏览切换（Prism 子集按需注册、双主题 token）。
  说明：编辑区不采用透明文本 overlay（中文 IME 合成文本不可见风险），改为只读高亮视图。
- Mermaid 渲染引擎抽为共享 util（编辑器分栏/预览/PNG 缓存写盘复用）。
- reduced-motion 全局降级、焦点环、滚动条等可访问细节已具备。
- **最终 E2E 回归通过**：新建 → 41 行树 → 选中/编辑 → 保存 → 导出（105 指令/4 组）→
  预览视图（4 列表项）→ 切回编辑。
- 遗留（发布阶段处理，非功能缺口）：CSP 强化与 electron-builder 打包分发。

### M2b-d 渲染层界面（主体完成）
- 状态层 AppContext：会话/选中/编辑提交（IPC 先行校验→本地镜像生效）、flush 注册表
  （块编辑挂起值在切换/保存/关闭前统一提交，复刻 collectEdits 语义）、Ctrl+S、toast/busy。
- 主界面三区：结构栏（树默认全展开/搜索过滤/右键复制删除按 copyable/deletable）、
  节点文档页（标题行内编辑、徽标、描述、块卡片流、添加块菜单、编辑缓存+防抖提交）、
  检查器（节点元信息/编制说明/视图切换占位/统计）。
- 8 种内容块编辑器基础交互全部落地：文本/图片（缩略图 dataURL、拖拽导入复制
  images/uuid、更换/移除、预览 Lightbox）/表格（就地网格、行列表头编辑、0-50/0-20
  约束、Tab/方向键迁移）/公式/代码（语言 8 项）/Mermaid（左码右图分栏、700ms 防抖
  渲染、失败提示、PNG 缓存写盘 mermaid/<sha16>.png）/两列表（按行编辑，空行过滤语义）。
- 欢迎页全面启用：新建向导（工作区+工程名+模板卡片分类）、打开工程（原生对话框）、
  最近工程列表（userData config recents）；设置按钮仍占位（M3 接入）。
- **E2E 冒烟通过**（DOC_E2E 环境变量驱动真实 DOM）：新建向导→创建→编辑器出现
  （titlebarProject=e2e工程、树 41 行全展开、根标题、选中"标识"块卡片 1）→ 保存 toast
  成功；磁盘产物 dproj + documentor.db 验证正确。
- 待补（登记）：代码块语法高亮、公式块即时预览、M6 预览视图与全界面走查。

### PLAN-05 修复：门禁与合规边界（P0-2/P0-3 完成）
- **背景**：上游 mmd2vsdx 2026-09-09 完成"结构收敛"重构（入口 `dist/app/application.js`
  → `dist/convert.js`，不再导出 `application`），我方 M7 对接随之失效；失败被"假转换器 +
  手写 `.d.ts` + 优雅降级"三重掩盖，直到本次实测才暴露。
- **P0-2 门禁**：`scripts/check-upstream.cjs`（静态契约检查）、
  `packages/docx/tests/mmd2vsdx.contract.test.ts`（`DOC_REAL_MMD=1` 真实链路）、
  根 `verify`（fail-fast）/`verify:local`；锚定记录 `docs/UPSTREAM-mmd2vsdx.md`。
  实测：`verify:local` 绿；上游检查与真实契约测试按预期红灯（P0-1 完成后转绿）。
- **P0-3 合规**：上游新形态把官方 Visio 母版 XML 内嵌进 `dist`（含 MS 版权 Cell），
  分发边界收紧为 **C1（发行包不含 mmd2vsdx）**；`docs/M7-合规说明.md` §2/§3.2/§6/§7 相应改写。

### PLAN-05 修复：打包与安全加固（P1-2 完成）
- **electron-builder 26 接入**（`apps/desktop/electron-builder.yml`，NSIS/免安装两档）；
  发行包按 C1 排除 mmd2vsdx；复用本地 Electron 二进制（`electronDist`）避免重复下载。
- **生产 CSP**：仅构建期注入 `<meta>`；防闪烁内联脚本以 **sha256 哈希**放行（非
  `'unsafe-inline'`）；`file:` 来源显式列入；Mermaid/KaTeX 运行期注入样式故保留
  `style-src 'unsafe-inline'`。
- **sandbox: true**：预加载产物仅 `require('electron')`（contextBridge/ipcRenderer），可安全启用。
- **验证**：`electron-vite preview` 生产产物 E2E 全流程通过（含物理点击重放）；
  `win-unpacked` 打包应用冒烟通过（新建工程/落库/导出）；
  `scripts/verify-package.cjs` 校验 asar：必需项齐全、`mmd2vsdx` 0 条、无开发依赖。
- **遗留**：NSIS 安装包在无 GitHub 网络环境受阻（winCodeSign 下载），需联网环境补跑；
  应用图标与代码签名属发布阶段事项。
