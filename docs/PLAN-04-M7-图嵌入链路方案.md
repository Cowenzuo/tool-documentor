# M7 图嵌入链路实施方案（mmd2vsdx 集成 · 评审稿）

> 状态：**方案评审稿**——用户偏好"把 D:\_dev\tool-mmd2vsdx 的包直接安装过来"（对方已预留导入机制）。
> 目标：Mermaid 图 → VSDX →（预览图）→ OLE 嵌入 docx，产出最终交付文档；纯文件格式操作，不依赖 Word/Visio COM（EMF 预览可选 Visio COM，另有零依赖兜底）。

---

## 1. 上游工具现状（已核实）

`D:\_dev\tool-mmd2vsdx`（纯 Node/TS 版 mmd2vsdx）：

- 包名 `mmd2vsdx`（**private: true 未发布 npm**），ESM 包（type: module），node ≥22.2；
  `main=dist/app/application.js`、`bin=dist/cli.js`、类型齐全（`import { application } from 'mmd2vsdx'` 有完整 TS 类型）；
- **库 API**：`application.convertText(text, options?) → {ok, vsdxBase64, diagramType, pageCount}`；
  `convertFile` / `convertDir` / `serve(HTTP)` / `configureStencils(config?)` / `shutdown()`；
- **模具资产分级供给**（官方母版**不随包**——与我们的版权边界策略一致）：
  | 优先级 | 来源 | 说明 |
  |---|---|---|
  | 1 | `configureStencils({assetFile})` | 预生成资产 JSON（`assets/stencils/stencil-data.json`，646KB），私有分发形态 B |
  | 2 | `configureStencils({stencilDir})` | 官方 .vssx/.vstx 目录，现场提取（形态 A） |
  | 3 | 缺省自动 | **自动搜本机 Visio** 安装目录提取；缓存 `%LOCALAPPDATA%\mmd2vsdx\stencil-data.json` |
  | 4 | `useConnectorMaster=false` | **纯本地内容模式，零资产**（不触发获取），产出的 VSDX 不含官方母版引用 |
- 依赖：mermaid **10.9.8**（固定）+ playwright（渲染需 Chromium `npx playwright install chromium`，本机缓存）；
  渲染单实例串行（幂等 worker），进程内单例，需要时 `shutdown()`；
- 上游 186/199 用例绿（含真实 Chromium 渲染与 16 黄金样本结构等价；**无母版文件的公开环境自动跳过母版类断言**——本机 Visio 或私有方式提供后才全量）。

## 2. 集成方式（选型）

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. pnpm `file:` 依赖（推荐起步）** | desktop `"mmd2vsdx": "file:../../../tool-mmd2vsdx"`（符号链接式） | 文件级共享、上游改码即生效；其 dist 已 build（不依赖 prepare）；pnpm 统一装其依赖到我们 lock | 绑定本机路径；**不可随包分发**（需在分发阶段改用 B/发布） |
| **B. git submodule（vendor 化，推荐长期）** | `git submodule add D:/_dev/tool-mmd2vsdx vendor/mmd2vsdx` + pnpm workspace 纳入 | 版本指针可追踪、可随我们仓库分发（其官方模具资产本就不入上游 git） | 多一步 submodule 管理；并入后其测试/资产进入我们工作树（可 .gitignore 其 tests/assets 不打包） |
| **C. 私有 registry 发布** | 上游 `private:true` 放开为私有 npm 发布 | 最正规 | 需对方发布流程；现阶段不必要 |

> ★ 建议：**A 起步跑通全链路 → B（submodule）固化**；任一方案下**官方模具资产都不入我们仓库**——运行时按上游分级供给（本机 Visio / stencil-dir / 私有 asset 文件）或纯本地模式。

## 3. 端到端管线（在 Documentor 内新增）

```
现有导出: 树 + 样式 → docx（含 [Mermaid 图表: 前60字] 占位段 + figure.caption 题注段）
                              │
             ▼ 用户选择「导出并处理图」/「导出并嵌入」
① Mermaid 收集    按文档树顺序取全部 mermaid 块（caption/code）
② VSDX 转换       application.convertText(code) → vsdx bytes
                  命名 <staging>/vsdx/<NNN>-<图名>.vsdx（NNN=序号）
③ 预览图          EMF（本机 Visio COM，可选）→ <staging>/preview-emf/<同名>.emf
                  PNG 兜底（Chromium 渲染 svg→png，零额外依赖）→ <同名>.png
④ OLE 嵌入        @documentor/postprocess：占位段 → w:object（OLE CFB + 预览图）块
                  按规格 05 §3.3/3.4（vsdx 字节零修改、长度优先 CF 目录排序、
                  CLSID Visio.Drawing.15、w:object 包 w:r 内、段落居中、题注在对象下方）
⑤ 产物            <输出目录>/<stem>-嵌入.docx
```

- **嵌入实现语言**：Node 纯实现（便携、无 Python 依赖）——MS-CFB 写入用 `cfb`(SheetJS) 或按 05 §3.3 规格自研（规格已含目录树排序/CLSID/流名）；OOXML 增补（rels/Content_Types）复用 docx 包 zip 工具；旧 `scripts/embed_vsdx.py` 作为**等价性对照**参考（测试期间对拍）。
- **匹配关系简化**：vsdx 由我们按块顺序生成（命名 `<NNN>-<图名>`），嵌入时按文档顺序与题注双重校验（题注 stripCaptionNumber 后与图名比对），比旧版"题注↔文件名猜测"更稳。

## 4. 界面与配置

- **导出对话框**（图处理组选项）：
  - `仅导出 DOCX`（现状）
  - `导出并转换 VSDX`（含预览图；docx 仍为占位）
  - `导出并嵌入`（最终交付）
- **设置 → 图转换**：stencil 模式（自动本机 Visio / 指定 stencil-dir / asset 文件 / **纯本地模式**）、预览图首选项（EMF 优先 / PNG）、Chromium 状态提示（缺则引导 `npx playwright install chromium`）。
- **IPC**：export:docx-embed 类通道；主进程持有 `application` 单例（串行队列），进程退出 `shutdown()`。
- **CLI**：`--test-export` 保持纯导出（无 UI 渲染）；新增 `--embed [--stencil-dir|--stencil-asset|--no-stencil]` 时走完整管线。

## 5. 前提与风险确认（需用户拍板）

| # | 项 | 现状/风险 | 建议 |
|---|---|---|---|
| 1 | 集成方式 | 见 §2 | **A 起步 + B 固化**（如同意 submodule 化更好） |
| 2 | 本机 Visio | 决定母版与 EMF 质量；旧链路用户机器曾用 Visio（推断已装，**待确认**） | 有 → 缺省自动模式；无 → 纯本地 + PNG 兜底 |
| 3 | Chromium | mmd2vsdx 渲染必需（~120MB 缓存，本机是否已装待确认） | 实施首日验证 `npx playwright install chromium` 状态 |
| 4 | EMF vs PNG | EMF 矢量更佳但依赖本机 Visio COM（Windows 专用脚本移植）；PNG 零依赖但栅格 | **EMF 优先 + PNG 兜底**（默认无需 COM 也能交付） |
| 5 | 打包分发 | file: 依赖不可随包；Chromium/母版为运行前提 | 打包阶段：mmd2vsdx 依赖 B 化 + 文档化运行前提（或随包下载 Chromium） |
| 6 | 水印/格式校验 | 嵌入后 Word 双击激活/画布一致需实测 | 实施末做旧版等价对拍（scripts 诊断脚本参考）+ 人工 Word 验收 |

## 6. 里程碑拆分（建议）

- **M7a 工具集成**：file: 依赖引入 + application 单例服务 + 转换冒烟（含母版/本地两种模式）；
- **M7b VSDX 产出与命名**：② 接入导出链路（选"转换 VSDX"）；交付目录约定；
- **M7c 后处理嵌入**：@documentor/postprocess（CFB/OLE/OOXML）+ 与 embed_vsdx.py 对拍；
- **M7d 界面/配置/CLI**：导出对话框选项、设置项、`--embed`；
- **M7e 交付验证**：全链路 E2E + Word 人工（双击激活/画布一致/移动节点）+ 文档收尾。

---

## 附：外部依赖清单（新增）

| 包 | 用途 | 备注 |
|---|---|---|
| `mmd2vsdx`（file:/submodule） | Mermaid→VSDX | ESM；mermaid10.9.8/playwright 由其包自有依赖树承载（与 UI 的 mermaid 11 互不干扰） |
| `cfb`（候选） | MS-CFB 写入 | 或按 05 §3.3 自研（规格完备） |

---

## 附：实施状态（M7a–M7e 已完成）

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M7a 工具集成 | ✅ | `mmd2vsdx` 以 `link:` 装入 `packages/docx` + `apps/desktop`；动态 `import()` 接入；`convertText` 冒烟（35KB VSDX，自动发现本机 Visio） |
| M7b VSDX 产出与命名 | ✅ | `collectMermaidFigures(tree)`（docx 包，与序列化同构遍历）；暂存 `<staging>/sdd-NNN-<图名>.vsdx` |
| M7c 后处理嵌入 | ✅ | 新包 `@documentor/postprocess`：自研 MS-CFB 写入/解析（`cfb.ts`，无第三方 CFB 库）、OLE 辅助流合成常量（`ole-streams.ts`，**不依赖 Word 样本**）、vsdx 包围盒/页面修补、`w:object` OOXML 嵌入、Visio COM EMF 预览（临时 ps1）。单测 13 例；与旧版 python（visio_ole.py）双向互操作验证通过 |
| M7d 界面/配置/CLI | ✅ | 导出对话框“图表嵌入”三档（文本占位/嵌入/嵌入+EMF 预览）；IPC 类型扩展；CLI `--embed-visio` / `--preview-emf` |
| M7e 交付验证 | ✅ | 两个真 E2E（demo 夹具 1 图、本地 438C SDD 12 图，真实 mmd2vsdx + Visio COM 预览）；**Word 真机打开通过**：12 OLE InlineShape + ProgID=Visio.Drawing.15，0 修复；合规文档 `docs/M7-合规说明.md` |

**验证中发现并修复的 pre-existing 缺陷**（详见 `docs/M7-合规说明.md` §5）：

1. `packages/docx/src/writer.ts`：`mc:Ignorable="w14 w15 wp14"` 未声明 `wp14` → 所有导出被 Word 拒开（已声明修复）；
2. 本地 438C 骨架 `word/styles.xml`：`mc:Ignorable="w14"` 未声明 `w14` → 模板数据补齐（localtest，gitignored）。

**与方案的差异**（实施决策）：

- 匹配改为“槽位对齐”（k↔k）+ 名称一致性诊断（避免旧版“题注↔文件名猜测”的错位）；题注命名用 `stripCaptionNumber` 后为题注，与文档内题注一致；
- **预览所属权修订（讨论定案）**：预览图 = 上游 mmd2vsdx 转换的附带物（`previewBase64`+`previewExt`，或暂存区同名 `.png/.emf`），本工程不再产预览——旧版 Visio COM/EMF 渲染（`preview.ts`/`renderVsdxPreviews`）已删除；未提供预览 → 无预览嵌入（Word 显示图标），不报错；
- 导出对话框移除“文本占位/嵌入/预览”三档用户选择 → 单一路径自动嵌入（mmd2vsdx 不可用自动降级占位 + 警告）；交付文件 = 用户所选路径；
- `useConnectorMaster` 随 `FigurePipelineOptions` 透传（CLI 缺省 true）。
