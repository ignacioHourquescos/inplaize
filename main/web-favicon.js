'use strict';

/**
 * Resuelve el favicon de una página (prioriza el .ico) y lo devuelve como data URL
 * para guardarlo en el acceso directo sin depender de la red al pintarlo.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const HTML_MAX = 700000;
const ICON_MAX = 96 * 1024;
const BUDGET_MS = 9000;

/** @type {AbortController | null} */
let activeController = null;

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function attr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = tag.match(re);
  return match ? decodeEntities(match[1] || match[2] || match[3] || '') : '';
}

/**
 * @param {string} raw
 * @returns {URL | null}
 */
function normalizePageUrl(raw) {
  let s = String(raw || '').trim();
  if (!s || s.length > 2048) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) s = `https://${s}`;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname;
  if (!host) return null;
  const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (!host.includes('.') && host !== 'localhost' && !ip) return null;
  return url;
}

function toHttpUrl(href, base) {
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.href;
  } catch {
    return '';
  }
}

function parseBaseHref(html, fallback) {
  const match = String(html || '').match(/<base\b[^>]*>/i);
  if (!match) return fallback;
  const href = attr(match[0], 'href');
  return href ? toHttpUrl(href, fallback) || fallback : fallback;
}

/**
 * @param {string} html
 * @param {string} baseUrl
 * @returns {{ href: string, type: string, sizes: string, rel: string }[]}
 */
function parseLinkIcons(html, baseUrl) {
  const out = [];
  const re = /<link\b[^>]*>/gi;
  let match;
  const source = String(html || '');
  while ((match = re.exec(source))) {
    const tag = match[0];
    const rel = attr(tag, 'rel').toLowerCase();
    const parts = rel.split(/\s+/).filter(Boolean);
    const isIcon = parts.some(
      (part) => part === 'icon' || part.startsWith('apple-touch-icon') || part === 'mask-icon' || part === 'shortcut',
    );
    if (!isIcon || (parts.length === 1 && parts[0] === 'shortcut')) continue;
    const hrefRaw = attr(tag, 'href');
    if (!hrefRaw || hrefRaw.startsWith('data:')) continue;
    const href = toHttpUrl(hrefRaw, baseUrl);
    if (!href) continue;
    out.push({
      href,
      type: attr(tag, 'type').toLowerCase(),
      sizes: attr(tag, 'sizes').toLowerCase(),
      rel,
    });
  }
  return out;
}

function scoreLink(link) {
  const href = String(link.href || '').toLowerCase();
  const type = String(link.type || '').toLowerCase();
  const rel = String(link.rel || '').toLowerCase();
  let score = 0;
  if (href.includes('.ico') || type.includes('icon')) score += 100;
  if (type.includes('png') || href.includes('.png')) score += 30;
  if (rel.includes('apple-touch')) score -= 25;
  if (rel.includes('mask-icon')) score -= 40;
  const size = String(link.sizes || '').match(/(\d+)/);
  if (size) {
    const n = Number(size[1]);
    if (n >= 24 && n <= 128) score += 20;
    else if (n > 256) score -= 30;
  }
  return score;
}

/**
 * .ico primero; después el resto de iconos declarados. Sin duplicados.
 * @param {{ href: string, type?: string, sizes?: string, rel?: string }[]} links
 * @param {string} origin
 * @returns {string[]}
 */
function buildCandidateList(links, origin) {
  let favicon = '';
  try {
    favicon = new URL('/favicon.ico', origin).href;
  } catch {
    favicon = '';
  }
  const scored = (Array.isArray(links) ? links : []).map((link) => ({
    href: link.href,
    score: scoreLink(link),
  }));
  if (favicon) {
    scored.push({
      href: favicon,
      score: scoreLink({ href: favicon, type: 'image/x-icon', sizes: '', rel: 'icon' }),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = [];
  const seen = new Set();
  for (const item of scored) {
    if (!item.href || seen.has(item.href)) continue;
    seen.add(item.href);
    out.push(item.href);
    if (out.length >= 6) break;
  }
  return out;
}

function extFromType(contentType, url) {
  const type = contentType || '';
  const href = url || '';
  if (type.includes('png') || /\.png(\?|$)/i.test(href)) return '.png';
  if (type.includes('jpeg') || type.includes('jpg') || /\.jpe?g(\?|$)/i.test(href)) return '.jpg';
  if (type.includes('gif') || /\.gif(\?|$)/i.test(href)) return '.gif';
  if (type.includes('webp') || /\.webp(\?|$)/i.test(href)) return '.webp';
  if (type.includes('svg') || /\.svg(\?|$)/i.test(href)) return '.svg';
  if (type.includes('icon') || /\.ico(\?|$)/i.test(href)) return '.ico';
  return '';
}

function sniffImageExt(buf, fallback) {
  if (!buf || !buf.length) return '';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length >= 6) {
    const gif = buf.slice(0, 6).toString('ascii');
    if (gif === 'GIF87a' || gif === 'GIF89a') return '.gif';
  }
  if (
    buf.length >= 12 &&
    buf.slice(0, 4).toString('ascii') === 'RIFF' &&
    buf.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return '.webp';
  }
  if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return '.ico';
  const head = buf.slice(0, 250).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return '.svg';
  return fallback || '';
}

function looksLikeImage(buf, ext) {
  if (ext === '.png') return buf[0] === 0x89 && buf[1] === 0x50;
  if (ext === '.jpg') return buf[0] === 0xff && buf[1] === 0xd8;
  if (ext === '.gif') return buf.slice(0, 3).toString('ascii') === 'GIF';
  if (ext === '.webp') return buf.slice(0, 4).toString('ascii') === 'RIFF';
  if (ext === '.ico') return buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0;
  if (ext === '.svg') return buf.slice(0, 400).toString('utf8').toLowerCase().includes('<svg');
  return false;
}

function imageDataUrl(buf, contentType, url) {
  if (!buf || !buf.length || buf.length > ICON_MAX) return '';
  const ext = sniffImageExt(buf, extFromType(contentType, url));
  if (!ext || !looksLikeImage(buf, ext)) return '';
  if (ext === '.svg') {
    const text = buf.toString('utf8').trim();
    if (!text.toLowerCase().includes('<svg') || text.length > 80000) return '';
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  }
  const mime = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
  }[ext];
  if (!mime) return '';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function isHtmlPayload(res) {
  const type = res.contentType || '';
  if (type.includes('html') || type.includes('xml')) return true;
  const head = res.buf.slice(0, 300).toString('utf8').toLowerCase();
  return head.includes('<!doctype html') || head.includes('<html') || head.includes('<link');
}

function remaining(deadline) {
  return deadline - Date.now();
}

/**
 * @param {string} url
 * @param {AbortSignal} parentSignal
 * @param {number} timeoutMs
 * @param {number} maxBytes
 * @param {string} accept
 */
async function fetchBytes(url, parentSignal, timeoutMs, maxBytes, accept) {
  if (parentSignal.aborted || timeoutMs < 400) return null;
  const { net } = require('electron');
  const controller = new AbortController();
  const onParent = () => controller.abort();
  parentSignal.addEventListener('abort', onParent, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: accept,
      },
    });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') || '0');
    if (len > maxBytes) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > maxBytes) return null;
    const contentType = String(res.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    return { buf, contentType, finalUrl: res.url || url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', onParent);
  }
}

/**
 * @param {string} pageUrlRaw
 * @returns {Promise<string | null>} data URL o null
 */
async function resolveWebFavicon(pageUrlRaw) {
  if (activeController) {
    try {
      activeController.abort();
    } catch {
      /* la petición anterior ya terminó */
    }
  }
  const controller = new AbortController();
  activeController = controller;
  const signal = controller.signal;
  try {
    const page = normalizePageUrl(pageUrlRaw);
    if (!page) return null;
    const deadline = Date.now() + BUDGET_MS;
    let links = [];
    const htmlRes = await fetchBytes(
      page.href,
      signal,
      remaining(deadline),
      HTML_MAX,
      'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
    );
    if (signal.aborted) return null;
    if (htmlRes && isHtmlPayload(htmlRes)) {
      const html = htmlRes.buf.toString('utf8', 0, Math.min(htmlRes.buf.length, 500000));
      const base = parseBaseHref(html, htmlRes.finalUrl || page.href);
      links = parseLinkIcons(html, base);
    }
    const candidates = buildCandidateList(links, page.origin);
    for (const href of candidates) {
      if (signal.aborted || remaining(deadline) < 400) return null;
      const img = await fetchBytes(
        href,
        signal,
        remaining(deadline),
        ICON_MAX,
        'image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.8',
      );
      if (!img) continue;
      const dataUrl = imageDataUrl(img.buf, img.contentType, href);
      if (dataUrl) return dataUrl;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (activeController === controller) activeController = null;
  }
}

module.exports = {
  resolveWebFavicon,
  parseLinkIcons,
  parseBaseHref,
  buildCandidateList,
  normalizePageUrl,
  imageDataUrl,
};
