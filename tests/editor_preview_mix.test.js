const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'templates', 'editor.js'), 'utf8');

function createElementStub(id) {
  return {
    id,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    appendChild() {},
    removeAttribute() {},
    setAttribute() {},
    getAttribute() { return null; },
    load() {},
    pause() {},
    play() { return Promise.resolve(); },
  };
}

const elements = new Map();
const documentStub = {
  body: createElementStub('body'),
  documentElement: createElementStub('html'),
  createElement: () => createElementStub('created'),
  getElementById: (id) => {
    if (!elements.has(id)) elements.set(id, createElementStub(id));
    return elements.get(id);
  },
  querySelectorAll: () => [],
  querySelector: () => createElementStub('query'),
  addEventListener() {},
};

const sandbox = {
  console,
  document: documentStub,
  window: {
    addEventListener() {},
    setTimeout,
    innerWidth: 1280,
    innerHeight: 720,
  },
  fetch: () => Promise.reject(new Error('skip boot load')),
  performance: { now: () => 0 },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
  FileReader: function FileReader() {},
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
  Blob: function Blob() {},
  Promise,
  setTimeout,
  clearTimeout,
};

vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'editor.js' });

assert.strictEqual(typeof sandbox.hiddenPlayerKeyForClip, 'function');

const first = sandbox.hiddenPlayerKeyForClip({
  id: 'clip-a',
  assetId: 'shared-asset',
  trackIndex: 0,
  timelineStart: 0,
});
const second = sandbox.hiddenPlayerKeyForClip({
  id: 'clip-b',
  assetId: 'shared-asset',
  trackIndex: 1,
  timelineStart: 0,
});

assert.notStrictEqual(first, second, 'two timeline clips of the same asset need independent audio players');
assert.strictEqual(first, 'clip-a');
assert.strictEqual(second, 'clip-b');
