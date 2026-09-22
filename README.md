# tool-rwdoc：Documentor 重写版，Node.js 与 Electron

**Documentor** 是模板驱动的结构化 DOCX 文档编辑器，这里是它的 Node.js + Electron 重写版。

> 定位：任何能用 docx 格式化的规范文档，都由「结构模板 + 样式模板」组合驱动编辑与导出。
> 样式模板是一份 stylemap 加一个 docx 骨架。出于版权考虑，模板不随软件分发，
> 由用户提供模板目录，每份模板的身份是 uuid，中文名与英文名只作展示，软件只提供处理管线。
> 新增一种文档格式等于新增一套模板，不用改代码。
> 详情见 `docs/版本开发过程/PLAN-01-项目规划与架构.md` §1 与 §8。

- 规格基线：旧版 C++/Qt 实现的实测规格 01 到 06，已通读
- 设计规划：`docs/版本开发过程/PLAN-01-项目规划与架构.md`、`docs/版本开发过程/PLAN-02-界面重设计方案.md`
- 里程碑：见 PLAN-01 §6，从 M0 骨架一路到 M7 图嵌入链路，mmd2vsdx 最后做

## 技术栈

TypeScript strict · Electron 44 · React 19 · Vite 7，构建走 electron-vite 5 · pnpm workspace
纯 OOXML 与 SQLite 管线，用内建 node:sqlite 与 jszip，不依赖 Office COM。

## 结构

```
packages/              # 本工程的全部模块，平级放在这里（pnpm workspace 的 packages/*）
  desktop/             #   可执行程序：Electron 壳，含界面
    src/main/          #     主进程：窗口、IPC、工程与导出管线宿主
    src/preload/       #     contextBridge 类型化桥
    src/renderer/      #     React UI：主题 token、组件、页面
    src/shared/        #     main、preload、renderer 三端共享的 IPC 契约
    out/               #     electron-vite 构建中间产物（不可直接运行）
  core/ templates/     #   纯逻辑库：零 UI 依赖、可单测
  docx/ postprocess/
samples/               # demo 级实例：示例模板、样例工程、实例样例，供直接打开测试，无外部版权内容
scripts/               # 入库脚本：上游契约检查、产物校验、按需构建库、一键启动
release/               # electron-builder 打包产物（可分发，不入库）
localscripts/          # 本机脚本（不入库）：单测、E2E 探针、Word 核对脚本、开发工具
temp/                  # 临时产物（不入库，可随时清空）
```

> **`packages/` 下不分 apps 与 libs**：可执行与库只是角色不同，同属一个工程，平级放一起。
> 依赖方向只允许 **desktop → 其余四个**，以及库之间 `core ← templates ← docx`；
> **任何库都不得依赖 desktop**——这条边界保证四个库能脱离 React/Electron 单独构建与单测。

> **两个产物目录别混**：`out/` 是 electron-vite 的中间产物（只有源码产物，`pnpm start` 跑它），
> `release/` 是 electron-builder 打出的可分发成品（可直接运行）。

| 目录 | 是什么 | 能不能直接跑 |
| --- | --- | --- |
| `packages/desktop/out/` | electron-vite 的构建中间产物（main/preload/renderer 三份） | ❌ 只有源码产物，`pnpm start` 跑的是它 |
| `release/`（仓库根） | electron-builder 打出的可分发成品 | ✅ 见「打包与安全」一节 |

## 开发

```bash
# 一键启动（双击 start-documentor.cmd 同效）
node scripts/start-documentor.cjs          # 默认启【发布版】：改数据用这条，秒开、不构建
node scripts/start-documentor.cjs --dev    # 启【开发版】：开发新功能用这条

pnpm install    # 首次或依赖变动后
pnpm dev        # electron-vite dev：渲染层 HMR（需先在 设置→模板目录 配置模板或经 DOC_E2E_TEMPLATES 注入开发模板）
pnpm typecheck  # 全仓 TS strict 检查
pnpm build      # 产物 packages/desktop/out/
pnpm verify     # 门禁：typecheck + build，收尾再跑上游契约检查（只报告不阻断；不再跑测试）
pnpm verify:upstream  # 上游契约检查的严格模式，漂移即退出码 1（发布前用）
pnpm test:local     # 本机单测：源码在 localscripts/tests/（不入库）
node localscripts/tools/test-export.cjs <instance.json> [out.docx] --templates <模板目录>   # 无界面导出对照（本机工具）
DOC_REAL_MMD=1 pnpm test:local   # 真实图转换契约测试（缺省跳过，需 Chromium）
pnpm package:dir  # 免安装包：release/win-unpacked（仓库根）
pnpm package      # NSIS 安装包：release/Documentor-<version>-setup.exe
pnpm verify:package   # 出免安装目录后校验 asar 内容（必需项齐全 / mmd2vsdx 不入包 / 无开发依赖）
```

能力自检八份，脚本都在本机 `localscripts/`（不入库）。一个能力一份，改哪块跑哪块；
界面那三份要先 `pnpm build`：

```bash
pnpm check:locks       # 权限：模板里写的锁，工程侧拦不拦得住
pnpm check:terms       # 权限文案：一个权限一个词，旧说法一个不剩
pnpm check:structure   # 结构模板编辑：目录快照、新建、读、保存、改名、删除、试跑、迁移
pnpm check:styles      # 样式模板编辑：读、写回、导入、改名、删除、试跑、迁移
pnpm check:open        # 工程打开：老格式工程的引用认出 uuid、保存补列
pnpm check:ui          # 模板编辑界面
pnpm check:open:ui     # 工程打开界面
pnpm check:terms:ui    # 权限标签与置灰
```

> **单测、E2E 探针、核对脚本、开发工具都在本机 `localscripts/`，不入库**。`.gitignore`
> 忽略整个目录，clone 下来没有它们；清单与跑法见 `docs/WORD处理经验/03-脚本手册.md`。

> **一键启动的默认行为**：`start-documentor.cmd` 与 `scripts/start-documentor.cjs`
> **默认启发布版**（`release/win-unpacked/Documentor.exe`，仓库根）——不做构建、秒开，
> 适合改数据时用。要开发时加 `--dev`，或在仓库根建一个空的 `.dev-mode` 标记文件。
>
> ⚠️ `.dev-mode` 只对这套一键启动生效：它只被 `scripts/start-documentor.cjs` 读取，
> 走 `start-documentor.cmd` 或指向它的快捷方式启动都会读到。安装包建出来的快捷方式
> 起的是装好的 `Documentor.exe`，不读这个标记。共享机器上留着它，别人从仓库这边
> 启动也会跑到开发版（还要现编库，多等十几秒）。
> 开发完记得 `del .dev-mode`；该文件已 gitignore，不会入库。

> **启动时的库构建**：只有开发版路径会跑 `scripts/ensure-libs.cjs`——
> 四个库包的源码没变就跳过构建（省约 4 秒），变了才重编。手工跑过 `pnpm build:libs` 后
> 用 `pnpm build:libs:mark` 刷新指纹，否则下次启动会白重编一遍。

> **临时产物约定**：界面自检工作区、导出对照、打包调试等一律放仓库根 `temp/`，该目录已被 .gitignore 忽略，
> 不写入系统临时目录。界面自检默认跑完即清理，加 `--keep` 可以保留（工作区在 `temp/check-ui/`）。

> 模板由外部目录提供，软件不内置。
> 真身在仓库外，由同级目录 `../tool-documentor-template/` 单独管理，不属本仓库；
> **配置模板目录时要选到它下面的 `packages/`**（`structures/` 与 `styles/` 在那里），不是仓库根。
> 模板的身份是各自 JSON 里的 uuid，目录名与文件名都用它；名字只作展示。
> 本仓库的自动化回归与演示只用 `samples/sample-template/`，那是自建的合成模板。
> 配错一层不会报错，软件只是静默跳过该目录，界面上一片空白——排查先看这里。

> 注：pnpm 11 把构建脚本白名单放在 `pnpm-workspace.yaml` 的 `allowBuilds`。
> Electron 44 起二进制改为首次运行懒下载，没有 postinstall，第一次 `pnpm dev` 会自动拉取。

## 运行时前置条件与边界

| 项 | 说明 |
|---|---|
| 模板目录 | 由用户提供，目录里是 `structures/<uuid>/` 与 `styles/<uuid>/`；软件不内置模板 |
| 图转换 | Mermaid 转 Visio 对象嵌入依赖上游 `mmd2vsdx` 与本机 Chromium，开发期用 `link:` 指到本机目录。发行包不含上游，版权边界见 `docs/版本开发过程/M7-合规说明.md` §3.2；上游缺失时导出照常成功，图以文本形式呈现 |
| 上游接口 | 唯一消费点是 `packages/docx/src/figure-export.ts`，契约与同步清单见 `docs/版本开发过程/UPSTREAM-mmd2vsdx.md` |
| 已知状态 | 上游 2026-09-09 重构后接口已变，图嵌入待修复，见 `docs/版本开发过程/PLAN-05-修复方案.md`；`pnpm verify` 的上游检查当前是预期红灯 |

## 打包与安全

**产物在哪**：仓库根的 `release/`。配置见 `packages/desktop/electron-builder.yml` 的
`directories.output: ../../release`。electron-builder 把这层相对路径解析到 projectDir 上，
projectDir 默认取进程的工作目录，不是配置文件所在目录；打包脚本在 `packages/desktop` 下执行，
写裸相对路径会落到 `packages/desktop/release`，所以显式上溯了两级统一到仓库根。

```
release/
├── Documentor-<version>-setup.exe          安装包，双击安装（NSIS，可选安装目录）
├── Documentor-<version>-setup.exe.blockmap 增量更新用，一起留着
└── win-unpacked/
    └── Documentor.exe                      免安装版，双击直接跑
```

- **打包**：`pnpm package` 出 NSIS 安装包，`pnpm package:dir` 出免安装目录。
  两者都复用本地 Electron（`electronDist`），不必联网下载。
- **当前版本**：代码与 `release/` 里的成品同为 `0.1.2-alpha1`（免安装目录 `win-unpacked/` 与安装包，2026-09-22 打，
  对应提交 `2e4c5c2`）；另保留着 `0.1.1-alpha1`、`0.1.0-beta1`、`0.1.0-alpha3`、`0.1.0-alpha1`
  四个更早的安装包（重新打包由用户明确要求时才做）。
  这一个 `0.1.2-alpha1` 是**同版本号重打**的：先前那一版（对应 `f95bc8d`）的读语句里还有
  `node.copy_group_id`，而这一列已随复制组字段退役从工程库里删掉（PLAN-19），老包打不开那些工程；
  内部版本不对外，重打比加回一个空转的列划算。
  开发新功能期间请继续用发布版改数据，别用 `pnpm dev`——
  理由与分界见工程工作区 `../tool-documentor-projs/README.md` 第 0 节。
- **分发边界**：发行包不含 `mmd2vsdx`。它的产物内嵌官方 Visio 母版 XML，属 Microsoft 许可内容，
  见 `docs/版本开发过程/M7-合规说明.md` §3.2。打包后用 `node scripts/verify-package.cjs` 复核。
- **生产 CSP**：构建期注入 `<meta http-equiv="Content-Security-Policy">`，防闪烁的那段内联脚本用
  sha256 哈希放行。开发环境不注入，因为 HMR 需要内联脚本与 ws。
- **沙箱**：`webPreferences.sandbox: true`，预加载产物只 `require('electron')`。
- **已知限制**：安装包构建期 electron-builder 会下载 `winCodeSign` 做签名，**没有 GitHub 网络会失败**；
  免安装目录（`package:dir`）不受影响。签名是 electron-builder 的默认自签，没有代码签名证书，
  别人装时 SmartScreen 会提示"未知发布者"。
- **图标**：当前用 Electron 默认图标（构建日志会提示 `application icon is not set`）。
  要给一个 `.ico`（建议含 256×256），配到 `electron-builder.yml` 的 `win.icon` 重打。
