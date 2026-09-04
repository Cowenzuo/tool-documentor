/**
 * DocxWriter：以 docx 骨架目录为模板 → 重写 numbering.xml（列表组 numId 克隆）
 * 与 word/document.xml（正文重建、保留 sectPr）→ 打包输出 .docx。
 * 对齐旧版 docxwriter.cpp 的全部实测规则（命名空间单次声明/克隆 nsid/tmpl/外8内4边框…）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import JSZip from 'jszip'
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
    throw new Error(`DocxWriter: 骨架目录无效: ${skeletonDir}`)
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

  // ---------- 2. document.xml 正文重建 ----------
  const originalDocumentXml = readSkeleton('word/document.xml').toString('utf8')
  const sectPr = extractSectPr(originalDocumentXml)
  const bodyXml = renderInstructions(instructions, groupToNumId)
  const documentXml = `${XML_HEAD}${bodyXml}${sectPr}</w:body></w:document>`

  // ---------- 3. 打包 ----------
  const zip = new JSZip()
  for (const rel of files) {
    let content: Buffer
    if (rel === 'word/document.xml') {
      content = Buffer.from(documentXml, 'utf8')
    } else if (rel === 'word/numbering.xml' && numberingXml !== null) {
      content = Buffer.from(numberingXml, 'utf8')
    } else {
      content = readSkeleton(rel)
    }
    zip.file(rel, content)
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
  listNumIds: Map<number, number>
): string {
  const parts: string[] = []
  for (const ins of instructions) {
    if (ins.opType === 'InsertParagraph') {
      const text = ins.content.text
      if (text.length === 0) continue
      parts.push(renderParagraph(ins.styleName, text, ins.listGroupId, listNumIds))
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
  const rows = c.rows
  const cols = Math.max(1, c.cols)
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

  const cell = (text: string, style: string): string => {
    const pPr = style.length > 0 ? `<w:pPr><w:pStyle w:val="${escapeXmlAttr(style)}"/></w:pPr>` : '<w:pPr/>'
    return (
      '<w:tc><w:tcPr>' +
      `<w:tcW w:w="${colWidth}" w:type="dxa"/>` +
      `</w:tcPr><w:p>${pPr}<w:r><w:t>${escapeXmlText(text)}</w:t></w:r></w:p></w:tc>`
    )
  }

  let body = ''
  // 表头行（仅当表头非空）
  if (c.headers.length > 0) {
    body += '<w:tr>'
    for (let col = 0; col < cols && col < c.headers.length; col++) {
      body += cell(c.headers[col] ?? '', c.headerStyle)
    }
    body += '</w:tr>'
  }
  // 数据行
  for (let r = 0; r < rows && r < c.rowsData.length; r++) {
    const row = c.rowsData[r] ?? []
    body += '<w:tr>'
    for (let col = 0; col < cols && col < row.length; col++) {
      body += cell(row[col] ?? '', c.bodyStyle)
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
