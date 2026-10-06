// XUL-J browser renderer: applies streamed ops directly to the DOM.
// Semantics mirror protocol/model.js (the headless client).
'use strict';

const ROW_H = 22;
const STRUCT = new Set(['op', 'seq', 'in', 'before', 'children', 'tag', 'id']);

class XulJ {
  // options.upload(id, file) -> Promise: sends a picked file to the host (filepicker).
  // options.download(op): starts a download; the default follows op.url on this origin.
  constructor(rootEl, send, options = {}) {
    this.rootEl = rootEl;
    this.send = send;
    this.options = options;
    this.reset();
    document.addEventListener('keydown', (e) => this.onKey(e));
  }

  reset() {
    this.rootEl.replaceChildren();
    this.nodes = new Map([['root', { tag: 'root', el: this.rootEl, attrs: {} }]]);
    this.commands = new Map();
    this.broadcasters = new Map();
    this.sources = new Map(); // source -> { rows: [], trees: Set<node> }
    this.waiting = [];
    this.lastSeq = 0;
  }

  apply(op) {
    if (op.seq) this.lastSeq = op.seq;
    switch (op.op) {
      case 'reset': return this.reset();
      case 'download': return (this.options.download || XulJ.download)(op);
      case 'notify': return this.notify(op);
      case 'node':
        if (this.insert(op)) return;
        // A newer version of a still-waiting node supersedes the queued one.
        this.waiting = this.waiting.filter((w) => !op.id || w.id !== op.id);
        this.waiting.push(op);
        return;
      case 'replace': {
        const old = this.nodes.get(op.id);
        if (!old) return;
        const fresh = this.build(op);
        fresh.external = old.external;
        if (fresh.attrs.order === undefined && old.attrs.order !== undefined) {
          fresh.attrs.order = old.attrs.order;
          fresh.el.dataset.order = old.attrs.order;
        }
        // Children that arrived through their own ops survive the swap.
        const kept = [...(old.body || old.el).children].filter((e) => this.nodes.get(e.dataset.xid)?.external);
        kept.forEach((e) => e.remove());
        old.el.replaceWith(fresh.el);
        this.unregister(old.el);
        kept.forEach((e) => (fresh.body || fresh.el).appendChild(e));
        if (fresh.tag === 'tabbox') this.syncTabs(fresh);
        if (fresh.tag === 'deck') this.refresh(fresh);
        if (fresh.tag === 'window') this.syncModal();
        this.afterInsert(fresh);
        return this.flush();
      }
      case 'set': {
        const n = this.nodes.get(op.id);
        if (!n) return;
        n.attrs = op.replace ? { ...op.attrs } : Object.assign(n.attrs, op.attrs);
        return this.refresh(n);
      }
      case 'remove': {
        this.waiting = this.waiting.filter((w) => w.id !== op.id);
        const n = this.nodes.get(op.id);
        if (!n || n.tag === 'root') return;
        const parent = n.el.parentElement?.closest('[data-xid]');
        n.el.remove();
        this.unregister(n.el);
        if (n.tag === 'tabpanel' && parent) this.syncTabs(this.nodes.get(parent.dataset.xid));
        if (n.tag === 'window') this.syncModal();
        return;
      }
      case 'command': {
        if (op.deleted) this.commands.delete(op.id);
        else {
          const { op: _o, seq: _s, ...state } = op;
          this.commands.set(op.id, { ...this.commands.get(op.id), ...state });
        }
        return this.refreshWhere((n) => n.attrs.command === op.id);
      }
      case 'broadcast':
        this.broadcasters.set(op.id, op.value);
        return this.refreshWhere((n) => Object.values(n.attrs.observes || {}).includes(op.id));
      case 'rows': {
        const src = this.source(op.source);
        if (op.clear) src.rows = [];
        if (op.append) for (const r of op.append) src.rows.push(r);
        src.trees.forEach((t) => this.paintTree(t, true));
        return;
      }
    }
  }

  // ---- structure ---------------------------------------------------------

  insert(op) {
    const parent = this.nodes.get(op.in);
    if (!parent) return false;
    const n = this.build(op);
    n.external = true;
    const container = parent.body || parent.el;
    let anchor = op.before && this.nodes.get(op.before)?.el;
    if (anchor && anchor.parentElement !== container) anchor = null;
    if (!anchor && typeof n.attrs.order === 'number') {
      anchor = [...container.children].find((e) => e.dataset.order !== undefined && Number(e.dataset.order) > n.attrs.order);
    }
    if (anchor) container.insertBefore(n.el, anchor);
    else container.appendChild(n.el);
    this.afterInsert(n);
    if (n.tag === 'tabpanel') this.syncTabs(parent);
    if (parent.tag === 'deck') this.refresh(parent);
    if (n.tag === 'window') this.syncModal(); // needs the window attached to see it
    this.flush();
    return true;
  }

  flush() {
    const queued = this.waiting;
    this.waiting = [];
    for (const op of queued) if (!this.insert(op)) this.waiting.push(op);
  }

  build(spec) {
    const attrs = {};
    for (const [k, v] of Object.entries(spec)) if (!STRUCT.has(k)) attrs[k] = v;
    const n = { tag: spec.tag, id: spec.id, attrs };
    n.el = this.createEl(n);
    n.el.classList.add('x', `x-${n.tag}`);
    n.el.dataset.xid = n.id || `_anon${XulJ.anon++}`;
    if (typeof attrs.order === 'number') n.el.dataset.order = attrs.order;
    n.id = n.el.dataset.xid;
    this.nodes.set(n.id, n);
    for (const c of spec.children || []) {
      const child = this.build(c);
      (n.body || n.el).appendChild(child.el);
    }
    if (n.tag === 'tabbox') this.syncTabs(n);
    this.refresh(n);
    return n;
  }

  afterInsert(n) {
    // Trees can only measure themselves once attached.
    for (const el of [n.el, ...n.el.querySelectorAll('.x-tree')]) {
      const t = this.nodes.get(el.dataset.xid);
      if (t && t.tag === 'tree') this.paintTree(t, false);
    }
  }

  unregister(el) {
    for (const e of [el, ...el.querySelectorAll('[data-xid]')]) {
      const n = this.nodes.get(e.dataset.xid);
      if (n && n.el === e) {
        this.nodes.delete(e.dataset.xid);
        if (n.tag === 'tree') this.source(n.attrs.rows.source).trees.delete(n);
      }
    }
  }

  source(id) {
    if (!this.sources.has(id)) this.sources.set(id, { rows: [], trees: new Set() });
    return this.sources.get(id);
  }

  // ---- element factories -------------------------------------------------

  createEl(n) {
    const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
    switch (n.tag) {
      case 'label': return el('span');
      case 'description': return el('p');
      case 'button':
      case 'toolbarbutton': {
        const b = el('button');
        b.type = 'button';
        b.addEventListener('click', () => this.fire(n.attrs.command));
        return b;
      }
      case 'textbox': {
        const i = el(n.attrs.multiline ? 'textarea' : 'input');
        if (!n.attrs.multiline) i.type = 'text';
        let timer;
        i.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(() => this.send({ op: 'input', id: n.id, value: i.value }), 150);
        });
        return i;
      }
      case 'checkbox': {
        const l = el('label');
        n.input = el('input');
        n.input.type = 'checkbox';
        n.text = el('span');
        l.append(n.input, n.text);
        n.input.addEventListener('change', () => this.send({ op: 'input', id: n.id, value: n.input.checked }));
        return l;
      }
      case 'menulist': {
        const s = el('select');
        s.addEventListener('change', () => {
          n.attrs.selectedIndex = s.selectedIndex;
          this.send({ op: 'input', id: n.id, value: s.value });
        });
        return s;
      }
      case 'groupbox': {
        const f = el('fieldset');
        n.legend = el('legend');
        n.body = el('div', 'x-body');
        f.append(n.legend, n.body);
        return f;
      }
      case 'tabbox': {
        const d = el('div');
        n.strip = el('div', 'x-tabs');
        n.strip.setAttribute('role', 'tablist');
        n.body = el('div', 'x-panels');
        d.append(n.strip, n.body);
        n.selected = 0;
        return d;
      }
      case 'tabpanel': {
        const d = el('div');
        d.setAttribute('role', 'tabpanel');
        return d;
      }
      case 'progressmeter': {
        const p = el('progress');
        p.max = 1;
        return p;
      }
      case 'tree': {
        const d = el('div');
        d.setAttribute('role', 'grid');
        n.head = el('div', 'x-tree-head');
        n.viewport = el('div', 'x-tree-viewport');
        n.sizer = el('div', 'x-tree-sizer');
        n.viewport.append(n.sizer);
        n.viewport.addEventListener('scroll', () => this.paintTree(n, false));
        d.append(n.head, n.viewport);
        this.source(n.attrs.rows.source).trees.add(n);
        new ResizeObserver(() => this.paintTree(n, false)).observe(n.viewport);
        return d;
      }
      case 'pending': {
        const d = el('div');
        d.setAttribute('aria-busy', 'true');
        return d;
      }
      case 'filepicker': {
        const d = el('div');
        n.input = el('input');
        n.input.type = 'file';
        n.status = el('span', 'x-muted');
        d.append(n.input, n.status);
        n.input.addEventListener('change', async () => {
          const files = [...n.input.files];
          if (!files.length || !this.options.upload) return;
          n.input.disabled = true;
          try {
            for (const [i, f] of files.entries()) {
              n.status.textContent = `Uploading ${f.name}${files.length > 1 ? ` (${i + 1}/${files.length})` : ''}…`;
              await this.options.upload(n.id, f);
            }
            n.status.textContent = '';
          } catch (e) {
            n.status.textContent = `Upload failed: ${e.message}`;
          } finally {
            n.input.disabled = Boolean(this.resolved(n).disabled);
          }
        });
        return d;
      }
      default: return el('div'); // window, boxes, toolbar, statusbar, spacer, deck
    }
  }

  // ---- attributes --------------------------------------------------------

  resolved(n) {
    const a = { ...n.attrs };
    for (const [attr, bid] of Object.entries(a.observes || {})) {
      if (this.broadcasters.has(bid)) a[attr] = this.broadcasters.get(bid);
    }
    const cmd = a.command && this.commands.get(a.command);
    if (cmd) {
      if (a.label === undefined) a.label = cmd.label;
      a.disabled = Boolean(a.disabled || cmd.disabled);
      if (cmd.key) a.title = `${a.label} (${cmd.key})`;
    }
    return a;
  }

  refreshWhere(pred) {
    for (const n of this.nodes.values()) if (pred(n)) this.refresh(n);
  }

  refresh(n) {
    const a = this.resolved(n);
    const el = n.el;
    if (a.flex !== undefined) el.style.flex = `${a.flex} ${a.flex} 0`;
    if (n.tag === 'spacer' && a.flex === undefined) el.style.flex = '1 1 0';
    if (typeof a.width === 'number' && !a.flex) { el.style.width = `${a.width}px`; el.style.flexShrink = '0'; }
    if (typeof a.height === 'number' && !a.flex) el.style.height = `${a.height}px`;
    if (a.align) el.style.alignItems = { start: 'flex-start', end: 'flex-end', center: 'center', stretch: 'stretch' }[a.align];
    if (typeof a.order === 'number') el.dataset.order = a.order;
    el.hidden = Boolean(a.hidden);
    el.classList.toggle('x-primary', a.class === 'primary');
    el.classList.toggle('x-danger', a.class === 'danger');
    el.classList.toggle('x-muted', a.class === 'muted');
    el.classList.toggle('x-mono', a.class === 'mono');
    if (a.title) el.title = a.title;

    switch (n.tag) {
      case 'window':
        if (a.label && !a.modal) document.title = a.label;
        el.classList.toggle('x-modal', Boolean(a.modal));
        if (a.icon) el.dataset.icon = a.icon;
        else delete el.dataset.icon;
        if (a.modal) { el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', a.label || ''); }
        this.syncModal();
        break;
      case 'filepicker':
        if (a.accept) n.input.accept = a.accept;
        n.input.multiple = Boolean(a.multiple);
        n.input.disabled = Boolean(a.disabled) || !this.options.upload;
        if (a.value) n.status.textContent = Array.isArray(a.value) ? a.value.join(', ') : String(a.value);
        break;
      case 'label':
      case 'description':
        el.textContent = a.value ?? a.label ?? '';
        break;
      case 'button':
      case 'toolbarbutton':
        el.textContent = a.label ?? '';
        el.disabled = Boolean(a.disabled);
        break;
      case 'textbox':
        if (el.tagName === 'INPUT') el.type = a.password ? 'password' : 'text';
        el.placeholder = a.placeholder || '';
        el.disabled = Boolean(a.disabled);
        // Ownership rule: the user owns the value while the field has focus.
        if (a.value !== undefined && document.activeElement !== el) el.value = a.value;
        break;
      case 'checkbox':
        n.text.textContent = a.label || '';
        n.input.disabled = Boolean(a.disabled);
        if (document.activeElement !== n.input) n.input.checked = Boolean(a.value);
        break;
      case 'menulist':
        if (a.options && el.options.length !== a.options.length) {
          el.replaceChildren(...a.options.map((o) => new Option(o.label, o.value)));
        }
        if (a.selectedIndex !== undefined) el.selectedIndex = a.selectedIndex;
        el.disabled = Boolean(a.disabled);
        break;
      case 'groupbox':
        n.legend.textContent = a.label || '';
        n.legend.hidden = !a.label;
        break;
      case 'progressmeter':
        el.value = Number(a.value) || 0;
        break;
      case 'deck':
        [...el.children].forEach((c, i) => { c.hidden = i !== (a.selectedIndex || 0); });
        break;
      case 'tabpanel': {
        const box = this.nodes.get(el.parentElement?.closest('.x-tabbox')?.dataset.xid);
        if (box) this.syncTabs(box);
        break;
      }
      case 'tree':
        if (n.viewport) setTimeout(() => this.paintTree(n, false), 0); // columns changed
        n.head.replaceChildren(...a.cols.map((c) => {
          const h = document.createElement('div');
          h.className = 'x-cell';
          h.textContent = c.label;
          this.sizeCell(h, c);
          return h;
        }));
        break;
      case 'pending':
        el.dataset.hint = a.hint || '';
        break;
    }
  }

  sizeCell(cell, col) {
    if (col.width) cell.style.flex = `0 0 ${col.width}px`;
    else cell.style.flex = `${col.flex || 1} 1 0`;
  }

  // ---- modal windows and notifications --------------------------------------

  // While a modal window is open, every other window is inert (no focus, no clicks).
  syncModal() {
    const wins = [...this.rootEl.children].filter((e) => e.classList.contains('x-window'));
    const modal = wins.filter((w) => w.classList.contains('x-modal') && !w.hidden).pop();
    this.rootEl.classList.toggle('x-has-modal', Boolean(modal));
    for (const w of wins) {
      if (modal && w !== modal) w.setAttribute('inert', '');
      else w.removeAttribute('inert');
    }
    if (modal && !modal.contains(document.activeElement)) {
      const target = modal.querySelector('.x-primary:not(:disabled)') || modal.querySelector('button:not(:disabled), input:not(:disabled)');
      if (target) setTimeout(() => target.focus(), 0);
    }
  }

  notify(op) {
    let box = document.getElementById('x-toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'x-toasts';
      box.setAttribute('role', 'status');
      document.body.append(box);
    }
    const t = document.createElement('div');
    t.className = `x-toast x-toast-${op.level || 'info'}`;
    t.textContent = op.message;
    box.append(t);
    setTimeout(() => t.remove(), 5000);
  }

  static download(op) {
    if (!/^\/download\/[A-Za-z0-9_-]+$/.test(op.url)) return;
    const a = document.createElement('a');
    a.href = op.url;
    a.download = op.name || '';
    document.body.append(a);
    a.click();
    a.remove();
  }

  // ---- tabbox ------------------------------------------------------------

  syncTabs(box) {
    if (!box || box.tag !== 'tabbox') return;
    const panels = [...box.body.children];
    if (box.selected >= panels.length) box.selected = 0;
    box.strip.replaceChildren(...panels.map((p, i) => {
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'x-tab';
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-selected', String(i === box.selected));
      t.textContent = this.nodes.get(p.dataset.xid)?.attrs.label || `Tab ${i + 1}`;
      t.addEventListener('click', () => { box.selected = i; this.syncTabs(box); });
      return t;
    }));
    panels.forEach((p, i) => { p.hidden = i !== box.selected; });
    panels.forEach((p) => p.querySelectorAll('.x-tree').forEach((t) => this.paintTree(this.nodes.get(t.dataset.xid), false)));
  }

  // ---- tree (virtualized) ------------------------------------------------

  paintTree(n, dataChanged) {
    if (!n || !n.el.isConnected) return;
    const rows = this.source(n.attrs.rows.source).rows;
    const vp = n.viewport;
    const wasAtBottom = vp.scrollTop + vp.clientHeight >= vp.scrollHeight - ROW_H * 2;
    n.sizer.style.height = `${rows.length * ROW_H}px`;
    if (dataChanged && wasAtBottom) vp.scrollTop = vp.scrollHeight;
    const first = Math.max(0, Math.floor(vp.scrollTop / ROW_H) - 5);
    const last = Math.min(rows.length, first + Math.ceil(vp.clientHeight / ROW_H) + 10);
    const cols = n.attrs.cols;
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const r = rows[i];
      const row = document.createElement('div');
      row.className = `x-row x-level-${r.level || ''}`;
      row.style.transform = `translateY(${i * ROW_H}px)`;
      for (const c of cols) {
        const cell = document.createElement('div');
        cell.className = 'x-cell';
        cell.textContent = r[c.id] ?? '';
        this.sizeCell(cell, c);
        row.append(cell);
      }
      frag.append(row);
    }
    n.sizer.replaceChildren(frag);
  }

  // ---- commands ----------------------------------------------------------

  fire(id) {
    const cmd = id && this.commands.get(id);
    if (cmd && !cmd.disabled) this.send({ op: 'do', command: id });
  }

  onKey(e) {
    const combo = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta', e.key.toLowerCase()]
      .filter(Boolean).join('+');
    for (const [id, cmd] of this.commands) {
      if (cmd.key === combo && !cmd.disabled) {
        e.preventDefault();
        return this.fire(id);
      }
    }
  }
}
XulJ.anon = 0;

window.XulJ = XulJ;
