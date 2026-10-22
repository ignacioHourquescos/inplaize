import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Suggestion from '@tiptap/suggestion';
import { Plugin, TextSelection } from '@tiptap/pm/state';

const PLACEHOLDER = 'Escribí, presioná / para insertar bloques...';

function sanitizeBrowserSrc(value) {
  if (typeof value !== 'string') return '';
  const src = value.replace(/\s+/g, '');
  if (src.length < 32 || src.length > 1200000) return '';
  if (!/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(src)) return '';
  return src;
}

function normalizeHref(raw) {
  const text = String(raw || '').trim();
  if (!text || text.length > 2000) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return '';
    if (url.protocol !== 'mailto:' && !url.hostname) return '';
    return url.href;
  } catch {
    return '';
  }
}

function linkLabel(href) {
  try {
    const url = new URL(href);
    if (url.protocol === 'mailto:') return url.pathname || href;
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    return `${url.host}${path}` || href;
  } catch {
    return href;
  }
}

function norm(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function isEmptySlash(state, range) {
  const $from = state.doc.resolve(range.from);
  if (!$from.parent.isTextblock) return false;
  const before = state.doc.textBetween($from.start(), range.from, 'x', 'x');
  const after = state.doc.textBetween(range.to, $from.end(), 'x', 'x');
  return before.length === 0 && after.length === 0;
}

function imageFiles(data) {
  if (!data || !data.files || !data.files.length) return [];
  const files = [];
  for (const file of data.files) {
    if (file && /^image\/(?:png|jpe?g|gif|webp)$/i.test(file.type)) files.push(file);
  }
  return files;
}

const SafeImage = Image.extend({
  addInputRules() {
    return [];
  },
  parseHTML() {
    return [{
      tag: 'img[src]',
      getAttrs: (element) => {
        const src = sanitizeBrowserSrc(element.getAttribute('src'));
        if (!src) return false;
        return { src, alt: element.getAttribute('alt') || '' };
      },
    }];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, state) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const cuts = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name === 'image' && !sanitizeBrowserSrc(node.attrs.src)) {
              cuts.push({ from: pos, to: pos + node.nodeSize });
            }
          });
          if (!cuts.length) return null;
          let tr = state.tr;
          for (let i = cuts.length - 1; i >= 0; i -= 1) tr = tr.delete(cuts[i].from, cuts[i].to);
          return tr;
        },
      }),
    ];
  },
}).configure({
  inline: false,
  allowBase64: true,
  resize: false,
});

function modLabel() {
  return /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl';
}

export function mount(host, options) {
  const portal = (options && options.portal) || document.body;
  const onChange = (options && options.onChange) || function () {};
  const onNotice = (options && options.onNotice) || function () {};
  const readImage = (options && options.readImage) || function () { return Promise.resolve(null); };

  let alive = true;
  let ready = false;
  let editor = null;
  let slashOn = false;
  let selected = 0;
  let currentItems = [];
  let latest = null;
  let unmountSlash = null;
  let savedRange = null;

  const menu = document.createElement('div');
  menu.className = 'notion-menu doc-slash-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', 'Insertar bloque');
  menu.setAttribute('data-mouse-hit', '');

  const bubble = document.createElement('div');
  bubble.className = 'doc-format-bar';
  bubble.setAttribute('role', 'toolbar');
  bubble.setAttribute('aria-label', 'Formato');
  bubble.setAttribute('data-mouse-hit', '');
  bubble.hidden = true;
  bubble.addEventListener('mousedown', (event) => event.preventDefault());

  const popover = document.createElement('div');
  popover.className = 'doc-link-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Enlace');
  popover.setAttribute('data-mouse-hit', '');
  popover.hidden = true;

  const linkInput = document.createElement('input');
  linkInput.type = 'url';
  linkInput.className = 'doc-link-input';
  linkInput.placeholder = 'https://…';
  linkInput.setAttribute('aria-label', 'Dirección del enlace');
  linkInput.spellcheck = false;

  const linkError = document.createElement('p');
  linkError.className = 'doc-link-error';
  linkError.hidden = true;

  const linkApply = document.createElement('button');
  linkApply.type = 'button';
  linkApply.className = 'doc-link-apply';
  linkApply.textContent = 'Agregar';

  const linkRemove = document.createElement('button');
  linkRemove.type = 'button';
  linkRemove.className = 'doc-link-remove';
  linkRemove.textContent = 'Quitar';

  const linkRow = document.createElement('div');
  linkRow.className = 'doc-link-row';
  linkRow.append(linkInput, linkApply, linkRemove);
  popover.append(linkRow, linkError);
  portal.append(bubble, popover);

  function hideBubble() {
    bubble.hidden = true;
  }

  function place(el, rect) {
    const margin = 8;
    const width = el.offsetWidth || 220;
    const height = el.offsetHeight || 44;
    let left = rect.left;
    let top = rect.top - height - 8;
    if (top < margin) top = rect.bottom + 8;
    const maxLeft = window.innerWidth - width - margin;
    if (left > maxLeft) left = Math.max(margin, maxLeft);
    if (left < margin) left = margin;
    if (top + height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - height - margin);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function selectionRect() {
    if (!editor) return null;
    try {
      const coords = editor.view.coordsAtPos(editor.state.selection.from);
      return { left: coords.left, top: coords.top, bottom: coords.bottom };
    } catch {
      return null;
    }
  }

  function showAt(el, rect) {
    el.hidden = false;
    el.style.visibility = 'hidden';
    place(el, rect);
    el.style.visibility = '';
  }

  function syncPressed() {
    if (!editor) return;
    bubble.querySelectorAll('[data-mark]').forEach((button) => {
      const on = editor.isActive(button.dataset.mark);
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function updateBubble() {
    if (!alive || !editor || slashOn || !popover.hidden) {
      hideBubble();
      return;
    }
    const selection = editor.state.selection;
    if (!(selection instanceof TextSelection) || selection.empty) {
      hideBubble();
      return;
    }
    const rect = selectionRect();
    if (!rect) {
      hideBubble();
      return;
    }
    showAt(bubble, rect);
    syncPressed();
  }

  function closeLink(refocus) {
    popover.hidden = true;
    linkError.hidden = true;
    if (refocus && alive && editor) editor.commands.focus();
    updateBubble();
  }

  function openLink() {
    if (!alive || !editor) return;
    const selection = editor.state.selection;
    savedRange = selection instanceof TextSelection
      ? { from: selection.from, to: selection.to }
      : { from: selection.from, to: selection.from };
    const current = editor.getAttributes('link').href || '';
    linkInput.value = current;
    linkError.hidden = true;
    linkRemove.hidden = !current;
    hideBubble();
    const rect = selectionRect() || { left: 24, top: 80, bottom: 100 };
    showAt(popover, rect);
    linkInput.focus();
    linkInput.select();
  }

  function applyLink() {
    if (!editor) return;
    const href = normalizeHref(linkInput.value);
    if (!href) {
      linkError.hidden = false;
      linkError.textContent = 'Ingresá una dirección http, https o mailto.';
      linkInput.focus();
      return;
    }
    const range = savedRange || { from: editor.state.selection.from, to: editor.state.selection.to };
    if (range.from === range.to) {
      editor.chain().focus().setTextSelection(range.from).insertContent({
        type: 'text',
        text: linkLabel(href),
        marks: [{ type: 'link', attrs: { href } }],
      }).run();
    } else {
      editor.chain().focus().setTextSelection(range).setLink({ href }).run();
    }
    closeLink(false);
  }

  function removeLink() {
    if (!editor || !savedRange) {
      closeLink(true);
      return;
    }
    editor.chain().focus().setTextSelection(savedRange).extendMarkRange('link').unsetLink().run();
    closeLink(false);
  }

  async function addImages(files, pos) {
    const list = files && files.length ? Array.from(files) : [null];
    let at = typeof pos === 'number' ? pos : (editor ? editor.state.selection.from : 1);
    for (const file of list) {
      if (!alive || !editor) return;
      let result = null;
      try {
        result = await readImage(file || undefined);
      } catch {
        result = { error: 'No se pudo leer la imagen.' };
      }
      if (!alive || !editor) return;
      if (!result) continue;
      if (result.error || !result.src) {
        onNotice(result.error || 'No se pudo leer la imagen.');
        continue;
      }
      const node = { type: 'image', attrs: { src: result.src, alt: '' } };
      const inserted = editor.chain().focus().insertContentAt(at, node).run();
      if (!inserted) editor.chain().focus().setImage({ src: result.src, alt: '' }).run();
      at = editor.state.selection.from;
    }
  }

  const mod = modLabel();
  const commands = [
    { id: 'text', label: 'Texto', icon: 'T', keywords: ['texto', 'parrafo'], run: ({ editor: ed, range }) => ed.chain().focus().deleteRange(range).setParagraph().run() },
    { id: 'h1', label: 'Encabezado 1', icon: 'H1', keywords: ['encabezado', 'titulo', 'h1'], run: ({ editor: ed, range }) => ed.chain().focus().deleteRange(range).setHeading({ level: 1 }).run() },
    { id: 'h2', label: 'Encabezado 2', icon: 'H2', keywords: ['encabezado', 'h2'], run: ({ editor: ed, range }) => ed.chain().focus().deleteRange(range).setHeading({ level: 2 }).run() },
    { id: 'h3', label: 'Encabezado 3', icon: 'H3', keywords: ['encabezado', 'h3'], run: ({ editor: ed, range }) => ed.chain().focus().deleteRange(range).setHeading({ level: 3 }).run() },
    { id: 'bullet', label: 'Lista con viñetas', icon: '•', keywords: ['lista', 'vineta', 'viñeta'], run: ({ editor: ed, range }) => ed.chain().focus().deleteRange(range).toggleBulletList().run() },
    { id: 'ordered', label: 'Lista numerada', icon: '1.', keywords: ['lista', 'numerada', 'numero'], run: ({ editor: ed, range }) => ed.chain().focus().deleteRange(range).toggleOrderedList().run() },
    { id: 'check', label: 'Checkbox', icon: '☐', keywords: ['checkbox', 'tarea', 'todo'], run: ({ editor: ed, range }) => ed.chain().focus().deleteRange(range).toggleTaskList().run() },
    { id: 'quote', label: 'Cita', icon: '“', keywords: ['cita', 'quote'], run: ({ editor: ed, range }) => ed.chain().focus().deleteRange(range).toggleBlockquote().run() },
    { id: 'rule', label: 'Separador', icon: '—', keywords: ['separador', 'linea'], run: ({ editor: ed, range }) => ed.chain().focus().deleteRange(range).setHorizontalRule().run() },
    { id: 'link', label: 'Enlace', icon: '↗', keywords: ['enlace', 'link', 'url'], run: ({ editor: ed, range }) => { ed.chain().focus().deleteRange(range).run(); openLink(); } },
    { id: 'image', label: 'Imagen', icon: '▣', keywords: ['imagen', 'foto'], run: ({ editor: ed, range }) => { ed.chain().focus().deleteRange(range).run(); addImages(null, ed.state.selection.from); } },
  ];

  function filterCommands(query) {
    const q = norm(query).trim();
    if (!q) return commands.slice();
    return commands.filter((item) => norm(item.label).includes(q) || item.keywords.some((word) => norm(word).includes(q)));
  }

  function highlight() {
    const buttons = [...menu.querySelectorAll('.notion-menu-item')];
    buttons.forEach((button, index) => {
      const on = index === selected;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) button.scrollIntoView({ block: 'nearest' });
    });
  }

  function renderMenu(props) {
    latest = props;
    const incoming = props.items || [];
    if (props.loading && !incoming.length && currentItems.length) return;
    currentItems = incoming;
    if (selected >= currentItems.length) selected = 0;
    menu.replaceChildren();
    if (!currentItems.length) {
      const empty = document.createElement('div');
      empty.className = 'doc-slash-empty';
      empty.textContent = props.loading ? 'Buscando…' : 'Sin resultados';
      menu.appendChild(empty);
      return;
    }
    currentItems.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `notion-menu-item${index === selected ? ' is-active' : ''}`;
      button.setAttribute('role', 'option');
      button.id = `doc-slash-${item.id}`;
      button.setAttribute('aria-selected', index === selected ? 'true' : 'false');
      const icon = document.createElement('span');
      icon.className = 'notion-menu-ico';
      icon.textContent = item.icon;
      const label = document.createElement('span');
      label.textContent = item.label;
      button.append(icon, label);
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('mouseenter', () => {
        selected = index;
        highlight();
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        if (latest) latest.command(item);
      });
      menu.appendChild(button);
    });
  }

  function closeSlash() {
    slashOn = false;
    if (!unmountSlash) return;
    const unmount = unmountSlash;
    unmountSlash = null;
    unmount();
  }

  const SlashCommand = Extension.create({
    name: 'slashCommand',
    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          char: '/',
          startOfLine: false,
          allowSpaces: false,
          container: portal,
          placement: 'bottom-start',
          floatingUi: { strategy: 'fixed' },
          decorationClass: 'doc-slash-query',
          decorationEmptyClass: 'doc-slash-query-empty',
          initialItems: commands,
          items: ({ query }) => filterCommands(query),
          command: ({ editor: ed, range, props }) => props.run({ editor: ed, range }),
          allow: ({ state, range }) => isEmptySlash(state, range),
          render: () => ({
            onStart: (props) => {
              if (unmountSlash) {
                const previous = unmountSlash;
                unmountSlash = null;
                previous();
              }
              slashOn = true;
              selected = 0;
              hideBubble();
              renderMenu(props);
              unmountSlash = props.mount(menu);
            },
            onUpdate: (props) => {
              if (props.query !== (latest && latest.query)) selected = 0;
              renderMenu(props);
            },
            onExit: () => {
              closeSlash();
              updateBubble();
            },
            onKeyDown: ({ event }) => {
              if (event.key === 'Escape' || event.key === 'Esc') {
                event.preventDefault();
                event.stopPropagation();
                return false;
              }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                event.stopPropagation();
                if (!currentItems.length) return true;
                selected = event.key === 'ArrowDown'
                  ? (selected + 1) % currentItems.length
                  : (selected - 1 + currentItems.length) % currentItems.length;
                highlight();
                return true;
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                if (currentItems[selected] && latest) latest.command(currentItems[selected]);
                return true;
              }
              return false;
            },
          }),
        }),
      ];
    },
  });

  const LinkShortcut = Extension.create({
    name: 'linkShortcut',
    addKeyboardShortcuts() {
      return {
        'Mod-k': () => {
          openLink();
          return true;
        },
      };
    },
  });

  function markButton(mark, label, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `doc-format-btn doc-format-${mark}`;
    button.dataset.mark = mark;
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      if (!editor) return;
      const chain = editor.chain().focus();
      if (mark === 'bold') chain.toggleBold();
      else if (mark === 'italic') chain.toggleItalic();
      else chain.toggleUnderline();
      chain.run();
      syncPressed();
    });
    return button;
  }

  const linkButton = document.createElement('button');
  linkButton.type = 'button';
  linkButton.className = 'doc-format-btn doc-format-link';
  linkButton.dataset.mark = 'link';
  linkButton.dataset.docLink = '1';
  linkButton.textContent = '↗';
  linkButton.title = `Enlace (${mod}+K)`;
  linkButton.setAttribute('aria-label', `Enlace (${mod}+K)`);
  linkButton.setAttribute('aria-pressed', 'false');
  linkButton.setAttribute('data-doc-link', '');
  linkButton.addEventListener('mousedown', (event) => event.preventDefault());
  linkButton.addEventListener('click', (event) => {
    event.preventDefault();
    openLink();
  });

  bubble.append(
    markButton('bold', 'B', `Negrita (${mod}+B)`),
    markButton('italic', 'I', `Cursiva (${mod}+I)`),
    markButton('underline', 'U', `Subrayado (${mod}+U)`),
    linkButton,
  );

  linkApply.addEventListener('click', (event) => {
    event.preventDefault();
    applyLink();
  });
  linkRemove.addEventListener('click', (event) => {
    event.preventDefault();
    removeLink();
  });
  linkInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      applyLink();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeLink(true);
    }
  });
  linkInput.addEventListener('input', () => {
    linkError.hidden = true;
  });

  function onPointerDown(event) {
    if (popover.hidden) return;
    const target = event.target;
    if (!(target instanceof Node) || popover.contains(target)) return;
    if (target instanceof Element && target.closest('[data-doc-link]')) return;
    closeLink(false);
  }
  document.addEventListener('pointerdown', onPointerDown, true);

  const initial = options && options.content && options.content.type === 'doc' ? options.content : undefined;

  try {
  editor = new Editor({
    element: host,
    content: initial,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        code: false,
        codeBlock: false,
        strike: false,
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          protocols: ['http', 'https', 'mailto'],
          HTMLAttributes: { rel: 'noopener noreferrer nofollow' },
        },
      }),
      SafeImage,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({
        placeholder: PLACEHOLDER,
        emptyEditorClass: 'is-editor-empty',
      }),
      SlashCommand,
      LinkShortcut,
    ],
    editorProps: {
      attributes: {
        spellcheck: 'true',
        'aria-label': 'Contenido del documento',
        'aria-multiline': 'true',
      },
      handleClick(_view, _pos, event) {
        const target = event.target;
        const anchor = target && target.closest ? target.closest('a') : null;
        if (anchor) event.preventDefault();
        return false;
      },
      handlePaste(_view, event) {
        const files = imageFiles(event.clipboardData);
        if (!files.length) return false;
        event.preventDefault();
        event.stopPropagation();
        addImages(files);
        return true;
      },
      handleDrop(view, event, _slice, moved) {
        if (moved) return false;
        const files = imageFiles(event.dataTransfer);
        if (!files.length) return false;
        event.preventDefault();
        event.stopPropagation();
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        addImages(files, coords ? coords.pos : undefined);
        return true;
      },
    },
    onUpdate: () => {
      if (!ready || !alive) return;
      onChange(editor.getJSON());
    },
    onSelectionUpdate: () => updateBubble(),
  });
  } catch (err) {
    alive = false;
    document.removeEventListener('pointerdown', onPointerDown, true);
    bubble.remove();
    popover.remove();
    throw err;
  }
  ready = true;

  return {
    getJSON() {
      return editor ? editor.getJSON() : { type: 'doc', content: [{ type: 'paragraph' }] };
    },
    focus(where) {
      if (!editor) return;
      editor.commands.focus(where === 'start' ? 'start' : 'end');
    },
    destroy() {
      alive = false;
      ready = false;
      document.removeEventListener('pointerdown', onPointerDown, true);
      closeSlash();
      bubble.remove();
      popover.remove();
      if (editor) {
        const current = editor;
        editor = null;
        current.destroy();
      }
    },
  };
}
