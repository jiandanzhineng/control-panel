const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const EventEmitter = require('events');

const detectorPath = path.join(__dirname, '..', 'plugins', 'shanbay-shock', 'detector.js');

describe('shanbay detector keyboard shortcuts', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('maps number keys to visible Shanbay answer options', async () => {
    const harness = runDetector({
      word: 'keyboard-one',
      options: ['认识', '不认识'],
    });
    await harness.flush();

    harness.document.dispatchKey('2');

    expect(harness.invokeCommands()).toEqual([
      expect.objectContaining({
        deviceId: 'shock',
        capability: 'shock',
        actionName: 'start',
        params: { voltage: 15 },
      }),
    ]);
  });

  it('monitors recognized shortcuts without triggering shock', async () => {
    const harness = runDetector({
      word: 'keyboard-right',
      options: ['认识', '不认识'],
    });
    await harness.flush();

    harness.document.dispatchKey('1');

    expect(harness.invokeCommands()).toHaveLength(0);
    expect(harness.statusText()).toContain('✓1 ✗0 · 答对');
  });

  it('monitors forgotten confirmation shortcuts using the same option order', async () => {
    const harness = runDetector({
      word: 'keyboard-two',
      options: ['想起来了', '没想起来'],
      params: { punishForgotten: true },
    });
    await harness.flush();

    harness.document.dispatchKey('2');

    expect(harness.invokeCommands()).toHaveLength(1);
    expect(harness.statusText()).toContain('电击中 1s');
  });

  function runDetector({ word, options, params = {} }) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shanbay-detector-'));
    const activePath = path.join(tempDir, 'active-plugin.json');
    fs.writeFileSync(activePath, JSON.stringify({
      pluginId: 'shanbay-shock',
      deviceMap: { shock: ['shock-vdev'] },
      params: { shockVoltage: 15, shockDuration: 1, punishForgotten: false, ...params },
      matchUrls: ['*://web.shanbay.com/*'],
      bridgeUrl: 'ws://127.0.0.1:5277/bridge',
    }), 'utf-8');

    const document = new FakeDocument();
    const title = document.createElement('h1');
    title.innerText = word;
    title.textContent = word;
    document.body.appendChild(title);

    for (const label of options) {
      const option = document.createElement('div');
      option.className = 'index_option__test';
      option.innerText = label;
      option.textContent = label;
      document.body.appendChild(option);
    }

    const sentMessages = [];
    class FakeWebSocket extends EventEmitter {
      constructor() {
        super();
        this.readyState = FakeWebSocket.OPEN;
        process.nextTick(() => this.emit('open'));
      }

      send(raw) {
        const message = JSON.parse(String(raw));
        sentMessages.push(message);
        if (message.id) {
          process.nextTick(() => {
            this.emit('message', Buffer.from(JSON.stringify({
              id: message.id,
              result: { ok: true, ready: true },
            })));
          });
        }
      }
    }
    FakeWebSocket.OPEN = 1;

    const timers = new Map();
    let timerId = 1;
    const context = {
      console,
      Buffer,
      Date,
      location: { href: 'https://web.shanbay.com/wordsweb/review' },
      document,
      window: {},
      process: {
        env: { ACTIVE_PLUGIN_PATH: activePath },
        cwd: () => path.join(__dirname, '..', '..'),
      },
      require: (name) => {
        if (name === 'fs') return fs;
        if (name === 'path') return path;
        if (name === 'ws') return FakeWebSocket;
        throw new Error(`Unexpected require: ${name}`);
      },
      setTimeout: (fn, ms) => {
        const id = timerId;
        timerId += 1;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
    };
    context.window = context;

    vm.runInNewContext(fs.readFileSync(detectorPath, 'utf-8'), context, { filename: detectorPath });

    return {
      document,
      flush: () => new Promise((resolve) => setImmediate(resolve)),
      invokeCommands: () => sentMessages.filter((message) => message.action === 'invoke'),
      statusText: () => {
        const el = document.getElementById('undersilicon-shanbay-status');
        return el ? collectText(el) : '';
      },
    };
  }
});

class FakeDocument {
  constructor() {
    this.readyState = 'complete';
    this.listeners = new Map();
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatchKey(key) {
    this.dispatchEvent({
      type: 'keydown',
      key,
      code: `Digit${key}`,
      target: this.body,
      repeat: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    });
  }

  dispatchEvent(event) {
    const handlers = this.listeners.get(event.type) || [];
    for (const handler of handlers) handler(event);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const selectors = selector.split(',').map((part) => part.trim()).filter(Boolean);
    const all = [];
    walk(this.head, (node) => all.push(node));
    walk(this.body, (node) => all.push(node));
    return all.filter((node) => selectors.some((part) => node.matches(part)));
  }

  getElementById(id) {
    return this.querySelectorAll('*').find((node) => node.id === id) || null;
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.className = '';
    this.id = '';
    this.innerText = '';
    this.textContent = '';
    this.style = { cssText: '' };
    this.classList = {
      add: (...names) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        names.forEach((name) => set.add(name));
        this.className = Array.from(set).join(' ');
      },
      remove: (...names) => {
        const remove = new Set(names);
        this.className = this.className.split(/\s+/).filter((name) => name && !remove.has(name)).join(' ');
      },
      contains: (name) => this.className.split(/\s+/).includes(name),
    };
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    this.refreshText();
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] || '';
  }

  matches(selector) {
    if (selector === '*') return true;
    if (selector === 'button') return this.tagName === 'BUTTON';
    if (selector === '[role="button"]') return this.getAttribute('role') === 'button';
    if (selector === 'h1') return this.tagName === 'H1';
    const classContains = selector.match(/^\[class\*="([^"]+)"\]$/);
    if (classContains) return this.className.includes(classContains[1]);
    return false;
  }

  closest(selector) {
    const selectors = selector.split(',').map((part) => part.trim()).filter(Boolean);
    let node = this;
    while (node) {
      if (selectors.some((part) => node.matches(part))) return node;
      node = node.parentNode;
    }
    return null;
  }

  refreshText() {
    if (this.children.length && !this.textContent) {
      this.textContent = this.children.map((child) => child.textContent || child.innerText || '').join('');
      this.innerText = this.textContent;
    }
  }
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function collectText(node) {
  return [
    node.innerText || node.textContent || '',
    ...node.children.map((child) => collectText(child)),
  ].join('');
}
