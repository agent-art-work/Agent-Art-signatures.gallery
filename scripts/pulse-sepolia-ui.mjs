import { fork } from 'node:child_process';
import { watch } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Fork's JSON IPC does not preserve Buffers. Only allowlisted font assets use
// this explicit wire format; stylesheet and script responses remain strings.
function unpackAsset(result) {
  if (result === undefined) return result;
  if (!Array.isArray(result) || result.length !== 2) throw Error('UI_RENDER_UNAVAILABLE');
  if (typeof result[0] === 'string') return result;
  const [wire, type] = result;
  if (wire?.kind !== 'font' || wire.encoding !== 'base64' || typeof wire.data !== 'string'
      || wire.data.length > 1024 * 1024 || !['font/woff2', 'text/plain; charset=utf-8'].includes(type)) throw Error('UI_RENDER_UNAVAILABLE');
  const bytes = Buffer.from(wire.data, 'base64');
  if (bytes.toString('base64') !== wire.data) throw Error('UI_RENDER_UNAVAILABLE');
  return [bytes, type];
}
/** Gracefully replace ONLY the UI renderer on template/style/client edits.
 * A broken UI build retains the old renderer. Requests are bounded and the
 * backend's verified checkpoint, read loops and wallet sessions are untouched. */
export function createSepoliaUiRenderer({ watchFiles = true, onReload = () => {} } = {}) {
  let current, opening, sequence = 0, revision = 0, closed = false, debounce;
  const children = new Set(), watchers = [];
  function retire(instance) { instance.retired = true; if (!instance.pending.size) { instance.child.kill(); children.delete(instance); } }
  function spawn() {
    const child = fork(resolve(root, 'scripts/pulse-sepolia-ui-worker.mjs'), [], {
      cwd: root, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { PATH: process.env.PATH, NODE_ENV: 'development' },
    });
    const instance = { child, pending: new Map(), retired: false }; children.add(instance);
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { retire(instance); reject(Error('UI_RENDER_UNAVAILABLE')); }, 10000);
      child.on('message', message => {
        if (message.ready) { clearTimeout(timer); accept(instance); return; }
        const task = instance.pending.get(message.id); if (!task) return;
        clearTimeout(task.timer); instance.pending.delete(message.id);
        if (message.error) task.reject(Error('UI_RENDER_UNAVAILABLE'));
        else {
          try { task.accept(task.name === 'asset' ? unpackAsset(message.result) : message.result); }
          catch { task.reject(Error('UI_RENDER_UNAVAILABLE')); }
        }
        if (instance.retired && !instance.pending.size) retire(instance);
      });
      const failed = () => {
        clearTimeout(timer); reject(Error('UI_RENDER_UNAVAILABLE')); children.delete(instance);
        for (const task of instance.pending.values()) { clearTimeout(task.timer); task.reject(Error('UI_RENDER_UNAVAILABLE')); }
        instance.pending.clear(); if (current === instance) current = undefined;
      };
      child.once('error', failed); child.once('exit', failed);
    });
  }
  async function reload() {
    if (closed) return;
    if (opening) return opening;
    opening = spawn().then(instance => {
      if (closed) { retire(instance); return; }
      const previous = current; current = instance; revision++; if (previous) retire(previous);
      onReload(revision);
    }).catch(() => {}).finally(() => { opening = undefined; });
    return opening;
  }
  async function call(name, ...args) {
    if (closed) throw Error('UI_RENDER_UNAVAILABLE');
    if (!current) await reload();
    const instance = current;
    if (!instance || instance.pending.size >= 32) throw Error('UI_RENDER_UNAVAILABLE');
    return new Promise((accept, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { instance.pending.delete(id); reject(Error('UI_RENDER_UNAVAILABLE')); if (instance.retired) retire(instance); }, 10000);
      instance.pending.set(id, { name, accept, reject, timer });
      instance.child.send({ id, name, args }, error => {
        if (error) { clearTimeout(timer); instance.pending.delete(id); reject(Error('UI_RENDER_UNAVAILABLE')); if (instance.retired) retire(instance); }
      });
    });
  }
  if (watchFiles) {
    const changed = filename => {
      const name = String(filename ?? '').replaceAll('\\', '/');
      if (!/^(?:openMint\/|brand\/|v1\/(?:fonts|siteCss|controlsCss)\.ts|algorithmV2\/|pulse-sepolia-(?:client|readiness-client|ui-worker)\.mjs)/.test(name)) return;
      clearTimeout(debounce); debounce = setTimeout(() => void reload(), 200);
    };
    for (const directory of ['src', 'scripts']) {
      try { watchers.push(watch(resolve(root, directory), { recursive: true }, (_event, file) => changed(file))); } catch {}
    }
  }
  void reload();
  return Object.freeze({ call, reload, revision: () => revision,
    async close() {
      closed = true; clearTimeout(debounce); for (const watcher of watchers) watcher.close();
      await opening; for (const instance of children) retire(instance);
    } });
}
