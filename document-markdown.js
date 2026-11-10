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

  function escapeHtml(text) {
    return String(text || '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function htmlImageSrc(node) {
    const src = node && node.attrs && typeof node.attrs.src === 'string' ? node.attrs.src.trim() : '';
    if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src)) return src;
    if (/^https?:\/\//i.test(src)) return src;
    return '';
  }

  function htmlInline(nodes) {
    if (!Array.isArray(nodes)) return '';
    return nodes.map((node) => {
      if (!node) return '';
      if (node.type === 'hardBreak') return '<br>';
      if (node.type !== 'text') return '';
      let out = escapeHtml(node.text);
      const marks = Array.isArray(node.marks) ? node.marks : [];
      marks.forEach((mark) => {
        if (!mark) return;
        if (mark.type === 'bold') out = `<strong>${out}</strong>`;
        else if (mark.type === 'italic') out = `<em>${out}</em>`;
        else if (mark.type === 'underline') out = `<u>${out}</u>`;
        else if (mark.type === 'link') {
          const href = linkHref(mark);
          if (/^(?:https?:|mailto:)/i.test(href)) out = `<a href="${escapeHtml(href)}">${out}</a>`;
        }
      });
      return out;
    }).join('');
  }

  function htmlBlock(node) {
    if (!node || typeof node !== 'object') return '';
    switch (node.type) {
      case 'doc':
        return htmlBlocks(node.content);
      case 'paragraph': {
        const text = htmlInline(node.content);
        return text ? `<p>${text}</p>` : '<p class="is-empty"></p>';
      }
      case 'heading': {
        const level = headingLevel(node) + 1;
        return `<h${level}>${htmlInline(node.content)}</h${level}>`;
      }
      case 'blockquote':
        return `<blockquote>${htmlBlocks(node.content)}</blockquote>`;
      case 'horizontalRule':
        return '<hr>';
      case 'image': {
        const src = htmlImageSrc(node);
        if (!src) return '';
        const width = Number(node.attrs && node.attrs.width);
        const style = Number.isFinite(width) && width >= 48 ? ` style="width:${Math.round(width)}px"` : '';
        return `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(imageAlt(node))}"${style}></figure>`;
      }
      case 'bulletList':
        return `<ul>${htmlBlocks(node.content)}</ul>`;
      case 'orderedList': {
        const start = listStart(node);
        return `<ol${start > 1 ? ` start="${start}"` : ''}>${htmlBlocks(node.content)}</ol>`;
      }
      case 'taskList':
        return `<ul class="tasks">${htmlBlocks(node.content)}</ul>`;
      case 'columns':
        return `<div class="cols">${htmlBlocks(node.content)}</div>`;
      case 'column':
        return `<div class="col">${htmlBlocks(node.content)}</div>`;
      case 'listItem':
        return `<li>${htmlBlocks(node.content)}</li>`;
      case 'taskItem': {
        const checked = !!(node.attrs && node.attrs.checked === true);
        return `<li class="task${checked ? ' is-done' : ''}"><span class="box">${checked ? '✓' : ''}</span><div>${htmlBlocks(node.content)}</div></li>`;
      }
      default:
        return node.content ? htmlBlocks(node.content) : '';
    }
  }

  function htmlBlocks(nodes) {
    if (!Array.isArray(nodes)) return '';
    return nodes.map(htmlBlock).join('');
  }

  const PRINT_CSS = `
    @page { size: A4; margin: 18mm 16mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #1f2328; font: 11pt/1.55 "Segoe UI", system-ui, sans-serif; }
    h1.doc-title { margin: 0 0 6px; font-size: 24pt; line-height: 1.2; }
    p.doc-description { margin: 0 0 18px; color: #59636e; font-size: 12pt; }
    h2 { font-size: 17pt; margin: 20px 0 8px; }
    h3 { font-size: 14pt; margin: 16px 0 6px; }
    h4 { font-size: 12pt; margin: 14px 0 6px; }
    p { margin: 0 0 8px; }
    p.is-empty { min-height: 1em; }
    a { color: #5b3fd9; }
    blockquote { margin: 8px 0; padding: 2px 0 2px 12px; border-left: 3px solid #d0d7de; color: #444c56; }
    hr { border: 0; border-top: 1px solid #d0d7de; margin: 16px 0; }
    ul, ol { margin: 0 0 8px; padding-left: 22px; }
    ul.tasks { list-style: none; padding-left: 0; }
    li.task { display: flex; gap: 8px; align-items: flex-start; }
    li.task > div { flex: 1; min-width: 0; }
    li.task.is-done > div { color: #8c959f; text-decoration: line-through; }
    .box { flex: none; width: 13px; height: 13px; margin-top: 4px; border: 1.5px solid #8c959f; border-radius: 3px; font-size: 9px; line-height: 10px; text-align: center; }
    figure { margin: 10px 0; break-inside: avoid; }
    .cols { display: flex; gap: 18px; align-items: flex-start; margin: 0 0 8px; break-inside: avoid; }
    .col { flex: 1 1 0; min-width: 0; }
    img { display: block; max-width: 100%; height: auto; border-radius: 4px; }
  `;

  /** HTML imprimible del documento, con las imágenes incrustadas. Sin scripts. */
  function documentToHtml(source) {
    const doc = source && typeof source === 'object' ? source : {};
    const title = cleanPlain(doc.title);
    const description = cleanPlain(doc.description);
    const content = doc.content && doc.content.type === 'doc' ? doc.content.content : [];
    const body = [
      title ? `<h1 class="doc-title">${escapeHtml(title)}</h1>` : '',
      description ? `<p class="doc-description">${escapeHtml(description)}</p>` : '',
      htmlBlocks(content),
    ].join('');
    return '<!doctype html><html lang="es"><head><meta charset="utf-8">'
      + `<title>${escapeHtml(title || 'Documento')}</title><style>${PRINT_CSS}</style></head>`
      + `<body>${body}</body></html>`;
  }

  return { documentToMarkdown, documentToHtml };
});
