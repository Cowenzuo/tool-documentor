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
 *   - 尺寸：**用图的自然尺寸**（vsdx 页面 × 72pt），只在超过可用宽/高时**等比缩小**，绝不放大；
 *     比例一律取页面真实比例（不夹、不猜），并锁 `aspectratio="t"`；
 *     页面尺寸**默认不动**（pages.xml 是生成侧的权威画布）；需要时用 patchPageSize 显式开启。
 */
import JSZip from 'jszip'
import { makeVisioOle } from './ole-streams'
import { vsdxContentBbox, vsdxPageSize, patchVsdxPageSize, stripVsdxThumbnail } from './vsdx'
import { makePreviewEmf, normalizePreviewEmf, declaredEqualsFrame, previewDpiOutOfBand } from './preview'

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
  /** 是否修补 VSDX 页面尺寸为内容包围盒（默认 false：pages.xml 是生成侧给的权威画布） */
  patchPageSize?: boolean
  /** 最大对象高度 pt（默认 550）；自然高度超了才等比缩小 */
  maxHeightPt?: number
  /** 宽度余量 pt（默认 10）；正文宽减掉它才是可用宽度 */
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
    throw new Error('embed：docx 内 word/document.xml / Content_Types 缺失')
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
      `图与插入位置数量对不上：文档里 ${holderIdx.length} 处、图 ${figures.length} 张，按 ${Math.min(holderIdx.length, figures.length)} 张处理`
    )
  }

  const nTotal = Math.min(holderIdx.length, figures.length)

  // ---- 逐槽位生成对象（对应旧版 plan；槽位 k ↔ figures[k]，跳过无 vsdx 槽位） ----
  interface SlotPlan {
    holderIndex: number
    figure: FigureInput
    /** 对象框（写进 v:shape 的显示尺寸，超出可用宽高时已等比缩小） */
    widthPt: number
    heightPt: number
    /** 图的自然尺寸（未缩放），写进 w:dxaOrig/dyaOrig：Word 的「原始大小」认它 */
    naturalWPt: number
    naturalHPt: number
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
      warnings.push(`「${fig.name}」重名，已跳过`)
      continue
    }
    seen.add(fig.name)

    let vsdxBytes = fig.vsdx
    const bbox = await vsdxContentBbox(vsdxBytes)
    // 页面尺寸默认**不改**（pages.xml 的 PageWidth/PageHeight 是生成侧给的权威画布，见 docs/06）：
    //   内容包围盒只由"四个格子齐全"的形状算得，实测把 77 个形状的图纸算成其中一个形状的大小；
    //   页面被压小后对象框跟着缩水，图纸内容也会落到页面外。要修补得显式开 patchPageSize。
    if (bbox && options.patchPageSize === true) {
      vsdxBytes = await patchVsdxPageSize(vsdxBytes, bbox.widthIn, bbox.heightIn)
    }
    vsdxBytes = await stripVsdxThumbnail(vsdxBytes)
    const oleBytes = makeVisioOle(vsdxBytes)

    // 对象框 = 图的**自然尺寸**（页面 × 72pt）：放不下才等比缩小，**绝不放大**。
    //
    // 三条都是踩过的坑（258 张图里 64 张被拉变形的那个 bug）：
    //   1. 比例必须取**页面**的真实比例。旧实现取内容包围盒的比例并夹在 [0.1, 3.0]，
    //      求不出还退回 0.75 —— 框的比例一旦与页面不符，Word 就按框把对象非等比拉伸，
    //      线宽、箭头、字号全跟着变形（"像缺了点东西"就是这么来的）；
    //   2. 宽度不能一律顶满正文宽：巴掌大的小图会被放大到 8.79 倍；
    //   3. 页面尺寸读不出来时退回包围盒（仍是真实比例），再不行才用 A4 横的一半兜底。
    const pageIn = await vsdxPageSize(vsdxBytes)
    if (!pageIn) {
      // 读不出画布尺寸不是致命：按 A4 横的一半估。但必须报出来——框与预览尺寸都建立在这个值上。
      warnings.push(`「${fig.name}」读不出画布尺寸，对象框与预览尺寸按 6 × 4.5in 估算`)
    }
    const baseW = pageIn?.widthIn ?? bbox?.widthIn ?? 6
    const baseH = pageIn?.heightIn ?? bbox?.heightIn ?? 4.5
    const naturalW = baseW * 72
    const naturalH = baseH * 72
    const scale = Math.min(1, maxWidth / naturalW, maxHeight / naturalH)
    const width = naturalW * scale
    const height = naturalH * scale

    // 预览件（见 docs/WORD处理经验/06 与 07）：
    //   · 有 ⇒ 只把"声明尺寸"校正成自洽值（画面与其它字节一律不动）；
    //   · 没有 ⇒ 自产一张带示意文字的件（模板 + 自洽的声明尺寸）；
    //   · 护栏：声明尺寸不得等于对象框尺寸，相等必被 Word 撑大。
    let previewExt = fig.previewExt
    let previewBytes = fig.preview
    /** 自产件与可解析的 EMF 走同一条校正/护栏路径；PNG/JPG 原样嵌入 */
    let emfPreview = previewBytes === undefined || previewExt === undefined || previewExt === 'emf'
    if (previewBytes === undefined) {
      // 自产件：把对象框一并传进去 —— 模板按"对象框 × 参考dpi"挑，画面自然尺寸贴近对象框
      // （Word 是按画面的自然尺寸摆放、超出对象框才裁；比例尺与 dpi 的取值见 preview.ts 注释）
      previewBytes = makePreviewEmf(baseW, baseH, width, height)
      previewExt = 'emf'
    } else if (emfPreview) {
      const fixed = normalizePreviewEmf(previewBytes, baseW, baseH)
      if (fixed) previewBytes = fixed
      else {
        warnings.push(`「${fig.name}」预览件不是可解析的 EMF（缺头或 EMF+ 注释），按原样嵌入`)
        emfPreview = false
      }
    }
    if (emfPreview && previewBytes && declaredEqualsFrame(previewBytes, width, height)) {
      warnings.push(
        `「${fig.name}」预览图的声明尺寸与对象框相等，Word 更新对象时会撑大框（见 docs/WORD处理经验/06）`
      )
    }
    // 护栏：dpi 越出常规区间会被 Word 当成"尺寸需要重算"，双击后对象框被改（见 preview.ts 的说明）
    if (emfPreview && previewBytes) {
      const outOfBand = previewDpiOutOfBand(previewBytes)
      if (outOfBand) {
        warnings.push(
          `「${fig.name}」预览图的 dpi 越出常规区间（参考 ${outOfBand.ref.toFixed(0)}、逻辑 ${outOfBand.lx}/${outOfBand.ly}），` +
            `Word 可能因此改变对象框大小（见 docs/WORD处理经验/07）`
        )
      }
    }

    plans.push({
      holderIndex: hi,
      figure: fig,
      widthPt: width,
      heightPt: height,
      naturalWPt: naturalW,
      naturalHPt: naturalH,
      oleBytes,
      previewExt,
      previewBytes
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
    const block = buildObjectBlock(
      shapeId,
      objectId,
      ridOle,
      plan.widthPt,
      plan.heightPt,
      plan.naturalWPt,
      plan.naturalHPt,
      ridImg,
      plan.previewExt
    )
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

/**
 * 构造 VML OLE 对象块（含局部 w10 命名空间声明，与旧版一致）。
 *
 * 三处尺寸属性都是"别再改回去"的：
 *   - `w:dxaOrig/w:dyaOrig`：对象的**原始尺寸**（twips = pt×20），Word 的「原始大小」按它算；
 *     不写的话 Word 拿显示框当原始尺寸，重置大小就对不上（原生嵌入件里就有这两个属性）；
 *   - `aspectratio="t"`：**锁住宽高比**。写 `f` 等于允许 Word 非等比拉伸对象 ——
 *     框的比例只要和页面差一点，图就被拉歪（这是 258 张图里 64 张变形的直接原因）。
 */
function buildObjectBlock(
  shapeId: string,
  objectId: string,
  ridOle: string,
  widthPt: number,
  heightPt: number,
  naturalWPt: number,
  naturalHPt: number,
  ridImg: string | undefined,
  imgExt?: string
): string {
  const imagedata = ridImg
    ? `<v:imagedata r:id="${ridImg}" o:title=""/>`
    : ''
  // imgExt 仅用于将来扩展（如 raster 预览的 fill 类型）；当前 imagedata 即可
  void imgExt
  const twips = (pt: number): number => Math.round(pt * 20)
  return (
    '<w:object xmlns:w10="' + NS_W10 + '" ' +
    `w:dxaOrig="${twips(naturalWPt)}" w:dyaOrig="${twips(naturalHPt)}">` +
    `<v:shape id="${shapeId}" o:spt="75" type="#_x0000_t75" ` +
    // 两位小数：图的尺寸可能是几 pt（空图/微型图），只留一位会把宽高比舍歪（8pt 上一位=0.6%）
    `style="height:${heightPt.toFixed(2)}pt;width:${widthPt.toFixed(2)}pt;" ` +
    'o:ole="t" filled="f" o:preferrelative="t" stroked="f" coordsize="21600,21600">' +
    '<v:path/><v:fill on="f" focussize="0,0"/><v:stroke on="f"/>' + imagedata +
    '<o:lock v:ext="edit" aspectratio="t"/>' +
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
