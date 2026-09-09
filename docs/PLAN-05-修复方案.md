# PLAN-05 修复方案：M7 对接 · 合规复核 · 发布工程化

> 状态：**执行中**——P0-2、P0-3 已完成（2026-09-09）；P0-1、P1-2、P2 待执行。
> 依据：2026-09-09 会话实测——typecheck ✅ / 87 单测 ✅ / build ✅ / CLI 纯导出 ✅ / **CLI 图嵌入 ❌**。

---

## 0. 结论与根因

当前仓库代码质量本身是好的（类型、单测、构建、纯导出全绿）；问题集中在**与上游 `tool-mmd2vsdx` 的边界**上，且被三道"绿灯"掩盖。

| # | 现象 | 根因 | 影响 |
|---|---|---|---|
| 1 | 图嵌入静默失效（`Cannot read properties of undefined (reading 'convertText')`） | 上游 2026-09-08/09 完成"结构收敛"重构（`00ed1ff`、`a91f58d`），入口由 `dist/app/application.js` 改为 `dist/convert.js`，不再导出 `application` | 交付 docx 中的图退回文本占位；M7 里程碑实际不成立 |
| 2 | 绿灯未报警 | ① 测试全用**注入的假转换器**；② `mmd2vsdx.d.ts` 是**手写旧 API**（不读上游真实类型）；③ 失败按设计**优雅降级**（WARN + 退出码 0） | 漂移可持续存在而不被发现 |
| 3 | 合规说明已过期 | 上游新形态把**官方 Visio 母版 XML 逐字内嵌**进 `dist/common/masters/templates/*.js`（含 `Copyright (c) 2012 Microsoft Corporation`），其仓库另跟踪 280 个官方模板解压文件 | `docs/M7-合规说明.md` §3.2「官方模具不随包分发」断言失效；**分发边界需重新拍板** |

> 补充事实（新上游 API）：入口 `dist/convert.js` 仅导出 `renderContract(a, opts)` 与 `kImplementedKinds`；
> 完整管线为 `Parser.convertText(text) → ContractA` → `renderContract` → `PartsAssembler.assemble` → `Squeeze.pack` → `.vsdx` 字节；
> `exports` 只声明了 `"."` 与 `"./package.json"`，README 推荐的深路径导入当前**不可用**（`ERR_PACKAGE_PATH_NOT_EXPORTED`）；
> `package.json` 亦缺 `"types"`。`useConnectorMaster` 选项已消失（母版改为程序化装配）。

---

## 1. 决策记录（已拍板）

| 编号 | 决策 | 结论 | 对本方案的影响 |
|---|---|---|---|
| **D1** | M7 接口修复路线 | **A**：上游补稳定门面（`convertText`/`shutdown` + `types` + 子路径导出） | P0-1 只走 A 路线；B/C 移入附录 A（不实施） |
| **D2** | 分发边界 | **C1**：我方发行包**不含** mmd2vsdx，图嵌入为运行时可选能力 | P0-3 按 C1 落地；P1-2 不打包上游，只做"能力缺失时的可读提示" |
| **D3** | 依赖固化 | **暂不固化**，保持 `link:../../../tool-mmd2vsdx` 本地开发 | P1-1 **顺延至发布前**，不作为当前批次 |

---

## 2. P0 阶段（阻塞级，必须先做）

### P0-1 M7 接口修复

**目标**：`pnpm cli:test-export -- … --embed-visio` 真实产出含 OLE 对象的 docx，且 GUI 导出同样生效。

**步骤（路线 A，已拍板）**
1. 上游 `tool-mmd2vsdx`：
   - 新增门面 `dist/index.js`（或 `application` 对象），导出 `convertText(text, opts) → {ok, vsdxBase64, previewPngBase64?, error?}` 与 `shutdown()`；
   - `package.json` 补 `"types": "./dist/index.d.ts"`，并把 `exports` 扩为 `{".": …}` + 可选子路径（`./parser`、`./convert`、`./xml-parts`、`./squeeze`）；
   - README 的用法示例与 `exports` 对齐。
2. 我方 `packages/docx/src/figure-export.ts`：
   - `loadMmd2vsdxConverter()` 改为消费新门面（保留现有 `MmdConverter` 形状，调用方零改动）；
   - 删除/忽略 `useConnectorMaster`（新 API 无此概念）；
   - `shutdown()` 映射到上游 `Parser.shutdown()`，并保留 5s 超时外壳。
3. 类型：删除两份手写 `.d.ts`（`packages/docx/src/mmd2vsdx.d.ts`、`apps/desktop/src/main/mmd2vsdx.d.ts`），改用上游真实类型；若上游暂未提供，则只保留一份并标注"必须随上游同步"。
4. 清理：`apps/desktop/cli/test-export.cjs` 中已失效的 `{ mode: figureMode }` 传参。

**共同步骤**
5. 真实链路回归：用 `localtest/templates` 的 438C SDD 模板跑 12 图 E2E（`--embed-visio` + GUI 各一遍），Word 打开验收（OLE 双击激活、画布一致）。
6. 记录结果：更新 `docs/M7-合规说明.md` §6 验证表与 `docs/PLAN-04-…md` 附录状态。

**涉及文件**：`packages/docx/src/figure-export.ts`、`packages/docx/src/mmd2vsdx.d.ts`、`apps/desktop/src/main/mmd2vsdx.d.ts`、`apps/desktop/src/main/services/project-service.ts`、`apps/desktop/cli/test-export.cjs`、上游 `package.json` + 门面模块。

**验收**：CLI 输出 `Figures: total=N converted=N embedded=N`；产物含 `w:object`/`o:OLEObject`/`oleObjectN.bin`；Word 无修复提示。

### P0-2 真实链路门禁与上游锚定 ✅ 已完成（2026-09-09）

**目标**：接口再漂移时**立刻红灯**，而不是静默降级。

**已交付**

1. **真实契约测试** `packages/docx/tests/mmd2vsdx.contract.test.ts`：
   - 默认跳过，`DOC_REAL_MMD=1` 运行（脚本 `pnpm --filter @documentor/docx test:real`，需 Chromium）；
   - **不注入**转换器，直接走真实上游加载器 → 真实 Mermaid→VSDX → 真实 OLE 嵌入；
   - 断言 `converted/embedded === total`、`failed === []`、产物含 `<o:OLEObject Type="Embed" ProgID="Visio.Drawing.15"`、
     `word/embeddings/oleObject1.bin` 为合法 CFB（Package 流非空）；
   - 失败信息指向 `docs/UPSTREAM-mmd2vsdx.md` 与 P0-1。
2. **上游锚定检查** `scripts/check-upstream.cjs`（静态、毫秒级）：
   - 从 `apps/desktop`/`packages/docx` 解析 `mmd2vsdx/package.json`；
   - 校验包名、可解析入口、类型声明、入口是否导出门面 `convertText`/`shutdown`（或旧形态 `application`）；
   - 不一致 → 非零退出 + 期望/实际差异 + 修复指引。
3. **一键门禁**（根 `package.json`）：`verify` = 上游检查 → typecheck → 全量单测 → build（fail-fast）；
   `verify:local` = 跳过上游检查的日常门禁（上游改造期间使用）。
4. **锚定记录** `docs/UPSTREAM-mmd2vsdx.md`：上游位置/快照 commit、消费契约、唯一消费点、同步清单、门禁入口。

**实测结果（2026-09-09）**

| 检查 | 结果 |
|---|---|
| `node scripts/check-upstream.cjs` | ✗ 红灯（预期）：入口缺 `convertText`/`shutdown`、未声明类型 |
| `pnpm --filter @documentor/docx test:real` | ✗ 红灯（预期）：`Cannot read properties of undefined (reading 'convertText')`，带 P0-1 指引 |
| `pnpm --filter @documentor/docx test` | ✅ 20 通过 + 1 跳过（契约测试默认跳过） |
| `pnpm verify:local` | ✅ 全绿 |

> 红灯是**预期状态**：门禁正是为了在 P0-1 完成前持续暴露该缺口。

### P0-3 合规复核与分发边界 ✅ 已完成（2026-09-09）

**目标**：把"发行包内不含第三方版权内容"这条既有边界重新落实。

1. 事实固定：上游 `dist/common/masters/templates/{class,er,gantt,sequence}.js` 逐字内嵌官方母版 XML（含 MS 版权 Cell），上游仓库另跟踪约 280 个官方模板解压文件。
2. 按 **D2-C1** 执行：
   - 我方**发行产物不含** `mmd2vsdx`（`link:` 仅开发期使用；打包时排除）；
   - 图嵌入作为"运行时可选能力"：缺省给出可读提示（文案口径见 `docs/产品文案口径.md`），不因缺失而中断导出；
   - 若确需随包提供，必须先取得上游"去除官方母版内嵌"的版本（D2-C2）——**不采用**。
3. 文档改写 `docs/M7-合规说明.md`（已完成）：
   - 开头增 2026-09-09 修订说明（接口漂移 + 母版内嵌 + C1 结论）；
   - §2 许可证表补"官方母版 XML：Microsoft EULA、不随我方分发"行；
   - §3.2 重写为"上游母版资产与分发边界（C1）"，旧四级供应降为历史说明；
   - §6 验证表标注"真 E2E / Word 真机 / 结构复核待重验"，单测与类型检查按本次复核更新；
   - §7 遗留项改为指向 PLAN-05 的结论性条目。
4. README 增"运行时前置条件与边界"小节（模板目录 / 图转换可选能力 / 上游契约位置 / 已知状态）。

**验收**：合规文档不再出现与上游现状矛盾的断言；发行包不含上游 dist 与官方母版内容（打包阶段 P1-2 复核）。

---

## 3. P1 阶段（发布前必须）

### P1-1 依赖形态固化（顺延至发布前）

> D3 已拍板：当前保持 `link:` 本地开发，本节不作为本批次工作项，仅保留发布前的执行方案。

1. 按 **D3** 选型：
   - submodule：`git submodule add <url> vendor/mmd2vsdx` + `pnpm-workspace.yaml` 纳入；`link:../../../tool-mmd2vsdx` → `link:../../vendor/mmd2vsdx`（或 registry 版本）。
   - registry：上游放开 `private`，按版本 pin（`pnpm.overrides`）。
2. 换机验证：干净目录 `pnpm install && pnpm verify` 通过（当前 `link:../../../tool-mmd2vsdx` 在别的机器上必然失败）。
3. 运行时前置文档化：`npx playwright install chromium`；打包场景下 `PLAYWRIGHT_BROWSERS_PATH` 与浏览器目录的处理方式。

### P1-2 打包与安全加固 ✅ 已完成（2026-09-09）

**已交付**

1. **electron-builder 26**（`apps/desktop` devDependency + `electron-builder.yml`）：
   `appId`/`productName`/`directories.output: release`/`asar`/`win.target: nsis`/`nsis.oneClick: false`；
   `files` 按 **C1 排除** `mmd2vsdx`；复用本地 Electron 二进制（`electronDist`，避免重复下载）。
   根脚本：`pnpm package:dir`（免安装）/ `pnpm package`（NSIS）。
2. **生产 CSP**（`electron.vite.config.ts`，仅构建期注入 `<meta>`）：
   - 防闪烁内联脚本以 **sha256 哈希**放行（比原方案的"抽文件"更严格：`script-src` 无 `'unsafe-inline'`）；
   - `file:` 来源显式列入（`loadFile` 下 Chromium 不匹配 `'self'`）；
   - `style-src 'unsafe-inline'`（Mermaid/KaTeX 运行期注入样式）、`img-src data: blob:`；
   - 开发环境不注入（HMR 需内联脚本与 ws）。
3. **sandbox: true**（预加载产物仅 `require('electron')`，验证通过）。
4. **产物内容校验** `scripts/verify-package.cjs`：必需项齐全 / `mmd2vsdx` 0 条 / 无开发依赖 / 无 source map。
5. **打包回归**：`win-unpacked` 冒烟（新建工程 → 落库 → 导出）通过。

**实测结果**

| 检查 | 结果 |
|---|---|
| `electron-vite preview` 生产产物 E2E（DOC_E2E 全流程 + 物理点击重放） | ✅ 通过（CSP 未阻断、sandbox 生效、导出降级提示正确） |
| `pnpm package:dir` + `node scripts/verify-package.cjs` | ✅ asar 80.2 MB；`mmd2vsdx` 0 条；必需项齐全 |
| `win-unpacked/Documentor.exe` 冒烟 | ✅ 进程存活；工作区产出 `documentor.dproj` + `documentor.db` + 导出 docx |
| `electron-builder --win`（NSIS） | ✅ `release/Documentor-0.1.0-alpha1-setup.exe`（125.1 MB） |

**遗留**：无 GitHub 网络时 `winCodeSign` 下载会失败（本地验证用 `--config.win.signAndEditExecutable=false` 绕过）；
应用图标与代码签名属发布阶段事项；**安装包未在本机实际安装**（避免改动系统，安装行为待用户验收）。

---

## 4. P2 阶段（收尾）

### P2-1 文档校正 ✅ 已完成（2026-09-09）

| 文件 | 改动 | 状态 |
|---|---|---|
| `docs/PLAN-01-项目规划与架构.md` | §6 M2 行改「✅（M6 收尾）」；M7 行补「⚠ 实现已完成、接口待对齐」；§10 增 P0-2/P0-3/P1-2 实施记录 | ✅ |
| `docs/PLAN-03-模板关联方案.md` | 标题去「（待实施）」；§4 清单勾选并注明落地 commit | ✅ |
| `docs/PLAN-04-M7-图嵌入链路方案.md` | 附录标注"接口漂移后待重验"；M7d 同步"单一路径自动嵌入"；M7e 改 ⚠ | ✅ |
| `docs/M7-合规说明.md` | 见 P0-3 | ✅ |
| `README.md` | 运行时前置条件、`pnpm verify`、打包与安全、当前图嵌入状态 | ✅ |
| `docs/产品文案口径.md` | "能力缺失时的提示语"条目（面向人、不暴露内部） | 待补 |

### P2-2 工程卫生（部分完成）

1. ✅ `scripts/` 落地 `check-upstream.cjs`（P0-2）与 `verify-package.cjs`（P1-2）。
2. ⏸ **CI 阻塞于 P1-1**：`pnpm install` 需要本机 `link:../../../tool-mmd2vsdx`，CI 环境不存在该目录；
   依赖形态固化（submodule/registry）完成前无法建立可用流水线。当前提交门禁为本地 `pnpm verify:local`
   （+ 打包后 `node scripts/verify-package.cjs`）。
3. ⏸ `backup/2026-09-09-pre-integrate` **保留**：内容与 main 一致（`git diff` 为空），
   但历史不同（rebase 前的提交指针），删除需 `-D` 强删并丢失该指针。作为安全网保留；
   如需清理：`git branch -D backup/2026-09-09-pre-integrate`。
4. ✅ "git 历史仍含已剥离资产"的说明保留在 `docs/PLAN-01` §8/§10 与 `docs/M7-合规说明.md`。

---

## 5. 执行顺序与依赖

```
P0-1 上游门面 + 我方适配 ──→ P0-1 真实回归（12 图 + Word）
      │                              │
      └─ P0-2 门禁（可先行）─────────┤
                                     └─ P0-3 合规复核与文档边界（C1）
                                             └─ P1-2 打包与安全加固
                                                     └─ P2-1 文档校正 ──→ P2-2 工程卫生
（P1-1 依赖固化：顺延至发布前，不阻塞本批次）
```

- P0-2 与 P0-1 可并行（门禁先立，能立刻暴露 P0-1 的完成度）。
- P0-3 不依赖代码修复，可即刻启动（结论已定 C1）。
- P1-2 不打包上游（C1），只做"能力缺失时的可读提示"与安全加固。

---

## 6. 验收矩阵

| 阶段 | 验收命令/动作 | 通过标准 |
|---|---|---|
| P0-1 | `pnpm cli:test-export -- resources/test-fixtures/instance-sample.json out.docx --templates resources/test-fixtures/sample-template --embed-visio` | `converted=1 embedded=1`；产物含 OLE 部件 |
| P0-1 | GUI 导出 + Word 打开（本地 438C SDD 12 图） | 12 个 OLE 对象、双击激活、无修复提示 |
| P0-2 | `DOC_REAL_MMD=1 pnpm --filter @documentor/docx test` | 真实转换契约测试通过 |
| P0-2 | `pnpm verify`（人为改坏上游 exports 后） | 非零退出且指出差异 |
| P0-3 | 发行包清单核对 | 不含上游 dist / 官方母版内容 |
| P1-1 | 干净目录 `pnpm install && pnpm verify` | 全绿（无需本机 `D:\_dev\tool-mmd2vsdx`） |
| P1-2 | 安装包启动 + `DOC_E2E` 冒烟 | 主流程通过；生产 CSP 生效且页面无告警阻断 |
| P2 | 文档一致性走查 | 无与现状矛盾的断言；`pnpm verify` 全绿 |

---

## 7. 风险登记

| 风险 | 等级 | 对策 |
|---|---|---|
| 上游继续重构，门面再次漂移 | 高 | P0-2 锚定检查 + 真实契约测试；`docs/UPSTREAM-mmd2vsdx.md` 同步清单 |
| 上游拒绝恢复门面/去除母版 | 中 | 走 B 路线（宿主注入）保功能；D2-C1 保合规 |
| 打包后 Chromium 路径失效 | 中 | P1-1 文档化 `PLAYWRIGHT_BROWSERS_PATH`；打包回归纳入验收 |
| CSP 收紧打断 Mermaid/KaTeX 内联样式 | 中 | 保留 `style-src 'unsafe-inline'`；以安装包实测为准 |
| `node:sqlite` 在打包环境的可用性 | 低 | 已有 Electron E2E 佐证；P1-2 回归再验 |

---

## 8. 工作量估算（不含上游协调等待）

| 阶段 | 估算 | 状态 |
|---|---|---|
| P0-1 接口修复 + 真实回归 | 0.5–1 天 | 待执行（上游门面在另一会话推进中） |
| P0-2 门禁与锚定 | 0.5 天 | ✅ 完成 |
| P0-3 合规复核与文档 | 0.5 天 | ✅ 完成 |
| P1-1 依赖固化 | 顺延（发布前） | 顺延 |
| P1-2 打包与安全 | 1–1.5 天 | ✅ 完成 |
| P2 收尾 | 0.5 天 | 主体完成（CI 阻塞于 P1-1） |

> 剩余：P0-1（依赖上游门面）+ P2-2 的两项收尾。

---

## 附录 A：未采用的备选路线（D1 已排除）

**B 我方桥接（今天就能跑通，不依赖上游）**：把"上游加载器"从库内默认值改为**宿主注入**——`packages/docx` 保留 `loadConverter` 注入点；`apps/desktop/src/main/services/mmd-loader.ts`（CJS，用 `require.resolve('mmd2vsdx/package.json')` 定位包根后动态 import 四个内部模块）在 `project-service.exportDocx` 传入；CLI 复用同一加载器。缺点：耦合上游内部路径，上游再挪文件就再坏一次。**仅在 A 路线被上游阻塞时启用。**

**C 上游仅补子路径导出**：改动比 A 小，但我方需显式编排四步管线、且拿不到单一错误边界。**作为 A 的降级形态保留。**

---

## 9. 执行进度

**已完成（2026-09-09）**

- P0-2：`scripts/check-upstream.cjs`、`packages/docx/tests/mmd2vsdx.contract.test.ts`（+`test:real`）、
  根 `verify`/`verify:local`、`docs/UPSTREAM-mmd2vsdx.md`。
- P0-3：`docs/M7-合规说明.md`（C1 分发边界 + 待重验标注）、README「运行时前置条件与边界」。
- P1-2：electron-builder（NSIS/免安装两档，C1 排除上游）、生产 CSP（哈希放行内联脚本）、
  `sandbox: true`、`scripts/verify-package.cjs`；生产产物 E2E + 打包应用冒烟均通过。
- P2-1：PLAN-01/03/04、README、产品文案口径校正。
- P2-2：`scripts/` 落地；CI 阻塞于 P1-1（记录原因）。

**下一步**

1. **P0-1**（阻塞于上游）：上游门面 `convertText`/`shutdown` + `types` + 子路径导出就绪后，
   切换 `loadMmd2vsdxConverter()` → 跑 `pnpm verify`（上游检查与真实契约测试转绿）→ 12 图真实回归 + Word 验收。
2. P2-2 收尾：清理 `backup/2026-09-09-pre-integrate`；P1-1 完成后补 CI。

**当前门禁状态**

| 命令 | 状态 |
|---|---|
| `pnpm verify:local` | ✅ 绿 |
| `node scripts/verify-package.cjs` | ✅ 绿（打包后） |
| `node scripts/check-upstream.cjs` | ✗ 红灯（预期，P0-1 后转绿） |
| `pnpm --filter @documentor/docx test:real` | ✗ 红灯（预期，P0-1 后转绿） |
