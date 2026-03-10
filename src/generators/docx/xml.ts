import type { XmlNode } from './types.ts';
export type { XmlNode } from './types.ts';
import { MAX_RECURSION_DEPTH } from '../../safety.ts';

const ENTITIES: Record<string, string> = {
  'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"', 'apos': "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/g, (_, ent: string) => {
    if (ent.startsWith('#x')) return String.fromCharCode(parseInt(ent.slice(2), 16));
    if (ent.startsWith('#')) return String.fromCharCode(parseInt(ent.slice(1), 10));
    return ENTITIES[ent] ?? '&';
  });
}

export function parseXml(text: string): XmlNode {
  let pos = 0;

  function skipWhitespace(): void {
    while (pos < text.length && (text[pos] === ' ' || text[pos] === '\t' || text[pos] === '\n' || text[pos] === '\r')) pos++;
  }

  // Skip prolog, comments, processing instructions
  function skipMisc(): void {
    while (pos < text.length) {
      skipWhitespace();
      if (text.startsWith('<?', pos)) {
        const end = text.indexOf('?>', pos);
        if (end === -1) break;
        pos = end + 2;
      } else if (text.startsWith('<!--', pos)) {
        const end = text.indexOf('-->', pos);
        if (end === -1) break;
        pos = end + 3;
      } else if (text.startsWith('<!DOCTYPE', pos) || text.startsWith('<!doctype', pos)) {
        // Skip DOCTYPE — handle nested brackets
        let depth = 0;
        while (pos < text.length) {
          if (text[pos] === '[') depth++;
          else if (text[pos] === ']') depth--;
          else if (text[pos] === '>' && depth === 0) { pos++; break; }
          pos++;
        }
      } else {
        break;
      }
    }
  }

  function parseTagName(): { prefix: string; tag: string; fullName: string } {
    const start = pos;
    while (pos < text.length && text[pos] !== ' ' && text[pos] !== '\t' && text[pos] !== '\n' &&
           text[pos] !== '\r' && text[pos] !== '>' && text[pos] !== '/') pos++;
    const fullName = text.slice(start, pos);
    const colonIdx = fullName.indexOf(':');
    if (colonIdx >= 0) {
      return { prefix: fullName.slice(0, colonIdx), tag: fullName.slice(colonIdx + 1), fullName };
    }
    return { prefix: '', tag: fullName, fullName };
  }

  function parseAttributes(): Map<string, string> {
    const attrs = new Map<string, string>();
    while (pos < text.length) {
      skipWhitespace();
      if (text[pos] === '>' || text[pos] === '/') break;

      const nameStart = pos;
      while (pos < text.length && text[pos] !== '=' && text[pos] !== ' ' && text[pos] !== '>' && text[pos] !== '/') pos++;
      const name = text.slice(nameStart, pos);
      skipWhitespace();

      if (text[pos] !== '=') {
        attrs.set(name, '');
        continue;
      }
      pos++; // skip =
      skipWhitespace();

      const quote = text[pos];
      if (quote !== '"' && quote !== "'") {
        // Unquoted attribute value
        const vStart = pos;
        while (pos < text.length && text[pos] !== ' ' && text[pos] !== '>') pos++;
        attrs.set(name, decodeEntities(text.slice(vStart, pos)));
        continue;
      }
      pos++; // skip opening quote
      const vStart = pos;
      while (pos < text.length && text[pos] !== quote) pos++;
      attrs.set(name, decodeEntities(text.slice(vStart, pos)));
      pos++; // skip closing quote
    }
    return attrs;
  }

  function parseElement(depth = 0): XmlNode {
    if (depth > MAX_RECURSION_DEPTH) throw new Error('XML nesting too deep');
    pos++; // skip <
    const { prefix, tag, fullName } = parseTagName();
    const attrs = parseAttributes();
    skipWhitespace();

    // Self-closing
    if (text[pos] === '/') {
      pos++; // skip /
      pos++; // skip >
      return { tag, prefix, attrs, children: [], text: '' };
    }

    pos++; // skip >

    // Parse children and text content
    const children: XmlNode[] = [];
    let textContent = '';

    while (pos < text.length) {
      if (text.startsWith('</', pos)) {
        // Closing tag
        pos += 2;
        // Skip past closing tag name and >
        while (pos < text.length && text[pos] !== '>') pos++;
        pos++; // skip >
        return { tag, prefix, attrs, children, text: textContent };
      }

      if (text.startsWith('<!--', pos)) {
        const end = text.indexOf('-->', pos);
        pos = end === -1 ? text.length : end + 3;
        continue;
      }

      if (text[pos] === '<') {
        children.push(parseElement(depth + 1));
      } else {
        const start = pos;
        while (pos < text.length && text[pos] !== '<') pos++;
        textContent += decodeEntities(text.slice(start, pos));
      }
    }

    return { tag, prefix, attrs, children, text: textContent };
  }

  skipMisc();
  if (pos >= text.length || text[pos] !== '<') {
    return { tag: '', prefix: '', attrs: new Map(), children: [], text: '' };
  }
  return parseElement();
}

// Helper: find first child with given prefix:tag
export function findChild(node: XmlNode, prefix: string, tag: string): XmlNode | null {
  for (const c of node.children) {
    if (c.prefix === prefix && c.tag === tag) return c;
  }
  return null;
}

// Helper: find all children with given prefix:tag
export function findChildren(node: XmlNode, prefix: string, tag: string): XmlNode[] {
  return node.children.filter(c => c.prefix === prefix && c.tag === tag);
}

// Helper: get attribute value
export function attr(node: XmlNode, name: string): string | null {
  return node.attrs.get(name) ?? null;
}
