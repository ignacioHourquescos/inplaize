'use strict';

/** Sesión por defecto para accesos sin perfil (compatibilidad con datos antiguos). */
const DEFAULT_PARTITION = 'persist:dock-default';
const MAX_SESSION_ID_LEN = 64;

/**
 * Normaliza el id de sesión del usuario: minúsculas, solo a-z 0-9 y guiones.
 * @param {unknown} raw
 * @returns {string}
 */
function sanitizeSessionId(raw) {
  if (raw == null || typeof raw !== 'string') return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, MAX_SESSION_ID_LEN);
}

/**
 * Slug para id de sesión (solo creación / migración). El nombre visible puede cambiar
 * sin alterar el sessionId persistido. Debe coincidir con renderer.js.
 * @param {unknown} raw
 * @returns {string}
 */
function sessionIdFromName(raw) {
  if (raw == null || typeof raw !== 'string') return '';
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return sanitizeSessionId(slug);
}

/**
 * @param {string} [sessionId]
 * @returns {string} partition string para webPreferences
 */
function partitionFromSessionId(sessionId) {
  const id = sanitizeSessionId(sessionId);
  if (!id) return DEFAULT_PARTITION;
  return `persist:${id}`;
}

module.exports = {
  sanitizeSessionId,
  sessionIdFromName,
  partitionFromSessionId,
  DEFAULT_PARTITION,
  MAX_SESSION_ID_LEN,
};
