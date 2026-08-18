// Boot src/app.js under a minimal DOM shim: proves the module imports,
// wires listeners, renders, and populates pickers from live capabilities().
const elements = new Map();
const makeElement = (id) => ({
  id,
  children: [],
  textContent: '',
  innerHTML: '',
  value: '',
  placeholder: '',
  href: '',
  disabled: false,
  dataset: {},
  classList: {
    classes: new Set(['hide']),
    toggle(name, force) {
      if (force === undefined) return;
      force ? this.classes.add(name) : this.classes.delete(name);
    },
    add(name) { this.classes.add(name); },
    remove(name) { this.classes.delete(name); },
  },
  listeners: {},
  addEventListener(type, fn) { this.listeners[type] = fn; },
  append(...nodes) { this.children.push(...nodes); },
  replaceChildren(...nodes) { this.children = nodes; },
});
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  },
  createElement: (tag) => makeElement(`<${tag}>`),
};
globalThis.window = { location: { href: 'https://onchain.local/' } };
globalThis.location = globalThis.window.location;
globalThis.prompt = () => null;
globalThis.Option = class {
  constructor(label, value) {
    this.textContent = label;
    this.value = value;
  }
};

await import('../src/app.js');
// let capabilities-driven first render + async fillStats land
await new Promise((resolve) => setTimeout(resolve, 4000));

const platform = elements.get('platform');
const currency = elements.get('currency');
console.log('platform options:', platform.children.map((c) => c.textContent).join(', '));
console.log('currency options:', currency.children.map((c) => c.textContent).join(', '));
console.log('payee placeholder:', elements.get('payee').placeholder);
console.log('cta:', elements.get('cta').textContent);
console.log('pageAddress:', elements.get('pageAddress').textContent);
console.log('connect label:', elements.get('connect').textContent);
if (platform.children.length === 0) {
  console.error('BOOT TEST FAILED: no platforms rendered');
  process.exit(1);
}

// Drive the estimate path: platform → revolut, currency → EUR, amount → 100.
platform.listeners.change({ target: { value: 'revolut' } });
currency.listeners.change({ target: { value: 'EUR' } });
const amount = elements.get('amount');
amount.listeners.input({ target: { value: '100' } });
await new Promise((resolve) => setTimeout(resolve, 2500));
console.log('receive:', elements.get('receive').textContent);
console.log('rate:', elements.get('rate').textContent);
console.log('eta:', elements.get('eta').textContent);
console.log('details visible:', !elements.get('details').classList.classes.has('hide'));
elements.get('payee').listeners.input({ target: { value: 'revtag123' } });
console.log('cta with payee (not connected):', elements.get('cta').textContent);

// Every id the app touched must exist in the shell; the shim auto-creates
// elements, which would otherwise mask references to removed markup.
const { readFileSync } = await import('node:fs');
const shell = readFileSync(new URL('../src/shell.html', import.meta.url), 'utf8');
const shellIds = new Set([...shell.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const missing = [...elements.keys()].filter((id) => !shellIds.has(id));
if (missing.length) {
  console.error('BOOT TEST FAILED: app references ids missing from shell:', missing.join(', '));
  process.exit(1);
}
console.log('BOOT OK');
process.exit(0);
