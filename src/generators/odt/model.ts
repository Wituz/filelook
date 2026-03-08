import { parseXml, findChild, findChildren, attr } from '../docx/xml.ts';
import type {
  XmlNode, DocxDocument, DocxBlock, DocxParagraph, DocxTable, DocxTableRow,
  DocxTableCell, DocxRun, DocxStyle, DocxParagraphProps, DocxRunProps,
  DocxBorder, DocxBorderSet, DocxFloatingImage, DocxInlineImage,
} from '../docx/types.ts';
import { DEFAULT_PARA_PROPS, DEFAULT_RUN_PROPS } from '../docx/types.ts';

// CSS/XSL-FO unit conversion to points
function cssUnitToPt(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/^(-?\d+\.?\d*)\s*(cm|mm|in|pt|px|pc)?$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  if (isNaN(num)) return null;
  switch (match[2] ?? 'pt') {
    case 'cm': return num * 28.3465;
    case 'mm': return num * 2.83465;
    case 'in': return num * 72;
    case 'pt': return num;
    case 'px': return num * 0.75;
    case 'pc': return num * 12;
    default: return num;
  }
}

export function parseOdtModel(files: Map<string, Uint8Array>): { doc: DocxDocument; floats: DocxFloatingImage[] } {
  const contentXml = files.get('content.xml');
  if (!contentXml) throw new Error('Invalid ODT: missing content.xml');

  const contentRoot = parseXml(new TextDecoder().decode(contentXml));
  const stylesXml = files.get('styles.xml');
  const stylesRoot = stylesXml ? parseXml(new TextDecoder().decode(stylesXml)) : null;

  const { pageWidth, pageHeight, marginTop, marginBottom, marginLeft, marginRight } = parsePageLayout(stylesRoot);
  const styles = parseOdtStyles(contentRoot, stylesRoot);
  const images = extractOdtImages(files);
  const floats: DocxFloatingImage[] = [];
  const body = parseOdtBody(contentRoot, floats, images);

  // Resolve document defaults from "Default Paragraph Style" if it exists
  let defaults = { ...DEFAULT_PARA_PROPS };
  let defaultRunProps: DocxRunProps = { ...DEFAULT_RUN_PROPS, fontSize: 12 };
  const defStyle = styles.get('Default_20_Paragraph_20_Style') ?? styles.get('Standard');
  if (defStyle) {
    defaults = { ...defaults, ...defStyle.paragraphProps, styleId: null };
    defaultRunProps = { ...defaultRunProps, ...defStyle.runProps, styleId: null };
  }

  return {
    doc: {
      body, styles, defaults, defaultRunProps,
      relationships: new Map(),
      images,
      pageWidth, pageHeight, marginTop, marginBottom, marginLeft, marginRight,
    },
    floats,
  };
}

// Page layout from styles.xml → <style:page-layout> → <style:page-layout-properties>
function parsePageLayout(stylesRoot: XmlNode | null): {
  pageWidth: number; pageHeight: number;
  marginTop: number; marginBottom: number; marginLeft: number; marginRight: number;
} {
  // A4 defaults
  let pageWidth = 595.28;
  let pageHeight = 841.89;
  let marginTop = 56.69;
  let marginBottom = 56.69;
  let marginLeft = 56.69;
  let marginRight = 56.69;

  if (!stylesRoot) return { pageWidth, pageHeight, marginTop, marginBottom, marginLeft, marginRight };

  const autoStyles = findChild(stylesRoot, 'office', 'automatic-styles');
  if (!autoStyles) return { pageWidth, pageHeight, marginTop, marginBottom, marginLeft, marginRight };

  for (const child of autoStyles.children) {
    if (child.prefix === 'style' && child.tag === 'page-layout') {
      const props = findChild(child, 'style', 'page-layout-properties');
      if (!props) continue;

      const w = cssUnitToPt(attr(props, 'fo:page-width'));
      const h = cssUnitToPt(attr(props, 'fo:page-height'));
      if (w !== null) pageWidth = w;
      if (h !== null) pageHeight = h;

      const mt = cssUnitToPt(attr(props, 'fo:margin-top'));
      const mb = cssUnitToPt(attr(props, 'fo:margin-bottom'));
      const ml = cssUnitToPt(attr(props, 'fo:margin-left'));
      const mr = cssUnitToPt(attr(props, 'fo:margin-right'));
      if (mt !== null) marginTop = mt;
      if (mb !== null) marginBottom = mb;
      if (ml !== null) marginLeft = ml;
      if (mr !== null) marginRight = mr;
      break;
    }
  }

  return { pageWidth, pageHeight, marginTop, marginBottom, marginLeft, marginRight };
}

// Parse styles from both content.xml automatic-styles and styles.xml named styles
function parseOdtStyles(contentRoot: XmlNode, stylesRoot: XmlNode | null): Map<string, DocxStyle> {
  const styles = new Map<string, DocxStyle>();

  // Named styles from styles.xml
  if (stylesRoot) {
    const officeStyles = findChild(stylesRoot, 'office', 'styles');
    if (officeStyles) {
      for (const s of findChildren(officeStyles, 'style', 'style')) {
        parseOdtStyleNode(s, styles);
      }
    }
    // Auto-styles from styles.xml (master page styles etc.)
    const autoStylesSxml = findChild(stylesRoot, 'office', 'automatic-styles');
    if (autoStylesSxml) {
      for (const s of findChildren(autoStylesSxml, 'style', 'style')) {
        parseOdtStyleNode(s, styles);
      }
    }
  }

  // Auto-styles from content.xml (override named styles with same name)
  const autoStyles = findChild(contentRoot, 'office', 'automatic-styles');
  if (autoStyles) {
    for (const s of findChildren(autoStyles, 'style', 'style')) {
      parseOdtStyleNode(s, styles);
    }
  }

  return styles;
}

function parseOdtStyleNode(node: XmlNode, styles: Map<string, DocxStyle>): void {
  const name = attr(node, 'style:name');
  if (!name) return;

  const parentStyle = attr(node, 'style:parent-style-name');
  const pProps = findChild(node, 'style', 'paragraph-properties');
  const rProps = findChild(node, 'style', 'text-properties');

  styles.set(name, {
    id: name,
    basedOn: parentStyle ?? null,
    paragraphProps: pProps ? { ...DEFAULT_PARA_PROPS, ...parseOdtParaProps(pProps), styleId: name } : { ...DEFAULT_PARA_PROPS, styleId: name },
    runProps: rProps ? { ...DEFAULT_RUN_PROPS, ...parseOdtRunProps(rProps), styleId: name } : { ...DEFAULT_RUN_PROPS, styleId: name },
  });
}

function parseOdtParaProps(props: XmlNode): Partial<DocxParagraphProps> {
  const result: Partial<DocxParagraphProps> = {};

  const align = attr(props, 'fo:text-align');
  if (align) {
    if (align === 'center') result.alignment = 'center';
    else if (align === 'end' || align === 'right') result.alignment = 'right';
    else if (align === 'justify') result.alignment = 'justify';
    else result.alignment = 'left';
  }

  const marginTop = cssUnitToPt(attr(props, 'fo:margin-top'));
  if (marginTop !== null) result.spaceBefore = marginTop;
  const marginBottom = cssUnitToPt(attr(props, 'fo:margin-bottom'));
  if (marginBottom !== null) result.spaceAfter = marginBottom;

  const lineHeight = attr(props, 'fo:line-height');
  if (lineHeight) {
    if (lineHeight.endsWith('%')) {
      result.lineSpacing = parseFloat(lineHeight) / 100;
    } else {
      const lhPt = cssUnitToPt(lineHeight);
      if (lhPt !== null) result.lineSpacing = lhPt / 12;
    }
  }

  const marginLeft = cssUnitToPt(attr(props, 'fo:margin-left'));
  if (marginLeft !== null) result.indentLeft = marginLeft;
  const marginRight = cssUnitToPt(attr(props, 'fo:margin-right'));
  if (marginRight !== null) result.indentRight = marginRight;
  const textIndent = cssUnitToPt(attr(props, 'fo:text-indent'));
  if (textIndent !== null) result.indentFirstLine = textIndent;

  const bgColor = attr(props, 'fo:background-color');
  if (bgColor && bgColor !== 'transparent') result.shading = bgColor.replace('#', '');

  const borderBottom = attr(props, 'fo:border-bottom');
  if (borderBottom && borderBottom !== 'none') {
    result.borderBottom = parseCssBorder(borderBottom);
  }

  const breakBefore = attr(props, 'fo:break-before');
  if (breakBefore === 'page') result.pageBreakBefore = true;

  return result;
}

function parseCssBorder(value: string): DocxBorder | null {
  const parts = value.trim().split(/\s+/);
  if (parts.length < 2 || parts[1] === 'none') return null;
  const width = cssUnitToPt(parts[0]) ?? 0.5;
  const color = parts.length >= 3 ? parts[2].replace('#', '') : '000000';
  return { width, color };
}

function parseOdtRunProps(props: XmlNode): Partial<DocxRunProps> {
  const result: Partial<DocxRunProps> = {};

  const fontSize = cssUnitToPt(attr(props, 'fo:font-size'));
  if (fontSize !== null) result.fontSize = fontSize;

  const fontWeight = attr(props, 'fo:font-weight');
  if (fontWeight === 'bold' || fontWeight === '700') result.bold = true;
  else if (fontWeight === 'normal' || fontWeight === '400') result.bold = false;

  const fontStyle = attr(props, 'fo:font-style');
  if (fontStyle === 'italic' || fontStyle === 'oblique') result.italic = true;
  else if (fontStyle === 'normal') result.italic = false;

  const underline = attr(props, 'style:text-underline-style');
  if (underline && underline !== 'none') result.underline = true;
  else if (underline === 'none') result.underline = false;

  const color = attr(props, 'fo:color');
  if (color && color !== 'auto') result.color = color.replace('#', '');

  return result;
}

// Extract images from Pictures/ directory
function extractOdtImages(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const images = new Map<string, Uint8Array>();
  for (const [name, data] of files) {
    if (name.startsWith('Pictures/')) {
      images.set(name, data);
    }
  }
  return images;
}

// Body parsing
function parseOdtBody(contentRoot: XmlNode, floats: DocxFloatingImage[], images: Map<string, Uint8Array>): DocxBlock[] {
  const body = findChild(contentRoot, 'office', 'body');
  if (!body) return [];
  const text = findChild(body, 'office', 'text');
  if (!text) return [];
  return parseOdtBlocks(text, floats, images);
}

function parseOdtBlocks(parent: XmlNode, floats: DocxFloatingImage[], images: Map<string, Uint8Array>): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  for (const child of parent.children) {
    if (child.prefix === 'text' && (child.tag === 'p' || child.tag === 'h')) {
      blocks.push(parseOdtParagraph(child, floats, images));
    } else if (child.prefix === 'text' && child.tag === 'list') {
      blocks.push(...parseOdtList(child, 0, floats, images));
    } else if (child.prefix === 'table' && child.tag === 'table') {
      blocks.push(parseOdtTable(child, floats, images));
    } else if (child.prefix === 'text' && child.tag === 'section') {
      blocks.push(...parseOdtBlocks(child, floats, images));
    }
  }
  return blocks;
}

function parseOdtParagraph(node: XmlNode, floats: DocxFloatingImage[], images: Map<string, Uint8Array>): DocxParagraph {
  const styleName = attr(node, 'text:style-name');
  // Only set styleId — leave other fields undefined so they don't override
  // style chain values in resolveParaProps (which uses ?? to merge)
  const props = { styleId: styleName ?? null } as DocxParagraphProps;

  const runs: DocxRun[] = [];
  collectInlineContent(node, null, runs, floats, images);

  return { type: 'paragraph', props, runs };
}

// Collect text runs from a paragraph or span node
function collectInlineContent(
  node: XmlNode, runStyleId: string | null,
  runs: DocxRun[], floats: DocxFloatingImage[], images: Map<string, Uint8Array>,
): void {
  // Only set styleId — leave other fields undefined so style chain resolves correctly
  const baseProps = { styleId: runStyleId ?? null } as DocxRunProps;

  if (node.children.length === 0) {
    if (node.text) {
      runs.push({ type: 'text', text: node.text, props: baseProps });
    }
    return;
  }

  // Emit bare inter-element text (the XML parser concatenates it into node.text).
  // This handles mixed content like: bare text<text:span>styled</text:span>
  if (node.text) {
    runs.push({ type: 'text', text: node.text, props: baseProps });
  }

  for (const child of node.children) {
    if (child.prefix === 'text' && child.tag === 'span') {
      const spanStyle = attr(child, 'text:style-name');
      collectInlineContent(child, spanStyle, runs, floats, images);
    } else if (child.prefix === 'text' && child.tag === 's') {
      const count = parseInt(attr(child, 'text:c') ?? '1', 10);
      runs.push({ type: 'text', text: ' '.repeat(count), props: baseProps });
    } else if (child.prefix === 'text' && child.tag === 'tab') {
      runs.push({ type: 'tab', text: '\t', props: baseProps });
    } else if (child.prefix === 'text' && child.tag === 'line-break') {
      runs.push({ type: 'break', text: '\n', props: baseProps });
    } else if (child.prefix === 'text' && child.tag === 'a') {
      collectInlineContent(child, runStyleId, runs, floats, images);
    } else if (child.prefix === 'draw' && child.tag === 'frame') {
      parseOdtDrawFrame(child, runs, floats, images);
    }
  }
}

function parseOdtDrawFrame(
  frame: XmlNode, runs: DocxRun[], floats: DocxFloatingImage[], images: Map<string, Uint8Array>,
): void {
  const imageNode = findChild(frame, 'draw', 'image');
  if (!imageNode) return;

  const href = attr(imageNode, 'xlink:href');
  if (!href || !images.has(href)) return;

  const width = cssUnitToPt(attr(frame, 'svg:width')) ?? 72;
  const height = cssUnitToPt(attr(frame, 'svg:height')) ?? 72;
  const anchorType = attr(frame, 'text:anchor-type');

  if (anchorType === 'page' || anchorType === 'paragraph' || anchorType === 'char') {
    const x = cssUnitToPt(attr(frame, 'svg:x')) ?? 0;
    const y = cssUnitToPt(attr(frame, 'svg:y')) ?? 0;
    floats.push({ rId: href, widthPt: width, heightPt: height, x, y, wrapMode: 'square' });
  } else {
    // as-char (inline) or default
    runs.push({
      type: 'image', text: '',
      props: { styleId: null } as DocxRunProps,
      image: { rId: href, widthPt: width, heightPt: height },
    });
  }
}

// List → flattened paragraphs with bullet markers
function parseOdtList(listNode: XmlNode, level: number, floats: DocxFloatingImage[], images: Map<string, Uint8Array>): DocxParagraph[] {
  const result: DocxParagraph[] = [];
  for (const item of findChildren(listNode, 'text', 'list-item')) {
    for (const child of item.children) {
      if (child.prefix === 'text' && (child.tag === 'p' || child.tag === 'h')) {
        const para = parseOdtParagraph(child, floats, images);
        para.props = {
          ...para.props,
          bullet: level === 0 ? '\u2022' : '\u2013',
          indentLeft: (level + 1) * 18,
        };
        result.push(para);
      } else if (child.prefix === 'text' && child.tag === 'list') {
        result.push(...parseOdtList(child, level + 1, floats, images));
      }
    }
  }
  return result;
}

// Table parsing
function parseOdtTable(tableNode: XmlNode, floats: DocxFloatingImage[], images: Map<string, Uint8Array>): DocxTable {
  const columnWidths: number[] = [];
  for (const col of findChildren(tableNode, 'table', 'table-column')) {
    const repeat = parseInt(attr(col, 'table:number-columns-repeated') ?? '1', 10);
    for (let i = 0; i < repeat; i++) {
      columnWidths.push(0); // 0 = let layout engine compute
    }
  }

  const borders: DocxBorderSet = {
    top: { width: 0.5, color: '000000' },
    bottom: { width: 0.5, color: '000000' },
    left: { width: 0.5, color: '000000' },
    right: { width: 0.5, color: '000000' },
    insideH: { width: 0.5, color: '000000' },
    insideV: { width: 0.5, color: '000000' },
  };

  const rows: DocxTableRow[] = [];
  for (const rowNode of findChildren(tableNode, 'table', 'table-row')) {
    const cells: DocxTableCell[] = [];
    for (const cellNode of findChildren(rowNode, 'table', 'table-cell')) {
      const colSpan = parseInt(attr(cellNode, 'table:number-columns-spanned') ?? '1', 10);
      const blocks = parseOdtBlocks(cellNode, floats, images);
      cells.push({ blocks, columnSpan: colSpan, shading: null });
    }
    rows.push({ cells, height: 0 });
  }

  return { type: 'table', rows, columnWidths, borders };
}
