'use strict';

/**
 * Semántica compartida para escribir cookies ajenas en una partition.
 *
 * Hay tres caminos que inyectan una sesión (importar cookies de Google desde
 * Chrome, importar un navegador completo y prestarle la sesión de un acceso a
 * otro) y los tres tienen que escribir exactamente igual: alcanza con que uno
 * cambie el alcance de una cookie para que el sitio reciba dos cookies con el
 * mismo nombre y no sepa cuál vale. Google contesta eso con /CookieMismatch.
 */

/**
 * Tanto CDP como Electron devuelven el dominio canónico: con punto inicial si
 * la cookie se fijó con atributo `Domain` (vale para los subdominios) y sin
 * punto si es host-only. `hostOnly` solo lo trae Electron.
 * @param {Record<string, any>} cookie
 * @returns {boolean}
 */
function isHostOnly(cookie) {
  if (cookie.hostOnly === true) return true;
  if (cookie.hostOnly === false) return false;
  return !String(cookie.domain || '').startsWith('.');
}

/**
 * CDP usa 'Strict' | 'Lax' | 'None'; Electron, 'strict' | 'lax' | 'no_restriction'.
 * @param {unknown} value
 * @returns {Electron.CookiesSetDetails['sameSite']}
 */
function normalizeSameSite(value) {
  switch (String(value || '').toLowerCase()) {
    case 'strict':
      return 'strict';
    case 'lax':
      return 'lax';
    case 'none':
    case 'no_restriction':
      return 'no_restriction';
    default:
      return 'unspecified';
  }
}

/**
 * Vencimiento en segundos epoch, o null si la cookie muere con la sesión.
 * CDP lo llama `expires`; Electron, `expirationDate`.
 * @param {Record<string, any>} cookie
 * @returns {number | null}
 */
function expirationOf(cookie) {
  if (cookie.session === true) return null;
  const raw =
    typeof cookie.expirationDate === 'number'
      ? cookie.expirationDate
      : typeof cookie.expires === 'number'
        ? cookie.expires
        : null;
  if (raw === null || !Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}

/** Host al que pertenece la cookie, sin el punto del atributo Domain. */
function hostOf(cookie) {
  return String((cookie && cookie.domain) || '').replace(/^\./, '');
}

/**
 * Traduce una cookie leída (de CDP o de otra partition) a lo que espera
 * `session.cookies.set`, conservando su alcance original.
 * @param {Record<string, any>} cookie
 * @returns {Electron.CookiesSetDetails | null} null si no es usable
 */
function toSetDetails(cookie) {
  if (!cookie || typeof cookie !== 'object') return null;
  const host = hostOf(cookie);
  if (!host) return null;

  const name = String(cookie.name || '');
  const sameSite = normalizeSameSite(cookie.sameSite);
  // Chromium descarta SameSite=None sin Secure.
  const secure = !!cookie.secure || sameSite === 'no_restriction';
  const cookiePath = typeof cookie.path === 'string' && cookie.path ? cookie.path : '/';

  /** @type {Electron.CookiesSetDetails} */
  const details = {
    url: `${secure ? 'https' : 'http'}://${host}${cookiePath}`,
    name,
    value: String(cookie.value || ''),
    path: cookiePath,
    secure,
    httpOnly: !!cookie.httpOnly,
    sameSite,
  };

  // Mandar `domain` es poner el atributo Domain: convierte una cookie host-only
  // en una válida para todos los subdominios. El día que el sitio vuelva a
  // escribir la host-only quedan las dos y las manda juntas en cada request.
  // Las __Host- directamente no admiten Domain.
  if (!/^__Host-/.test(name) && !isHostOnly(cookie)) {
    details.domain = String(cookie.domain || '');
  }

  const expirationDate = expirationOf(cookie);
  if (expirationDate !== null) details.expirationDate = expirationDate;

  return details;
}

/**
 * Borra las cookies que la partition ya tenía para esos sitios. Escribir una
 * sesión nueva encima de la anterior deja un estado a medio camino: el login
 * viejo sigue ahí en las cookies que la sesión nueva no pisa.
 * @param {Electron.Session} ses
 * @param {(cookie: Electron.Cookie) => boolean} match
 * @returns {Promise<number>} cuántas se borraron
 */
async function removeCookies(ses, match) {
  let cookies = [];
  try {
    cookies = await ses.cookies.get({});
  } catch {
    return 0;
  }
  let removed = 0;
  for (const c of cookies) {
    let keep = true;
    try {
      keep = !match(c);
    } catch {
      keep = true;
    }
    if (keep) continue;
    const host = hostOf(c);
    if (!host) continue;
    const cookiePath = typeof c.path === 'string' && c.path ? c.path : '/';
    try {
      await ses.cookies.remove(`${c.secure ? 'https' : 'http'}://${host}${cookiePath}`, String(c.name || ''));
      removed += 1;
    } catch {
      /* si una no se puede borrar, el resto igual se limpia */
    }
  }
  return removed;
}

module.exports = {
  isHostOnly,
  normalizeSameSite,
  hostOf,
  toSetDetails,
  removeCookies,
};
