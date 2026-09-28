# make-preview-template.ps1 — 生成"带示意文字的预览图模板"（EMF+ 双格式，按比例与尺寸分档），并产出内联用的 TS 常量。
# 用法：powershell -File packages/postprocess/scripts/make-preview-template.ps1
#
# 产出：
#   packages/postprocess/resources/preview-template-<比例>-<长边px>.emf   各档模板（留档、便于比对）
#   packages/postprocess/src/preview-template.ts                          内联 base64 常量（运行时用，避免打包漏带资源）
#
# 为什么要分档（两份实测结论）：
#   1. 比例：模板画面的像素比例与运行时声明的物理比例不一致时，非等比映射会把边框和文字挤掉一部分；
#   2. 尺寸：模板画面的"自然尺寸"（像素 ÷ 参考dpi）若大于声明矩形，文字会被裁掉；小于则缩在角落。
#      ⇒ 运行时挑"自然尺寸 ≤ 声明尺寸"里最大的一档：既不裁，又尽量贴近对象大小。
#
# 每档固定规格（与 preview.ts 的运行时改写保持一致）：
#   参考设备 1920x1080 px / 508x286 mm（96dpi）+ EMF+ LogicalDpi 120 ⇒ 比值 1.25（常规值，不改）
#   画面 = 浅灰边框 + 两行提示文字（GDI+ 生成，两层内容一致）
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$resDir = Join-Path $root 'packages\postprocess\resources'
$outTs = Join-Path $root 'packages\postprocess\src\preview-template.ts'
New-Item -ItemType Directory -Force $resDir | Out-Null
Get-ChildItem $resDir -Filter 'preview-template*.emf' -ErrorAction SilentlyContinue | Remove-Item -Force

# 比例档：**按几何铺开**，2 倍步长覆盖 1:32 ~ 32:1（11 档）。
# 不是随手挑的几个数：预览要多大、什么比例，只有消费端（documentor）知道，生产端只给 .vsdx；
# 所以这里要能覆盖任意画布比例 ⇒ 最坏情况（落在两档之间）单轴铺满 ≈ 1/√2 = 0.71，而不是 0.09。
$aspects = @(0.03125, 0.0625, 0.125, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0)
# 尺寸档：长边像素，√2 步长从 24px（≈0.17in，够最小的对象框）到 1085px（≈7.5in，够最高的对象框）。
$longSides = @(24, 34, 48, 68, 96, 136, 192, 272, 384, 543, 768, 1085)

# 估一行文字的像素宽度：汉字约等于字号，拉丁约 0.55 倍
function Get-TextWidth([string]$Text, [double]$FontSize) {
    $w = 0.0
    foreach ($ch in $Text.ToCharArray()) {
        if ([int]$ch -lt 0x2e80) { $w += $FontSize * 0.55 } else { $w += $FontSize }
    }
    return $w
}

function New-Template {
    param([double]$Aspect, [int]$LongSide, [string]$OutEmf)
    if ($Aspect -ge 1) { $pxW = $LongSide; $pxH = [int][Math]::Round($LongSide / $Aspect) }
    else { $pxH = $LongSide; $pxW = [int][Math]::Round($LongSide * $Aspect) }
    $short = [Math]::Min($pxW, $pxH)

    # 两行提示（GDI+ 自己写多行没问题；运行时不要手写记录）
    $line1 = 'mmd2vsdx 生成'
    $line2 = '双击用 Visio 查看'
    if ($pxW -lt 300) { $line1 = 'mmd2vsdx'; $line2 = '双击查看' }
    # 边框内缩比例：越大内容越向中心收（人验口径：内容要"向中心变小集中"）
    $margin = [Math]::Max(4, [Math]::Round($short * 0.12))
    $innerW = $pxW - 2 * $margin

    # 字号：先按短边取，再按"最长一行不超画面宽 × 0.7"收窄。
    # 估算必须保守：GDI+ 实际渲染宽度比"汉字 = 字号"的估算宽约 1.35 倍，否则 NoWrap 下会剪掉尾巴。
    $fontSize = [Math]::Max(5, [Math]::Round($short * 0.055))
    while ($fontSize -gt 5) {
        $w1 = Get-TextWidth $line1 $fontSize
        $w2 = Get-TextWidth $line2 $fontSize
        if ([Math]::Max($w1, $w2) * 1.35 -le $pxW * 0.7) { break }
        $fontSize--
    }

    $bmp = New-Object System.Drawing.Bitmap 1, 1
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    try {
        $rect = New-Object System.Drawing.Rectangle 0, 0, $pxW, $pxH
        $mf = New-Object System.Drawing.Imaging.Metafile($OutEmf, $hdc, $rect,
            [System.Drawing.Imaging.MetafileFrameUnit]::Pixel,
            [System.Drawing.Imaging.EmfType]::EmfPlusDual)
        $mg = [System.Drawing.Graphics]::FromImage($mf)
        try {
            $mg.Clear([System.Drawing.Color]::White)
            $penW = [Math]::Max(1, [Math]::Round($short * 0.008))
            $border = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(190, 190, 190)), $penW
            $mg.DrawRectangle($border, $margin, $margin, $pxW - 2 * $margin - 1, $pxH - 2 * $margin - 1)
            $border.Dispose()

            $font = New-Object System.Drawing.Font 'Microsoft YaHei', $fontSize
            $fmt = New-Object System.Drawing.StringFormat
            $fmt.Alignment = [System.Drawing.StringAlignment]::Center
            $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
            # NoWrap：绝不换行（窄框换行会挤成两行、看起来更乱）；行宽已按内框宽收过
            $fmt.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
            $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(110, 110, 110))
            # 文字画在"整幅宽 + 内缩后的上下半区"里：左右留足不裁切，上下按 margin 向中心收
            $innerH = $pxH - 2 * $margin
            $half = $innerH / 2
            $rectTop = New-Object System.Drawing.RectangleF 0, $margin, $pxW, $half
            $rectBottom = New-Object System.Drawing.RectangleF 0, ($margin + $half), $pxW, $half
            $mg.DrawString($line1, $font, $brush, $rectTop, $fmt)
            $mg.DrawString($line2, $font, $brush, $rectBottom, $fmt)
            $brush.Dispose()
            $font.Dispose()
        } finally { $mg.Dispose() }
        $mf.Dispose()
    } finally {
        $g.ReleaseHdc($hdc)
        $g.Dispose()
        $bmp.Dispose()
    }

    # 规格化：参考设备 96dpi；声明尺寸 = 像素 ÷ 96（= 画面自然尺寸）；EMF+ LogicalDpi 120
    $bytes = [IO.File]::ReadAllBytes($OutEmf)
    [BitConverter]::GetBytes([int]0).CopyTo($bytes, 24)
    [BitConverter]::GetBytes([int]0).CopyTo($bytes, 28)
    [BitConverter]::GetBytes([int][Math]::Round($pxW / 96.0 * 2540)).CopyTo($bytes, 32)
    [BitConverter]::GetBytes([int][Math]::Round($pxH / 96.0 * 2540)).CopyTo($bytes, 36)
    [BitConverter]::GetBytes([int]1920).CopyTo($bytes, 72)
    [BitConverter]::GetBytes([int]1080).CopyTo($bytes, 76)
    [BitConverter]::GetBytes([int]508).CopyTo($bytes, 80)
    [BitConverter]::GetBytes([int]286).CopyTo($bytes, 84)
    $scan = [BitConverter]::ToInt32($bytes, 4)
    while ($scan + 8 -le $bytes.Length) {
        $rt = [BitConverter]::ToInt32($bytes, $scan)
        $rs = [BitConverter]::ToInt32($bytes, $scan + 4)
        if ($rs -lt 8 -or ($scan + $rs) -gt $bytes.Length) { break }
        if ($rt -eq 70 -and [BitConverter]::ToInt16($bytes, $scan + 16) -eq 0x4001) {
            [BitConverter]::GetBytes([int]120).CopyTo($bytes, $scan + 36)
            [BitConverter]::GetBytes([int]120).CopyTo($bytes, $scan + 40)
            break
        }
        if ($rt -eq 14) { break }
        $scan += $rs
    }
    [IO.File]::WriteAllBytes($OutEmf, $bytes)
    return @{ PxW = $pxW; PxH = $pxH; Bytes = $bytes.Length; Aspect = [Math]::Round($pxW / $pxH, 4) }
}

$entries = @()
foreach ($ls in $longSides) {
    foreach ($a in $aspects) {
        $atag = ('{0:0.###}' -f $a).Replace('.', '_')
        $emf = Join-Path $resDir ("preview-template-{0}-{1}.emf" -f $atag, $ls)
        $info = New-Template -Aspect $a -LongSide $ls -OutEmf $emf
        $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($emf))
        $entries += [PSCustomObject]@{
            Aspect = $info.Aspect; PxW = $info.PxW; PxH = $info.PxH
            NaturalWIn = [Math]::Round($info.PxW / 96.0, 4); NaturalHIn = [Math]::Round($info.PxH / 96.0, 4)
            Base64 = $b64; Bytes = $info.Bytes
        }
    }
    Write-Output ("尺寸档 长边 {0}px 已生成（{1} 个比例档）" -f $ls, $aspects.Count)
}

# —— 产出内联 TS 常量 ——
$tsLines = @(
    '/**',
    ' * preview-template.ts — 带示意文字的预览图模板（EMF+ 双格式，base64 内联，按比例与尺寸分档）。',
    ' *',
    ' * 由 packages/postprocess/scripts/make-preview-template.ps1 生成，请勿手改：',
    ' *   · 参考设备 1920x1080 px / 508x286 mm（96dpi）+ EMF+ LogicalDpi 120（都是常规值）；',
    ' *   · 声明尺寸 = 画面像素 ÷ 96 = 画面自然尺寸（模板内已如此）；运行时按对象画布改写声明尺寸；',
    ' *   · 运行时挑"自然尺寸 ≤ 声明尺寸"里最大的一档：文字既不裁、也不缩在角落；',
    ' *   · 画面 = 浅灰边框 + 两行提示文字，两层内容一致（EMF+ 感知的渲染器也能显示）。',
    ' */',
    'export interface PreviewTemplate {',
    '  /** 宽高比 */',
    '  aspect: number',
    '  /** 画面设备像素宽 */',
    '  pxW: number',
    '  /** 画面设备像素高 */',
    '  pxH: number',
    '  /** 画面自然宽（英寸，= pxW ÷ 96） */',
    '  naturalWIn: number',
    '  /** 画面自然高（英寸） */',
    '  naturalHIn: number',
    '  /** EMF 字节的 base64 */',
    '  base64: string',
    '}',
    '',
    'export const PREVIEW_TEMPLATES: PreviewTemplate[] = ['
)
foreach ($e in $entries) {
    $tsLines += ("  {{ aspect: {0}, pxW: {1}, pxH: {2}, naturalWIn: {3}, naturalHIn: {4}, base64:" -f $e.Aspect, $e.PxW, $e.PxH, $e.NaturalWIn, $e.NaturalHIn)
    $b64 = $e.Base64
    for ($i = 0; $i -lt $b64.Length; $i += 100) {
        $len = [Math]::Min(100, $b64.Length - $i)
        $suffix = if ($i + $len -lt $b64.Length) { " +" } else { '' }
        $tsLines += ("    '" + $b64.Substring($i, $len) + "'" + $suffix)
    }
    $tsLines += '  },'
}
$tsLines += ']'
$tsLines += @(
    '',
    '/** 兜底：取第一个（档位恒定非空） */',
    'export const PREVIEW_TEMPLATE_BASE64 = PREVIEW_TEMPLATES[0]!.base64'
)
$ts = ($tsLines -join "`r`n") + "`r`n"
[IO.File]::WriteAllText($outTs, $ts, (New-Object Text.UTF8Encoding($false)))
$totalB64 = ($entries | ForEach-Object { $_.Base64.Length } | Measure-Object -Sum).Sum
Write-Output ("已写出 {0}（{1} 档，合计 base64 {2} 字符）" -f $outTs, $entries.Count, $totalB64)
