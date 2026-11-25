/**
 * Carpeta de accesos, como al apilar apps en Android.
 * El icono de la franja muestra hasta cuatro miniaturas; el clic abre el grupo.
 */
(function () {
  let openEl = null;
  let openAnchor = null;
  let onPointerDown = null;
  let onKey = null;

  function memberGlyph(member) {
    const icon = member && typeof member.icon === 'string' ? member.icon.trim() : '';
    const name = (member && member.name) || '';
    if (
      icon.startsWith('data:image/')
      || icon.startsWith('http://')
      || icon.startsWith('https://')
      || icon.includes('/')
      || /\.(png|jpe?g|svg|webp|gif|ico)$/i.test(icon)
    ) {
      const img = document.createElement('img');
      img.className = 'shell-shortcut-icon-img';
      img.src = icon;
      img.alt = '';
      img.draggable = false;
      return img;
    }
    if (icon) {
      const emoji = document.createElement('span');
      emoji.className = 'shell-shortcut-icon-emoji';
      emoji.textContent = icon;
      return emoji;
    }
    const letter = document.createElement('span');
    letter.className = 'shell-shortcut-icon-fallback';
    letter.textContent = name.trim().charAt(0).toUpperCase() || '?';
    return letter;
  }

  function folderGlyph(members) {
    const grid = document.createElement('span');
    grid.className = 'workspace-glyph';
    const shown = (Array.isArray(members) ? members : []).slice(0, 4);
    const cells = shown.length ? shown : [{ name: 'W' }];
    for (const member of cells) {
      const cell = document.createElement('span');
      cell.className = 'workspace-glyph-cell';
      cell.appendChild(memberGlyph(member));
      grid.appendChild(cell);
    }
    return grid;
  }

  function close() {
    const hide = openEl && openEl._onHide;
    if (openEl) openEl.remove();
    openEl = null;
    openAnchor = null;
    if (onPointerDown) document.removeEventListener('pointerdown', onPointerDown, true);
    if (onKey) document.removeEventListener('keydown', onKey, true);
    onPointerDown = null;
    onKey = null;
    if (typeof hide === 'function') hide();
  }

  function place(pop, anchor) {
    const rect = anchor.getBoundingClientRect();
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  function open(anchor, workspace, onOpenMember, hooks) {
    if (!anchor || !workspace) return;
    if (openAnchor === anchor) {
      close();
      return;
    }
    close();
    if (hooks && typeof hooks.onShow === 'function') hooks.onShow();
    const pop = document.createElement('div');
    pop.className = 'workspace-folder';
    pop.setAttribute('role', 'menu');
    const title = document.createElement('div');
    title.className = 'workspace-folder-title';
    title.textContent = workspace.name || 'Workspace';
    const grid = document.createElement('div');
    grid.className = 'workspace-folder-grid';
    const members = Array.isArray(workspace.members) ? workspace.members : [];
    for (const member of members) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'workspace-folder-item';
      btn.setAttribute('aria-label', member.name || 'Acceso');
      const wrap = document.createElement('span');
      wrap.className = 'shell-shortcut-icon-wrap';
      wrap.appendChild(memberGlyph(member));
      const label = document.createElement('span');
      label.className = 'workspace-folder-label';
      label.textContent = member.name || 'Web';
      btn.appendChild(wrap);
      btn.appendChild(label);
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        close();
        if (typeof onOpenMember === 'function') onOpenMember(member);
      });
      grid.appendChild(btn);
    }
    pop.appendChild(title);
    pop.appendChild(grid);
    document.body.appendChild(pop);
    place(pop, anchor);
    openEl = pop;
    openEl._onHide = hooks && hooks.onHide;
    openAnchor = anchor;
    onPointerDown = (ev) => {
      if (!openEl) return;
      const target = ev.target;
      if (target instanceof Node && (openEl.contains(target) || anchor.contains(target))) return;
      close();
    };
    onKey = (ev) => {
      if (ev.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
  }

  window.UsualDeskWorkspace = {
    folderGlyph,
    memberGlyph,
    open,
    close,
  };
})();
