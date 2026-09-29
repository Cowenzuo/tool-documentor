<#
  visio-normalize.ps1 — 用一次 Visio（COM）批处理：每张 vsdx 重存一遍并导出预览 EMF。

  为什么要有它：嵌入 vsdx 时连线端点/走线若由生成侧"复刻"Visio 的求解结果，Word 首帧会偏移；
  让 Visio 自己重存一次就从"复刻"变成"取真值"（详见 docs/WORD处理经验/10）。

  调用形态（主进程 side 见 packages/desktop/src/main/services/visio-service.ts）：
    powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File visio-normalize.ps1 -Manifest <清单.json>
  清单：{ "items": [ { "id": "...", "in": "x.vsdx", "outVsdx": "x.out.vsdx", "outEmf": "x.emf" } ] }
  回执（stdout，单行 JSON）：[ { "id": "...", "ok": true } | { "id": "...", "ok": false, "reason": "..." } ]

  硬约束（改脚本前先读）：
    1. **一律新建实例**（CreateObject），不接管用户已打开的 Visio；
    2. 不可见 + 抑制弹框（AlertResponse=No to All）：绝不能让对话框把导出挂住；
    3. 单会话批量：启动一次处理全部图，别每张都起一次 Visio；
    4. 逐张 try/catch：一张失败不影响其余；失败项由调用方回退到内置方案；
    5. 退出必须走 finally 的 Quit()，否则会留下看不见的 Visio 进程。
#>
param(
  [Parameter(Mandatory = $true)][string]$Manifest,
  [int]$AlertResponse = 7,
  [string]$EmfKind = 'EMF'
)

$ErrorActionPreference = 'Stop'
$items = (Get-Content -Raw -Encoding UTF8 -LiteralPath $Manifest | ConvertFrom-Json).items
$results = New-Object System.Collections.ArrayList

$app = $null
try {
  $app = New-Object -ComObject Visio.Application
  $app.Visible = $false
  # 弹框一律按"否"回答：导出是无人值守的，任何对话框都会把整批卡死
  $app.AlertResponse = $AlertResponse
  $app.EventsEnabled = 0

  foreach ($item in $items) {
    $doc = $null
    try {
      # visOpenCopy(4) + visOpenRO(2)：打开副本且只读，不碰用户的原始文件
      $doc = $app.Documents.OpenEx($item.in, 6)
      # 重存即让 Visio 自己解一遍走线/端点/母版；输出件才是我们要嵌的那份
      $doc.SaveAs($item.outVsdx)
      $page = $doc.Pages.Item(1)
      # 按页面尺寸导出（不是文件自带的缩略图，那张是小图、放进 Word 会糊）。
      # **只传文件名**：PowerShell 解析不了 Export 的两参数重载（报 "Cannot find an overload"），
      # Visio 会按扩展名推断格式 —— 所以清单里的 outEmf 必须是 .emf 后缀。
      $page.Export($item.outEmf)
      $null = $results.Add([ordered]@{ id = $item.id; ok = $true })
    } catch {
      $null = $results.Add([ordered]@{ id = $item.id; ok = $false; reason = $_.Exception.Message })
    } finally {
      if ($doc -ne $null) {
        try { $doc.Close() } catch { }
      }
    }
  }
} catch {
  # 起不来（没装 / COM 被拦 / 许可问题）：整批标失败，调用方回退
  foreach ($item in $items) {
    $null = $results.Add([ordered]@{ id = $item.id; ok = $false; reason = $_.Exception.Message })
  }
} finally {
  if ($app -ne $null) {
    try { $app.Quit() } catch { }
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch { }
  }
}

# 只输出 JSON：调用方按单行解析，日志另走 stderr
Write-Output ($results | ConvertTo-Json -Compress -Depth 5)
