// A tiny XUL-J "server" that runs in the page. In a real deployment these ops arrive over SSE
// or MQTT from a server, a device or a desktop bridge; here a local app emits them, so the
// demo works on a static site. The renderer (xulj.js) is the real one from xul-j/xul-j.
'use strict';
(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wire = document.getElementById('wire');
  const wireLog = document.getElementById('wire-log');
  const pause = document.getElementById('wire-pause');
  const count = document.getElementById('wire-count');

  let ui, seq, ops, generation = 0;
  const st = { env: 'staging', filter: '', rows: [], running: null };

  function log(dir, msg) {
    if (pause.checked || wire.hidden) return;
    const li = document.createElement('li');
    li.className = dir === '→' ? 'out' : 'in';
    li.textContent = `${dir} ${JSON.stringify(msg)}`;
    wireLog.append(li);
    while (wireLog.childElementCount > 200) wireLog.firstElementChild.remove();
    wireLog.scrollTop = wireLog.scrollHeight;
  }

  function emit(op) {
    const msg = { ...op, seq: ++seq };
    ops++;
    count.textContent = `${ops} ops`;
    log('←', msg);
    ui.apply(msg);
  }

  function send(intent) {
    log('→', intent);
    setTimeout(() => handle(intent), 40); // a network round trip, roughly
  }

  const now = () => new Date().toTimeString().slice(0, 8);
  const visible = (r) => !st.filter || `${r.level} ${r.msg}`.toLowerCase().includes(st.filter.toLowerCase());

  function logRow(level, msg) {
    const row = { t: now(), level, msg };
    st.rows.push(row);
    if (visible(row)) emit({ op: 'rows', source: 'log', append: [row] });
  }

  function busy(on) {
    emit({ op: 'broadcast', id: 'busy', value: on });
    emit({ op: 'command', id: 'cmd_deploy', disabled: on });
    emit({ op: 'command', id: 'cmd_cancel', disabled: !on });
  }

  const STEPS = [
    ['info', 'Resolving revision a1f9c3e'], ['info', 'Installing dependencies'], ['info', 'Running tests'],
    ['debug', '128 passed, 0 failed'], ['warn', 'Bundle grew 4.2% since the last release'],
    ['info', 'Building image'], ['info', 'Rolling out 3/3 replicas'], ['info', 'Switching traffic'],
  ];

  async function deploy(gen) {
    const run = { cancelled: false };
    st.running = run;
    busy(true);
    logRow('info', `Deploying to ${st.env}`);
    for (let i = 0; i < STEPS.length; i++) {
      await sleep(450);
      if (gen !== generation || run.cancelled) break;
      logRow(...STEPS[i]);
      emit({ op: 'broadcast', id: 'progress', value: (i + 1) / STEPS.length });
      emit({ op: 'broadcast', id: 'status', value: `Deploying to ${st.env}… ${i + 1}/${STEPS.length}` });
    }
    if (gen !== generation) return;
    if (run.cancelled) { logRow('error', 'Deploy cancelled'); emit({ op: 'broadcast', id: 'status', value: 'Cancelled' }); }
    else { logRow('info', `Deployed to ${st.env}`); emit({ op: 'broadcast', id: 'status', value: `Deployed to ${st.env}` }); }
    st.running = null;
    busy(false);
  }

  // A modal confirmation, the way a bridge renders MessageBox / JOptionPane.
  function confirmProduction() {
    emit({ op: 'command', id: 'cmd_yes', label: 'Deploy' });
    emit({ op: 'command', id: 'cmd_no', label: 'Cancel', key: 'escape' });
    emit({
      op: 'node', in: 'root', tag: 'window', id: 'confirm', label: 'Deploy to production?', modal: true, icon: 'warning',
      children: [
        { tag: 'description', value: 'This deploys revision a1f9c3e to production for all users.' },
        { tag: 'hbox', children: [{ tag: 'spacer', flex: 1 }, { tag: 'button', command: 'cmd_no' }, { tag: 'button', command: 'cmd_yes', class: 'primary' }] },
      ],
    });
  }

  function closeConfirm() {
    emit({ op: 'remove', id: 'confirm' });
    emit({ op: 'command', id: 'cmd_yes', deleted: true });
    emit({ op: 'command', id: 'cmd_no', deleted: true });
  }

  function handle(m) {
    const gen = generation;
    if (m.op === 'do') {
      if (m.command === 'cmd_deploy') { if (st.env === 'production') confirmProduction(); else deploy(gen); }
      if (m.command === 'cmd_yes') { closeConfirm(); deploy(gen); }
      if (m.command === 'cmd_no') { closeConfirm(); emit({ op: 'broadcast', id: 'status', value: 'Deploy cancelled' }); }
      if (m.command === 'cmd_cancel' && st.running) st.running.cancelled = true;
      if (m.command === 'cmd_rollback') logRow('warn', `Rollback of ${st.env} requested (demo: nothing happens)`);
    } else if (m.op === 'input') {
      if (m.id === 'env') {
        st.env = m.value;
        emit({ op: 'set', id: 'win', attrs: { label: `Deploy console — ${st.env}` } });
      }
      if (m.id === 'filter') {
        st.filter = String(m.value);
        emit({ op: 'rows', source: 'log', clear: true, append: st.rows.filter(visible) });
      }
    }
  }

  async function start() {
    const gen = ++generation;
    seq = 0;
    ops = 0;
    st.env = 'staging';
    st.filter = '';
    st.rows = [];
    st.running = null;
    wireLog.replaceChildren();
    const step = async (ms) => { await sleep(ms); return gen === generation; };

    emit({ op: 'reset' });
    emit({ op: 'command', id: 'cmd_deploy', label: 'Deploy', key: 'ctrl+enter' });
    emit({ op: 'command', id: 'cmd_cancel', label: 'Cancel', key: 'escape', disabled: true });
    emit({ op: 'broadcast', id: 'busy', value: false });
    emit({ op: 'broadcast', id: 'status', value: 'Idle' });
    emit({ op: 'broadcast', id: 'progress', value: 0 });
    emit({ op: 'node', in: 'root', tag: 'window', id: 'win', label: 'Deploy console' });
    if (!await step(250)) return;
    emit({
      op: 'node', in: 'win', tag: 'toolbar', id: 'tb', children: [
        { tag: 'toolbarbutton', id: 'tb_deploy', command: 'cmd_deploy', class: 'primary' },
        { tag: 'toolbarbutton', id: 'tb_cancel', command: 'cmd_cancel' },
        { tag: 'spacer', id: 'tb_spacer', flex: 1 },
        { tag: 'menulist', id: 'env', observes: { disabled: 'busy' }, options: [{ value: 'staging', label: 'staging' }, { value: 'production', label: 'production' }] },
        { tag: 'textbox', id: 'filter', placeholder: 'Filter log…' },
      ],
    });
    if (!await step(250)) return;
    emit({
      op: 'node', in: 'win', tag: 'vbox', id: 'body', flex: 1,
      children: [{ tag: 'pending', id: 'log', hint: 'tree', flex: 1 }],
    });
    emit({
      op: 'node', in: 'win', tag: 'statusbar', id: 'sb', children: [
        { tag: 'label', id: 'sb_status', observes: { value: 'status' } },
        { tag: 'spacer', flex: 1 },
        { tag: 'progressmeter', id: 'sb_progress', observes: { value: 'progress' } },
      ],
    });
    // The log tree arrives late; the placeholder has been holding its space.
    if (!await step(900)) return;
    emit({
      op: 'replace', id: 'log', tag: 'tree', flex: 1, class: 'mono',
      cols: [{ id: 't', label: 'Time', width: 80 }, { id: 'level', label: 'Level', width: 64 }, { id: 'msg', label: 'Message', flex: 1 }],
      rows: { source: 'log' },
    });
    logRow('info', 'Ready. Press Deploy (Ctrl+Enter); pick production for a confirmation dialog.');
    // A "plugin" overlays a button into the toolbar, anchored by id, after the fact.
    if (!await step(1400)) return;
    emit({ op: 'command', id: 'cmd_rollback', label: 'Rollback' });
    emit({ op: 'node', in: 'tb', before: 'tb_spacer', tag: 'toolbarbutton', id: 'tb_rollback', command: 'cmd_rollback', class: 'danger', observes: { disabled: 'busy' } });
  }

  ui = new XulJ(document.getElementById('root'), send);
  document.getElementById('replay').addEventListener('click', start);
  document.getElementById('wire-toggle').addEventListener('click', (e) => {
    wire.hidden = !wire.hidden;
    e.target.textContent = wire.hidden ? 'Show wire' : 'Hide wire';
  });
  if (window.matchMedia('(max-width: 700px)').matches) {
    wire.hidden = true;
    document.getElementById('wire-toggle').textContent = 'Show wire';
  }
  start();
})();
