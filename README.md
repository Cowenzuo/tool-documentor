# tool-rwdoc — Documentor 重写（Node.js + Electron）

**Documentor**（模板驱动的结构化 DOCX 文档编辑器）的 Node.js + Electron 重写版。

> 定位：任何可用 docx 格式化的规范文档，都由「结构模板 + 样式模板（stylemap + docx 骨架）」
> 组合驱动编辑与导出；**模板不随软件分发**（版权考虑）——由用户提供模板目录
> （设置 → 模板目录，每个目录含 manifest.json），软件只提供处理管线；
> 新文档格式 = 新增模板注册，无需改代码。详见 `docs/PLAN-01-项目规划与架构.md` §1/§8。

- 规格基线：`D:\_dev\documentor\docs\NodeJS路线资料`（01~06，C++/Qt 版实测规格）
- 设计规划：`docs/PLAN-01-项目规划与架构.md`、`docs/PLAN-02-界面重设计方案.md`
- 里程碑：见 PLAN-01 §6（M0 骨架 → … → M7 图嵌入链路，mmd2vsdx 最后做）

## 技术栈

TypeScript (strict) · Electron 44 · React 19 · Vite 7（electron-vite 5）· pnpm workspace
纯 OOXML/SQLite 管线（node:sqlite 内建 / jszip），无 Office COM 依赖。

## 结构

```
apps/desktop/          # Electron 壳：main / preload / renderer(React) 三段
  src/main/            # 主进程：窗口、IPC、后续数据/导出管线宿主
  src/preload/         # contextBridge 类型化桥
  src/renderer/        # React UI：主题 token、组件、页面
  src/shared/          # main⇄preload⇄renderer 共享 IPC 契约
packages/              # （M1 起）core / templates / docx 纯逻辑包
resources/test-fixtures/  # 合成回归数据（示例模板/样例工程/实例样例——无外部版权内容）
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
node scripts/verify-package.cjs   # 校验 asar 内容（必需项齐全 / mmd2vsdx 不入包 / 无开发依赖）
```

> 模板：软件不内置，由外部目录提供。
> 本地开发/使用模板放 `localtest/templates/`（.gitignore 忽略、不入库）；
> 自动化回归使用 `resources/test-fixtures/sample-template/`（自建合成模板）。

> 注：pnpm 11 将构建脚本白名单放在 `pnpm-workspace.yaml` 的 `allowBuilds`。
> Electron 44 起二进制为首次运行懒启动下载（无 postinstall），首次 `pnpm dev` 会自动拉取。

## 运行时前置条件与边界

| 项 | 说明 |
|---|---|
| 模板目录 | 由用户提供（设置 → 模板目录，每个目录含 manifest.json）；软件不内置模板 |
| 图转换（可选能力） | Mermaid → Visio 对象嵌入依赖上游 `mmd2vsdx`（开发期为 `link:` 本机依赖）+ 本机 Chromium；**发行包不包含上游**（版权边界，见 `docs/M7-合规说明.md` §3.2）；上游缺失时导出仍成功，图以文本形式呈现 |
| 上游接口 | 唯一消费点 `packages/docx/src/figure-export.ts`；契约与同步清单见 `docs/UPSTREAM-mmd2vsdx.md` |
| 已知状态 | 上游 2026-09-09 重构后接口已变，图嵌入待修复（`docs/PLAN-05-修复方案.md` P0-1）；`pnpm verify` 的上游检查当前为预期红灯 |

## 打包与安全

- **打包**：`pnpm package`（NSIS 安装包）/ `pnpm package:dir`（免安装目录）；配置见 `apps/desktop/electron-builder.yml`。
- **分发边界（C1）**：发行包**不含** `mmd2vsdx`——其产物内嵌官方 Visio 母版 XML（Microsoft 许可内容），
  见 `docs/M7-合规说明.md` §3.2；打包后用 `node scripts/verify-package.cjs` 复核。
- **生产 CSP**：构建期注入 `<meta http-equiv="Content-Security-Policy">`；防闪烁内联脚本以
  **sha256 哈希**放行；开发环境不注入（HMR 需要内联脚本与 ws）。
- **沙箱**：`webPreferences.sandbox: true`（预加载产物仅 `require('electron')`）。
- **已知限制**：无 GitHub 网络时 electron-builder 的 `winCodeSign` 下载会失败；
  可复用本地 Electron 二进制（`electronDist`）并跳过可执行文件编辑以完成本地验证。
