<#
  word-tables.ps1 —— 用 Word 回读表格：行列数、纵向合并的跨行分布。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File docs\WORD处理经验\scripts\word-tables.ps1 -Path 出.docx [-Index 1]

  看点：含纵向合并的表格不能用 Rows.Item(r).Cells 逐行取，会抛"无法访问此集合中单独的行"。
        改用 Range.Cells 遍历，按 RowIndex 分组，每行少掉的格数就是合并跨度。
        起点格归属合并的首行，因此被覆盖的行会少格。
#>
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$Index = 1
)

$ErrorActionPreference = 'Stop'
$full = (Resolve-Path -LiteralPath $Path).Path
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($full, $false, $true)
  "File   : " + $doc.Name
  "Tables : " + $doc.Tables.Count
  if ($doc.Tables.Count -lt $Index) { "序号超出表格数"; $doc.Close($false); return }

  $t = $doc.Tables.Item($Index)
  "Table  : rows={0} cols={1} cells={2}" -f $t.Rows.Count, $t.Columns.Count, $t.Range.Cells.Count

  $byRow = @{}
  foreach ($cell in $t.Range.Cells) {
    $r = $cell.RowIndex
    if (-not $byRow.ContainsKey($r)) { $byRow[$r] = @() }
    $byRow[$r] += ($cell.Range.Text -replace "[\r\a]", '')
  }
  foreach ($r in ($byRow.Keys | Sort-Object)) {
    "  row{0,3}: cells={1} [{2}]" -f $r, $byRow[$r].Count, ($byRow[$r] -join ' | ')
  }

  $merged = 0
  foreach ($r in $byRow.Keys) { if ($byRow[$r].Count -lt $t.Columns.Count) { $merged++ } }
  "小结：{0} 行中有 {1} 行因纵向合并而少格" -f $byRow.Count, $merged
  $doc.Close($false)
} finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
