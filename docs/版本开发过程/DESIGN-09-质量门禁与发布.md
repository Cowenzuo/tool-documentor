# 质量门禁与发布

> 本文写提交与发布要过哪几道关、每道关看住什么、怎么证明做到了，以及这些关口当前有哪些
> 已知的缺口与限制。红线正文在 [项目特定规范.md](../AI开发约定/项目特定规范.md) 第 7 节，
> 本文只列门禁与验证方式，不重复条文。

## 1 三层门禁

门禁按"多久跑一次"分三层，成本与覆盖面依次放大，不要混着用。

| 层 | 什么时候跑 | 命令 | 成本 |
| --- | --- | --- | --- |
| 改完一处 | 每次改完自己动的那块 | `pnpm typecheck` 加一份对应的 `pnpm check:*` | 几秒到一两分钟 |
| 提交/合并 | 收口这个任务 | `pnpm verify` | 分钟级 |
| 发布 | 要出可分发的成品 | `pnpm verify`、`pnpm verify:upstream`、`pnpm verify:package` | 分钟级加打包时间 |

一条贯穿三层的原则：**产品能力不得落在脚本里**。模板校验与必需键推导、锁的判定与写入拒绝、
模板加载、序列化与 OOXML 打包全在 `packages/` 内实现，只靠类型检查、构建与打包产物就能验证。
`scripts/` 与 `localscripts/` 都可以整目录删掉，删掉不影响程序与验收结论。

三层的分工不要越位：

- **别为一次小改动跑整套验收。** 改了一个能力就只跑它那一份自检，顺手带上几秒钟的
  `pnpm typecheck`；`pnpm verify` 留到合并与定版这种节点。库包单测也不在门禁链里，
  它是本机单独跑的一条口径；
- **别让门禁自己短路。** 用 `&&` 串起来的链条，前面一项恒红就会把后面全短路掉，回归整体漏网。
  已知会红但必须留着的检查放最后一项，且不阻断；
- **别用脚本当能力的实现处。** 自检删掉之后产品功能必须完好；要靠脚本才能成立的能力，
  说明它放错了层。

## 2 提交前要跑什么

### 先分清哪些要先构建

四个库包（`core`、`templates`、`postprocess`、`docx`）的 `exports` 里 `import` 条件指向 `src/*.ts`，
`require` 条件指向 `dist/*.js`。**单测走的是 `src`，Electron 主进程走的是 `dist`**，
所以单测全绿不等于应用对，中间靠 `scripts/ensure-libs.cjs` 的指纹保证 `dist` 是新的。

由此定下两条：

- 用 `src` 的那几份（`pnpm test:local`、`check:locks`、`check:terms`、`check:structure`、
  `check:styles`、`check:open`）不要求先构建，它们要么读源码，要么自己把服务编成 CJS 再 require；
- 起真实 Electron 的四份（`check:ui`、`check:open:ui`、`check:terms:ui`、`check:undo`）
  **必须先 `pnpm build`**，它们跑的是 `packages/desktop/out/` 里的产物，没有产物直接报错退出。

`ensure-libs.cjs` 解决的是另一件事：开发版启动时按源码指纹决定要不要重建库，指纹一致就跳过，
省约 4 秒。它的判据是三层：源码文件清单加修改时间与大小的指纹、逐文件「产物是否存在」、
以及源文件与产物逐个比时间。只比时间戳会漏掉删除，只看目录是否存在会漏掉半套产物。
指纹之外还有两处要知道：指纹里不含 `tsconfig.base.json` 与 TypeScript 版本，改这两处要手工跑
`pnpm build:libs:mark` 刷新；而直接跑 `pnpm build:libs`（`pnpm build` 用的是它）**不会**刷新指纹，
之后开发版启动会因指纹不符白重编一次，安全但多余，要跟上指纹就在那之后跑一次 `--mark`。

### 九份能力自检各看住什么

一个能力范畴一份自检，改哪块跑哪块；哪一份红了就说明哪个能力有问题，不把各份拧成一个全量大套件。

- `pnpm check:locks`：结构锁在工程侧的拦与放，走产品写入侧；
- `pnpm check:terms`：权限文案一个权限一个词、旧说法一个不剩，读源码，一秒出结果，不构建；
- `pnpm check:structure`：结构模板编辑的目录快照、新建、读、保存、改名、删除、试跑与迁移；
- `pnpm check:styles`：样式模板编辑的读、写回、导入、改名、删除、试跑与迁移；
- `pnpm check:open`：工程打开，老格式工程的引用认出 uuid、保存补列、悬挂与撞名；
- `pnpm check:ui`：模板编辑界面，真实 Electron 里点一遍；
- `pnpm check:open:ui`：工程打开界面，点「最近打开」进老工程、看状态栏、物理点保存后读回库与锚点；
- `pnpm check:terms:ui`：权限标签、置灰与换类型入口；
- `pnpm check:undo`：撤销，改形状这一步退得回去、保存前后都退得回去，刚打完字就按 `Ctrl+Z`
  也撤得掉。

几处必须守住的口径：自检**走产品自己的服务**，断言的是行为不是规则表，照抄一份规则到脚本里
规则改了脚本还是绿的；期望值必须取自契约本身，文案类断言只在「文案本身就是契约」的地方允许，
且期望值要从 `shared/permissionTerms.ts` 或根 `package.json` 现取；界面自检**同时读界面与库**，
只读界面会被「界面没跟上」骗过去，只读库会漏掉另一种毛病；只对着外部事实断言，
盯自家输出的脚本一律删除、不修。

### 单测

`pnpm test:local` 跑 `localscripts/tests/` 下的单测，覆盖四个库包的 `src`。
带真实上游转换的那条契约测试缺省跳过，要跑得显式给环境变量 `DOC_REAL_MMD=1`，且需要本机
Chromium。**单测不在 `pnpm verify` 里**，它是本机单独跑的一条口径，两条不要混。

### 界面自检怎么起

四份界面自检共用一个驱动 `localscripts/e2e/run.cjs`：它起真实 Electron，让探针在主进程里
用 `executeJavaScript` 驱动渲染层 DOM，用 `fs` 与 `node:sqlite` 直接看磁盘上的锚点与库，
物理点击用 `sendInputEvent` 走命中判定（按钮不存在或灰着就点不动）。

几处约定：

- 隔离：另给一份 `userData` 与一份临时模板目录，不碰你正在用的配置与仓库里的样例；
- 工作区在 `temp/check-ui/`，跑完即清理，加 `--keep` 保留（失败时的截图也在里面）；
- 换夹具与探针用 `--fixture` / `--probe`；起打包好的成品用 `--exe <程序>`，这是"发布版
  真机验收"那条路；多工程连跑放宽时限用 `--timeout <秒>`（缺省 120 秒）；
- 夹具与探针各走各的路：工程打开、权限文案与撤销三条路各用自己的夹具，探针互不牵连。

## 3 发布前要跑什么

### `pnpm verify`

```
pnpm typecheck && pnpm build && node scripts/check-upstream.cjs
```

三项依次跑：全仓 TS strict 检查、构建（先四个库再桌面壳）、最后上游契约检查。
它**不跑测试**，也不依赖 `localscripts/`。

上游检查放在**最后一项且不阻断**是有意的：上游接口漂移是已知会红的预期状态，把它放在首位用
`&&` 串联，会把类型检查与构建一起短路掉，回归整体漏网。所以默认模式发现漂移只打印、退出码
仍为 0。

### `pnpm verify:upstream`

`node scripts/check-upstream.cjs --strict`，同样的检查，漂移以退出码 1 拦住。**发布前跑这个。**

它做的是静态检查：解析 `mmd2vsdx` 的 `package.json`，看包名、入口（`exports["."]` 或 `main`）、
是否声明类型（`types` 或 `exports["."].types`），再读入口文件文本判断有没有导出门面
`convertText` 与 `shutdown`（或旧形态的 `application` 对象承载两者）。它不 import 上游，
所以是毫秒级的。真实转换行为不在门禁里：那要 Chromium 与本机上游目录，手工跑本机 CLI 核对。

### `node scripts/verify-package.cjs`

打包产物校验，读 `release/win-unpacked/resources/app.asar` 的条目清单，看三件事：

| 看什么 | 内容 |
| --- | --- |
| 必需项齐全 | `out/main/index.js`、`out/preload/index.js`、`out/renderer/index.html`，四个库的 `dist/index.js`，以及 `jszip` |
| 禁止项为空 | `mmd2vsdx`（版权边界，见 [DESIGN-07-导出、题注与图嵌入.md](DESIGN-07-导出、题注与图嵌入.md)）、`.map` 源映射、`electron-builder`/`electron-vite`/`typescript`/`vitest` 四个开发依赖、`electron/dist/` |
| 无开发依赖泄漏 | 用 `packages/desktop/package.json` 的 `devDependencies` 逐个比对 asar 顶层包清单 |

失败即以退出码 1 结束，逐条列出问题。它还会打印 asar 条目数、`mmd2vsdx` 条目数（期望 0）
与 asar 体积，加 `--list` 再列出顶层依赖包名。前提是先有解包目录，所以用
**`pnpm verify:package`** 一步到位：先 `package:dir` 再校验。

## 4 Word 回读验收

XML 写对了不等于 Word 认。同一份 XML，Word 解析后的结论和肉眼读 XML 经常不一致，已知三类差异：
元素顺序不对时 Word 静默忽略；样式是继承来的，看定义看不到最终字体；域有缓存值与更新值两态。

**硬要求：改完导出链路，必须用 Word 打开一次产物，确认没有修复提示。** 出现"文件可能已经损坏"
一律当缺陷处理，常见原因是命名空间重复声明、`mc:Ignorable` 里的前缀没声明、多级列表层级越界。

打开之后先看三处：标题编号是否连续、题注编号与章节号是否对得上、图片是否都在。
域要分两步核对：先读一遍缓存值确认正确，再更新全部域读第二遍，确认编号不变且没有错误文本。
第二步能抓出样式名写错导致 `STYLEREF` 解析不到，以及序号重启层级不对。

核对脚本分两类，都在本机 `localscripts/word-checks/`：四个 PowerShell 脚本走 Word COM
回读版式、编号与域、表格与合并、图形与图片段落；`docx-check.cjs` 不开 Word，直接读 zip 给
媒体数、关系数、域数、合并标记与题注样式分布，适合放进自动化。表格有纵向合并时
`Table.Rows.Item(r).Cells` 会直接抛异常，要改用 `Table.Range.Cells` 按 `RowIndex` 分组统计，
这不是产物坏了，是 Word 的集合访问限制。

| 脚本 | 看什么 |
| --- | --- |
| `word-typography.ps1` | 逐样式回读字号、行距、段前后、缩进、对齐与中西文字体 |
| `word-captions.ps1` | 标题编号、题注域、域更新前后对比、错误域统计 |
| `word-tables.ps1` | 表格行列与纵向合并的跨行分布 |
| `word-images.ps1` | 内嵌图形数、图形尺寸、图片段落样式与对齐 |
| `docx-check.cjs` | 不开 Word 读包：媒体、关系、域、合并、题注样式分布 |

写这类脚本有两条本机约定：`.ps1` 里含中文必须存成 UTF-8 带 BOM，否则 PowerShell 5.1
按 ANSI 解码，中文注释变乱码；`.cjs` 从脚本位置往上找仓库根（认 `pnpm-workspace.yaml`），
不写死相对层数。

## 5 本机自检资产不入库意味着什么

`localscripts/` 整个目录被 `.gitignore` 忽略：clone 下来没有它，也不接受提交。
九份能力自检、四份库包单测、E2E 夹具与探针、Word 核对脚本、无界面导出对照与样例工程生成器
都在里面。

这在设计上是可接受的：它们是纯本机辅助，删掉不影响程序功能、构建产物与验收结论。
**但它同时是一个明确的风险**：这些自检是发布门禁的一部分，而这台机器出事就全没了。
换一台机器 `pnpm install` 之后，`pnpm check:*` 与 `pnpm test:local` 一个都跑不起来，
仓库里也没有第二份可克隆的来源。可以做的事是给整个目录做一份仓库外的备份，成本很低。

`scripts/` 是另一回事：那四个脚本随仓库走，clone 就有。

| 关系 | 结论 |
| --- | --- |
| `scripts/` 随仓库走 | clone 就有：一键启动、按需构建库、上游契约检查、产物校验 |
| `localscripts/` 不入库 | clone 没有：九份自检、单测、E2E 与 Word 核对、开发工具 |
| 谁依赖谁 | 脚本可以引用产品代码，产品代码不得引用脚本 |
| 删掉会怎样 | 三个门禁命令不受影响；本机自检与单测全部消失，且无法从仓库恢复 |

因此"提交前要跑什么"这条口径有个容易忽略的前提：**它在一台有 `localscripts/` 的机器上才成立**。
新人接手或换机之后，第一件事应当是确认这个目录还在不在，不在就找维护者要备份。

## 6 红线清单与"怎么证明做到了"

红线正文在 [项目特定规范.md](../AI开发约定/项目特定规范.md)。这里只列每条红线对应的门禁与
证明方式，一句一条。

| 红线 | 怎么证明 |
| --- | --- |
| 导出以样式骨架为底，只重写 `document.xml` 与 `numbering.xml`，其余部件逐字节保留 | 导出后读包逐部件比对；Word 回读无修复提示 |
| 题注段落不得同时挂 `numPr`，也不得被绑到多级列表某一层 | 读产物确认题注段无 `numPr`；Word 里更新域后编号不变、标题计数不被顶高 |
| `ilvl` 只到 0 到 8 | 层级越界时 Word 报文件损坏，回读即拦下 |
| 图片块必须真正嵌入，占位只在文件缺失时兜底 | 导出后 `InlineShapes` 计数与图片块数一致；`word/media` 与关系数三者相符 |
| 图片显示尺寸按骨架 `sectPr` 算，不得写死宽度 | 单测钉住宽高比与 EMU 取值；换骨架页面尺寸后尺寸跟着变 |
| 模板不随软件分发，上游 `mmd2vsdx` 不进发行包 | `pnpm verify:package` 里 `mmd2vsdx` 条目数必须为 0 |
| 改完导出链路必须用 Word 打开一次产物确认没有修复提示 | 见第 4 节 |
| 复制中文名目录不得用 `fs.cpSync` | 本机脚本里整目录复制一律逐文件 `copyFileSync` 递归 |
| 模板能力不得落在脚本里 | `build`、`typecheck`、`verify` 三条链不依赖 `localscripts/` |
| 同一输入两次导出结果一致 | 包内压缩参数固定；列表编号克隆的随机值用时间戳加种子，需按产物逐字节比对 |

## 7 打包产物的已知限制

先看产物在哪：仓库根的 `release/`。配置在 `packages/desktop/electron-builder.yml` 的
`directories.output`，那一项上溯了两级到仓库根，因为 electron-builder 把它解析到 projectDir
上，而 projectDir 取的是进程工作目录，不是配置文件所在目录。打包脚本在 `packages/desktop`
下执行，写裸相对路径会落到 `packages/desktop/release`。

三条产物：`release/win-unpacked/Documentor.exe` 是免安装目录，双击直接跑，也是产物校验的对象；
`release/Documentor-<version>-setup.exe` 是 NSIS 安装包，可选安装目录；
`release/Documentor-<version>-setup.exe.blockmap` 供增量更新，与安装包一起留着。

限制与注意：

- **没有代码签名证书**。安装时 Windows SmartScreen 会提示"未知发布者"，签名是 electron-builder
  的默认自签，不是可信证书；
- **构建期要下 `winCodeSign`**。`pnpm package`（NSIS 安装包）在构建期需要 GitHub 网络，
  没有网络会失败；免安装目录 `pnpm package:dir` 不受影响，两者都复用本地 Electron 二进制、
  不必联网下 Electron 本体；
- **同一个版本号可以重打**，内部版本不对外，重打比加回一个空转的列划算。所以"成品对应哪个提交"
  要以仓库根 `README.md` 与 `release/` 里的实际文件为准，不看版本号；
- **`release/` 里的成品不随开发提交重建**。开发期只做源码、构建产物与门禁验证，重新打包是
  用户明确要求的动作，理由是它是用户当前正在用的软件；
- **每次打包后都要跑一遍产物校验**（`pnpm verify:package`）：必需项、上游条目为 0、
  无 source map 与开发依赖这三条是打包这件事本身的验收。发行边界是**两道**：打包配置
  `packages/desktop/electron-builder.yml` 的 `files` 白名单里就写着排除 `mmd2vsdx`，
  再由这个脚本独立复核产物，不看配置只看结果；
- **应用图标**取 `packages/desktop/build/icon.ico`，靠 electron-builder 默认的 buildResources
  目录生效，配置里不必写 `win.icon`。删掉那个文件就会退回 Electron 默认图标，
  构建日志会提示 `application icon is not set`。

## 8 相关文档

| 主题 | 去哪看 |
| --- | --- |
| 红线条文、验收口径、仓库结构与依赖方向 | [项目特定规范.md](../AI开发约定/项目特定规范.md) |
| 本机脚本与入库脚本的登记、跑法与历史整理 | [03-脚本手册.md](../WORD处理经验/03-脚本手册.md) |
| Word 回读的逐项核对表与取法 | [01-Word实测核对方法.md](../WORD处理经验/01-Word实测核对方法.md) |
| 构建、打包与分发边界的完整说明 | 仓库根 [README.md](../../README.md) |
| 模块划分与依赖方向（门禁要看住的边界） | [DESIGN-01-总体架构与模块.md](DESIGN-01-总体架构与模块.md) |
| 导出门禁与合规边界 | [DESIGN-07-导出、题注与图嵌入.md](DESIGN-07-导出、题注与图嵌入.md) |
| 撤销这份自检验的是什么 | [DESIGN-08-撤销与重做.md](DESIGN-08-撤销与重做.md) |
