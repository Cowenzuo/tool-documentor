# 上游锚定记录：mmd2vsdx

> 用途：本仓库对上游 `mmd2vsdx` 的**唯一消费契约**与**变更同步清单**。
> 上游一旦改动，按本文对照：`scripts/check-upstream.cjs` 负责静态红灯，
> 真实链路按第 5 节第 2 条用本机 CLI 手工核对（单测移出产品之后，产品侧不再跑真实转换测试）。

---

## 1. 上游位置与形态

| 项 | 值 |
|---|---|
| 本地路径 | `D:\_dev\tool-mmd2vsdx` |
| 包名 | `mmd2vsdx`（`private: true`，未发布 registry） |
| 引入方式 | `link:../../../tool-mmd2vsdx`（`packages/docx` 与 `packages/desktop` 各一条） |
| 形态 | ESM（`"type": "module"`），入口 `main`/`exports["."]` |
| 运行时前置 | 本机 Chromium（playwright）；母版已程序化装配，**无需 Visio** |

## 2. 锚定快照

| 项 | 值 |
|---|---|
| 快照时间 | 2026-09-09 |
| 上游 HEAD | `ce2c66c feat(er): 对齐官方 er-all-in-one 模板库…` |
| 关键重构 | `00ed1ff refactor: 结构收敛——零资产输入、测试独立、同层合并`、`a91f58d chore(pkg): 重新声明包入口 main/exports` |
| 我方集成时间 | 2026-09-04（`42eb0a4 feat: M7 图嵌入链路…`，按**旧 API** 对接） |
| 当前状态 | **已漂移**：入口由 `dist/app/application.js` 改为 `dist/convert.js`，不再导出 `application` |

## 3. 消费契约

### 3.1 目标形态（P0-1 完成后，我方唯一依赖面）

```ts
// 期望：包根可解析、带类型、提供门面
import { convertText, shutdown } from 'mmd2vsdx'

const r = await convertText(code, opts)
// → { ok: boolean; vsdxBase64?: string; error?: string
//     previewBase64?: string; previewExt?: 'png' | 'emf' }   // 预览为可选附带物
await shutdown()
```

- `package.json` 需声明类型（`"types"` 或 `exports["."].types`）；
- 允许门面以 `application` 对象承载同名成员（旧形态兼容）；
- 子路径导出（`./parser`、`./convert`、`./xml-parts`、`./squeeze`）为可选项，非我方依赖。

### 3.2 上游内部事实（仅供排障，不作为依赖）

新管线：`Parser.convertText(text) → ContractA` → `renderContract(a, opts)` →
`PartsAssembler.assemble(b.parts, opts)` → `Squeeze.pack(full) → Buffer`；
`Parser.shutdown()` 释放浏览器资源。当前 `exports` 只含 `"."` 与 `"./package.json"`，
README 展示的深路径导入会被 `exports` 白名单拦截（`ERR_PACKAGE_PATH_NOT_EXPORTED`）。

## 4. 我方消费点（改动只应发生在这些位置）

| 位置 | 作用 |
|---|---|
| `packages/docx/src/figure-export.ts` → `loadMmd2vsdxConverter()` | **唯一**上游调用点（动态 `import('mmd2vsdx')`） |
| `packages/docx/src/mmd2vsdx.d.ts` | 类型声明（P0-1 后改由上游提供；保留时须与本文件同步） |
| `packages/desktop/src/main/mmd2vsdx.d.ts` | 主进程侧声明（同上） |
| `localscripts/tools/test-export.cjs` | 无界面导出对照的 CLI（本机脚本，不入库；`--embed-visio` 走真实转换） |

## 5. 上游变更时的同步清单

1. 跑 `node scripts/check-upstream.cjs` → 看漂移点。
2. 需要看真实链路时，用 `localscripts/tools/test-export.cjs --embed-visio` 出一份带对象的 docx 回读
   （本机脚本，不入库；缺 Chromium 或上游不可用时那一段会降级成文本并给警告）。
3. 按需改 `loadMmd2vsdxConverter()`（保持 `MmdConverter` 形状，调用方零改动）。
4. 更新本文件 §2 锚定快照（HEAD / 时间 / 接口形状）。
5. 更新 `docs/版本开发过程/PLAN-05-修复方案.md` 与 `docs/版本开发过程/M7-合规说明.md` 的相关记录。

## 6. 门禁入口

| 命令 | 作用 | 成本 |
|---|---|---|
| `node scripts/check-upstream.cjs` | 静态契约检查（入口/门面导出/类型），报告模式：漂移只打印、不阻断 | 毫秒级 |
| `pnpm verify:upstream` | 同上但走严格模式：漂移以退出码 1 拦住，发布前用 | 毫秒级 |
| `pnpm verify` | typecheck + build + 上面的静态检查（收尾一项，不阻断） | 分钟级 |

`pnpm verify` 把上游检查放在**最后一项且不阻断**：它是已知会红的预期状态，
放在首位用 `&&` 串联会把类型检查与构建短路掉，回归整体漏网。
真实链路的核对不在门禁里：它要 Chromium 与本机上游目录，按第 5 节第 2 条手工跑。
