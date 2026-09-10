# 上游锚定记录：mmd2vsdx

> 用途：本仓库对上游 `mmd2vsdx` 的**唯一消费契约**与**变更同步清单**。
> 上游一旦改动，按本文对照；`scripts/check-upstream.cjs` 负责静态红灯，
> `packages/docx/tests/mmd2vsdx.contract.test.ts` 负责真实链路红灯。

---

## 1. 上游位置与形态

| 项 | 值 |
|---|---|
| 本地路径 | `D:\_dev\tool-mmd2vsdx` |
| 包名 | `mmd2vsdx`（`private: true`，未发布 registry） |
| 引入方式 | `link:../../../tool-mmd2vsdx`（`packages/docx` 与 `apps/desktop` 各一条） |
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
| `apps/desktop/src/main/mmd2vsdx.d.ts` | 主进程侧声明（同上） |
| `apps/desktop/cli/test-export.cjs` | CLI `--embed-visio` 入口（传递 `mode` 参数已失效，P0-1 清理） |

## 5. 上游变更时的同步清单

1. 跑 `node scripts/check-upstream.cjs` → 看漂移点。
2. 跑 `pnpm --filter @documentor/docx test:real` → 看真实链路。
3. 按需改 `loadMmd2vsdxConverter()`（保持 `MmdConverter` 形状，调用方零改动）。
4. 更新本文件 §2 锚定快照（HEAD / 时间 / 接口形状）。
5. 更新 `docs/PLAN-05-修复方案.md` 与 `docs/M7-合规说明.md` 的相关记录。

## 6. 门禁入口

| 命令 | 作用 | 成本 |
|---|---|---|
| `node scripts/check-upstream.cjs` | 静态契约检查（入口/门面导出/类型） | 毫秒级 |
| `pnpm --filter @documentor/docx test:real` | 真实转换 + OLE 嵌入契约测试（缺省合成夹具 1 图） | 需 Chromium，数十秒 |
| `DOC_REAL_MMD=1 DOC_REAL_MMD_TEMPLATE=localtest/templates DOC_REAL_MMD_STRUCTURE="438C-软件设计说明(SDD)" pnpm --filter @documentor/docx test:real` | 同上，但跑本地真实模板（SDD 结构实测 11 图） | 同上 |
| `pnpm verify` | 上述静态检查 + typecheck + 全量单测 + build | 分钟级 |
| `pnpm verify:local` | 跳过上游检查的本地门禁（上游改造期间日常用） | 分钟级 |
