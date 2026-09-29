<#
  visio-normalize.ps1 — 用一次 Visio（COM）批处理：每张 vsdx 重存一遍并导出预览 EMF。

  为什么要有它：嵌入 vsdx 时连线端点/走线若由生成侧"复刻"Visio 的求解结果，Word 首帧会偏移；
  让 Visio 自己重存一次就从"复刻"变成"取真值"（详见 docs/WORD处理经验/10）。

  调用形态（主进程侧见 packages/desktop/src/main/services/visio-service.ts）：
    powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File visio-normalize.ps1 -Manifest <清单.json> [-PidFile <pid.txt>]
  清单：{ "items": [ { "id": "...", "in": "x.vsdx", "outVsdx": "x.out.vsdx", "outEmf": "x.emf" } ] }
  回执（stdout，单行 JSON）：[ { "id": "...", "ok": true } | { "id": "...", "ok": false, "reason": "..." } ]

  硬约束（改脚本前先读）：
    1. **一律新建实例**（New-Object -ComObject），不接管用户已打开的 Visio；
    2. 不可见 + 抑制弹框（AlertResponse=No to All）：绝不能让对话框把导出挂住；
    3. 单会话批量：启动一次处理全部图，别每张都起一次 Visio；
    4. 逐张 try/catch：一张失败不影响其余；失败项由调用方回退到内置方案；
    5. **不许留进程**：Quit 之后要按 PID 复核，还在就强杀（Quit 会因 "callee busy" 静默失败，
       残留一个隐藏的 VISIO.EXE —— 2026-09-29 就是这么留出孤儿进程的）；PID 同时写进 -PidFile，
       父进程（Node）在超时/被杀时也能按它兜底清理；
    6. **本文件必须带 UTF-8 BOM**：Windows PowerShell 5.1 按 ANSI 读无 BOM 的 .ps1，
       中文注释会让脚本直接语法错误（改完记得保留 BOM）。
#>
param(
  [Parameter(Mandatory = $true)][string]$Manifest,
  [int]$AlertResponse = 7,
  [string]$PidFile = ''
)

$ErrorActionPreference = 'Stop'
$script:Started = Get-Date

# 具名常量：脚本里别留魔法数（改的时候要一眼看懂含义）
$OPEN_COPY_READONLY = 6      # visOpenCopy(4) + visOpenRO(2)：开只读副本，不碰用户原文件
$QUIT_WAIT_TRIES = 10        # Quit 之后等它退：最多 10 次
$QUIT_WAIT_MS = 300          # 每次 300ms（合计 3s）；还不退就强杀

$items = (Get-Content -Raw -Encoding UTF8 -LiteralPath $Manifest | ConvertFrom-Json).items
$results = New-Object System.Collections.ArrayList

# 拿到"我们刚起的那个 Visio"的 PID：优先用窗口句柄反查，拿不到就取启动时间在本次之后的最新进程
function Resolve-VisioPid($app) {
  try {
    $hwnd = [int64]$app.WindowHandle
    if ($hwnd -ne 0) {
      Add-Type -Namespace Doc -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
'@ -ErrorAction SilentlyContinue
      $owner = [uint32]0
      [void][Doc.Native]::GetWindowThreadProcessId([System.IntPtr]$hwnd, [ref]$owner)
      if ($owner -gt 0) { return [int]$owner }
    }
  } catch { }
  try {
    $p = Get-Process VISIO -ErrorAction SilentlyContinue |
      Where-Object { $_.StartTime -ge $script:Started.AddSeconds(-5) } |
      Sort-Object StartTime | Select-Object -Last 1
    if ($p) { return [int]$p.Id }
  } catch { }
  return 0
}

# 收尾：Quit → 复核 PID → 还活着就强杀（退出路径只有这一处，别在别处再写一份）
function Stop-VisioInstance($app, [int]$visioPid, [string]$pidFile) {
  if ($app -ne $null) {
    try { $app.Quit() } catch { }
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch { }
    try { [GC]::Collect(); [GC]::WaitForPendingFinalizers() } catch { }
  }
  if ($visioPid -gt 0) {
    for ($i = 0; $i -lt $QUIT_WAIT_TRIES; $i++) {
      if (-not (Get-Process -Id $visioPid -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds $QUIT_WAIT_MS
    }
    if (Get-Process -Id $visioPid -ErrorAction SilentlyContinue) {
      Write-Warning "Visio（pid $visioPid）没随 Quit 退出，强杀"
      Stop-Process -Id $visioPid -Force -ErrorAction SilentlyContinue
    }
  }
  if ($pidFile -ne '') {
    try { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue } catch { }
  }
}

$app = $null
$visioPid = 0
try {
  $app = New-Object -ComObject Visio.Application
  $visioPid = Resolve-VisioPid $app
  if ($PidFile -ne '' -and $visioPid -gt 0) {
    # 先写给父进程：万一 PowerShell 被强杀，Node 侧还能按这个 PID 兜底
    try { Set-Content -LiteralPath $PidFile -Value $visioPid -Encoding ASCII -Force } catch { }
  }
  $app.Visible = $false
  # 弹框一律按"否"回答：导出是无人值守的，任何对话框都会把整批卡死
  $app.AlertResponse = $AlertResponse
  $app.EventsEnabled = 0

  foreach ($item in $items) {
    $doc = $null
    try {
      # visOpenCopy(4) + visOpenRO(2)：打开副本且只读，不碰用户的原始文件
      $doc = $app.Documents.OpenEx($item.in, $OPEN_COPY_READONLY)
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
  Stop-VisioInstance $app $visioPid $PidFile
}

# 只输出 JSON：调用方按单行解析，日志另走 stderr
Write-Output ($results | ConvertTo-Json -Compress -Depth 5)
