'use strict';

/**
 * Pasa un documento del lienzo a markdown.
 * Sirve para copiarlo y pegarlo en un agente: título, descripción y cuerpo.
 * Las imágenes quedan como referencia, sin el data URL.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.InplaizeDocumentMarkdown = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const MARK_ORDER = ['underline', 'italic', 'bold', 'link'];

  function cleanPlain(value) {
    return String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function escapeInline(text) {
    return String(text || '').replace(/[\\`*_[\]~]/g, (ch) => `\\${ch}`);
  }

  function linkHref(mark) {
    const href = mark && mark.attrs && typeof mark.attrs.href === 'string' ? mark.attrs.href : '';
    return href.replace(/[\u0000-\u001f\s<>]/g, '');
  }

  function applyMarks(text, marks) {
    if (!Array.isArray(marks) || !marks.length) return text;
    const sorted = marks.slice().sort((a, b) => {
      const ai = MARK_ORDER.indexOf(a && a.type);
      const bi = MARK_ORDER.indexOf(b && b.type);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
    let out = text;
    sorted.forEach((mark) => {
      if (!mark) return;
      if (mark.type === 'bold') out = `**${out}**`;
      else if (mark.type === 'italic') out = `*${out}*`;
      else if (mark.type === 'underline') out = `<u>${out}</u>`;
      else if (mark.type === 'link') {
        const href = linkHref(mark);
        if (href) out = `[${out}](${href})`;
      }
    });
    return out;
  }

  function renderInline(nodes) {
    if (!Array.isArray(nodes)) return '';
    return nodes.map((node) => {
      if (!node) return '';
      if (node.type === 'hardBreak') return '  \n';
      if (node.type !== 'text') return '';
      return applyMarks(escapeInline(node.text), node.marks);
    }).join('');
  }

  function headingLevel(node) {
    const level = node && node.attrs && node.attrs.level;
    return level === 2 || level === 3 ? level : 1;
  }

  function listStart(node) {
    const start = node && node.attrs && node.attrs.start;
    const number = typeof start === 'number' ? start : parseInt(start, 10);
    if (!Number.isFinite(number) || number < 1) return 1;
    return Math.floor(number);
  }

  function markerFor(list, item, number) {
    if (list.type === 'taskList' || (item && item.type === 'taskItem')) {
      const checked = !!(item && item.attrs && item.attrs.checked === true);
      return `- [${checked ? 'x' : ' '}] `;
    }
    if (list.type === 'orderedList') return `${number}. `;
    return '- ';
  }

  function imageAlt(node) {
    const alt = node && node.attrs && typeof node.attrs.alt === 'string' ? node.attrs.alt : '';
    const clean = alt.replace(/[\[\]\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
    return clean || 'imagen';
  }

  function appendIndented(lines, block, prefix) {
    const trimmed = String(block || '').trim();
    if (!trimmed) return;
    trimmed.split('\n').forEach((line) => {
      lines.push(line ? prefix + line : prefix.trimEnd());
    });
  }

  function renderListItem(item, indent, marker) {
    const pad = '  '.repeat(indent);
    const hang = ' '.repeat(marker.length);
    const children = item && Array.isArray(item.content) ? item.content : [];
    const lines = [];
    if (!children.length) {
      lines.push(`${pad}${marker.trimEnd()}`);
    } else if (children[0] && children[0].type === 'paragraph') {
      const text = renderInline(children[0].content);
      const parts = text ? text.split('\n') : [];
      if (!parts.length) lines.push(`${pad}${marker.trimEnd()}`);
      else {
        lines.push(`${pad}${marker}${parts[0]}`);
        for (let i = 1; i < parts.length; i += 1) lines.push(`${pad}${hang}${parts[i]}`);
      }
      for (let i = 1; i < children.length; i += 1) {
        appendIndented(lines, renderBlock(children[i], 0), pad + hang);
      }
    } else {
      lines.push(`${pad}${marker.trimEnd()}`);
      children.forEach((child) => appendIndented(lines, renderBlock(child, 0), pad + hang));
    }
    return `${lines.join('\n')}\n`;
  }

  function renderList(node, indent) {
    const items = node && Array.isArray(node.content) ? node.content : [];
    if (!items.length) return '';
    const start = node.type === 'orderedList' ? listStart(node) : 1;
    const body = items.map((item, index) => renderListItem(item, indent, markerFor(node, item, start + index))).join('');
    return `${body.replace(/\s+$/, '')}\n\n`;
  }

  function renderBlock(node, indent) {
    if (!node || typeof node !== 'object') return '';
    const pad = '  '.repeat(indent || 0);
    switch (node.type) {
      case 'doc':
        return renderBlocks(node.content, indent);
      case 'paragraph': {
        const text = renderInline(node.content);
        if (!text) return '';
        return `${text.split('\n').map((line) => pad + line).join('\n')}\n\n`;
      }
      case 'heading': {
        const text = renderInline(node.content).replace(/\s*\n\s*/g, ' ').trim();
        return `${pad}${'#'.repeat(headingLevel(node))} ${text}\n\n`;
      }
      case 'blockquote': {
        const inner = renderBlocks(node.content, 0).trim();
        if (!inner) return `${pad}>\n\n`;
        return `${inner.split('\n').map((line) => `${pad}> ${line}`.trimEnd()).join('\n')}\n\n`;
      }
      case 'horizontalRule':
        return `${pad}---\n\n`;
      case 'image':
        return `${pad}![${imageAlt(node)}](imagen)\n\n`;
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        return renderList(node, indent || 0);
      default:
        return node.content ? renderBlocks(node.content, indent) : '';
    }
  }

  function renderBlocks(nodes, indent) {
    if (!Array.isArray(nodes)) return '';
    return nodes.map((node) => renderBlock(node, indent)).join('');
  }

  function documentToMarkdown(source) {
    const doc = source && typeof source === 'object' ? source : {};
    const parts = [];
    const title = cleanPlain(doc.title);
    const description = cleanPlain(doc.description);
    if (title) parts.push(`# ${escapeInline(title)}`);
    if (description) parts.push(escapeInline(description));
    const content = doc.content && doc.content.type === 'doc' ? doc.content.content : [];
    const body = renderBlocks(content, 0).trim();
    if (body) parts.push(body);
    if (!parts.length) return '';
    return `${parts.join('\n\n')}\n`;
  }

  return { documentToMarkdown };
});
