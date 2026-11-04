/**
 * Barra "Buscar en la página" (Ctrl+F). Vive en la franja del navegador porque
 * la página (BrowserView) tapa cualquier cosa que se dibuje debajo.
 */
(function () {
  const HTML = `<form class="page-find-bar" hidden autocomplete="off">
    <input class="page-find-input" type="text" placeholder="Buscar en la página"
      spellcheck="false" aria-label="Buscar en la página" />
    <span class="page-find-count" aria-live="polite"></span>
    <button type="button" class="page-find-btn" data-dir="prev" aria-label="Anterior">&#8963;</button>
    <button type="button" class="page-find-btn" data-dir="next" aria-label="Siguiente">&#8964;</button>
    <button type="button" class="page-find-btn" data-dir="close" aria-label="Cerrar búsqueda">&#215;</button>
  </form>`;

  /**
   * @param {HTMLElement} container
   * @param {{
   *   find: (text: string, opts: { forward?: boolean, newSearch?: boolean }) => Promise<unknown>,
   *   stop: () => Promise<unknown>,
   * }} api
   */
  function create(container, api) {
    container.insertAdjacentHTML('beforeend', HTML);
    const form = /** @type {HTMLFormElement} */ (container.lastElementChild);
    const input = /** @type {HTMLInputElement} */ (form.querySelector('.page-find-input'));
    const count = /** @type {HTMLElement} */ (form.querySelector('.page-find-count'));

    const search = (opts) => {
      const text = input.value;
      if (!text) {
        count.textContent = '';
        api.stop().catch(() => {});
        return;
      }
      api.find(text, opts).catch(() => {});
    };
    const close = () => {
      if (form.hidden) return;
      form.hidden = true;
      count.textContent = '';
      api.stop().catch(() => {});
    };
    const open = () => {
      form.hidden = false;
      input.focus();
      input.select();
      if (input.value) search({ newSearch: true });
    };

    input.addEventListener('input', () => search({ newSearch: true }));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        search({ forward: !e.shiftKey });
      }
    });
    form.addEventListener('submit', (e) => e.preventDefault());
    form.querySelectorAll('.page-find-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const dir = /** @type {HTMLElement} */ (b).dataset.dir;
        if (dir === 'close') close();
        else search({ forward: dir !== 'prev' });
      });
    });

    return {
      open,
      close,
      /** @param {{ active: number, total: number } | null} res */
      showResult: (res) => {
        if (form.hidden || !res) return;
        count.textContent = res.total ? `${res.active}/${res.total}` : '0/0';
      },
    };
  }

  window.UsualDeskPageFindBar = { create };
})();
