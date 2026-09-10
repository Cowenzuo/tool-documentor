<#
  word-typography.ps1 —— 用 Word 回读产物的版式：逐样式给出字号、行距、段前后、缩进、对齐与中西文字体。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File docs\WORD处理经验\scripts\word-typography.ps1 -Path 出.docx

  说明：每个样式取第一个非空段落作为样本，输出的是 Word 解析后的有效值，不是样式表里的定义值。
        表格单元格单独取第一张表的第二行首格，看字号与行距有没有被正文样式带偏。
#>
param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
$full = (Resolve-Path -LiteralPath $Path).Path
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($full, $false, $true)
  "File      : " + $doc.Name
  "Paragraphs: " + $doc.Paragraphs.Count + "   Tables: " + $doc.Tables.Count
  "---- 逐样式有效值 ----"
  $seen = @{}
  foreach ($p in $doc.Paragraphs) {
    $name = $p.Style.NameLocal
    if ($seen.ContainsKey($name)) { continue }
    $text = ($p.Range.Text -replace "[\r\a]", '')
    if ($text.Length -eq 0) { continue }
    $seen[$name] = $true
    "  {0,-12} 字号={1,-5} 行距={2,-6} 段前={3,-5} 段后={4,-5} 左缩={5,-5} 首行={6,-5} 对齐={7,-3} 中文={8,-8} 西文={9}" -f `
      $name,
      $p.Range.Font.Size,
      [Math]::Round($p.LineSpacing, 1),
      [Math]::Round($p.SpaceBefore, 1),
      [Math]::Round($p.SpaceAfter, 1),
      [Math]::Round($p.LeftIndent, 1),
      [Math]::Round($p.FirstLineIndent, 1),
      $p.Alignment,
      $p.Range.Font.NameFarEast,
      $p.Range.Font.NameAscii
  }

  "---- 表格单元格 ----"
  if ($doc.Tables.Count -gt 0) {
    $t = $doc.Tables.Item(1)
    "  tables={0} rows={1} cols={2}" -f $doc.Tables.Count, $t.Rows.Count, $t.Columns.Count
    foreach ($cell in $t.Range.Cells) {
      $para = $cell.Range.Paragraphs.Item(1)
      "  首格样本：字号={0} 行距={1} 首行缩进={2} 对齐={3} 样式={4}" -f `
        $cell.Range.Font.Size,
        [Math]::Round($para.LineSpacing, 1),
        [Math]::Round($para.FirstLineIndent, 1),
        $para.Alignment,
        $para.Style.NameLocal
      break
    }
  }
  $doc.Close($false)
} finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
