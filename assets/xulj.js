// XUL-J browser renderer: applies streamed ops directly to the DOM.
// Semantics mirror protocol/model.js (the headless client).
'use strict';

const STRUCT = new Set(['op', 'seq', 'in', 'before', 'children', 'tag', 'id']);

class XulJ {
  // options.upload(id, file) -> Promise: sends a picked file to the host (filepicker).
  // options.download(op): starts a download; the default follows op.url on this origin.
  constructor(rootEl, send, options = {}) {
    this.rootEl = rootEl;
    this.send = send;
    this.options = options;
    this.rowH = 22;
    this.theme = null;
    this.reset();
    document.addEventListener('keydown', (e) => this.onKey(e));
    // Menus open and close locally; only choosing an item reaches the server.
    document.addEventListener('pointerdown', (e) => {
      if (!(e.target instanceof Element) || !e.target.closest('.x-menu, .x-menupopup')) this.closeMenus();
    });
    document.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    window.addEventListener('resize', () => this.closeMenus());
    // The viewer's preferences beat the producer's theme, so re-apply when they change.
    for (const q of ['(prefers-color-scheme: dark)', '(prefers-contrast: more)', '(forced-colors: active)']) {
      const mq = window.matchMedia && window.matchMedia(q);
      if (mq && mq.addEventListener) mq.addEventListener('change', () => this.applyTheme());
    }
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
      case 'theme':
        this.theme = op;
        return this.applyTheme();
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
        n.sel = new Set();
        n.cursor = -1;
        n.sizer.addEventListener('click', (e) => this.rowClick(n, e));
        n.sizer.addEventListener('dblclick', (e) => {
          const i = this.rowIndex(e);
          if (i >= 0 && this.resolved(n).seltype !== 'none') this.send({ op: 'activate', id: n.id, row: i });
        });
        d.addEventListener('keydown', (e) => this.treeKey(n, e));
        this.source(n.attrs.rows.source).trees.add(n);
        new ResizeObserver(() => this.paintTree(n, false)).observe(n.viewport);
        return d;
      }
      case 'pending': {
        const d = el('div');
        d.setAttribute('aria-busy', 'true');
        return d;
      }
      case 'menubar': {
        const d = el('div');
        d.setAttribute('role', 'menubar');
        d.addEventListener('keydown', (e) => this.menubarKey(e));
        return d;
      }
      case 'menu': {
        const d = el('div');
        n.button = el('button', 'x-menu-button');
        n.button.type = 'button';
        n.button.setAttribute('aria-haspopup', 'menu');
        n.button.setAttribute('aria-expanded', 'false');
        n.labelEl = el('span', 'x-menu-label');
        n.button.append(n.labelEl);
        n.body = el('div', 'x-menupopup');
        n.body.setAttribute('role', 'menu');
        n.body.hidden = true;
        d.append(n.button, n.body);
        n.button.addEventListener('click', () => (n.el.classList.contains('x-open') && !this.isSubmenu(n) ? this.closeMenus() : this.openMenu(n, this.isSubmenu(n) ? 'first' : null)));
        n.button.addEventListener('pointerenter', () => this.hoverMenu(n));
        n.body.addEventListener('keydown', (e) => this.menuKey(e, n));
        return d;
      }
      case 'menuitem': {
        const b = el('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        n.check = el('span', 'x-menu-check');
        n.labelEl = el('span', 'x-menu-label');
        n.accel = el('span', 'x-menu-accel');
        b.append(n.check, n.labelEl, n.accel);
        b.addEventListener('click', () => { this.closeMenus(); this.fire(n.attrs.command); });
        b.addEventListener('pointerenter', () => this.closeSubmenusIn(b.parentElement));
        return b;
      }
      case 'menupopup': {
        // A context menu: not shown in place; opened at the pointer by elements naming it in `contextmenu`.
        const d = el('div');
        d.setAttribute('role', 'menu');
        d.hidden = true;
        n.body = d;
        d.addEventListener('keydown', (e) => this.menuKey(e, n));
        return d;
      }
      case 'menuseparator': {
        const d = el('div');
        d.setAttribute('role', 'separator');
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
    // A context menu is shown only while open; its attributes must not un-hide it.
    if (n.tag === 'menupopup') el.hidden = Boolean(a.hidden) || !el.classList.contains('x-open');
    el.classList.toggle('x-primary', a.class === 'primary');
    el.classList.toggle('x-danger', a.class === 'danger');
    el.classList.toggle('x-muted', a.class === 'muted');
    el.classList.toggle('x-mono', a.class === 'mono');
    el.classList.toggle('x-warning', a.class === 'warning');
    el.classList.toggle('x-success', a.class === 'success');
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
      case 'menu':
        n.labelEl.textContent = a.label || '';
        n.button.disabled = Boolean(a.disabled);
        if (a.accesskey) n.button.setAttribute('aria-keyshortcuts', XulJ.keyLabel(a.accesskey));
        break;
      case 'menuitem': {
        n.labelEl.textContent = a.label ?? '';
        el.disabled = Boolean(a.disabled);
        const checkable = typeof a.checked === 'boolean';
        el.setAttribute('role', checkable ? 'menuitemcheckbox' : 'menuitem');
        if (checkable) el.setAttribute('aria-checked', String(a.checked));
        else el.removeAttribute('aria-checked');
        n.check.textContent = a.checked ? '✓' : '';
        const cmd = a.command && this.commands.get(a.command);
        n.accel.textContent = cmd && cmd.key ? XulJ.keyLabel(cmd.key) : '';
        break;
      }
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
        n.sel = new Set(Array.isArray(a.selection) ? a.selection : []);
        if (a.seltype && a.seltype !== 'none') {
          el.tabIndex = 0;
          el.setAttribute('aria-multiselectable', String(a.seltype === 'multiple'));
        } else {
          el.removeAttribute('tabindex');
          el.removeAttribute('aria-multiselectable');
        }
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

  // ---- menus ---------------------------------------------------------------

  isSubmenu(n) { return Boolean(n.el.parentElement && n.el.parentElement.classList.contains('x-menupopup')); }

  menuOf(el) { return el && this.nodes.get(el.dataset.xid); }

  openMenu(n, focus) {
    if (this.isSubmenu(n)) this.closeSubmenusIn(n.el.parentElement, n);
    else this.closeMenus(n);
    n.el.classList.add('x-open');
    n.body.hidden = false;
    n.button.setAttribute('aria-expanded', 'true');
    this.placePopup(n);
    if (focus) {
      const items = this.menuItems(n.body);
      const target = focus === 'last' ? items[items.length - 1] : items[0];
      if (target) target.focus();
    }
  }

  closeMenu(n) {
    this.closeSubmenusIn(n.body);
    n.el.classList.remove('x-open');
    n.body.hidden = true;
    if (n.button) n.button.setAttribute('aria-expanded', 'false');
  }

  // Closes menus and context menus (both carry data-xid; popups inside menus do not).
  closeMenus(except) {
    for (const el of this.rootEl.querySelectorAll('.x-open[data-xid]')) {
      const n = this.menuOf(el);
      if (n && n !== except && !(except && n.el.contains(except.el))) this.closeMenu(n);
    }
  }

  closeSubmenusIn(popup, except) {
    if (!popup) return;
    for (const el of popup.querySelectorAll(':scope > .x-menu.x-open')) {
      const n = this.menuOf(el);
      if (n && n !== except) this.closeMenu(n);
    }
  }

  // Moving across a menubar while one menu is open switches menus; submenus open on hover.
  hoverMenu(n) {
    if (n.button.disabled) return;
    if (this.isSubmenu(n)) return this.openMenu(n);
    const open = [...n.el.parentElement.children].some((c) => c !== n.el && c.classList.contains('x-open'));
    if (open) this.openMenu(n);
  }

  placePopup(n) {
    const p = n.body;
    const r = n.button.getBoundingClientRect();
    const sub = this.isSubmenu(n);
    p.style.left = `${sub ? r.right : r.left}px`;
    p.style.top = `${sub ? r.top - 4 : r.bottom}px`;
    const pr = p.getBoundingClientRect();
    if (pr.right > window.innerWidth - 4) p.style.left = `${Math.max(4, sub ? r.left - pr.width : window.innerWidth - pr.width - 4)}px`;
    if (pr.bottom > window.innerHeight - 4) p.style.top = `${Math.max(4, window.innerHeight - pr.height - 4)}px`;
  }

  menuItems(popup) {
    return [...popup.children]
      .filter((c) => !c.hidden)
      .map((c) => (c.classList.contains('x-menu') ? c.querySelector(':scope > .x-menu-button') : c))
      .filter((b) => b && b.tagName === 'BUTTON' && !b.disabled);
  }

  topMenus(n) {
    const bar = n.el.parentElement;
    return [...bar.children].filter((c) => c.classList.contains('x-menu') && !c.hidden).map((c) => this.menuOf(c))
      .filter((m) => m && !m.button.disabled);
  }

  moveTop(n, dir) {
    let top = n;
    while (top && this.isSubmenu(top)) top = this.menuOf(top.el.parentElement.closest('.x-menu'));
    if (!top) return;
    const menus = this.topMenus(top);
    const next = menus[(menus.indexOf(top) + dir + menus.length) % menus.length];
    if (next) this.openMenu(next, 'first');
  }

  menuKey(e, n) {
    const items = this.menuItems(n.body);
    const i = items.indexOf(document.activeElement);
    const owner = document.activeElement && document.activeElement.classList.contains('x-menu-button')
      ? this.menuOf(document.activeElement.parentElement) : null;
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': (items[(i + 1) % items.length] || items[0]).focus(); break;
      case 'ArrowUp': (items[(i - 1 + items.length) % items.length] || items[items.length - 1]).focus(); break;
      case 'Home': items[0] && items[0].focus(); break;
      case 'End': items[items.length - 1] && items[items.length - 1].focus(); break;
      case 'ArrowRight':
        if (owner && owner !== n) this.openMenu(owner, 'first');
        else if (n.tag === 'menu') this.moveTop(n, 1);
        break;
      case 'ArrowLeft':
        if (this.isSubmenu(n)) { this.closeMenu(n); n.button.focus(); } else if (n.tag === 'menu') this.moveTop(n, -1);
        break;
      case 'Escape':
        this.closeMenu(n);
        (n.button || n.returnFocus || document.body).focus();
        break;
      case 'Tab': this.closeMenus(); handled = false; break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
    e.stopPropagation(); // nested popups bubble through their parents; handle once
  }

  menubarKey(e) {
    const btn = document.activeElement;
    if (!btn || !btn.classList.contains('x-menu-button')) return;
    const n = this.menuOf(btn.parentElement);
    if (!n || this.isSubmenu(n)) return;
    const menus = this.topMenus(n);
    const i = menus.indexOf(n);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const next = menus[(i + (e.key === 'ArrowRight' ? 1 : -1) + menus.length) % menus.length];
      if (n.el.classList.contains('x-open')) this.openMenu(next, 'first');
      else next.button.focus();
      e.preventDefault();
    } else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      this.openMenu(n, 'first');
      e.preventDefault();
    }
  }

  static keyLabel(key) {
    const names = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta', escape: 'Esc', enter: 'Enter', delete: 'Del' };
    return key.split('+').map((k) => names[k] || (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))).join('+');
  }

  // ---- context menus -----------------------------------------------------------

  onContextMenu(e) {
    if (!(e.target instanceof Element) || !this.rootEl.contains(e.target)) return;
    const rowEl = e.target.closest('.x-row');
    const treeEl = rowEl && rowEl.closest('.x-tree');
    if (rowEl && treeEl) {
      // Right-clicking an unselected row selects it first, as on the desktop.
      const n = this.nodes.get(treeEl.dataset.xid);
      const i = Number(rowEl.dataset.index);
      if (n && this.resolved(n).seltype && this.resolved(n).seltype !== 'none' && !n.sel.has(i)) this.select(n, [i], i);
    }
    // Selecting repaints the rows (detaching the target), so look up from the tree itself.
    if (this.openContextMenuFor(treeEl || e.target, e.clientX, e.clientY)) e.preventDefault();
  }

  // Finds the nearest element (from target outwards) with a `contextmenu` and opens that popup.
  openContextMenuFor(target, x, y) {
    for (let el = target; el && el !== this.rootEl; el = el.parentElement) {
      const owner = el.dataset && el.dataset.xid ? this.nodes.get(el.dataset.xid) : null;
      const popupId = owner && this.resolved(owner).contextmenu;
      if (!popupId) continue;
      const popup = this.nodes.get(popupId);
      if (!popup || popup.tag !== 'menupopup' || el.closest('[inert]')) return false;
      this.openPopupAt(popup, x, y, owner);
      return true;
    }
    return false;
  }

  openPopupAt(n, x, y, owner) {
    this.closeMenus();
    n.returnFocus = document.activeElement;
    n.el.classList.add('x-open');
    n.el.hidden = false;
    n.el.style.left = `${x}px`;
    n.el.style.top = `${y}px`;
    const pr = n.el.getBoundingClientRect();
    if (pr.right > window.innerWidth - 4) n.el.style.left = `${Math.max(4, window.innerWidth - pr.width - 4)}px`;
    if (pr.bottom > window.innerHeight - 4) n.el.style.top = `${Math.max(4, window.innerHeight - pr.height - 4)}px`;
    const first = this.menuItems(n.el)[0];
    if (first) first.focus();
    // Lets the producer run the app's "menu opening" hooks; the menu is already open meanwhile.
    this.send({ op: 'contextmenu', id: n.id, target: owner.id });
  }

  // ---- selection -------------------------------------------------------------------

  rowIndex(e) {
    const row = e.target instanceof Element && e.target.closest('.x-row');
    return row ? Number(row.dataset.index) : -1;
  }

  rowClick(n, e) {
    const i = this.rowIndex(e);
    const type = this.resolved(n).seltype;
    if (i < 0 || !type || type === 'none') return;
    let next;
    if (type === 'multiple' && e.shiftKey && n.anchor >= 0) {
      const [a, b] = [Math.min(n.anchor, i), Math.max(n.anchor, i)];
      next = Array.from({ length: b - a + 1 }, (_, k) => a + k);
    } else if (type === 'multiple' && (e.ctrlKey || e.metaKey)) {
      next = n.sel.has(i) ? [...n.sel].filter((k) => k !== i) : [...n.sel, i];
      n.anchor = i;
    } else {
      next = [i];
      n.anchor = i;
    }
    this.select(n, next, i);
  }

  // Shows the selection at once and tells the producer; its echo confirms (or corrects) it.
  select(n, rows, cursor) {
    const sorted = [...new Set(rows)].sort((a, b) => a - b);
    n.sel = new Set(sorted);
    n.cursor = cursor;
    if (n.anchor === undefined || n.anchor < 0) n.anchor = cursor;
    this.paintTree(n, false);
    this.send({ op: 'select', id: n.id, rows: sorted });
  }

  treeKey(n, e) {
    const type = this.resolved(n).seltype;
    if (!type || type === 'none' || e.target !== n.el) return;
    const count = this.source(n.attrs.rows.source).rows.length;
    if (!count) return;
    const page = Math.max(1, Math.floor(n.viewport.clientHeight / this.rowH) - 1);
    const cur = n.cursor >= 0 ? n.cursor : (n.sel.size ? Math.min(...n.sel) : -1);
    let next = null;
    switch (e.key) {
      case 'ArrowDown': next = Math.min(count - 1, cur + 1); break;
      case 'ArrowUp': next = Math.max(0, cur - 1); break;
      case 'PageDown': next = Math.min(count - 1, cur + page); break;
      case 'PageUp': next = Math.max(0, cur - page); break;
      case 'Home': next = 0; break;
      case 'End': next = count - 1; break;
      case 'Enter':
        if (cur >= 0) this.send({ op: 'activate', id: n.id, row: cur });
        return e.preventDefault();
      default: return;
    }
    e.preventDefault();
    if (type === 'multiple' && e.shiftKey && n.anchor >= 0) {
      const [a, b] = [Math.min(n.anchor, next), Math.max(n.anchor, next)];
      this.select(n, Array.from({ length: b - a + 1 }, (_, k) => a + k), next);
    } else {
      n.anchor = next;
      this.select(n, [next], next);
    }
    const top = next * this.rowH, vp = n.viewport;
    if (top < vp.scrollTop) vp.scrollTop = top;
    else if (top + this.rowH > vp.scrollTop + vp.clientHeight) vp.scrollTop = top + this.rowH - vp.clientHeight;
  }

  // ---- theme -------------------------------------------------------------------------

  // Producer themes are design tokens, never CSS. The viewer wins: high contrast ignores producer
  // colours, dark mode uses only an explicit dark palette, and token pairs that would fall below
  // WCAG contrast are dropped. Non-colour tokens (radius, density, font) always apply.
  applyTheme() {
    const st = this.rootEl.style;
    for (const v of XulJ.THEME_VARS) st.removeProperty(v);
    this.rootEl.classList.remove('x-density-compact', 'x-density-comfortable');
    this.themeDropped = [];
    this.rowH = 22;
    const t = this.theme;
    if (!t) return this.repaintTrees();
    const mq = (q) => Boolean(window.matchMedia && window.matchMedia(q).matches);
    const dark = mq('(prefers-color-scheme: dark)');
    const contrast = mq('(prefers-contrast: more)') || mq('(forced-colors: active)');
    const base = t.tokens || {};
    let colors = {};
    if (!contrast) colors = dark ? { ...(t.dark || {}) } : { ...base };
    // Effective colours: producer tokens over the stylesheet defaults.
    const css = getComputedStyle(this.rootEl);
    const eff = (k) => colors[k] || css.getPropertyValue(XulJ.TOKEN_VARS[k]).trim();
    const pairs = [['text', 'surface', 4.5], ['text', 'background', 4.5], ['accentText', 'accent', 4.5], ['muted', 'surface', 3], ['danger', 'surface', 3]];
    for (const [fg, bg, min] of pairs) {
      if (!(fg in colors) && !(bg in colors)) continue;
      const ratio = XulJ.contrast(eff(fg), eff(bg));
      if (ratio !== null && ratio < min) {
        this.themeDropped.push(`${fg}/${bg} ${ratio.toFixed(2)}:1`);
        delete colors[fg];
        delete colors[bg];
      }
    }
    for (const [k, v] of Object.entries(colors)) if (XulJ.TOKEN_VARS[k]) st.setProperty(XulJ.TOKEN_VARS[k], v);
    if (typeof base.radius === 'number') st.setProperty('--x-radius', `${base.radius}px`);
    if (base.font && XulJ.FONTS[base.font]) st.setProperty('--x-font', XulJ.FONTS[base.font]);
    if (base.density === 'compact' || base.density === 'comfortable') this.rootEl.classList.add(`x-density-${base.density}`);
    this.rowH = { compact: 20, comfortable: 28 }[base.density] || 22;
    this.repaintTrees();
  }

  repaintTrees() {
    for (const n of this.nodes.values()) if (n.tag === 'tree') this.paintTree(n, false);
  }

  static contrast(a, b) {
    const rgb = (c) => {
      const m = /^#([0-9a-f]{6})$/i.exec(c || '');
      if (!m) return null;
      return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    };
    const la = rgb(a), lb = rgb(b);
    if (!la || !lb) return null;
    const lum = (l) => 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
    const [x, y] = [lum(la), lum(lb)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
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
    const wasAtBottom = vp.scrollTop + vp.clientHeight >= vp.scrollHeight - this.rowH * 2;
    n.sizer.style.height = `${rows.length * this.rowH}px`;
    if (dataChanged && wasAtBottom) vp.scrollTop = vp.scrollHeight;
    const first = Math.max(0, Math.floor(vp.scrollTop / this.rowH) - 5);
    const last = Math.min(rows.length, first + Math.ceil(vp.clientHeight / this.rowH) + 10);
    const cols = n.attrs.cols;
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const r = rows[i];
      const row = document.createElement('div');
      row.className = `x-row x-level-${r.level || ''}${n.sel && n.sel.has(i) ? ' x-selected' : ''}${i === n.cursor ? ' x-cursor' : ''}`;
      row.dataset.index = i;
      row.setAttribute('role', 'row');
      if (n.sel && n.sel.size) row.setAttribute('aria-selected', String(n.sel.has(i)));
      row.style.height = `${this.rowH}px`;
      row.style.transform = `translateY(${i * this.rowH}px)`;
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
    if (e.key === 'Escape' && this.rootEl.querySelector('.x-open[data-xid]')) {
      this.closeMenus();
      return e.preventDefault();
    }
    if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && this.rootEl.contains(document.activeElement)) {
      const r = document.activeElement.getBoundingClientRect();
      if (this.openContextMenuFor(document.activeElement, r.left + 8, r.top + Math.min(r.height, this.rowH))) return e.preventDefault();
    }
    const combo = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta', e.key.toLowerCase()]
      .filter(Boolean).join('+');
    // Access keys open top-level menus (Alt+F → File), unless a modal window blocks them.
    for (const n of this.nodes.values()) {
      if (n.tag !== 'menu' || n.attrs.accesskey !== combo || this.isSubmenu(n) || n.button.disabled) continue;
      if (n.el.closest('[inert]') || !n.el.isConnected || n.el.closest('[hidden]')) continue;
      e.preventDefault();
      return this.openMenu(n, 'first');
    }
    for (const [id, cmd] of this.commands) {
      if (cmd.key === combo && !cmd.disabled) {
        e.preventDefault();
        return this.fire(id);
      }
    }
  }
}
XulJ.anon = 0;
XulJ.TOKEN_VARS = {
  accent: '--accent', accentText: '--accent-text', surface: '--surface', background: '--bg', chrome: '--chrome',
  text: '--text', muted: '--muted', border: '--border', danger: '--danger', warning: '--warn', success: '--success',
};
XulJ.THEME_VARS = [...Object.values(XulJ.TOKEN_VARS), '--x-radius', '--x-font'];
XulJ.FONTS = {
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", system-ui, sans-serif',
  classic: 'Tahoma, Verdana, "MS Sans Serif", sans-serif',
};

window.XulJ = XulJ;
