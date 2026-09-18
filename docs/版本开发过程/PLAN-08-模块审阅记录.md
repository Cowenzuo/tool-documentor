# PLAN-08 模块审阅记录

> 这份文档记一次全仓审阅。审阅对象是五个模块包加整体打包链路，每个对象由一名独立审阅者
> 通读实现后上报，主对话逐条复核关键结论并作判定。
> 判定分三档：必修、应修、不改。本文只记发现与判定，改动另起提交。
> 审阅基准提交 `d59a059`，时间 2026-09-18。

## 1 审阅怎么做的

审阅拆成六个对象：`packages/core` 文档模型与工程存储、`packages/templates` 模板加载与校验、
`packages/docx` 序列化与 OOXML 打包、`packages/postprocess` OLE 容器与 VSDX 装配、
`packages/desktop` Electron 宿主与界面，以及跨模块的整体打包与构建链路。

每个对象一名审阅者。约束是只读：不改文件、不做 git 操作、不重新打包、不启动应用。
允许读产物，比如 asar 索引、exe 版本信息、`release/` 里的现成文件。

主对话负责复核和判定。本文写成"必修"的条目，都由主对话自己再跑一遍或再读一遍源码确认，
不采信转述。复核手段按对象不同，读源码行号、用 Node 在内存里跑真函数、直接跑现成脚本看退出码。
docx 与打包两块条目最多，复核时逐条对过行号。

## 2 结论摘要

一句话结论：没有发现"一打开就错"的缺陷，但存在几条会静默丢数据的路径，还有一条门禁链条
自己短路，会让回归整体漏网。

必修 8 条，都在第 3 节；应修 9 条，在第 4 节；门禁与文档连带项 6 条，在第 5 节；
判定不改或只改注释的，在第 6 节。

三条共性根因值得单独记下来，因为后面的条目大多能归到其中一条：

第一，**元数据可以小于真实数据，读取侧却拿它当上界**。表格的 `rows`、`cols` 都是提示性
元数据，界面按真实数据渲染，导出侧历史上拿它们当循环上界，于是元数据偏小就静默丢行或丢列。
`rows` 那条上一轮已经修掉，同一处 `cols` 还没修，这就是必修第 2 条。

第二，**测试跑 `src`，运行时 `require` 的是 `dist`**。四个库包的 `exports` 里
`import` 条件指向 `.ts` 源文件，`require` 条件指向 `dist/*.js`，测试走前者、Electron 主进程走后者。
单测全绿不等于应用对，中间只靠 `scripts/ensure-libs.cjs` 的指纹保证 `dist` 是新的。

第三，**门禁自己短路或漏检**。`pnpm verify` 第一步就恒红并中断，后面三项一个都不跑；
按需构建的指纹一致就早返回，产物缺文件也不重建；E2E 既不构建也不测打包产物。

## 3 必修：会静默丢数据，或让工程与产物不可用

| 编号 | 位置 | 现象 | 复核结果 |
| --- | --- | --- | --- |
| M1 | `packages/core/src/blocks.ts:178-180`、`packages/core/src/blocks.ts:21-23` | 未知内容块类型被写成 `-1` 入库，重新打开工程时抛错，工程从此打不开 | 亲测：`createBlock('video')` 得 `blockTypeIndex` 为 `-1`，重新加载抛「未知内容块类型: -1」 |
| M2 | `packages/docx/src/writer.ts:542` | 表格列上界取 `block.cols`，而 `cols` 缺失时为 `0`，一行四列的数据导出成只有一列 | 亲测源码：行上界已改成只认 `data.length`，列没改；模板 `manager.ts:488` 与实例 `instance.ts:95` 都允许 `cols` 为 `0` |
| M3 | `packages/docx/src/instructions.ts:64-77` | XML 1.0 非法控制字符原样写进 `<w:t>`，`document.xml` 非良构，Word 打不开整份文档 | 亲测源码：两个转义函数只处理 `& < >`，不处理 `\u0000` 到 `\u001F` |
| M4 | `packages/desktop/src/renderer/src/components/editor/BlockEditors.tsx:83,85` | 导入图片时写文件用 `images/<name>`，记录到块的 `imagePath` 却是裸文件名，读侧一律按工程目录相对路径解析 | 亲测源码：两个消费者的路径拼法都带 `images/`；导出侧解析不到就降级成 `[图片: pic.png]` 占位 |
| M5 | `packages/docx/src/writer.ts:324-337`、`packages/docx/src/writer.ts:340-363` | 导入对话框允许 `webp/svg/bmp/emf`，导出侧 `webp/svg` 声明成 `application/octet-stream`，其它未识别格式一律按 `800×520` 渲染 | 亲测：`ipc.ts:157` 允许八种扩展名，`imageMime` 无 webp/svg 分支，`imageSizePx` 兜底值固定，宽高比被强制成 1.538 |
| M6 | `packages/desktop/src/renderer/src/state/AppContext.tsx:199-327`、`packages/desktop/src/renderer/src/components/editor/NodePage.tsx:98,130` | 八处写操作在 `await` 前取会话快照，回来后用旧快照回写整棵状态树，重叠提交时后一次覆盖前一次；调用侧又是 `void` 不等待，重叠是常态 | 亲测源码：`guardSession()` 在 `await` 之前，`setSession({ ...s, ... })` 在之后；界面回退成旧值后下一次保存会把旧值写回库 |
| M7 | `packages/desktop/src/main/services/project-service.ts:162-171` | 保存并关闭工程时，保存抛错只 `console.error`，接着照样关闭，用户以为已保存 | 亲测源码：`catch` 里只有一行日志，`closeProject()` 在 `try` 之外；调用点是 `ipc.ts:75` 与 `main/index.ts:327` |
| M8 | `packages/core/src/store.ts:164-174` | 根节点入库只写 `id` 与 `title`，根上的内容块和描述在保存时静默丢失 | 亲测：保存前根节点 1 个内容块，重新打开后为 0；界面可从树面板的根节点行走到这个位置 |

## 4 应修：契约、边界与产物合规

| 编号 | 位置 | 现象 | 判定理由 |
| --- | --- | --- | --- |
| S1 | `packages/core/src/table-merge.ts`、`BlockEditors.tsx:197-216` | 显式跨度 `rowSpans` 陈旧或越界时不回落到兼容判定，缩表后跨度原样透传，合并位置错乱或消失 | 与 M2 同源，改了 M2 之后这里的错位更容易被看见 |
| S2 | `packages/templates/src/manager.ts:235-245` | 结构去重用 manifest 的 `name`，注册用 JSON 里的 `name`，两者不一致时静默替换，"先加载的优先"不成立 | 两份作者文档对键的说法互相矛盾，得先定口径再改代码 |
| S3 | `packages/templates/src/manager.ts:491`、`manager.ts:235-245` | 模板块的 `mergeVertical` 声明从不被解析，模板里写了纵向合并的表格实例化后一个都没带上 | 亲测：同一模板实例化后 `mergeVertical` 从 10 个变 0 个 |
| S4 | `packages/templates/src/manager.ts:98-105` | 模板 JSON 解析失败返回 `null`，上报里的 `skipped` 仍是空数组，用户看到"加载成功"但少了东西 | 静默跳过与"加载报告"的承诺相反 |
| S5 | `packages/postprocess/src/cfb.ts:105,193,213,233-240` | miniFAT 未使用槽写 `0` 而非 `FREESECT`；`DIFAT` 没有 `nFat > 109` 的守卫 | 亲测：同样是未使用槽，FAT 写 `FREE x78`，miniFAT 是 `ZERO x124`。DIFAT 溢出阈值对应约 7 MB 的嵌入对象，超过就静默产出非法容器 |
| S6 | `packages/core/src/captions.ts:7` | 题注手写序号剥离只认 ASCII 数字，全角数字剥不掉 | 中文输入法下顺手打出全角数字很常见，表现为题注编号重复 |
| S7 | `packages/docx/src/writer.ts:88-94,158-171` | 骨架缺 `word/_rels/document.xml.rels` 时不补 styles 与 numbering 关系，这两个部件成孤儿 | 四套真实样式模板都自带该部件，只有样例骨架没有；风险落在自定义模板上，且模板校验也不查这一项 |
| S8 | `packages/docx/src/serializer.ts:211-219` | 图表降级时占位段只取源码前 60 字符，提示文案却说"以文本形式导出" | 实测 261 字符的源码只留 74 字符，切在半截 token 上，尾部丢失 |
| S9 | `packages/docx/src/serializer.ts:113-125` | 题注章节号在缺层、副标题、无标题前置三种情况下算出 `4.0`、`..1` 或空串 | 实测复现；域更新后又跳变，用户会看到"表4.0-1"这类编号 |

## 5 门禁与文档连带项

| 编号 | 位置 | 现象 | 建议 |
| --- | --- | --- | --- |
| G1 | `package.json:27`、`scripts/check-upstream.cjs:133` | `pnpm verify` 第一步返回退出码 1，`&&` 串起来的类型检查、全量单测、构建一个都不跑 | 亲测 `node scripts/check-upstream.cjs` 退出码为 1，脚本自己说"红为预期状态"。建议把这一项移到链条末尾，或改成只报告不阻断 |
| G2 | `packages/core/package.json:7-12`，其余三包同形 | `exports` 的 `import` 指向 `src/*.ts`，`require` 指向 `dist/*.js`，19 个测试文件全测 `src` | 补一条跑 `dist` 的产物级往返测试，或把这条风险写进项目特定规范 |
| G3 | `scripts/ensure-libs.cjs:130` | 指纹一致就直接返回，逐个产物存在性检查在决策上不可达 | 指纹里 `dist` 只记目录是否存在；删掉或损坏单个产物后，开发启动会打印"跳过构建"并继续 |
| G4 | `scripts/e2e-smoke.cjs:53,108` | E2E 跑的是工作树里的 `out/`，不构建也不碰打包产物，断言只有 3 项，探针产出的 20 多个字段基本没验 | 至少补导出、预览、设置三项断言；发布前另加一条针对 `release/win-unpacked` 的最小启动冒烟 |
| G5 | `scripts/e2e-smoke.cjs:73,103-116` | 一键清理没杀干净，本轮实测留下 dev 模式 Electron 进程存活十几分钟，并锁住临时工程数据库 | 本轮已手工杀进程并清掉 `temp/`。脚本的收尾需要覆盖整棵进程树，临时工程目录也要自清 |
| G6 | `docs/AI开发约定/项目特定规范.md:96` 等多处 | 文档与现实不符：写"五包单测"但 `desktop` 没有测试脚本；`.dev-mode` 的影响面被说成包含安装包快捷方式；`electron-builder.yml` 的路径基准注释写成配置文件所在目录，实际是进程工作目录；`ensure-libs.cjs` 头注释说构建配置不进指纹，实现里进了 | 按实际口径订正，并在 `verify:local` 与 `verify` 的区别上写清楚 |

## 6 判定不改，或只改注释

| 项 | 位置 | 判定 |
| --- | --- | --- |
| `previewFromStaging` 生产路径不可达，`Slot.previewExt` 的 `jpg` 分支从未赋值 | `packages/docx/src/figure-export.ts:170-184,92` | 不改代码。它是给测试注入用的钩子，删了会掉测试覆盖，加一行注释说明即可 |
| `gen-sample-project.cjs` 是孤儿脚本 | `packages/desktop/scripts/gen-sample-project.cjs` | 暂留。它是造样例工程的工具，写进文档比删掉更有用 |
| `FALLBACK_MEDIA_BOX` 注释写"A4 加一英寸边距"，数值实际不是 A4 正文区 | `packages/docx/src/writer.ts` | 只改注释 |
| `start-documentor.cmd` 是 GBK 无 BOM | 仓库根 | 本机正常，中文 Windows 之外才会乱码，暂不改 |
| `ensure-libs.cjs` 日志把"元数据变了"说成"产物落后于源码" | `scripts/ensure-libs.cjs:139` | 只改文案，改成按源码内容指纹口径描述 |
| 发行包 manifest 里仍声明 `link:` 依赖 | `packages/desktop/package.json:23` | 低优先。运行期无害，打包阶段剔除更干净 |
| `pnpm build` 走不刷指纹的 `build:libs`，下一次开发启动必白编一次 | `package.json:16,20` | 顺手改。把 `build` 换成 `build:libs:mark` 即可 |

## 7 本轮附带清理

审阅期间产生的临时验证脚本与 E2E 残留已删除：`temp/verify-b3.cjs`、`temp/e2e-*/`，
以及一个从 E2E 冒烟里漏下来的 dev 模式 Electron 进程树。`git status` 为空。

## 8 后续

改动范围由用户裁定：**必修 8 条加门禁 3 条**。应修 9 条与文档连带项暂缓，
需要时从第 4、5 节取。

## 9 本轮执行情况

必修 8 条与门禁 3 条已全部执行，另附同一根因上的两处小修。

| 编号 | 落实方式 | 回归 |
| --- | --- | --- |
| M1 | `blockTypeIndex` 与 `createBlock` 对枚举外类型直接抛错；新增 `parseBlockType` 做宽松解析，读库遇到无法识别的 `block_type` 只跳过该块并记警告；打开工程时把警告弹给用户 | core `blocks.test.ts`、`store.test.ts` 新增 5 条 |
| M2 | 列数改为取「表头长度、每行长度、`cols`」的最大值，与行同一口径；参差行补齐到列数，行内单元格数与 `tblGrid` 一致 | docx `writer.test.ts` 新增 2 条 |
| M3 | 转义前先剔除 XML 1.0 不允许的码位，制表、换行、回车保留 | docx `writer.test.ts` 新增 1 条 |
| M4 | 导入图片时块的 `imagePath` 记为 `images/uuid.ext`；读侧对只记文件名的历史数据回落一次 `images/` 查找 | docx `writer.test.ts` 新增 1 条覆盖回落；界面侧由类型检查与 E2E 冒烟覆盖 |
| M5 | `imageMime` 补 WebP 与 SVG；`imageSizePx` 补 BMP、WebP、SVG、EMF 四种文件头解析，导入对话框放行的八种格式都能读出真实尺寸 | docx `writer.test.ts` 新增 1 条，四种格式各验一次宽高比 |
| M6 | 会话状态改用函数式更新，写操作不再拿 `await` 之前的快照回写整棵树 | 类型检查加 E2E 冒烟 |
| M7 | `saveAndCloseProject` 返回结果，保存失败就不关闭：关窗路径弹对话框由用户选，切换工程路径把错误抛回界面 | 类型检查加 E2E 冒烟 |
| M8 | 根节点的描述与内容块随保存落库，读取时一并读回 | core `store.test.ts` 新增 1 条 |
| G1 | 上游检查改报告模式，默认退出码 0，移到 `pnpm verify` 收尾；新增 `pnpm verify:upstream` 走严格模式 | 两种模式各跑一次，退出码分别为 0 与 1 |
| G3 | 指纹一致时补一道「逐文件产物是否存在」检查，缺失即重建 | 删掉一个 `dist` 文件后跑 `ensure:libs`，确认自动重建 |
| G4 | `pnpm e2e` 先构建；断言从 3 项扩到 11 项，并等物理点击结果一并判定；探针失败早退；补进程树与工作区清理 | `pnpm e2e` 全绿 |

测试总数从 144 通过加 1 跳过变为 **154 通过加 1 跳过**，本次新增 10 条。
`docs/AI开发约定/项目特定规范.md`、`docs/WORD解压结构研究/表格与合并.md`、
`docs/WORD解压结构研究/图片与对象嵌入.md`、`docs/WORD处理经验/03-脚本手册.md`、
`docs/待讨论功能备忘.md`、`docs/版本开发过程/UPSTREAM-mmd2vsdx.md` 与仓库根
`README.md` 已按新口径同步。

## 10 仍未处理

- **发布版未重建，也不该由开发提交去重建**：`release/` 里仍是基准提交 `dd032b8` 的产物，
  本轮修复没进发布版。这是有意为之，用户当前在用那个版本改数据，重新打包只在用户
  明确要求时做。届时发布版会一次性带上 M4 的图片路径与 M7 的静默关闭等修复；
- 应修 9 条（S1 到 S9）与文档连带项 G2、G6，状态不变；
- 第 5 节的 G5 顺带修了：`e2e-smoke` 被中途终止时会留下持有工程数据库句柄的
  Electron 进程，现已补信号收尾与清理提示；
- **新发现一条**，是加完 E2E 断言后才看得见的：构建产物的 CSP 里
  `script-src` 的 sha256 是按带 CRLF 的脚本文本算的，而 Chromium 在比对前会把
  换行归一成 LF，于是 `packages/desktop/out/renderer/index.html` 里那段防主题闪烁的
  内联脚本在生产包里**永远被 CSP 拦住**（`pnpm e2e` 会打出
  `[renderer:error/csp] ... blocked`）。修法是一行：`electron.vite.config.ts:35`
  取哈希前把 `\r\n` 换成 `\n`。本轮未改，等裁定；
- 审阅者的原始报告只存在于当次会话记录里，需要归档再另说。
