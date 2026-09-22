# 导出、题注与图嵌入

> 本文写导出这条线上的当前设计：docx 怎么从样式骨架生成、题注编号的口径、图片与流程图的
> 两种嵌入方式，以及流程图转换背后的上游依赖与合规边界。包内部件的逐字节处置与
> 元素级不变量见 [包结构与写入方式.md](../WORD解压结构研究/包结构与写入方式.md) 与
> [样式与编号.md](../WORD解压结构研究/样式与编号.md)，那两份是唯一事实源，本文写的是
> 本工程怎么用它们。

## 1 链路总览

一次导出从界面点「导出」开始，到写出用户给的那个路径结束，中间不产生需要用户辨认的中间文件。

1. 用户选样式模板与输出路径，主进程 `ProjectService.exportDocx()` 先落库一次，与保存同一口径；
2. `exportTreeToDocxWithFigures()` 走两步：序列化把文档树转成写入指令，`writeDocx()` 读样式骨架
   写出一份带占位段的临时 docx；
3. `attachFiguresToDocx()` 在这份临时 docx 上做图嵌入，产出最终字节；
4. 最终产物写到 `outputPath`，临时件在 `finally` 里删掉。

导出对话框（`pages/ExportDialog.tsx`）只呈现信息、不给路径选择。样式下拉列出模板目录里
能读出的全部样式，默认选中结构里写的那一份；「图表嵌入」「表格」两段是只读提示，由
`figureCounts()` 现算。**没有「文本占位 / 转换 VSDX / 嵌入」这类用户档位**，图嵌入是
单一路径自动执行，上游不可用时降级为文本并如实告知。

导出前另有一道预检查（`ProjectService.precheck()`）：缺图（文件不在）、转换组件不可用、
表格超出行列上限三类问题一次说清，不做常规计数播报。同一份口径在 `figureCounts()` 里
再走一遍，供对话框显示。

「图片块」与「流程图块」是两条**不同的嵌入链路**，调试时先分清走的是哪一条。表格块是第三种
情况，它不经嵌入，由写入侧直接写成 Word 原生表格。三类分开计数，是因为只数流程图会把
「文档里有一百多张图、几十个表」说成「没有图表」。

## 2 骨架是底，只重写两个部件

导出**不生成** docx，而是改写样式模板自带的骨架。理由是骨架里的页面设置、页眉页脚、
样式表是用户单位的版式资产，重新生成一份必然走样。

**`word/document.xml` 整体重写**，只保留骨架尾部的 `sectPr`。**`word/numbering.xml` 只在有列表组时
重写**，为每个列表组克隆编号定义，没有列表组就原样带过。`word/_rels/document.xml.rels` 在骨架
自带时只追加关系，整份缺时才补一份并把 styles 与 numbering 的关系一并补出。`[Content_Types].xml`
在新增媒体或对象时追加 `Default` 声明。**其余部件逐字节带过去，不解析再序列化。**

关系号与媒体序号都**接现有最大值往后排**（`maxRid()` 扫 `rIdN`，`maxMediaIndex()` 扫
`word/media/imageN.`），不是从 1 重新发号。极简骨架会缺关系表，真实样式模板都自带。
`writeDocx()` 的骨架检查只有一条：`styleDef.skeletonPath` 下必须有 `word/document.xml`，
否则直接抛「样式骨架目录无效」。包内压缩参数固定，同一输入两次导出字节一致。

**列表编号克隆**是唯一会重写 `numbering.xml` 的场景。每个列表组克隆一份 `abstractNum`，
配一个新的 `abstractNumId`/`numId`（从 200 起顺序发号），并重写 `nsid` 与 `tmpl`，
让 Word 认为它们是不同的编号定义。组与样式之间靠一张实测出来的映射表
`STYLE_TO_ABSTRACT` 对应。组装顺序有硬要求：新 `abstractNum` 插在最后一个
`</w:abstractNum>` 之后，新 `num` 插在 `</numbering>` 之前，所有 `abstractNum` 必须在所有
`num` 之前，顺序错了 Word 会把编号解析成样式自带的编号。

## 3 题注与编号

题注（表题、图题）的编号一律**不走标题的多级列表**，走域。原因是硬约束：
与标题共用同一个多级列表的题注层级会顶高标题计数，与用第几层无关。

`writer.ts` 渲染出的题注段落是这样一串，标签由块类型定，表格出「表」、图片与流程图出「图」：

```
表{ STYLEREF "标题 2" \n }-{ SEQ 表 \* ARABIC \s 2 }  表名
图{ STYLEREF "标题 3" \n }-{ SEQ 图 \* ARABIC \s 3 }  图名
```

`STYLEREF <样式> \n` 取最近一个该样式段落的编号，也就是章节号，`\n` 表示只要编号不要文字；
`SEQ <标签> \* ARABIC \s N` 是自增序号，`\s N` 表示在第 N 层标题处重启，得到本节内的序号。
两个域都写进 `w:fldSimple`，并把导出时算好的编号放进子 run 作缓存值，Word 打开即显示正确、
按 F9 可刷新。

域里的样式名必须是**界面上的本地化名称**，写 styleId 或骨架里的英文 `w:name` 都认不到。
所以 `chapterStyleNames` 由样式模板显式给出，模板没配时按中文 Word 惯例补「标题 N」，
配成空串则退化为「只写算好的章节号文本、不发域」。

### 三种编号模式

`captionNumbering` 按表与图分别取 `auto`（缺省）、`static`、`field` 三种模式：

| 模式 | 编号从哪来 | serializer 产出 |
| --- | --- | --- |
| `auto` | 骨架样式自带的列表编号 | 普通段落，文字只写标题 |
| `static` | 数据侧自己写进题注文字 | 普通段落，文字原样带出 |
| `field` | `STYLEREF` + `SEQ` 域 | `InsertCaption` 指令，含章节号与序号的缓存值 |

`auto` 与 `static` 在写入侧是同一个动作（都是普通段落），区别只在编号由谁给：前者靠骨架的
`w:pStyle` 绑定，后者靠数据。**解析格式与实例数据两处给出的题注文字都原样带出**，
程序不剥离、不改写、也不提示；文字里带了手写编号，那是数据自己的问题，出现在文档里
比被程序悄悄抹掉更好查。样式模板里配的题注样式 ID 来自 `styleMap` 的 `table.caption`
与 `figure.caption` 两个键，代码不写死 styleId。

### 章节号怎么拼

章节号按**当前路径上实际存在的标题层级**用点号拼，两侧都由 `serializer.ts` 维护：
计数器按层级推进，进入某层标题时重置更深的层级与相应的题注序号；路径栈里只留普通标题层级，
列表子标题不占编号链。因此缺层不补 0（标题 1 直挂标题 3 得到 `4.1.1` 而不是 `4.0.1`），
重复算逐字相同。

一个可挂靠的标题都没有时，退化为不带章节号的题注：章节号显式留空，序号仍由 `SEQ` 域给出，
`writer.renderCaption` 在没有章节号时不写那个固定的连字符，因此不会出现「表-1」这种残号。
这种情况只提示一次，逐条刷屏不会多给出信息。

### 两条必须守住的边界

**题注段落不得挂 `numPr`**，也不得在 `numbering.xml` 里被绑到某一层。两者并存时 Word 按列表
编号，与域里的编号打架，出现两个号。骨架侧要同时做两件事：`capF` 去掉 `numPr`，`numbering.xml`
去掉该层级上的 `w:pStyle` 绑定。另一条是 `w:ilvl` 只到 0 到 8，写 9 会让 Word 报文件损坏。

## 4 图片嵌入

图片块必须**真正嵌入**，占位文本只在文件缺失时作为兜底出现。这条是红线，不是策略。

`serializer.ts` 的 `resolveImage()` 按工程目录解析 `imagePath`，兼容只记了文件名的历史数据
（落到工程 `images/` 下再找一次）；解析不到且路径非空，才输出 `[图片: <路径>]` 占位段。
解析得到的绝对路径交给 `writer.ts` 的 `addImage()`，同一路径复用同一份媒体与同一条关系，
不重复登记，所以图表被多次引用不会让包体翻倍。

新增一张图片要同时改三处登记，缺一处 Word 就显示不出来：媒体文件落 `word/media/imageN.ext`、
`document.xml.rels` 追加一条 `relationships/image`、`[Content_Types].xml` 补该扩展名的
`Default` 声明。序号都接现有最大值往后排。

### 显示尺寸按骨架算

**不得写死宽度。** 可用区域从骨架的 `sectPr` 现算：页宽减左右页边距、页高减上下页边距，
页边距缺省按 Word 的 1440 twips；页面尺寸缺失才整块回退到 A4 兜底值。`writer.mediaBoxOf()`
与界面预览用的 `skeletonTextWidthTwips()` 是同一套解析，界面不另算一份。

缩放规则四条，同时生效时取更小的那个，宽高比始终不变：

1. 按可用宽度铺满，保持宽高比；
2. 低于 150 像素宽的极小图不放大，按原始尺寸输出，硬拉只会糊成一片；
3. 受可用高度上限约束，竖长图即使宽度没超也按高度缩，避免一张图跨好几页；
4. 单位换算是 96 DPI 一像素 9525 EMU，一 twip 635 EMU。

像素尺寸从文件头读，不依赖外部库。导入对话框放行的八种格式都要能读出来：PNG 看 `IHDR`、
JPEG 扫 `SOF` 段、GIF 看逻辑屏幕描述符、BMP 走 DIB 头并给负高度取绝对值、WebP 认
`VP8X`/`VP8L`/`VP8 ` 三种头、SVG 先看 `width`/`height` 带单位换算再看 `viewBox`、
EMF 读 `rclFrame`（0.01 毫米）并在全零时退回 `rclBounds`。只有一种情况用 800 乘 520 的
兜底值：文件头认不出来，多半是文件损坏或被改名。此时 MIME 也会落到
`application/octet-stream`，Word 显示成无法识别的对象，用户看得见，不会误以为图正常。

## 5 流程图：转换、嵌入与降级

流程图走的是另一条链路：Mermaid 源码先转成 VSDX 字节，再包成 OLE 复合容器嵌进 docx，
用户双击即用 Visio 打开。

文献级结构是 `w:object` 里先 `v:shape` 与可选的 `v:imagedata` 预览，再
`o:OLEObject Type="Embed" ProgID="Visio.Drawing.15"`。两条实现上的硬要求：
`w:object` 是 run 级元素，必须包在 `w:r` 内，否则 Word 不激活这个对象；
对象段落按 `figure` 样式居中。

VSDX 字节本身进包之前要包一层 **OLE 复合容器**（CFB）。容器里除 VSDX 数据流之外还有三条
辅助流：`\x01Ole` 是 20 字节的固定结构，`\x01CompObj` 是版本头加 CLSID 加 ANSI 长度前缀串
并带 ProgID 与 AppName，`\x03ObjInfo` 是 6 字节的固定结构。三条都按公开结构常量程序化构造，
不读任何 Word 样本。数据流的字节零修改，目录项按「长度优先」排序。这一层由
`@documentor/postprocess` 负责，它不感知文档树、样式与模板，是纯粹的字节装配，可以独立复用与
单测。对象在文档里的 XML 片段见 [图片与对象嵌入.md](../WORD解压结构研究/图片与对象嵌入.md)。

### 占位段与槽位对齐

流程图在序列化阶段先写成占位段，文本以 `[Mermaid` 开头，`collectMermaidFigures()` 用与
序列化同构的遍历收集图块。嵌入阶段按文档顺序找占位段，**第 k 个占位段配第 k 张图**，
不做「按题注名猜文件」的对齐。两侧数量对不上时按较少的一方处理并转成用户看得懂的提示。

占位段的文本就是源码本身，超过 2000 字符才截断，且切在行尾并写明已截断与真实长度。
降级成文本时用户看到的就是这一段，所以它不能只留半截 token 而说「以文本形式导出」。

### 对象尺寸与预览

显示宽度取正文宽留 10pt 余量，高度按 VSDX 内容包围盒的比例，比例被夹在 0.1 到 3.0 之间，
最大高度 550pt；同时默认把 VSDX 页面尺寸修补成内容包围盒。预览图**不是本工程产的**，它是上游
转换的附带物，与 VSDX 同源同风格；回退链两条，转换结果带 `previewBase64` 就直接用，否则看暂存区
有没有同名 `.png`/`.emf`，都没有则**无预览嵌入**，OLE 对象仍然有效，Word 显示图标，不报错、
不中断。临时 VSDX 落在一次导出专属的暂存目录，收尾时整个删掉；导入的图片是另一回事，
它们复制进工程 `images/` 并记相对路径，因为图片是工程数据的一部分。

### 转换组件不可用时怎么办

从收集到嵌入，任何一步让「图转换」整体不可用，都走同一条降级：交付文本版、给一句面向用户的
提示、导出照常成功。`FigurePipelineStats.unavailable` 专门区分这种情况，因为此时
`failed` 是空的，调用方只有靠它才知道 total 张全都没嵌进去。导出对话框读到它就说
「N 张以文本形式导出」，不说「含 N 张图」。

降级的四种情形与各自的可见后果：转换服务整体不可用（`unavailable` 为真、`failed` 为空）说
「N 张以文本形式导出，双击编辑暂不可用」；个别图转换失败时提示里列出前三条题注；题注与文件名
不一致时进 `nameMisses`，照常按槽位嵌入并提示；无预览不提示，Word 里显示对象图标。

## 6 上游依赖与锚定记录

`mmd2vsdx` 是仓库外的本机检出，以 `link:../../../tool-mmd2vsdx` 装进 `packages/docx` 与
`packages/desktop` 的依赖树，不 vendored、不打补丁。形式是纯 ESM，主进程由动态 `import()` 接入。

要消费的门面只有两个成员：`convertText(text, opts)` 与 `shutdown()`。`pickFacade()` 兼容三种
解析形态，模块根导出这两个名字、包在 `application` 对象上承载、或被 CJS/ESM 互操作的
`default` 包一层，都能认出来；都不匹配就抛一句带「期望契约 + 排查入口」的错误，由调用方
降级为文本导出。**唯一消费点是 `figure-export.ts` 的 `loadMmd2vsdxConverter()`**，改动只应发生
在这里。它把 `useConnectorMaster` 透传给上游（缺省 true，即使用 Connector 母版），并把返回值
裁剪成 `FigureConvertResult`：`ok`、`vsdxBase64`、`error`，外加可选的 `previewBase64` 与
`previewExt`。

### 当前状态

上游已完成一次结构收敛重构，入口与 API 都变了，我方按旧接口写的对接因此失效，
静态契约检查持续报漂移：入口已无 `convertText`/`shutdown`，且没有声明类型。
这一状态是**已知且预期**的，处理办法是等上游门面发布后再切换加载器。我方这一侧的准备已经做完：
门面解析兼容新旧两种形态、加载点只有一处、降级路径完整、导出对话框会提前告知转换不可用。
缺的只有上游那一个门面。

`scripts/check-upstream.cjs` 只做静态检查（读 `package.json` 与入口文件文本），不 import
上游，因此毫秒级出结果。它有两种模式：默认报告模式发现漂移只打印、退出码仍为 0，
`--strict`（`pnpm verify:upstream`）发现漂移退出 1。`pnpm verify` 把它放在**最后一项且不阻断**，
因为它是已知会红的预期状态，放在首位用 `&&` 串联会把类型检查与构建短路掉，回归整体漏网。
真实链路的核对不在门禁里，它要 Chromium 与本机上游目录，手工跑本机 CLI 出一份带对象的
docx 回读。

### 当前锚定（2026-09-22 核对）

| 项 | 值 |
| --- | --- |
| 本机检出 | `D:\_dev\tool-mmd2vsdx`，分支 `master` |
| 检出 HEAD | `96750a0`，2026-09-10，提交信息「chore: 定版 v0.1-alpha3」 |
| 包版本 / 形态 | `0.1.0-alpha3`，纯 ESM，无 `types` 声明 |
| 入口 / `exports` | `main` 为 `./dist/convert.js`；`exports` 有 `.`、`./service`、`./dist/*`、`./package.json` |
| 入口当前导出 | `kImplementedKinds`、`renderContract` —— **没有** `convertText` / `shutdown` |
| 静态检查结论 | `node scripts/check-upstream.cjs` 报两条漂移：入口缺门面导出、未声明类型 |

### 上游改动时核对哪几处

跑 `node scripts/check-upstream.cjs` 先看漂移点；核对上游的快照点（本地路径、包名与形态、
入口与 `exports`、是否声明类型、运行时前置）；核对我方四处消费点（`figure-export.ts` 的加载器与
门面解析、`packages/docx/src/mmd2vsdx.d.ts`、`packages/desktop/src/main/mmd2vsdx.d.ts`，以及
本机 CLI 的 `--embed-visio`）；真实链路用 `localscripts/tools/test-export.cjs --embed-visio`
出一份带对象的 docx 回读，缺 Chromium 或上游不可用时那一段会降级成文本并给警告；改完把本文的
锚定记录与 `docs/AI开发约定/项目特定规范.md` 里的相关口径一起更新。

## 7 合规与分发边界

### 为什么发行包不含上游

上游现在的产物把**官方 Visio 母版 XML 逐字内嵌**进它自己的 `dist`，那些 `MasterContents`
里带着 Microsoft 的版权声明。官方母版属 Microsoft 许可内容，不是开源许可，与本仓库的 MIT
不兼容，因此不能随本软件分发。结论是一条固定的分发边界：**发行包不含 `mmd2vsdx`**。

由此图嵌入是**运行时可选能力**，不是交付前提。上游缺失时导出仍成功，图以文本形式呈现，
界面给出提示。开发期用 `link:` 指向本机上游检出，那是使用不是分发。若将来要「开箱即用」，
前提是上游提供一种不含官方母版的发行形态，否则维持现状。

除母版之外，本工程不消费任何受版权约束的素材：OLE 辅助流的字节按公开结构常量程序化构造，
`CLSID` 与 `ProgID` 是 Microsoft 的公开注册标识符，仓库里入库的只有自建的合成样例。

### 怎么保证发行包干净

打包后用 `node scripts/verify-package.cjs` 校验 `release/win-unpacked/resources/app.asar`，
它同时看两头。**必需项齐全**：`out/main`、`out/preload`、`out/renderer` 三段产物，四个 workspace
库的 `dist/index.js`，以及 `jszip`，任一缺失即失败。**禁止项必须为空**：`mmd2vsdx` 条目数期望为
0（命中即失败并写明原因是版权边界），另加 source map、`electron-builder`/`electron-vite`/
`typescript`/`vitest` 四个开发依赖，以及不应再入 asar 的 Electron 二进制目录。它还会用
`packages/desktop/package.json` 的 `devDependencies` 逐个比对 asar 顶层包清单，看有没有开发依赖
泄漏，并打印 asar 条目数、`mmd2vsdx` 条目数（期望 0）与 asar 体积，加 `--list` 再列出顶层包名。
发布前的完整口径见 [DESIGN-09-质量门禁与发布.md](DESIGN-09-质量门禁与发布.md)。

## 8 相关文档

包内部件的逐字节处置与元素级不变量见 [包结构与写入方式.md](../WORD解压结构研究/包结构与写入方式.md)；
样式继承、字体槽位与题注域见 [样式与编号.md](../WORD解压结构研究/样式与编号.md)；图片与对象的
XML 片段、尺寸算法与媒体登记见 [图片与对象嵌入.md](../WORD解压结构研究/图片与对象嵌入.md)；
表格合并的映射见 [表格与合并.md](../WORD解压结构研究/表格与合并.md)；用 Word 回读核对产物见
[01-Word实测核对方法.md](../WORD处理经验/01-Word实测核对方法.md)；门禁与打包产物的已知限制见
[DESIGN-09-质量门禁与发布.md](DESIGN-09-质量门禁与发布.md)；用户可见提示的用词见
[产品文案口径.md](产品文案口径.md)；模块边界见 [DESIGN-01-总体架构与模块.md](DESIGN-01-总体架构与模块.md)。
