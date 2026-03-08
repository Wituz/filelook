import { parseXml, findChild, findChildren, attr } from '../docx/xml.ts';
import type { XmlNode } from '../docx/types.ts';
import type {
  PptxTheme, PptxSlide, PptxShape, PptxTextShape, PptxPictureShape,
  PptxParagraph, PptxRun, PlaceholderDef,
} from './types.ts';

// Scheme aliases
const SCHEME_ALIASES: Record<string, string> = {
  tx1: 'dk1', tx2: 'dk2', bg1: 'lt1', bg2: 'lt2',
};

function emuToPt(emu: number): number { return emu / 12700; }

function numAttr(node: XmlNode, name: string): number | null {
  const v = attr(node, name);
  if (v === null) return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

function parseRels(files: Map<string, Uint8Array>, relsPath: string): Map<string, string> {
  const rels = new Map<string, string>();
  const data = files.get(relsPath);
  if (!data) return rels;
  const xml = parseXml(new TextDecoder().decode(data));
  for (const child of xml.children) {
    if (child.tag === 'Relationship') {
      const id = attr(child, 'Id');
      const target = attr(child, 'Target');
      if (id && target) rels.set(id, target);
    }
  }
  return rels;
}

function parseTheme(files: Map<string, Uint8Array>, themePath: string): PptxTheme {
  const colors = new Map<string, string>();
  const data = files.get(themePath);
  if (!data) return { colors };

  const xml = parseXml(new TextDecoder().decode(data));
  const themeElements = findChild(xml, 'a', 'themeElements');
  if (!themeElements) return { colors };

  const clrScheme = findChild(themeElements, 'a', 'clrScheme');
  if (!clrScheme) return { colors };

  for (const child of clrScheme.children) {
    if (child.prefix !== 'a') continue;
    const name = child.tag; // dk1, lt1, dk2, lt2, accent1-6, hlink, folHlink
    const srgb = findChild(child, 'a', 'srgbClr');
    if (srgb) {
      const val = attr(srgb, 'val');
      if (val) colors.set(name, val);
      continue;
    }
    const sys = findChild(child, 'a', 'sysClr');
    if (sys) {
      const val = attr(sys, 'lastClr') ?? attr(sys, 'val');
      if (val) colors.set(name, val);
    }
  }

  return { colors };
}

function resolveColor(fillNode: XmlNode | null, theme: PptxTheme): string | null {
  if (!fillNode) return null;

  const srgb = findChild(fillNode, 'a', 'srgbClr');
  if (srgb) return attr(srgb, 'val');

  const scheme = findChild(fillNode, 'a', 'schemeClr');
  if (scheme) {
    let name = attr(scheme, 'val');
    if (!name) return null;
    if (SCHEME_ALIASES[name]) name = SCHEME_ALIASES[name];
    return theme.colors.get(name) ?? null;
  }

  return null;
}

function resolveColorFromNode(node: XmlNode, theme: PptxTheme): string | null {
  const solidFill = findChild(node, 'a', 'solidFill');
  return resolveColor(solidFill, theme);
}

function hasOuterShadow(rPr: XmlNode | null): boolean {
  if (!rPr) return false;
  const effectLst = findChild(rPr, 'a', 'effectLst');
  if (!effectLst) return false;
  return findChild(effectLst, 'a', 'outerShdw') !== null;
}

function parsePlaceholders(spTree: XmlNode): PlaceholderDef[] {
  const defs: PlaceholderDef[] = [];
  for (const sp of findChildren(spTree, 'p', 'sp')) {
    const nvSpPr = findChild(sp, 'p', 'nvSpPr');
    if (!nvSpPr) continue;
    const nvPr = findChild(nvSpPr, 'p', 'nvPr');
    if (!nvPr) continue;
    const ph = findChild(nvPr, 'p', 'ph');
    if (!ph) continue;

    const type = attr(ph, 'type');
    const idxStr = attr(ph, 'idx');
    const idx = idxStr !== null ? parseInt(idxStr, 10) : null;

    const spPr = findChild(sp, 'p', 'spPr');
    if (!spPr) continue;
    const xfrm = findChild(spPr, 'a', 'xfrm');
    if (!xfrm) continue;
    const off = findChild(xfrm, 'a', 'off');
    const ext = findChild(xfrm, 'a', 'ext');
    if (!off || !ext) continue;

    const x = numAttr(off, 'x');
    const y = numAttr(off, 'y');
    const cx = numAttr(ext, 'cx');
    const cy = numAttr(ext, 'cy');
    if (x === null || y === null || cx === null || cy === null) continue;

    // Parse anchor from bodyPr in layout/master placeholder
    let anchor: 't' | 'ctr' | 'b' = 't';
    const txBody = findChild(sp, 'p', 'txBody');
    if (txBody) {
      const bodyPr = findChild(txBody, 'a', 'bodyPr');
      if (bodyPr) {
        const a = attr(bodyPr, 'anchor');
        if (a === 'ctr') anchor = 'ctr';
        else if (a === 'b') anchor = 'b';
      }
    }

    defs.push({ type, idx: isNaN(idx!) ? null : idx, x: emuToPt(x), y: emuToPt(y), width: emuToPt(cx), height: emuToPt(cy), anchor });
  }
  return defs;
}

function findPlaceholderPos(
  phType: string | null, phIdx: number | null,
  layoutPhs: PlaceholderDef[], masterPhs: PlaceholderDef[],
): PlaceholderDef | null {
  // Match by type first, then by idx
  for (const phs of [layoutPhs, masterPhs]) {
    if (phType) {
      const byType = phs.find(p => p.type === phType);
      if (byType) return byType;
    }
    if (phIdx !== null) {
      const byIdx = phs.find(p => p.idx === phIdx);
      if (byIdx) return byIdx;
    }
  }
  return null;
}

function getDefaultFontSize(phType: string | null): number {
  if (phType === 'title' || phType === 'ctrTitle') return 44;
  if (phType === 'subTitle') return 32;
  if (phType === 'body') return 18;
  return 18;
}

function getDefaultAlignment(phType: string | null): 'left' | 'center' | 'right' {
  if (phType === 'ctrTitle' || phType === 'subTitle' || phType === 'title') return 'center';
  return 'left';
}

function parseTextBody(txBody: XmlNode, theme: PptxTheme, defaultFontSize: number, phType: string | null = null): PptxParagraph[] {
  const paragraphs: PptxParagraph[] = [];
  const defaultAlign = getDefaultAlignment(phType);

  for (const pNode of findChildren(txBody, 'a', 'p')) {
    const pPr = findChild(pNode, 'a', 'pPr');
    let alignment: 'left' | 'center' | 'right' = defaultAlign;
    let spaceBefore = 0;
    let spaceAfter = 0;
    let bullet: string | null = null;

    if (pPr) {
      const algn = attr(pPr, 'algn');
      if (algn === 'ctr') alignment = 'center';
      else if (algn === 'r') alignment = 'right';

      const spcBef = findChild(pPr, 'a', 'spcBef');
      if (spcBef) {
        const spcPts = findChild(spcBef, 'a', 'spcPts');
        if (spcPts) {
          const val = numAttr(spcPts, 'val');
          if (val !== null) spaceBefore = val / 100;
        }
      }
      const spcAft = findChild(pPr, 'a', 'spcAft');
      if (spcAft) {
        const spcPts = findChild(spcAft, 'a', 'spcPts');
        if (spcPts) {
          const val = numAttr(spcPts, 'val');
          if (val !== null) spaceAfter = val / 100;
        }
      }

      const buChar = findChild(pPr, 'a', 'buChar');
      if (buChar) {
        bullet = attr(buChar, 'char') ?? '\u2022';
      }
    }

    const runs: PptxRun[] = [];
    for (const rNode of findChildren(pNode, 'a', 'r')) {
      const rPr = findChild(rNode, 'a', 'rPr');
      let fontSize = defaultFontSize;
      let bold = false;
      let color: string | null = null;

      if (rPr) {
        const sz = numAttr(rPr, 'sz');
        if (sz !== null) fontSize = sz / 100;
        const b = attr(rPr, 'b');
        if (b === '1' || b === 'true') bold = true;
        color = resolveColorFromNode(rPr, theme);
      }

      const shadow = hasOuterShadow(rPr);
      const t = findChild(rNode, 'a', 't');
      if (t) {
        runs.push({ text: t.text, fontSize, bold, color, shadow });
      }
    }

    // Also handle <a:fld> (field) elements like slide numbers, dates
    for (const fld of findChildren(pNode, 'a', 'fld')) {
      const rPr = findChild(fld, 'a', 'rPr');
      let fontSize = defaultFontSize;
      let bold = false;
      let color: string | null = null;
      if (rPr) {
        const sz = numAttr(rPr, 'sz');
        if (sz !== null) fontSize = sz / 100;
        const b = attr(rPr, 'b');
        if (b === '1' || b === 'true') bold = true;
        color = resolveColorFromNode(rPr, theme);
      }
      const shadow = hasOuterShadow(rPr);
      const t = findChild(fld, 'a', 't');
      if (t && t.text) {
        runs.push({ text: t.text, fontSize, bold, color, shadow });
      }
    }

    paragraphs.push({ alignment, runs, spaceBefore, spaceAfter, bullet });
  }

  return paragraphs;
}

function parseShapeXfrm(sp: XmlNode): { x: number; y: number; width: number; height: number } | null {
  const spPr = findChild(sp, 'p', 'spPr');
  if (!spPr) return null;
  const xfrm = findChild(spPr, 'a', 'xfrm');
  if (!xfrm) return null;
  const off = findChild(xfrm, 'a', 'off');
  const ext = findChild(xfrm, 'a', 'ext');
  if (!off || !ext) return null;

  const x = numAttr(off, 'x');
  const y = numAttr(off, 'y');
  const cx = numAttr(ext, 'cx');
  const cy = numAttr(ext, 'cy');
  if (x === null || y === null || cx === null || cy === null) return null;

  return { x: emuToPt(x), y: emuToPt(y), width: emuToPt(cx), height: emuToPt(cy) };
}

function getPlaceholderInfo(sp: XmlNode): { type: string | null; idx: number | null } | null {
  const nvSpPr = findChild(sp, 'p', 'nvSpPr');
  if (!nvSpPr) return null;
  const nvPr = findChild(nvSpPr, 'p', 'nvPr');
  if (!nvPr) return null;
  const ph = findChild(nvPr, 'p', 'ph');
  if (!ph) return null;
  const type = attr(ph, 'type');
  const idxStr = attr(ph, 'idx');
  const idx = idxStr !== null ? parseInt(idxStr, 10) : null;
  return { type, idx: idx !== null && !isNaN(idx) ? idx : null };
}

function findBlipRId(node: XmlNode): string | null {
  for (const child of node.children) {
    if (child.prefix === 'a' && child.tag === 'blip') {
      return attr(child, 'r:embed') ?? attr(child, 'r:link') ?? null;
    }
    const found = findBlipRId(child);
    if (found) return found;
  }
  return null;
}

function resolveSlideBackground(
  slideXml: XmlNode, layoutXml: XmlNode | null, masterXml: XmlNode | null, theme: PptxTheme,
): string | null {
  for (const xml of [slideXml, layoutXml, masterXml]) {
    if (!xml) continue;
    const cSld = findChild(xml, 'p', 'cSld');
    if (!cSld) continue;
    const bg = findChild(cSld, 'p', 'bg');
    if (!bg) continue;
    const bgPr = findChild(bg, 'p', 'bgPr');
    if (bgPr) {
      const color = resolveColorFromNode(bgPr, theme);
      if (color) return color;
    }
    const bgRef = findChild(bg, 'p', 'bgRef');
    if (bgRef) {
      const color = resolveColor(bgRef, theme);
      if (color) return color;
    }
  }
  return null;
}

function parseSpTree(
  spTree: XmlNode, theme: PptxTheme, slideRels: Map<string, string>,
  layoutPhs: PlaceholderDef[], masterPhs: PlaceholderDef[],
): PptxShape[] {
  const shapes: PptxShape[] = [];

  for (const child of spTree.children) {
    if (child.prefix === 'p' && child.tag === 'sp') {
      const shape = parseTextShapeNode(child, theme, layoutPhs, masterPhs);
      if (shape) shapes.push(shape);
    } else if (child.prefix === 'p' && child.tag === 'pic') {
      const shape = parsePictureNode(child, slideRels);
      if (shape) shapes.push(shape);
    }
    // Skip grpSp, graphicFrame, cxnSp
  }

  return shapes;
}

function parseTextShapeNode(
  sp: XmlNode, theme: PptxTheme,
  layoutPhs: PlaceholderDef[], masterPhs: PlaceholderDef[],
): PptxTextShape | null {
  let pos = parseShapeXfrm(sp);
  const phInfo = getPlaceholderInfo(sp);
  let defaultFontSize = 18;

  if (!pos && phInfo) {
    const resolved = findPlaceholderPos(phInfo.type, phInfo.idx, layoutPhs, masterPhs);
    if (!resolved) return null; // no position, skip
    pos = resolved;
  }
  if (!pos) return null;

  if (phInfo) {
    defaultFontSize = getDefaultFontSize(phInfo.type);
  }

  // Shape fill
  let fill: string | null = null;
  const spPr = findChild(sp, 'p', 'spPr');
  if (spPr) {
    fill = resolveColorFromNode(spPr, theme);
  }

  // Text body
  const txBody = findChild(sp, 'p', 'txBody');
  if (!txBody) return null;

  // Resolve vertical anchor: slide bodyPr → layout/master placeholder
  let anchor: 't' | 'ctr' | 'b' = 't';
  const bodyPr = findChild(txBody, 'a', 'bodyPr');
  if (bodyPr) {
    const a = attr(bodyPr, 'anchor');
    if (a === 'ctr') anchor = 'ctr';
    else if (a === 'b') anchor = 'b';
  }
  // Inherit from layout/master if slide doesn't specify
  if (anchor === 't' && phInfo && !(bodyPr && attr(bodyPr, 'anchor'))) {
    const resolved = findPlaceholderPos(phInfo.type, phInfo.idx, layoutPhs, masterPhs);
    if (resolved) anchor = resolved.anchor;
  }

  const paragraphs = parseTextBody(txBody, theme, defaultFontSize, phInfo?.type ?? null);
  // Skip shapes with no actual text
  const hasText = paragraphs.some(p => p.runs.length > 0);
  if (!hasText) return null;

  return { type: 'text', ...pos, fill, anchor, paragraphs };
}

function parsePictureNode(pic: XmlNode, slideRels: Map<string, string>): PptxPictureShape | null {
  const pos = parsePicXfrm(pic);
  if (!pos) return null;

  const blipFill = findChild(pic, 'p', 'blipFill');
  if (!blipFill) return null;
  const rId = findBlipRId(blipFill);
  if (!rId) return null;

  return { type: 'picture', ...pos, rId };
}

function parsePicXfrm(pic: XmlNode): { x: number; y: number; width: number; height: number } | null {
  const spPr = findChild(pic, 'p', 'spPr');
  if (!spPr) return null;
  const xfrm = findChild(spPr, 'a', 'xfrm');
  if (!xfrm) return null;
  const off = findChild(xfrm, 'a', 'off');
  const ext = findChild(xfrm, 'a', 'ext');
  if (!off || !ext) return null;

  const x = numAttr(off, 'x');
  const y = numAttr(off, 'y');
  const cx = numAttr(ext, 'cx');
  const cy = numAttr(ext, 'cy');
  if (x === null || y === null || cx === null || cy === null) return null;

  return { x: emuToPt(x), y: emuToPt(y), width: emuToPt(cx), height: emuToPt(cy) };
}

function loadXml(files: Map<string, Uint8Array>, path: string): XmlNode | null {
  const data = files.get(path);
  if (!data) return null;
  return parseXml(new TextDecoder().decode(data));
}

export function parsePptxSlide(files: Map<string, Uint8Array>): { slide: PptxSlide; images: Map<string, Uint8Array> } {
  // 1. Parse presentation.xml for slide size and first slide reference
  const presXml = loadXml(files, 'ppt/presentation.xml');
  if (!presXml) throw new Error('Invalid PPTX: missing presentation.xml');

  let slideWidth = 720; // default 10" = 720pt
  let slideHeight = 540; // default 7.5" = 540pt

  const sldSz = findChild(presXml, 'p', 'sldSz');
  if (sldSz) {
    const cx = numAttr(sldSz, 'cx');
    const cy = numAttr(sldSz, 'cy');
    if (cx !== null) slideWidth = emuToPt(cx);
    if (cy !== null) slideHeight = emuToPt(cy);
  }

  // Find first slide rId
  const sldIdLst = findChild(presXml, 'p', 'sldIdLst');
  if (!sldIdLst) throw new Error('Invalid PPTX: no slides');
  const firstSldId = findChildren(sldIdLst, 'p', 'sldId')[0];
  if (!firstSldId) throw new Error('Invalid PPTX: no slides');
  const slideRId = attr(firstSldId, 'r:id');
  if (!slideRId) throw new Error('Invalid PPTX: no slides');

  // 2. Resolve slide path from presentation rels
  const presRels = parseRels(files, 'ppt/_rels/presentation.xml.rels');
  const slidePath = presRels.get(slideRId);
  if (!slidePath) throw new Error('Invalid PPTX: no slides');
  const fullSlidePath = slidePath.startsWith('/') ? slidePath.slice(1) : `ppt/${slidePath}`;

  // 3. Parse theme
  let theme: PptxTheme = { colors: new Map() };
  for (const [, target] of presRels) {
    if (target.includes('theme')) {
      const themePath = target.startsWith('/') ? target.slice(1) : `ppt/${target}`;
      theme = parseTheme(files, themePath);
      break;
    }
  }

  // 4. Parse slide XML
  const slideXml = loadXml(files, fullSlidePath);
  if (!slideXml) throw new Error('Invalid PPTX: missing slide XML');

  // 5. Parse slide rels for layout + images
  const slideRels = parseRels(files, relsPath(fullSlidePath));

  // 6. Find layout and master, parse placeholders
  let layoutXml: XmlNode | null = null;
  let masterXml: XmlNode | null = null;
  let layoutPhs: PlaceholderDef[] = [];
  let masterPhs: PlaceholderDef[] = [];

  for (const [, target] of slideRels) {
    if (target.includes('slideLayout')) {
      const layoutPath = target.startsWith('/') ? target.slice(1) : `ppt/slides/${target}`;
      // Normalize path (handle ../slideLayouts/...)
      const normalizedLayout = normalizePath(fullSlidePath, target);
      layoutXml = loadXml(files, normalizedLayout);
      if (layoutXml) {
        const spTree = findSpTree(layoutXml);
        if (spTree) layoutPhs = parsePlaceholders(spTree);

        // Find master from layout rels
        const layoutRels = parseRels(files, relsPath(normalizedLayout));
        for (const [, lt] of layoutRels) {
          if (lt.includes('slideMaster')) {
            const normalizedMaster = normalizePath(normalizedLayout, lt);
            masterXml = loadXml(files, normalizedMaster);
            if (masterXml) {
              const mst = findSpTree(masterXml);
              if (mst) masterPhs = parsePlaceholders(mst);
            }
            break;
          }
        }
      }
      break;
    }
  }

  // 7. Resolve background
  const background = resolveSlideBackground(slideXml, layoutXml, masterXml, theme);

  // 8. Parse shape tree
  const spTree = findSpTree(slideXml);
  const shapes = spTree ? parseSpTree(spTree, theme, slideRels, layoutPhs, masterPhs) : [];

  // 9. Extract images
  const images = new Map<string, Uint8Array>();
  for (const [rId, target] of slideRels) {
    if (!target.includes('media/') && !target.includes('image')) continue;
    const imgPath = normalizePath(fullSlidePath, target);
    const data = files.get(imgPath);
    if (data) images.set(rId, data);
  }

  return {
    slide: { width: slideWidth, height: slideHeight, background, shapes },
    images,
  };
}

function findSpTree(xml: XmlNode): XmlNode | null {
  const cSld = findChild(xml, 'p', 'cSld');
  if (!cSld) return null;
  return findChild(cSld, 'p', 'spTree');
}

function normalizePath(basePath: string, relative: string): string {
  if (relative.startsWith('/')) return relative.slice(1);
  const parts = basePath.split('/');
  parts.pop(); // remove filename
  for (const seg of relative.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

// OOXML rels path: ppt/slides/slide1.xml → ppt/slides/_rels/slide1.xml.rels
function relsPath(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/');
  if (lastSlash < 0) return '_rels/' + filePath + '.rels';
  return filePath.slice(0, lastSlash + 1) + '_rels/' + filePath.slice(lastSlash + 1) + '.rels';
}
