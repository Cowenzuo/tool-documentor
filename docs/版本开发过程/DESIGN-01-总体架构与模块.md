# 总体架构与模块

> 本文写工程当前的分块方式：产品是什么、五个包各管什么、依赖朝哪个方向走、
> 主进程与渲染层之间靠什么说话、两类数据各放在哪里、构建产出什么。
> 模板内部的字段与配对规则见 [DESIGN-03-模板体系.md](DESIGN-03-模板体系.md)，
> 界面怎么摆见 [DESIGN-02-界面结构.md](DESIGN-02-界面结构.md)。

## 1 产品定位

**Documentor 是模板驱动的结构化 DOCX 文档编辑器**，不是某一类标准文档的专用编辑器。
任何能用 docx 格式化的规范文档，都由「结构模板 + 样式模板」的组合驱动编辑与导出：
结构模板给文档树的形状，样式模板给版式（一张 stylemap 加一个 docx 骨架）。

由此推出两条硬口径：

- **新增一种文档格式 = 新增一套模板，不改代码。** 模板系统本来就是数据驱动的，
  加载器只认 uuid 与字段，不认识"这是哪种报告"；
- **模板不随软件分发。** 软件只提供处理管线，模板由用户通过 设置 → 模板目录 提供。
  这是版权边界，也是 `release/` 里没有模板、仓库里只有 `samples/` 合成模板的原因。

## 2 技术栈

| 用途 | 选型 | 一句话理由 |
| --- | --- | --- |
| 语言 | TypeScript strict | `tsconfig.base.json` 另开 `noUncheckedIndexedAccess`、`noFallthroughCasesInSwitch` |
| 桌面壳 | Electron 44 | `sandbox: true`、`contextIsolation: true`、无边框自绘标题栏 |
| 界面 | React 19 + Vite 7（electron-vite 5） | 三段一体：main / preload / renderer 由同一份配置产出 |
| 包管理 | pnpm 11 workspace | 构建脚本白名单写在 `pnpm-workspace.yaml` 的 `allowBuilds` |
| 工程存储 | `node:sqlite`（内建） | 免原生模块 ABI 双编译；测试经 `NODE_OPTIONS=--experimental-sqlite` |
| docx 读写 | `jszip` | 读骨架 zip、替换部件、重新打包；不依赖 Office COM |
| 公式/图/代码 | `katex`（动态 import）、`mermaid`、`prismjs` | 都在渲染层用，不影响主进程 |

引擎要求 Node ≥ 22.12、pnpm ≥ 11，写在根 `package.json` 的 `engines` 里。

## 3 五个包与依赖方向

`packages/` 下**不区分 apps 与 libs**：可执行与库只是角色不同，平级放在一起。
每个包的职责与依赖如下（依赖取自各自的 `package.json`）：

| 包 | 职责 | 依赖 |
| --- | --- | --- |
| `@documentor/core` | 文档树与内容块模型（8 种块）、SQLite 工程存储、锚点读写、实例 JSON、表格合并与上限、撤销栈、id 与时间工具 | 无 |
| `@documentor/templates` | 模板身份与目录扫描、引用解析、加载与实例化、逻辑样式键与模板校验 | `core` |
| `@documentor/docx` | 序列化（树 → 写入指令）、OOXML 打包（指令 → docx）、图与对象的嵌入编排 | `core`、`templates`、`postprocess`、`jszip`、`mmd2vsdx`（`link:` 到仓库外） |
| `@documentor/postprocess` | OLE/CFB 复合容器、VSDX 装配、对象段替换 | `jszip` |
| `@documentor/desktop` | Electron 壳与界面：main 持工程与导出管线、preload 做类型化桥、renderer 是 React 界面 | 上面四个 + React/Electron/编辑器依赖 |

依赖方向是硬边界，只有两种合法朝向：

- **可执行 → 库**：`desktop` 可以依赖其余四个，**任何库都不得依赖 `desktop`**；
- **库之间**：`core ← templates ← docx`，另加 `docx → postprocess`。

> 注意 `docx` 依赖 `postprocess` 这一条：`@documentor/docx` 的 `package.json` 里
> `@documentor/postprocess` 是实打实的 workspace 依赖，图嵌入链路（`figure-export.ts`）
> 调的就是它。

这条边界换来的东西很具体：四个库的 devDependencies 只有 `@types/node`，
可以脱离 React 与 Electron 单独构建、单独单测；vitest 挂在仓库根，不在库包里。

每个库内部按主题分文件，一个主题一个文件，出口 `index.ts` 只做转发：

| 包 | 主要文件（`src/`） | 管什么 |
| --- | --- | --- |
| `core` | `tree.ts`、`blocks.ts`、`store.ts`、`anchor.ts` | 文档树语义、8 种块的判别联合与库往返、ProjectStore、`documentor.dproj` |
| | `block-convert.ts`、`table-merge.ts`、`table-limits.ts` | 换类型的搬运规则、纵向合并判定、表格行列上限 |
| | `instance.ts`、`history.ts`、`idgen.ts`、`time.ts`、`mermaid-source.ts` | 实例 JSON、撤销栈、节点 id、时间、流程图源码规范化 |
| `templates` | `identity.ts`、`discover.ts`、`resolve.ts` | 模板身份、目录扫描、引用解析 |
| | `manager.ts`、`types.ts` | 加载与实例化、结构/样式模板的类型 |
| | `validate.ts`、`style-rules.ts`、`style-keys.ts`、`style-match.ts` | 校验、样式键元数据、导入时的映射草稿 |
| `docx` | `serializer.ts`、`instructions.ts`、`writer.ts` | 树 → 写入指令、指令 → OOXML 部件 → 打包 |
| | `figure-export.ts`、`mmd2vsdx.d.ts` | 图与对象的嵌入编排、上游门面的类型声明 |
| `postprocess` | `cfb.ts`、`ole-streams.ts`、`vsdx.ts`、`embed.ts` | OLE 复合容器读写、流、VSDX 装配、对象段替换 |

`desktop` 的分法见上一节与 [DESIGN-02-界面结构.md](DESIGN-02-界面结构.md)：
`src/main/`（服务与 IPC 注册）、`src/preload/`、`src/renderer/src/`（pages / components /
state / theme / styles / utils）、`src/shared/`。

## 4 主进程 / 预加载 / 渲染层

三段的分工与互相看得见什么：

| 层 | 位置 | 能做什么 | 不能做什么 |
| --- | --- | --- | --- |
| main（Node） | `packages/desktop/src/main/` | 窗口与生命周期、IPC 注册、持权威文档树与 SQLite、跑导出管线、读写模板目录与配置文件 | 不碰 DOM |
| preload | `src/preload/index.ts` | 只 `require('electron')`，用 `contextBridge` 暴露 `window.documentor` | 不写业务逻辑 |
| renderer | `src/renderer/` | React 界面；持文档树的只读镜像 + 本地 UI 状态 | 不直接碰文件与 SQLite |
| shared | `src/shared/` | 三端共享的 IPC 契约与 DTO | 不含实现 |

主进程侧的四个服务各自单一：

- `services/project-service.ts`：工程生命周期（新建/打开/保存/关闭）、树与块的全部变更、
  图片导入、ui_state、导出。**变更的唯一权威**；
- `services/template-editor-service.ts`：模板目录里的文件读写，按 uuid 定位，
  不依赖数据库（详见 [DESIGN-03-模板体系.md](DESIGN-03-模板体系.md)）；
- `services/template-host.ts`：装配 `TemplateManager`，只加载设置里的模板目录，产出加载报告；
- `services/config.ts`：`userData/config.json` 的读写与最近工程列表。

> 分层的一条实际约束：`template-editor-service.ts` **不 import electron**，
> 模板目录列表与应用数据目录由 `ipc.ts` 注进去。于是它能被本机单测直接跑，
> 不必起应用。

## 5 IPC 的约定

**通道名与 DTO 只有一份来源**：`packages/desktop/src/shared/project.ts` 的 `ProjectIpc`
（工程域）与 `shared/contract.ts` 的 `IPC`（窗口域）。渲染层不许自己拼字符串。

约定逐条：

- **命名是 `<域>:<动作>`**：`project:open`、`node:update-title`、`block:add`、
  `image:import`、`ui-state:save`、`templates:list-styles`、`template:save-style`、`export:docx` 等；
- **请求—应答一律 `ipcMain.handle` / `invoke`**，返回值是**局部结果**而不是整棵树
  （例如 `block:add` 回该节点的新块数，`node:copy` 回新子树与插入位置）；
- **只有窗口控制是单向的**：`window:minimize`、`window:toggle-maximize`、`window:close`
  走 `ipcMain.on`，不需要回执；
- **主进程 → 渲染层只有一条推送**：`window:maximized-changed`，用于标题栏切最大化图标；
- **错误统一转成 rejection 的 message**。`ipc.ts` 的 `handle()` 把 handler 抛出的任何错误
  包成一个 `Error`，渲染层用 `utils/errorText.ts` 取出文案直接展示，不另做错误码；
- **渲染层可见的 API 面**收在 `DesktopApi`：`window` / `project` / `tree` / `block` /
  `history` / `uiState` / `dialog` / `export` / `settings` / `templates` /
  `templateEditor` / `files` 十二组，每组的类型也在 `shared/project.ts`。

按域列一遍通道名，改动时照这个分组找：

| 域 | 通道 |
| --- | --- |
| 应用与窗口 | `app:get-info`、`window:minimize`、`window:toggle-maximize`、`window:close`、`window:is-maximized`、`window:maximized-changed` |
| 工程 | `project:create`、`project:open`、`project:close`、`project:save`、`project:get-info`、`project:is-open`、`project:reveal-folder`、`project:page-text-width`、`project:precheck` |
| 树与历史 | `tree:get-root`、`node:update-title`、`node:update-description`、`node:copy`、`node:delete`、`history:undo`、`history:redo`、`history:state`、`history:jump` |
| 内容块 | `block:add`、`block:remove`、`block:move`、`block:update`、`image:import`、`file:write-bytes`、`file:read-data-url` |
| 界面状态与对话框 | `ui-state:save`、`ui-state:load`、`dialog:select-dproj`、`dialog:select-directory`、`dialog:select-image`、`dialog:select-docx`、`dialog:save-path` |
| 设置与模板查询 | `settings:get`、`settings:set`、`templates:list-structures`、`templates:list-styles`、`templates:style-options`、`templates:diagnose` |
| 模板编辑 | `template:snapshot`、`template:read`、`template:save`、`template:create`、`template:delete`、`template:rename`、`template:read-style`、`template:save-style`、`template:import-style`、`template:rename-style`、`template:delete-style`、`template:trial-run`、`template:migrate` |
| 导出 | `export:docx`、`export:figure-counts` |

数据流的模型是「**main 权威 + renderer 镜像**」：渲染层先 IPC，主进程校验成功后再本地生效；
界面上待提交的编辑（标题、编制说明、内容块）由页面自己攒着，切换、保存、撤销前统一
`flushAll()` 提交，语义等价于旧版的 `collectEdits`。这条顺序与撤销的关系见
[DESIGN-08-撤销与重做.md](DESIGN-08-撤销与重做.md)。

## 6 两类数据放哪

**工程数据**放在 `documentor.dproj` 所在的那个目录里，固定四样：

```
<工程目录>/
├── documentor.dproj    锚点 JSON：记录工程名、库文件名、模板引用
├── documentor.db       SQLite 工程库（node 表 / content_block 表 / ui_state 表）
├── images/             导入的图片，文件名是 uuid
└── mermaid/            流程图渲染出来的 PNG 缓存，文件名是 sha16
```

库里的引用一律是相对工程目录的路径。表结构与锚点字段的逐列职责见
[DESIGN-04-工程数据与存储.md](DESIGN-04-工程数据与存储.md)。

**模板数据**不在本仓库，也不在工程目录里，由用户在设置里指定一个或多个模板目录；
每个模板目录下固定两个子目录 `structures/` 与 `styles/`，里面**一层 uuid 目录一层
`<uuid>.json`**，没有清单文件。字段与目录组织见
[DESIGN-03-模板体系.md](DESIGN-03-模板体系.md)。

**应用配置**在 Electron 的 userData 目录：`%APPDATA%/Documentor/config.json`，
字段是 `default_project_dir`、`template_dirs`、`recents`（应用名在 ready 之前
`app.setName('Documentor')` 定下，否则配置目录会落到默认名上）。
主题偏好不走 config，走渲染层的 `localStorage`（键 `doc-theme`）。

**按工程记的界面状态**（选中章节、树的展开集合、上次用的视图）走主进程的
`ui-state:save` / `ui-state:load`，落进工程库的 `ui_state` 表——换工程就换一份。
栏宽这类与工程无关的偏好走 `localStorage`（`layout.treeWidth`、
`layout.templateListWidth`、`layout.templateTreeWidth`、`layout.templateListPaneSplit`）。

配模板目录时最容易踩的一脚：**目录要选到模板仓库的 `packages/` 那一层**
（`structures/` 与 `styles/` 在那里），不是仓库根。配错一层不会报错，
加载器只是静默跳过该目录，界面上一片空白；设置对话框里每个目录就地显示加载结果，
就是为了让这件事当场可见，而不是让人对着空白猜。加载报告的口径见
[DESIGN-03-模板体系.md](DESIGN-03-模板体系.md)。

## 7 构建与产物

```
pnpm dev            # ensure-libs 指纹检查 → electron-vite dev（渲染层 HMR）
pnpm typecheck      # pnpm -r typecheck：五个包各跑一次 tsc --noEmit
pnpm build          # build:libs（core→templates→postprocess→docx，tsc 出 dist）
                    #   + desktop 的 electron-vite build
pnpm package:dir    # build 后 electron-builder --dir → release/win-unpacked/
pnpm package        # build 后 electron-builder --win → release/Documentor-<版本>-setup.exe
pnpm verify         # typecheck + build + 上游契约检查（报告模式，不阻断）
pnpm verify:upstream # 上游契约检查的严格模式，漂移即退出码 1
```

**库包双条件导出**是这里最容易踩的一处：四个库的 `exports` 把 `import` 指向 `src/*.ts`、
把 `require` 指向 `dist/*.js`。vitest 与 vite 走前者（直接读源码），
Electron 主进程运行期走后者（读 `tsc` 产物）。所以**单测全绿不等于应用跑的是同一份代码**，
中间靠 `scripts/ensure-libs.cjs` 的源码指纹保证 `dist` 是新的。改动 `exports`、
`tsconfig.build.json` 或产物目录之后，要在 `require` 路径上手工验一遍。

**两个产物目录别混**：

| 目录 | 是什么 | 能不能直接跑 |
| --- | --- | --- |
| `packages/desktop/out/` | electron-vite 的构建中间产物（main / preload / renderer 三份） | ❌ 只有源码产物，`pnpm start` 跑的是它 |
| `release/`（仓库根） | electron-builder 打出的可分发成品 | ✅ 免安装目录里的 `Documentor.exe` 双击就跑 |

`release/` 的落点写在 `packages/desktop/electron-builder.yml` 的 `directories.output: ../../release`。
这里必须显式上溯两级：electron-builder 把配置里的相对路径解析到 projectDir，
而 projectDir 取的是**进程工作目录**，不是配置文件所在目录——打包脚本在
`packages/desktop` 下执行，写裸相对路径会落到 `packages/desktop/release`。
同理不要从仓库根以外的目录直接调 electron-builder。

**打包与安全的几条现状**：发行包用 asar，`files` 里显式排除 `mmd2vsdx`
（版权边界见 [DESIGN-07-导出、题注与图嵌入.md](DESIGN-07-导出、题注与图嵌入.md)）；
生产 CSP 在构建期注入 `<meta>`，防闪烁那段内联脚本按 **sha256 哈希**放行而不是
`'unsafe-inline'`，且算哈希前要把换行归一成 LF（Chromium 比对前自己会归一，
按 CRLF 算出来的哈希永远对不上，那段脚本会被拦掉）；应用图标取
`packages/desktop/build/icon.ico`。质量门禁与发布口径见
[DESIGN-09-质量门禁与发布.md](DESIGN-09-质量门禁与发布.md)。

## 8 怎么起应用

仓库提供两种启动方式，**默认起的是发布版**，这一点容易记反：

```
node scripts/start-documentor.cjs          # 默认：跑 release/win-unpacked/Documentor.exe，秒开
node scripts/start-documentor.cjs --dev    # 开发版：先按指纹构建库，再起 electron-vite dev
```

`start-documentor.cmd` 与它同效。仓库根放一个空的 `.dev-mode` 标记文件也能把默认切到开发版，
但**这个标记只被 `scripts/start-documentor.cjs` 读**：安装包建出来的快捷方式起的是装好的
`Documentor.exe`，不读它。共享机器上留着 `.dev-mode`，别人从仓库这边启动也会跑到开发版，
还要现编库多等十几秒，开发完记得删。

开发版路径会跑 `scripts/ensure-libs.cjs`：按源码内容指纹决定四个库要不要重编，
省掉大约四秒的固定开销。手工跑过 `pnpm build:libs` 之后要用 `pnpm build:libs:mark`
刷新指纹，否则下次启动会白重编一遍。指纹一致时仍会逐文件检查 `dist` 产物是否存在，
缺文件照样重建。

界面自检、导出对照、打包调试产生的临时文件一律放仓库根 `temp/`（已 gitignore），
不写系统临时目录。

## 9 红线

- **依赖方向**：库不得依赖 `desktop`，库不得 import electron 与任何 UI 库。
  破这条，四个库就再也不能脱离界面单独构建与单测；
- **产品能力不得落在脚本里**。模板校验、锁的判定、模板加载、序列化与 OOXML 打包
  全部在 `packages/` 内实现；`scripts/` 与 `localscripts/` 整目录删掉，
  程序的功能、构建产物与验收结论都不受影响；
- **脚本可以引用产品代码，产品代码不得引用脚本**。`build`、`typecheck`、`verify`
  三条链不依赖 `localscripts/`；
- **模板与上游 mmd2vsdx 都不进发行包**，这是合规红线，不是可选项；
- **`release/` 里的成品不随开发提交重建**。它是用户当前在用的软件，
  重新打包是用户明确要求的动作；
- **注释以中文为主，内部诊断日志带模块前缀**（`[templates]`、`[renderer:csp]`、
  `[lifecycle]`、`[security]`），方便在控制台里按来源过滤。
