'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const electronPath = require.resolve('electron');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'inplaize-docs-'));

require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { getPath: () => userData },
    BrowserWindow: { getAllWindows: () => [] },
  },
};

const { saveTodos, loadTodos } = require('../main/todos-store');

function tinyImage() {
  return `data:image/png;base64,${'A'.repeat(48)}`;
}

const saved = saveTodos({
  title: 'Tareas',
  columns: [
    {
      id: 'col-a',
      blocks: [
        { id: 'todo-1', type: 'todo', text: 'Leche', done: true, indent: 0 },
        { id: 'text-1', type: 'text', text: 'Nota', indent: 1 },
        {
          id: 'doc-1',
          type: 'document',
          text: 'titulo viejo',
          done: true,
          doc: {
            title: 'Bitácora',
            description: 'Línea\nsegunda',
            parentId: 'otro-lado',
            createdAt: '2026-01-02T03:04:05.000Z',
            updatedAt: '2026-02-03T04:05:06.000Z',
            content: {
              type: 'doc',
              content: [
                { type: 'heading', attrs: { level: 9 }, content: [{ type: 'text', text: 'Hola' }] },
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'ver ', marks: [{ type: 'bold' }] },
                    {
                      type: 'text',
                      text: 'sitio',
                      marks: [{ type: 'link', attrs: { href: 'https://example.com/a' } }],
                    },
                    {
                      type: 'text',
                      text: 'malo',
                      marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
                    },
                  ],
                },
                {
                  type: 'taskList',
                  content: [
                    {
                      type: 'taskItem',
                      attrs: { checked: true },
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hecho' }] }],
                    },
                  ],
                },
                { type: 'image', attrs: { src: tinyImage(), alt: 'foto' } },
                { type: 'image', attrs: { src: 'https://example.com/x.png' } },
                { type: 'script', content: [{ type: 'text', text: 'no' }] },
                { type: 'horizontalRule' },
              ],
            },
          },
        },
      ],
    },
  ],
});

const doc = saved.columns[0].blocks[2];
assert.strictEqual(doc.type, 'document');
assert.strictEqual(doc.text, 'Bitácora');
assert.strictEqual(doc.done, false);
assert.strictEqual(doc.doc.title, 'Bitácora');
assert.strictEqual(doc.doc.description, 'Línea segunda');
assert.strictEqual(doc.doc.parentId, 'col-a');
assert.strictEqual(doc.doc.createdAt, '2026-01-02T03:04:05.000Z');
assert.strictEqual(doc.doc.id, 'doc-1');
assert.strictEqual(doc.doc.content.content[0].attrs.level, 1);
assert.strictEqual(doc.doc.content.content[1].content[1].marks[0].attrs.href, 'https://example.com/a');
assert.strictEqual(doc.doc.content.content[1].content[2].marks, undefined);
assert.strictEqual(doc.doc.content.content[2].content[0].attrs.checked, true);
assert.strictEqual(doc.doc.content.content[3].type, 'image');
assert.strictEqual(doc.doc.content.content[4].type, 'horizontalRule');
assert.strictEqual(saved.columns[0].blocks[0].type, 'todo');
assert.strictEqual(saved.columns[0].blocks[0].doc, undefined);
assert.strictEqual(saved.columns[0].blocks[1].indent, 1);

const huge = `data:image/png;base64,${'B'.repeat(1300000)}`;
const stripped = saveTodos({
  columns: [{
    id: 'col-b',
    blocks: [{
      id: 'doc-big',
      type: 'document',
      doc: {
        title: 'Grande',
        content: {
          type: 'doc',
          content: [{ type: 'image', attrs: { src: huge } }, { type: 'paragraph' }],
        },
      },
    }],
  }],
});
const bigNodes = stripped.columns[0].blocks[0].doc.content.content;
assert.ok(!bigNodes.some((node) => node.type === 'image'));

const legacy = saveTodos({
  items: [{ id: 'legacy-1', text: 'Comprar pan', done: false }],
});
assert.strictEqual(legacy.columns[0].blocks[0].type, 'todo');
assert.strictEqual(legacy.columns[0].blocks[0].text, 'Comprar pan');
assert.strictEqual(legacy.columns[0].blocks[0].doc, undefined);

const loaded = loadTodos();
assert.strictEqual(loaded.columns[0].blocks[0].text, 'Comprar pan');

fs.rmSync(userData, { recursive: true, force: true });
console.log('document-content ok');
