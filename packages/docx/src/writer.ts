/**
 * DocxWriter：以 docx 骨架目录为模板 → 重写 numbering.xml（列表组 numId 克隆）
 * 与 word/document.xml（正文重建、保留 sectPr）→ 打包输出 .docx。
 * 对齐旧版 docxwriter.cpp 的全部实测规则（命名空间单次声明/克隆 nsid/tmpl/外8内4边框…）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import JSZip from 'jszip'
import { resolveTableMerges } from '@documentor/core'
import type { StyleTemplateDef } from '@documentor/templates'
import type { WriteInstruction } from './instructions'
import { escapeXmlAttr, escapeXmlText } from './instructions'

// ---------- OOXML 命名空间（与旧版一致；wp 只声明一次，否则 Word 打不开） ----------
const XML_HEAD =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ' +
  'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" ' +
  'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" ' +
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ' +
  'xmlns:wpsCustomData="http://www.wps.cn/officeDocument/2013/wpsCustomData" ' +
  'xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" ' +
  'mc:Ignorable="w14 w15 wp14"><w:body>'

// 列表 styleId → 骨架 numbering.xml 中的 abstractNumId（实测映射）
const STYLE_TO_ABSTRACT: Record<string, string> = {
  '62': '7',
  '63': '9',
  '64': '3',
  '65': '6',
  '67': '4',
  '94': '0'
}

export interface WriteDocxResult {
  outputPath: string
  /** 克隆的列表组数 */
  clonedGroups: number
}

/**
 * 把指令序列写入 docx。
 * @param instructions 写入指令
 * @param styleDef 样式模板（skeletonPath 必须指向 docx 骨架目录）
 * @param outputPath 输出 .docx 路径
 */
export async function writeDocx(
  instructions: WriteInstruction[],
  styleDef: StyleTemplateDef,
  outputPath: string
): Promise<WriteDocxResult> {
  const skeletonDir = styleDef.skeletonPath
  if (!skeletonDir || !existsSync(join(skeletonDir, 'word', 'document.xml'))) {
    throw new Error(`样式骨架目录无效: ${skeletonDir}`)
  }

  const files = listFilesRecursive(skeletonDir)
  const readSkeleton = (rel: string): Buffer =>
    readFileSync(join(skeletonDir, rel))

  // ---------- 1. numbering.xml 列表克隆 ----------
  const numberingPath = files.find((f) => f === 'word/numbering.xml')
  let numberingXml: string | null = null
  let groupToNumId = new Map<number, number>()
  if (numberingPath) {
    numberingXml = readSkeleton(numberingPath).toString('utf8')
    const cloned = cloneNumberingForGroups(instructions, numberingXml)
    numberingXml = cloned.xml
    groupToNumId = cloned.groupToNumId
  }

  // ---------- 2. document.xml 正文重建（含图片嵌入） ----------
  const originalDocumentXml = readSkeleton('word/document.xml').toString('utf8')
  const sectPr = extractSectPr(originalDocumentXml)
  /** 图片可用区域：从骨架页面尺寸与页边距算出，不再写死宽度 */
  const mediaBox = mediaBoxOf(sectPr)
  const images: EmbeddedImage[] = []
  const imageByPath = new Map<string, EmbeddedImage>()
  const relsPath = 'word/_rels/document.xml.rels'
  let relsXml = files.includes(relsPath)
    ? readSkeleton(relsPath).toString('utf8')
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
  let nextRid = maxRid(relsXml) + 1
  let nextMedia = maxMediaIndex(files) + 1

  const addImage = (srcPath: string): EmbeddedImage | null => {
    const cached = imageByPath.get(srcPath)
    if (cached) return cached
    if (!existsSync(srcPath)) return null
    const data = readFileSync(srcPath)
    const ext = extOf(srcPath)
    const { w, h } = imageSizePx(data, ext)
    const { cx, cy } = fitEmu(w, h, mediaBox)
    const idx = nextMedia++
    const entry: EmbeddedImage = {
      srcPath,
      ext,
      relId: `rId${nextRid++}`,
      mediaPath: `word/media/image${idx}${ext}`,
      name: `image${idx}${ext}`,
      data,
      widthEmu: cx,
      heightEmu: cy
    }
    images.push(entry)
    imageByPath.set(srcPath, entry)
    return entry
  }

  const bodyXml = renderInstructions(instructions, groupToNumId, addImage)
  const documentXml = `${XML_HEAD}${bodyXml}${sectPr}</w:body></w:document>`

  // ---------- 2b. 图片部件：rels / Content_Types ----------
  let contentTypesXml: string | null = null
  if (images.length > 0) {
    const newRels = images
      .map(
        (e) =>
          `<Relationship Id="${e.relId}" ` +
          'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ' +
          `Target="${e.mediaPath.slice('word/'.length)}"/>`
      )
      .join('')
    relsXml = relsXml.replace('</Relationships>', newRels + '</Relationships>')

    const ctPath = '[Content_Types].xml'
    if (files.includes(ctPath)) {
      contentTypesXml = readSkeleton(ctPath).toString('utf8')
      const exts = [...new Set(images.map((e) => e.ext.slice(1).toLowerCase()))]
      let extra = ''
      for (const x of exts) {
        if (!new RegExp(`Extension="${x}"`, 'i').test(contentTypesXml)) {
          extra += `<Default Extension="${x}" ContentType="${imageMime(x)}"/>`
        }
      }
      if (extra) contentTypesXml = contentTypesXml.replace(/(<Types\b[^>]*>)/, `$1${extra}`)
    }
  }

  // ---------- 3. 打包 ----------
  const zip = new JSZip()
  for (const rel of files) {
    let content: Buffer
    if (rel === 'word/document.xml') {
      content = Buffer.from(documentXml, 'utf8')
    } else if (rel === 'word/numbering.xml' && numberingXml !== null) {
      content = Buffer.from(numberingXml, 'utf8')
    } else if (rel === relsPath && images.length > 0) {
      content = Buffer.from(relsXml, 'utf8')
    } else if (rel === '[Content_Types].xml' && contentTypesXml !== null) {
      content = Buffer.from(contentTypesXml, 'utf8')
    } else {
      content = readSkeleton(rel)
    }
    zip.file(rel, content)
  }
  for (const e of images) zip.file(e.mediaPath, e.data)
  // 骨架本身没有 document.xml.rels 时（极简骨架），按需补一份
  if (images.length > 0 && !files.includes(relsPath)) {
    zip.file(relsPath, Buffer.from(relsXml, 'utf8'))
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  const data = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'STORE',
    platform: 'DOS'
  })
  writeFileSync(outputPath, data)
  return { outputPath, clonedGroups: groupToNumId.size }
}

// ================= numbering 克隆 =================

function cloneNumberingForGroups(
  instructions: WriteInstruction[],
  numberingXml: string
): { xml: string; groupToNumId: Map<number, number> } {
  const result = new Map<number, number>()
  // 收集列表组 → styleId（保持指令出现顺序即 groupId 升序语义）
  const groupStyleIds = new Map<number, string>()
  for (const ins of instructions) {
    if (ins.opType === 'InsertParagraph' && ins.listGroupId > 0) {
      if (!groupStyleIds.has(ins.listGroupId)) {
        groupStyleIds.set(ins.listGroupId, ins.styleName)
      }
    }
  }
  if (groupStyleIds.size === 0) return { xml: numberingXml, groupToNumId: result }

  const nowMs = Date.now()
  let absIdStart = 200
  let numIdStart = 200
  const newAbstractNums: string[] = []
  const newNums: string[] = []

  // C++ QMap 按 key 升序遍历 → 数值排序保证确定性
  const groupIds = [...groupStyleIds.keys()].sort((a, b) => a - b)

  for (const groupId of groupIds) {
    const styleId = groupStyleIds.get(groupId)!
    const origAbsId = STYLE_TO_ABSTRACT[styleId]
    if (!origAbsId) continue

    const pattern = `<w:abstractNum w:abstractNumId="${origAbsId}"`
    const absStart = numberingXml.indexOf(pattern)
    if (absStart === -1) continue
    const absEndTag = '</w:abstractNum>'
    const absEndRaw = numberingXml.indexOf(absEndTag, absStart)
    if (absEndRaw === -1) continue
    const absEnd = absEndRaw + absEndTag.length
    let absBlock = numberingXml.slice(absStart, absEnd)

    // abstractNumId → 新 id
    const newAbsId = absIdStart++
    absBlock = absBlock.replace(`w:abstractNumId="${origAbsId}"`, `w:abstractNumId="${newAbsId}"`)

    // nsid / tmpl 重写（Word 用其判断编号连续性；每个克隆唯一）
    const newNsid = uniqueHex(nowMs, newAbsId)
    absBlock = absBlock
      .replace(/w:nsid w:val="[A-Fa-f0-9]+"/g, `w:nsid w:val="${newNsid}"`)
      .replace(/w:tmpl w:val="[A-Fa-f0-9]+"/g, `w:tmpl w:val="${newNsid}"`)

    newAbstractNums.push(absBlock)
    const newNumId = numIdStart++
    result.set(groupId, newNumId)
    newNums.push(`<w:num w:numId="${newNumId}"><w:abstractNumId w:val="${newAbsId}"/></w:num>`)
  }

  if (newAbstractNums.length === 0) return { xml: numberingXml, groupToNumId: result }

  // 新 abstractNum 插到最后一个 </w:abstractNum> 之后；新 num 插到 </w:numbering> 之前
  const lastAbsEndRaw = numberingXml.lastIndexOf('</w:abstractNum>')
  let xml = numberingXml
  if (lastAbsEndRaw >= 0) {
    const lastAbsEnd = lastAbsEndRaw + '</w:abstractNum>'.length
    const numEnd = xml.lastIndexOf('</w:numbering>')
    const numPart = numEnd >= 0 ? xml.slice(lastAbsEnd, numEnd) : xml.slice(lastAbsEnd)
    xml =
      xml.slice(0, lastAbsEnd) +
      newAbstractNums.join('') +
      numPart +
      newNums.join('') +
      (numEnd >= 0 ? xml.slice(numEnd) : '')
  }
  return { xml, groupToNumId: result }
}

/** 与旧版一致的 nsid 算法：BigInt 模拟 qint64 异或，hex 大写取低 8 位 */
function uniqueHex(nowMs: number, seed: number): string {
  const value = BigInt(nowMs) ^ (BigInt(seed) << 16n)
  return value.toString(16).toUpperCase().slice(-8)
}

// ================= 图片嵌入 =================

interface EmbeddedImage {
  srcPath: string
  ext: string
  relId: string
  mediaPath: string
  name: string
  data: Buffer
  widthEmu: number
  heightEmu: number
}

const EMU_PER_PX = 9525 // 96 DPI
const EMU_PER_TWIP = 635

/** 正文可用区域（EMU）。按骨架 sectPr 的页面尺寸与页边距算，而不是写死宽度 */
interface MediaBox {
  widthEmu: number
  heightEmu: number
}

/** 找不到 sectPr 时的兜底：A4 + Word 默认 1 英寸左右边距 */
const FALLBACK_MEDIA_BOX: MediaBox = { widthEmu: 5400000, heightEmu: 7920000 }

/**
 * 正文可用宽度与高度上限。
 * - 页边距缺省值取 Word 的 1 英寸（1440 twips）；骨架里左右为 0 是「按页宽画线」的常见写法，
 *   正文区吃满，因此仍按实际值计算；
 * - 页面尺寸缺失时整块回退到 A4 兜底值。
 */
function mediaBoxOf(sectPr: string): MediaBox {
  const pgSz = /<w:pgSz\b[^>]*\/?>/u.exec(sectPr)?.[0] ?? ''
  const pw = Number(/\bw:w="(\d+)"/u.exec(pgSz)?.[1] ?? 0)
  const ph = Number(/\bw:h="(\d+)"/u.exec(pgSz)?.[1] ?? 0)
  if (!(pw > 0) || !(ph > 0)) return FALLBACK_MEDIA_BOX

  const pgMar = /<w:pgMar\b[^>]*\/?>/u.exec(sectPr)?.[0] ?? ''
  const attr = (name: string, fallback: number): number => {
    const v = new RegExp(`\\bw:${name}="(-?\\d+)"`, 'u').exec(pgMar)?.[1]
    const n = Number(v ?? fallback)
    // 负页边距是合法的（超出页边），但对图片可用区没意义，按 0 处理
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  const left = pgMar ? attr('left', 1440) : 1440
  const right = pgMar ? attr('right', 1440) : 1440
  const top = pgMar ? attr('top', 1440) : 1440
  const bottom = pgMar ? attr('bottom', 1440) : 1440

  const widthTw = Math.max(720, pw - left - right) // 至少 0.5 英寸，避免算出不可用的宽度
  const heightTw = Math.max(720, ph - top - bottom)
  return { widthEmu: widthTw * EMU_PER_TWIP, heightEmu: heightTw * EMU_PER_TWIP }
}

/**
 * 骨架的正文可用宽度（twips），供界面预览按同一栏宽排版。
 * 与导出侧用同一套 sectPr 解析：页宽减左右页边距，缺省边距 1 英寸；
 * 骨架读不到或没有 sectPr 时返回那套兜底值，绝不自己另算一份。
 */
export function skeletonTextWidthTwips(skeletonPath: string): number | null {
  if (!skeletonPath) return null
  const docPath = join(skeletonPath, 'word', 'document.xml')
  if (!existsSync(docPath)) return null
  const mediaBox = mediaBoxOf(extractSectPr(readFileSync(docPath, 'utf8')))
  return Math.round(mediaBox.widthEmu / EMU_PER_TWIP)
}

function extOf(p: string): string {  const m = /\.[a-z0-9]+$/i.exec(p)
  return (m ? m[0] : '.png').toLowerCase()
}

function imageMime(ext: string): string {
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    bmp: 'image/bmp',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    emf: 'image/x-emf',
    wmf: 'image/x-wmf'
  }
  return map[ext.toLowerCase()] ?? 'application/octet-stream'
}

/** WebP：VP8X 画布、VP8L 无损、VP8 有损三种头都要认 */
function webpSizePx(buf: Buffer): { w: number; h: number } | null {
  const chunk = buf.toString('ascii', 12, 16)
  if (chunk === 'VP8X' && buf.length >= 30) {
    return {
      w: 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)),
      h: 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16))
    }
  }
  if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
    const bits = buf.readUInt32LE(21)
    return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >> 14) & 0x3fff) }
  }
  if (chunk === 'VP8 ') {
    // 关键帧起始码 9d 01 2a 之后是 14 位宽、14 位高
    const start = buf.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20)
    if (start >= 0 && start + 7 <= buf.length) {
      const w = buf.readUInt16LE(start + 3) & 0x3fff
      const h = buf.readUInt16LE(start + 5) & 0x3fff
      if (w > 0 && h > 0) return { w, h }
    }
  }
  return null
}

/** SVG：先看 width/height 属性（带单位换算），没有就看 viewBox */
function svgSizePx(buf: Buffer): { w: number; h: number } | null {
  const text = buf.toString('utf8', 0, Math.min(buf.length, 8192))
  const tag = /<svg[^>]*>/i.exec(text)?.[0]
  if (!tag) return null
  const attr = (name: string): number | null => {
    const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"|${name}\\s*=\\s*'([^']*)'`, 'i').exec(tag)
    const raw = (m?.[1] ?? m?.[2] ?? '').trim()
    if (raw.length === 0) return null
    const num = Number.parseFloat(raw)
    if (!Number.isFinite(num) || num <= 0) return null
    const unit = /[a-z%]+$/i.exec(raw)?.[0]?.toLowerCase() ?? ''
    if (unit === 'mm') return Math.round((num * 96) / 25.4)
    if (unit === 'cm') return Math.round((num * 96) / 2.54)
    if (unit === 'in') return Math.round(num * 96)
    if (unit === 'pt') return Math.round((num * 96) / 72)
    if (unit === '%') return null
    return Math.round(num)
  }
  const w = attr('width')
  const h = attr('height')
  if (w && h) return { w, h }
  const vb = /viewBox\s*=\s*"([^"]*)"|viewBox\s*=\s*'([^']*)'/i.exec(tag)
  const parts = (vb?.[1] ?? vb?.[2] ?? '').trim().split(/[\s,]+/).map(Number)
  const vw = parts[2]
  const vh = parts[3]
  if (parts.length === 4 && vw !== undefined && vh !== undefined && vw > 0 && vh > 0) {
    return { w: Math.round(vw), h: Math.round(vh) }
  }
  return null
}

/** EMF 头：iType(0) nSize(4) rclBounds(8) rclFrame(24)，rclFrame 单位 0.01 毫米 */
function emfSizePx(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 40 || buf.readUInt32LE(0) !== 1) return null
  const toPx = (v: number): number => Math.max(1, Math.round((v / 100) * (96 / 25.4)))
  const frameW = buf.readInt32LE(32) - buf.readInt32LE(24)
  const frameH = buf.readInt32LE(36) - buf.readInt32LE(28)
  if (frameW > 0 && frameH > 0) return { w: toPx(frameW), h: toPx(frameH) }
  // rclFrame 全零时退回 rclBounds（设备单位，按像素算）
  const boundW = buf.readInt32LE(16) - buf.readInt32LE(8)
  const boundH = buf.readInt32LE(20) - buf.readInt32LE(12)
  if (boundW > 0 && boundH > 0) return { w: boundW, h: boundH }
  return null
}

/**
 * 从文件头读像素尺寸。
 * 导入对话框放行的八种格式都要能读出来：读不出来的会被当成 800×520 渲染，
 * 宽高比一错，图在纸上就是拉变形的。
 */
function imageSizePx(buf: Buffer, ext: string): { w: number; h: number } {
  const e = ext.toLowerCase()
  if (e === '.png' && buf.length >= 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  }
  if (e === '.jpg' || e === '.jpeg') {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++
        continue
      }
      const marker = buf[i + 1]!
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) }
      }
      i += 2 + buf.readUInt16BE(i + 2)
    }
  }
  if (e === '.gif' && buf.length >= 10) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) }
  }
  if (e === '.bmp' && buf.length >= 26 && buf.toString('ascii', 0, 2) === 'BM') {
    const headerSize = buf.readUInt32LE(14)
    if (headerSize === 12) {
      return { w: buf.readUInt16LE(18), h: buf.readUInt16LE(20) }
    }
    const w = buf.readInt32LE(18)
    const h = buf.readInt32LE(22)
    if (w > 0 && h !== 0) return { w, h: Math.abs(h) }
  }
  if (
    e === '.webp' &&
    buf.length >= 30 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const size = webpSizePx(buf)
    if (size) return size
  }
  if (e === '.svg') {
    const size = svgSizePx(buf)
    if (size) return size
  }
  if (e === '.emf') {
    const size = emfSizePx(buf)
    if (size) return size
  }
  // 认不出来的格式：给一个固定值撑住版面。此时 MIME 多半也是 octet-stream，
  // Word 会显示成无法识别的对象，用户看得见，不会以为图正常。
  return { w: 800, h: 520 }
}

/**
 * 图片显示尺寸：按正文可用区域铺满宽度，保持宽高比，并受高度上限约束。
 *
 * 策略（与用户口径一致）：
 * - 目标宽度 = 可用宽度；低分辨率小图不硬拉——见 MIN_UPSCALE_PX；
 * - 高图（竖长截图）即使宽度没超，也按可用高度缩小，避免一张图跨好几页；
 * - 只缩不放的旧口径已废弃：300px 的截图按 96 DPI 只有 3.1 英寸，在纸上偏小。
 */
const MIN_UPSCALE_PX = 150

function fitEmu(w: number, h: number, box: MediaBox): { cx: number; cy: number } {
  const pxW = Math.max(1, w)
  const pxH = Math.max(1, h)
  const naturalCx = Math.max(1, Math.round(pxW * EMU_PER_PX))
  const naturalCy = Math.max(1, Math.round(pxH * EMU_PER_PX))

  // 极小图不放大：放上去只会糊成一片，还不如按原始尺寸
  let targetCx = pxW < MIN_UPSCALE_PX ? naturalCx : box.widthEmu

  // 按高度上限收敛（竖长图在这里被压下来）
  if (naturalCy > box.heightEmu) {
    const byHeight = (naturalCx * box.heightEmu) / naturalCy
    targetCx = Math.min(targetCx, byHeight)
  }

  const scale = targetCx / naturalCx
  return {
    cx: Math.max(1, Math.round(targetCx)),
    cy: Math.max(1, Math.round(naturalCy * scale))
  }
}

function maxRid(relsXml: string): number {
  let max = 0
  for (const m of relsXml.matchAll(/Id="rId(\d+)"/g)) max = Math.max(max, Number(m[1]))
  return max
}

function maxMediaIndex(files: string[]): number {
  let max = 0
  for (const f of files) {
    const m = /^word\/media\/image(\d+)\./.exec(f)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max
}

function renderImageParagraph(e: EmbeddedImage, docPrId: number, styleName: string): string {
  const cx = e.widthEmu
  const cy = e.heightEmu
  const pStyle =
    styleName.length > 0 ? `<w:pStyle w:val="${escapeXmlAttr(styleName)}"/>` : ''
  return (
    `<w:p><w:pPr>${pStyle}<w:jc w:val="center"/></w:pPr><w:r><w:drawing>` +
    '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    `<wp:docPr id="${docPrId}" name="Picture ${docPrId}"/>` +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${escapeXmlAttr(e.name)}"/>` +
    '<pic:cNvPicPr/></pic:nvPicPr>' +
    `<pic:blipFill><a:blip r:embed="${e.relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
    '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
  )
}

// ================= 题注域 =================

/**
 * 题注段落：标签 + 章节号 + '-' + 序号 + 标题。
 * 章节号/序号用域实现（STYLEREF / SEQ），并写入导出时算好的缓存值——
 * Word 打开即显示正确，F9 或改结构后可自动更新；不占用标题多级列表，故不会顶高标题编号。
 * instr 中的样式名按 Word 惯例用双引号包裹（中文 Word 的标题样式名为「标题 N」）。
 */
function renderCaption(
  styleName: string,
  content: Extract<WriteInstruction, { opType: 'InsertCaption' }>['content']
): string {
  const pPr =
    styleName.length > 0
      ? `<w:pPr><w:pStyle w:val="${escapeXmlAttr(styleName)}"/></w:pPr>`
      : '<w:pPr/>'
  const chapter =
    content.chapterStyleName.length > 0
      ? field(
          ` STYLEREF "${content.chapterStyleName}" \\n `,
          content.chapterText
        )
      : run(content.chapterText)
  const seq = field(
    ` SEQ ${content.seqName} \\* ARABIC \\s ${content.seqRestartLevel} `,
    content.seqText
  )
  const title = content.title.length > 0 ? run(` ${content.title}`, true) : ''
  return `<w:p>${pPr}${run(content.label)}${chapter}${run('-')}${seq}${title}</w:p>`
}

/** 普通文本 run（保留首尾空格） */
function run(text: string, preserveSpace = false): string {
  if (text.length === 0) return ''
  const space = preserveSpace || /^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''
  return `<w:r><w:t${space}>${escapeXmlText(text)}</w:t></w:r>`
}

/** 简单域（w:fldSimple）+ 缓存结果 */
function field(instr: string, cached: string): string {
  return (
    `<w:fldSimple w:instr="${escapeXmlAttr(instr)}">` +
    `<w:r><w:t>${escapeXmlText(cached)}</w:t></w:r>` +
    '</w:fldSimple>'
  )
}

// ================= document.xml 渲染 =================

function extractSectPr(documentXml: string): string {
  const start = documentXml.indexOf('<w:sectPr')
  if (start === -1) return ''
  const end = documentXml.indexOf('</w:sectPr>', start)
  if (end === -1) return ''
  return documentXml.slice(start, end + '</w:sectPr>'.length)
}

function renderInstructions(
  instructions: WriteInstruction[],
  listNumIds: Map<number, number>,
  addImage: (srcPath: string) => EmbeddedImage | null
): string {
  const parts: string[] = []
  let docPrId = 1
  for (const ins of instructions) {
    if (ins.opType === 'InsertParagraph') {
      const text = ins.content.text
      if (text.length === 0) continue
      parts.push(renderParagraph(ins.styleName, text, ins.listGroupId, listNumIds))
    } else if (ins.opType === 'InsertCaption') {
      parts.push(renderCaption(ins.styleName, ins.content))
    } else if (ins.opType === 'InsertImage') {
      const img = addImage(ins.content.srcPath)
      if (img) parts.push(renderImageParagraph(img, docPrId++, ins.content.styleName))
    } else if (ins.opType === 'InsertTable') {
      parts.push(renderTable(ins.content))
    } else if (ins.opType === 'InsertPageBreak') {
      parts.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
    }
  }
  return parts.join('')
}

function renderParagraph(
  styleName: string,
  text: string,
  listGroupId: number,
  listNumIds: Map<number, number>
): string {
  let pPr = ''
  const pieces: string[] = []
  if (styleName.length > 0) {
    pieces.push(`<w:pStyle w:val="${escapeXmlAttr(styleName)}"/>`)
  }
  if (listGroupId > 0) {
    const numId = listNumIds.get(listGroupId)
    if (numId !== undefined && numId > 0) {
      pieces.push(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`)
    }
  }
  pPr = pieces.length > 0 ? `<w:pPr>${pieces.join('')}</w:pPr>` : '<w:pPr/>'
  return `<w:p>${pPr}<w:r><w:rPr/><w:t>${escapeXmlText(text)}</w:t></w:r></w:p>`
}

function renderTable(
  content: Extract<WriteInstruction, { opType: 'InsertTable' }>['content']
): string {
  const c = content
  // 列数与行数同口径：**只认真实数据宽度**。
  // cols 是提示性元数据，模板/实例 JSON 不给它时是 0，拿它当上界会把后面几列静默丢掉。
  const cols = Math.max(1, c.headers.length, c.cols, ...c.rowsData.map((row) => row.length))
  // 正文行数：**只认 data 的实际长度**。
  // rows 是提示性元数据（写入侧可能给 data.length + 1 的旧口径），
  // 拿它当上界会在 rows < data.length 时静默丢掉行尾数据；
  // 拿它的较大值又会在 rows > data.length 时凭空多出空行。所以两个都不用。
  const rows = c.rowsData.length
  const colWidth = Math.floor(9072 / cols)

  // tblPr：宽度 + 边框（外 sz=8 内 sz=4）+ 单元格边距（左右 108 dxa）
  const borders = ['top', 'left', 'bottom', 'right']
    .map((pos) => `<w:${pos} w:val="single" w:color="auto" w:sz="8" w:space="0"/>`)
    .join('')
  const inside = '<w:insideH w:val="single" w:color="auto" w:sz="4" w:space="0"/>' +
    '<w:insideV w:val="single" w:color="auto" w:sz="4" w:space="0"/>'
  const cellMar = '<w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>' +
    '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/>'

  const tblPr =
    '<w:tblPr><w:tblW w:w="5000" w:type="pct"/>' +
    `<w:tblBorders>${borders}${inside}</w:tblBorders>` +
    `<w:tblCellMar>${cellMar}</w:tblCellMar></w:tblPr>`

  const grid = `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${colWidth}"/>`).join('')}</w:tblGrid>`

  // 合并来源：显式跨度逐格优先，mergeVertical 开时兼容判定补没认领的部分。
  // 列数与上面的 cols 同口径：表头、cols 与数据行三者取最大值，
  // 只按数据行宽度会把表头多出来的那几列上的跨度丢掉
  const merges = resolveTableMerges({
    data: c.rowsData,
    headers: c.headers,
    cols: c.cols,
    rowSpans: c.rowSpans,
    mergeVertical: c.mergeVertical
  })

  const cell = (text: string, style: string, merge?: 'start' | 'continue'): string => {
    const pPr = style.length > 0 ? `<w:pPr><w:pStyle w:val="${escapeXmlAttr(style)}"/></w:pPr>` : '<w:pPr/>'
    // vMerge 需排在 tcW 之后；合并块起点加 vAlign=center，续格留空段（Word 约定）
    const vMergeXml =
      merge === 'start' ? '<w:vMerge w:val="restart"/>' : merge === 'continue' ? '<w:vMerge/>' : ''
    const vAlignXml = merge === 'start' ? '<w:vAlign w:val="center"/>' : ''
    const inner =
      merge === 'continue'
        ? `<w:p>${pPr}</w:p>`
        : `<w:p>${pPr}<w:r><w:t>${escapeXmlText(text)}</w:t></w:r></w:p>`
    return (
      '<w:tc><w:tcPr>' +
      `<w:tcW w:w="${colWidth}" w:type="dxa"/>` +
      vMergeXml +
      vAlignXml +
      `</w:tcPr>${inner}</w:tc>`
    )
  }

  let body = ''
  // 表头行（仅当表头非空；表头不参与纵向合并）
  if (c.headers.length > 0) {
    body += '<w:tr>'
    // 补齐到 cols：表格行必须与 tblGrid 列数一致，缺格会让 Word 的边框与合并错位
    for (let col = 0; col < cols; col++) {
      body += cell(c.headers[col] ?? '', c.headerStyle)
    }
    body += '</w:tr>'
  }
  // 数据行：逐行走 data，一行不多一行不少
  for (let r = 0; r < rows; r++) {
    const row = c.rowsData[r] ?? []
    body += '<w:tr>'
    for (let col = 0; col < cols; col++) {
      const m = merges?.[r]?.[col]
      const mergeArg = m === undefined || (m.rowSpan <= 1 && !m.covered) ? undefined : m.covered ? 'continue' : 'start'
      body += cell(row[col] ?? '', c.bodyStyle, mergeArg)
    }
    body += '</w:tr>'
  }

  return `<w:tbl>${tblPr}${grid}${body}</w:tbl>`
}

// ================= 目录 =================

function listFilesRecursive(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry)
      const rel = prefix ? `${prefix}/${entry}` : entry
      if (statSync(full).isDirectory()) {
        walk(full, rel)
      } else {
        out.push(rel)
      }
    }
  }
  walk(dir, '')
  return out.sort()
}
