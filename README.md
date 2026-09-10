# tool-rwdoc：Documentor 重写版，Node.js 与 Electron

**Documentor** 是模板驱动的结构化 DOCX 文档编辑器，这里是它的 Node.js + Electron 重写版。

> 定位：任何能用 docx 格式化的规范文档，都由「结构模板 + 样式模板」组合驱动编辑与导出。
> 样式模板是一份 stylemap 加一个 docx 骨架。出于版权考虑，模板不随软件分发，
> 由用户提供模板目录，目录里带 manifest.json，软件只提供处理管线。
> 新增一种文档格式等于新增一套模板注册，不用改代码。
> 详情见 `docs/PLAN-01-项目规划与架构.md` §1 与 §8。

- 规格基线：`D:\_dev\documentor\docs\NodeJS路线资料` 01 到 06，来自 C++/Qt 版的实测规格
- 设计规划：`docs/PLAN-01-项目规划与架构.md`、`docs/PLAN-02-界面重设计方案.md`
- 里程碑：见 PLAN-01 §6，从 M0 骨架一路到 M7 图嵌入链路，mmd2vsdx 最后做

## 技术栈

TypeScript strict · Electron 44 · React 19 · Vite 7，构建走 electron-vite 5 · pnpm workspace
纯 OOXML 与 SQLite 管线，用内建 node:sqlite 与 jszip，不依赖 Office COM。

## 结构

```
apps/desktop/          # Electron 壳：main / preload / renderer 三段
  src/main/            # 主进程：窗口、IPC、工程与导出管线宿主
  src/preload/         # contextBridge 类型化桥
  src/renderer/        # React UI：主题 token、组件、页面
  src/shared/          # main、preload、renderer 三端共享的 IPC 契约
packages/              # core / templates / docx / postprocess 四个纯逻辑包
resources/test-fixtures/  # 合成回归数据：示例模板、样例工程、实例样例，无外部版权内容
```

## 开发

```bash
pnpm install
pnpm dev        # electron-vite dev：渲染层 HMR（需先在 设置→模板目录 配置模板或经 DOC_E2E_TEMPLATES 注入开发模板）
pnpm typecheck  # 全仓 TS strict 检查
pnpm build      # 产物 apps/desktop/out/
pnpm verify     # 门禁：上游契约检查 + typecheck + 全量单测 + build
pnpm verify:local  # 同上但跳过上游检查（上游改造期间日常用）
pnpm cli:test-export -- <instance.json> [out.docx] --templates <模板目录>   # 无界面导出
pnpm --filter @documentor/docx test:real   # 真实图转换契约测试（需 Chromium）
pnpm package:dir  # 免安装包：release/win-unpacked（含产物内容校验见下）
pnpm package      # NSIS 安装包：release/Documentor-<version>-setup.exe
pnpm e2e          # 生产产物 E2E 冒烟（工作区落 temp/，见下）
node scripts/verify-package.cjs   # 校验 asar 内容（必需项齐全 / mmd2vsdx 不入包 / 无开发依赖）
```

> **临时产物约定**：E2E 工作区、冒烟导出、打包调试等一律放仓库根 `temp/`，该目录已被 .gitignore 忽略，
> 不写入系统临时目录。`pnpm e2e` 默认跑完即清理，加 `--keep` 可以保留。

> 模板由外部目录提供，软件不内置。本地开发与自用模板放 `localtest/templates/`，该目录不入库。
> 自动化回归用 `resources/test-fixtures/sample-template/`，那是自建的合成模板。

> 注：pnpm 11 把构建脚本白名单放在 `pnpm-workspace.yaml` 的 `allowBuilds`。
> Electron 44 起二进制改为首次运行懒下载，没有 postinstall，第一次 `pnpm dev` 会自动拉取。

## 运行时前置条件与边界

| 项 | 说明 |
|---|---|
| 模板目录 | 由用户提供，每个目录含 manifest.json；软件不内置模板 |
| 图转换 | Mermaid 转 Visio 对象嵌入依赖上游 `mmd2vsdx` 与本机 Chromium，开发期用 `link:` 指到本机目录。发行包不含上游，版权边界见 `docs/M7-合规说明.md` §3.2；上游缺失时导出照常成功，图以文本形式呈现 |
| 上游接口 | 唯一消费点是 `packages/docx/src/figure-export.ts`，契约与同步清单见 `docs/UPSTREAM-mmd2vsdx.md` |
| 已知状态 | 上游 2026-09-09 重构后接口已变，图嵌入待修复，见 `docs/PLAN-05-修复方案.md`；`pnpm verify` 的上游检查当前是预期红灯 |

## 打包与安全

- **打包**：`pnpm package` 出 NSIS 安装包，`pnpm package:dir` 出免安装目录，配置在 `apps/desktop/electron-builder.yml`。
- **分发边界**：发行包不含 `mmd2vsdx`。它的产物内嵌官方 Visio 母版 XML，属 Microsoft 许可内容，
  见 `docs/M7-合规说明.md` §3.2。打包后用 `node scripts/verify-package.cjs` 复核。
- **生产 CSP**：构建期注入 `<meta http-equiv="Content-Security-Policy">`，防闪烁的那段内联脚本用
  sha256 哈希放行。开发环境不注入，因为 HMR 需要内联脚本与 ws。
- **沙箱**：`webPreferences.sandbox: true`，预加载产物只 `require('electron')`。
- **已知限制**：没有 GitHub 网络时 electron-builder 下载 `winCodeSign` 会失败。
  可以复用本地 Electron 二进制，并跳过可执行文件编辑，完成本地验证。
