/**
 * embed.ts — 把 VSDX（含 OLE CF 容器）嵌入 docx 的 Mermaid 占位段。
 *
 * 移植自《documentor 旧版 scripts/embed_vsdx.py》，结构对齐 Word 2013+ 原生嵌入对象：
 *
 *   <w:object>
 *     <v:shape ...><v:imagedata r:id="rIdIMG"/></v:shape>   ← EMF/PNG 预览（可选）
 *     <o:OLEObject Type="Embed" ProgID="Visio.Drawing.15" .../> ← 双击用 Visio 编辑
 *   </w:object>
 *
 * 匹配规则（默认按槽位对齐，旧版“题注名称优先”仅作诊断提示）：
 *   - 占位段：文本以 "[Mermaid" 开头的段落（序列化器输出的 [Mermaid 图表: …] 占位）；
 *   槽位 k ↔ figures[k]，调用方必须按文档顺序构造 figures；
 *   - 每个槽位取前一图题注（向后扫首个非空段 + 可选样式 ID 限定）用于诊断；
 *   - 尺寸：显示宽度 = 正文宽（sectPr 推导）留 10pt 余量；高度按内容包围盒比例；
 *     同时把 vsdx 页面尺寸修正为包围盒（首选项 patchPageSize，默认开启）。
 */
import JSZip from 'jszip'
import { makeVisioOle } from './ole-streams'
import { vsdxContentBbox, patchVsdxPageSize } from './vsdx'

const NS_W10 = 'urn:schemas-microsoft-com:office:word'

export interface FigureInput {
  /** 文件名（留档/提示用；建议 sdd-<NNN>-<图名>.vsdx 风格） */
  name: string
  /** VSDX 内容；省略=跳过该槽位（保留原占位文本） */
  vsdx?: Uint8Array
  /** 预览图（EMF 优先，PNG/JPG 兜底） */
  preview?: Uint8Array
  previewExt?: 'emf' | 'png' | 'jpg' | 'jpeg'
}

export interface EmbedVsdxOptions {
  /** figure.caption 的样式 ID（document.xml 中 w:pStyle val）；缺省=取占位后首个非空段 */
  captionStyleId?: string
  /** figure（图片/图形所在段落）的样式 ID；缺省不加 pStyle（仅居中） */
  figureStyleId?: string
  /** 是否修补 VSDX 页面尺寸为内容包围盒（默认 true） */
  patchPageSize?: boolean
  /** 内容比例上下限（默认 0.1 / 3.0） */
  ratioMin?: number
  ratioMax?: number
  /** 最大对象高度 pt（默认 550） */
  maxHeightPt?: number
  /** 宽度余量 pt（默认 10） */
  widthMarginPt?: number
}

export interface EmbedVsdxResult {
  docxBytes: Uint8Array
  embeddedCount: number
  /** 题注与文件名（去 sdd-NNN- 前缀）不一致的诊断提示（不影响嵌入） */
  nameMisses: string[]
  warnings: string[]
}

export async function embedVsdxIntoDocx(
  docxData: Uint8Array | ArrayBuffer,
  figures: FigureInput[],
  options: EmbedVsdxOptions = {}
): Promise<EmbedVsdxResult> {
  const warnings: string[] = []
  const zip = await JSZip.loadAsync(docxData)
  const docEntry = zip.file('word/document.xml')
  const ctEntry = zip.file('[Content_Types].xml')
  if (!docEntry || !ctEntry) {
    throw new Error('embed: docx 缺少 word/document.xml / Content_Types')
  }
  let docXml = await docEntry.async('string')
  // rels 部件可能缺失（最小骨架）；嵌入时必须存在 → 合成空关系表后合并
  const relsEntry = zip.file('word/_rels/document.xml.rels')
  const relsXml = relsEntry
    ? await relsEntry.async('string')
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '</Relationships>'
  const ctXml = await ctEntry.async('string')

  const bodyW = docxBodyWidthPt(docXml)
  const maxWidth = bodyW - (options.widthMarginPt ?? 10)
  const ratioMin = options.ratioMin ?? 0.1
  const ratioMax = options.ratioMax ?? 3.0
  const maxHeight = options.maxHeightPt ?? 550

  // ---- 定位占位段与图题注段 ----
  const paras = [...docXml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)]
  const holderIdx: number[] = []
  const capText: string[] = []
  for (let i = 0; i < paras.length; i++) {
    const m = paras[i]!
    const txt = paragraphText(m[0])
    if (txt.startsWith('[Mermaid')) {
      holderIdx.push(i)
      let cap = ''
      const scanEnd = Math.min(i + 5, paras.length)
      for (let j = i + 1; j < scanEnd; j++) {
        const pt = paragraphText(paras[j]![0])
        if (pt === '') continue
        if (options.captionStyleId !== undefined && hasStyle(paras[j]![0], options.captionStyleId)) {
          cap = pt
        }
        break
      }
      capText.push(cap)
    }
  }
  if (holderIdx.length === 0) {
    return { docxBytes: docxData instanceof ArrayBuffer ? new Uint8Array(docxData) : docxData, embeddedCount: 0, nameMisses: [], warnings }
  }
  if (holderIdx.length !== figures.length) {
    warnings.push(
      `图与插入位置数量不一致：文档中 ${holderIdx.length} 处，待嵌入 ${figures.length} 张，按 ${Math.min(holderIdx.length, figures.length)} 张处理`
    )
  }

  const nTotal = Math.min(holderIdx.length, figures.length)

  // ---- 逐槽位生成对象（对应旧版 plan；槽位 k ↔ figures[k]，跳过无 vsdx 槽位） ----
  interface SlotPlan {
    holderIndex: number
    figure: FigureInput
    widthPt: number
    heightPt: number
    oleBytes: Uint8Array
    previewExt?: string
    previewBytes?: Uint8Array
  }
  const plans: SlotPlan[] = []
  const nameMisses: string[] = []
  const seen = new Set<string>()

  for (let k = 0; k < nTotal; k++) {
    const hi = holderIdx[k]!
    const fig = figures[k]
    if (!fig || !fig.vsdx) continue // 转换失败的槽位：保留占位文本
    if (seen.has(fig.name)) {
      warnings.push(`「${fig.name}」文件名重复，已跳过嵌入`)
      continue
    }
    seen.add(fig.name)

    let vsdxBytes = fig.vsdx
    const bbox = await vsdxContentBbox(vsdxBytes)
    if (bbox && options.patchPageSize !== false) {
      vsdxBytes = await patchVsdxPageSize(vsdxBytes, bbox.widthIn, bbox.heightIn)
    }
    const oleBytes = makeVisioOle(vsdxBytes)

    let ratio = bbox ? Math.min(Math.max(bbox.heightIn / bbox.widthIn, ratioMin), ratioMax) : 0.75
    let width = maxWidth
    let height = width * ratio
    if (height > maxHeight) {
      height = maxHeight
      width = height / ratio
    }

    plans.push({
      holderIndex: hi,
      figure: fig,
      widthPt: width,
      heightPt: height,
      oleBytes,
      previewExt: fig.previewExt,
      previewBytes: fig.preview
    })

    // 名称一致性诊断（与旧版 miss 列表同语义）
    const stem = normName(fig.name.replace(/^sdd-\d+-/i, '').replace(/\.vsdx$/i, ''))
    const cn = normName(capText[k] ?? '')
    if (cn && cn !== stem) {
      nameMisses.push(capText[k]!)
    }
  }

  // ---- 替换占位段（逆序） ----
  const newRels: string[] = []
  const mediaAdded: Array<{ target: string; bytes: Uint8Array }> = []
  const embeddingsAdded: Array<{ target: string; bytes: Uint8Array }> = []
  let nextRid = 1
  const ridRe = /Id="rId(\d+)"/g
  let rm: RegExpExecArray | null
  while ((rm = ridRe.exec(relsXml)) !== null) nextRid = Math.max(nextRid, parseInt(rm[1]!, 10) + 1)
  // 已有 embedding/media 序号续接（骨架可能自带）；无匹配从 1 起
  const embedStart = Math.max(existingMaxIndex(zip, /^word\/embeddings\/oleObject(\d+)\.bin$/), 0) + 1
  const mediaStart = Math.max(existingMaxIndex(zip, /^word\/media\/image(\d+)\./), 0) + 1
  let nEmbed = embedStart
  let nImg = mediaStart
  const maxObjId = 1000000

  for (let k = plans.length - 1; k >= 0; k--) {
    const plan = plans[k]!

    // OLE 关系：vsdx → Compound File 容器（Visio OLE 协议；package 模式布局会错乱）
    const ridOle = `rId${nextRid++}`
    const embTarget = `word/embeddings/oleObject${nEmbed}.bin`
    nEmbed++
    embeddingsAdded.push({ target: embTarget, bytes: plan.oleBytes })
    newRels.push(
      '<Relationship Id="' + ridOle + '" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" ' +
      `Target="embeddings/oleObject${nEmbed - 1}.bin"/>`
    )

    let ridImg: string | undefined
    if (plan.previewBytes && plan.previewExt) {
      const ext = plan.previewExt
      const mTarget = `word/media/image${nImg}.${ext}`
      nImg++
      mediaAdded.push({ target: mTarget, bytes: plan.previewBytes })
      ridImg = `rId${nextRid++}`
      newRels.push(
        '<Relationship Id="' + ridImg + '" ' +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ' +
        `Target="media/${mTarget.slice('word/media/'.length)}"/>`
      )
    }

    const shapeId = `_x0000_i${2000 + k}`
    const objectId = String(maxObjId + k)
    const block = buildObjectBlock(shapeId, objectId, ridOle, plan.widthPt, plan.heightPt, ridImg, plan.previewExt)
    const m = paras[plan.holderIndex]!
    // w:object 是 run 级元素，必须包在 w:r 内（否则 Word 不激活 OLE）；对象段落套 figure 样式并居中
    const figStyle = options.figureStyleId
      ? `<w:pStyle w:val="${escapeAttr(options.figureStyleId)}"/>`
      : ''
    const replacement =
      `<w:p><w:pPr>${figStyle}<w:jc w:val="center"/></w:pPr><w:r>` + block + '</w:r></w:p>'
    docXml = docXml.slice(0, m.index) + replacement + docXml.slice(m.index + m[0].length)
  }

  // ---- 更新 rels / Content_Types ----
  const finalRels = relsXml.replace('</Relationships>', newRels.join('') + '</Relationships>')
  const defaults: string[] = []
  if (!ctXml.includes('<Default Extension="bin"')) {
    defaults.push(
      '<Default Extension="bin" ' +
      'ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>'
    )
  }
  const exts = new Set(mediaAdded.map((m) => m.target.split('.').pop()!.toLowerCase()))
  if (exts.has('emf') && !ctXml.includes('<Default Extension="emf"')) {
    defaults.push('<Default Extension="emf" ContentType="image/x-emf"/>')
  }
  if (exts.has('png') && !ctXml.includes('<Default Extension="png"')) {
    defaults.push('<Default Extension="png" ContentType="image/png"/>')
  }
  if ((exts.has('jpg') || exts.has('jpeg')) && !ctXml.includes('<Default Extension="jpeg"')) {
    defaults.push('<Default Extension="jpeg" ContentType="image/jpeg"/>')
  }
  const finalCt = defaults.length > 0 ? ctXml.replace('</Types>', defaults.join('') + '</Types>') : ctXml

  // ---- 写回 ----
  zip.file('word/document.xml', docXml)
  zip.file('word/_rels/document.xml.rels', finalRels)
  zip.file('[Content_Types].xml', finalCt)
  for (const e of embeddingsAdded) zip.file(e.target, e.bytes)
  for (const m2 of mediaAdded) zip.file(m2.target, m2.bytes)
  const buf = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'DOS'
  })

  return { docxBytes: buf, embeddedCount: plans.length, nameMisses, warnings }
}

// ================= 内部 =================

function paragraphText(paraXml: string): string {
  let text = ''
  const re = /<w:t[^>]*>([^<]*)<\/w:t>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(paraXml)) !== null) text += m[1]
  return text
}

function hasStyle(paraXml: string, styleId: string): boolean {
  const re = new RegExp(`<w:pStyle w:val="${escapeRe(styleId)}"`)
  return re.test(paraXml)
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** XML 属性值转义（样式 ID 注入 pStyle 用） */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 名称归一化：/ 与 - 互认，去空白 */
function normName(s: string): string {
  return s.replace(/[\/／]/g, '-').trim()
}

/** 从 sectPr 读正文宽度（pt）：(pgSz.w - pgMar.left - pgMar.right) / 20 */
export function docxBodyWidthPt(docXml: string): number {
  const m = /<w:sectPr[\s\S]*?<\/w:sectPr>/.exec(docXml)
  if (!m) return 467.7
  const s = m[0]
  const mw = /<w:pgSz w:w="(\d+)"/.exec(s)
  const ml = /<w:pgMar[^>]*w:left="(\d+)"/.exec(s)
  const mr = /<w:pgMar[^>]*w:right="(\d+)"/.exec(s)
  if (!(mw && ml && mr)) return 467.7
  return (parseInt(mw[1]!, 10) - parseInt(ml[1]!, 10) - parseInt(mr[1]!, 10)) / 20.0
}

/** 构造 VML OLE 对象块（含局部 w10 命名空间声明，与旧版一致） */
function buildObjectBlock(
  shapeId: string,
  objectId: string,
  ridOle: string,
  widthPt: number,
  heightPt: number,
  ridImg: string | undefined,
  imgExt?: string
): string {
  const imagedata = ridImg
    ? `<v:imagedata r:id="${ridImg}" o:title=""/>`
    : ''
  // imgExt 仅用于将来扩展（如 raster 预览的 fill 类型）；当前 imagedata 即可
  void imgExt
  return (
    '<w:object xmlns:w10="' + NS_W10 + '">' +
    `<v:shape id="${shapeId}" o:spt="75" type="#_x0000_t75" ` +
    `style="height:${heightPt.toFixed(1)}pt;width:${widthPt.toFixed(1)}pt;" ` +
    'o:ole="t" filled="f" o:preferrelative="t" stroked="f" coordsize="21600,21600">' +
    '<v:path/><v:fill on="f" focussize="0,0"/><v:stroke on="f"/>' + imagedata +
    '<o:lock v:ext="edit" aspectratio="f"/>' +
    '<w10:wrap type="none"/><w10:anchorlock/>' +
    '</v:shape>' +
    `<o:OLEObject Type="Embed" ProgID="Visio.Drawing.15" ShapeID="${shapeId}" ` +
    `DrawAspect="Content" ObjectID="${objectId}" r:id="${ridOle}">` +
    '<o:LockedField>false</o:LockedField>' +
    '</o:OLEObject>' +
    '</w:object>'
  )
}

/** 按 entry 正则扫描 zip 中已有的最大序号（无匹配返回 -1） */
function existingMaxIndex(zip: JSZip, re: RegExp): number {
  let max = -1
  for (const name of Object.keys(zip.files)) {
    const m = re.exec(name)
    if (m) max = Math.max(max, parseInt(m[1]!, 10))
  }
  return max
}
