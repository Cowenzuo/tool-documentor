<#
  word-images.ps1 —— 用 Word 回读内嵌图形与图片段落样式。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File docs\WORD处理经验\scripts\word-images.ps1 -Path 出.docx

  看点：InlineShapes.Count 应等于工程里的图片块数；图片段落的样式名与对齐能验证
        w:pStyle 是否写在了 w:pPr 首位（写错位置时 Word 忽略样式，段落落回正文体例）。
#>
param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
$full = (Resolve-Path -LiteralPath $Path).Path
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($full, $false, $true)
  "File        : " + $doc.Name
  "Paragraphs  : " + $doc.Paragraphs.Count
  "Tables      : " + $doc.Tables.Count
  "InlineShapes: " + $doc.InlineShapes.Count

  $sizes = @()
  for ($i = 1; $i -le [Math]::Min(3, $doc.InlineShapes.Count); $i++) {
    $s = $doc.InlineShapes.Item($i)
    $sizes += ("#{0} {1}x{2}pt type={3}" -f $i, [Math]::Round($s.Width, 1), [Math]::Round($s.Height, 1), $s.Type)
  }
  "FirstShapes : " + ($sizes -join ' | ')

  $hit = 0
  foreach ($p in $doc.Paragraphs) {
    if ($p.Range.InlineShapes.Count -le 0) { continue }
    $hit++
    if ($hit -le 3) {
      "ImagePara{0} : 样式='{1}' 对齐={2}" -f $hit, $p.Style.NameLocal, $p.Alignment
    }
  }
  "含图形的段落数：" + $hit
  $doc.Close($false)
} finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
