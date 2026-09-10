<#
  word-captions.ps1 —— 用 Word 回读标题编号与题注域，并做域更新前后对比。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File docs\WORD处理经验\scripts\word-captions.ps1 -Path 出.docx

  看点：
    1. 标题编号取 Range.ListFormat.ListString，逐级看前几个是否连续；
    2. 题注段落靠"段内有域"识别，打印样式名与文本；
    3. 调用 Fields.Update() 更新全部域后再看一遍，编号应保持不变；
    4. 统计更新后带错误标记的域数量，正常为 0。

  注意：中文 Word 的样式名是"标题 1""标题 2"，取内置样式用 COM 常量（标题 1 为 -2，依次递减）。
#>
param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
$full = (Resolve-Path -LiteralPath $Path).Path
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($full, $false, $false)

  function Show-Headings($doc, $styleName, $max) {
    $n = 0
    foreach ($p in $doc.Paragraphs) {
      if ($p.Style.NameLocal -ne $styleName) { continue }
      $text = ($p.Range.Text -replace "[\r\a]", '')
      if ($text.Length -eq 0) { continue }
      $n++
      if ($n -le $max) { "    {0}  {1}" -f $p.Range.ListFormat.ListString, $text }
      if ($n -ge $max) { break }
    }
  }
  function Show-CaptionParas($doc, $max) {
    $n = 0
    foreach ($p in $doc.Paragraphs) {
      if ($p.Range.Fields.Count -eq 0) { continue }
      $text = ($p.Range.Text -replace "[\r\a]", '')
      $n++
      if ($n -le $max) { "    [{0}] {1}" -f $p.Style.NameLocal, $text }
      if ($n -ge $max) { break }
    }
  }

  $h1 = $doc.Styles.Item(-2).NameLocal
  $h2 = $doc.Styles.Item(-3).NameLocal
  $h3 = $doc.Styles.Item(-4).NameLocal

  "== 更新前 =="
  "  样式名：'{0}' / '{1}' / '{2}'" -f $h1, $h2, $h3
  "  -- 标题 1 --"; Show-Headings $doc $h1 2
  "  -- 标题 2 --"; Show-Headings $doc $h2 3
  "  -- 标题 3 --"; Show-Headings $doc $h3 5
  "  -- 含域的段落，前 6 个 --"; Show-CaptionParas $doc 6
  "  域总数：" + $doc.Fields.Count

  "== 更新后（等同于按 F9）=="
  $doc.Fields.Update() | Out-Null
  "  -- 含域的段落 --"; Show-CaptionParas $doc 6
  "  -- 标题 3 --"; Show-Headings $doc $h3 5

  $err = 0
  $types = @{}
  foreach ($f in $doc.Fields) {
    if ($f.Result.Text -match '!|Error') { $err++ }
    $k = [string]$f.Type
    if (-not $types.ContainsKey($k)) { $types[$k] = 0 }
    $types[$k] = $types[$k] + 1
  }
  "  带错误标记的域：" + $err
  "  域类型分布：" + (($types.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join '  ')
  $doc.Close($false)
} finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
