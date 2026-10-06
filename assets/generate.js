// XUL-J generator: a language model (via OpenRouter, bring your own key) streams an interface
// as XUL-J operations, one JSON object per line. Each complete line is validated against the
// protocol schema and applied to the real renderer immediately. Afterwards the model acts as
// the app's backend: clicks go back to it as intents, and it answers with more operations.
'use strict';
(function () {
  const OR = 'https://openrouter.ai';
  const SUGGESTED = [
    'anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'anthropic/claude-haiku-4.5',
    'openai/gpt-5.6-terra', 'google/gemini-3.8-flash',
  ];
  const EXAMPLES = [
    'A pizza order form: size, toppings, quantity, a cart table and a running total',
    'A small task tracker with tabs for Today, Upcoming and Done',
    'A flight search: from, to, date, passengers, and a results table with prices',
    'An email client: folder list, message list, and a reading pane',
    'Settings for a photo app, with tabs, toggles and a reset button that asks for confirmation',
  ];

  const SYSTEM = `You generate user interfaces in XUL-J: a stream of JSON operations, ONE JSON OBJECT PER LINE.
Output only operation lines: no prose, no markdown, no code fences, no comments, no blank lines.

Operations:
{"op":"reset"}  clear everything (only as the very first line of a new interface)
{"op":"command","id":"cmd_save","label":"Save","key":"ctrl+s","disabled":false}  an action; buttons reference it by "command" and show its label
{"op":"broadcast","id":"busy","value":false}  a named value; elements bind attributes to it with "observes":{"disabled":"busy"}
{"op":"node","in":"<parent id or root>","id":"x","tag":"…", …attributes, "children":[{"tag":"…", …}]}  insert an element with nested children
{"op":"set","id":"x","attrs":{…}}  change attributes of an element
{"op":"replace","id":"x","tag":"…", …}  replace an element (e.g. a pending placeholder)
{"op":"remove","id":"x"}
{"op":"rows","source":"x","append":[{"<col id>":"value",…}],"clear":true}  table data for a tree whose rows.source is "x"
{"op":"notify","message":"…","level":"info"}  a short toast (info, warning, error)

Tags and their attributes:
window (top level, in "root"; label = title; "modal":true and "icon":"info|warning|error|question" for dialogs)
vbox, hbox, box (containers), spacer (flex:1 pushes siblings apart), groupbox (label), toolbar, statusbar
label (value), description (value, wraps), button and toolbarbutton (command, optional label, class "primary" or "danger")
textbox (value, placeholder, multiline:true, password:true), checkbox (label, value true/false)
menulist (options:[{"value":"a","label":"A"}], selectedIndex), tabbox (children are tabpanel elements with label)
deck (selectedIndex), tree (cols:[{"id":"name","label":"Name","width":120} or {"flex":1}], rows:{"source":"<tree id>"})
progressmeter (value 0..1), pending (hint = a tag; a placeholder for something you add later)
Common attributes: id (unique; letters, digits, _ . -; starts with a letter or _), flex (number),
width/height (px), align (start|center|end|stretch), class (primary|danger|muted|mono), disabled, hidden.
Layout is flexbox: windows and vboxes stack vertically, hboxes and toolbars horizontally; give flex:1 to what should grow.

Rules:
- New interface: reset, then commands and broadcasters, then the window (in "root"), then its content top-down,
  so the UI appears progressively. Aim for 20-60 lines.
- Every button and toolbarbutton has a "command"; declare commands before they are used.
- Give ids to everything you may update later. Never reuse an id.
- Fill trees with a few realistic rows using rows operations.
- Use a modal window (with buttons whose commands you declare) for confirmations; remove it when answered.

Interaction: after the interface exists you receive the user's actions as JSON, for example
{"do":"cmd_add","inputs":{"name":"Ada","qty":"2"}} where inputs are values the user changed since the last action
(checkboxes are true/false; menulists give the option value). Reply only with the operations that update the
interface, as the app's backend would: validate input, compute results, update text, rows and totals, show errors.
Never resend the whole interface. You may also receive change requests in plain words: reply with operations that
make the change.`;

  // ---- elements ----------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const wire = $('wire'), wireLog = $('wire-log'), pause = $('wire-pause'), count = $('wire-count');
  const promptEl = $('prompt'), modelEl = $('model'), goBtn = $('go'), stopBtn = $('stop');
  const stateEl = $('state'), changeEl = $('change'), changeBtn = $('change-go'), authEl = $('auth');

  let validate = () => [];
  let messages = [];
  let seq = 0, opCount = 0;
  let pendingInputs = {};
  let queue = Promise.resolve();
  let controller = null;
  const ui = new XulJ($('root'), onIntent);

  // ---- storage: the key never leaves the browser except to openrouter.ai ---------------------
  const store = {
    get(k) { try { return sessionStorage.getItem(k) || localStorage.getItem(k); } catch { return null; } },
    set(k, v, remember) {
      try {
        (remember ? localStorage : sessionStorage).setItem(k, v);
        (remember ? sessionStorage : localStorage).removeItem(k);
      } catch { /* storage blocked: the key lives only in memory */ }
    },
    del(k) { try { sessionStorage.removeItem(k); localStorage.removeItem(k); } catch { } },
  };
  let apiKey = store.get('xulj-or-key');

  function renderAuth() {
    authEl.replaceChildren();
    if (apiKey) {
      const who = document.createElement('span');
      who.className = 'muted';
      who.textContent = `OpenRouter key …${apiKey.slice(-4)}`;
      const out = button('Forget key', () => {
        apiKey = null;
        store.del('xulj-or-key');
        renderAuth();
        setState('Key forgotten. Revoke it at openrouter.ai/settings/keys if you no longer need it.');
      });
      authEl.append(who, out);
    } else {
      const signIn = button('Sign in with OpenRouter', startLogin, 'primary');
      const key = document.createElement('input');
      key.id = 'key';
      key.className = 'ctl';
      key.type = 'password';
      key.placeholder = 'or paste a key (sk-or-…)';
      key.autocomplete = 'off';
      key.setAttribute('aria-label', 'OpenRouter API key');
      const use = button('Use key', () => {
        if (!/^sk-or-[A-Za-z0-9_-]{10,}$/.test(key.value.trim())) return setState('That does not look like an OpenRouter key (sk-or-…).');
        saveKey(key.value.trim());
      });
      key.addEventListener('keydown', (e) => { if (e.key === 'Enter') use.click(); });
      const remember = document.createElement('label');
      remember.className = 'muted';
      remember.innerHTML = '<input type="checkbox" id="remember"> remember on this device';
      authEl.append(signIn, key, use, remember);
    }
    updateButtons();
  }

  function saveKey(k) {
    apiKey = k;
    const remember = $('remember') ? $('remember').checked : false;
    store.set('xulj-or-key', k, remember);
    try { sessionStorage.setItem('xulj-or-remember', remember ? '1' : ''); } catch { }
    renderAuth();
    setState('Ready.');
  }

  function button(text, onClick, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `ctl${cls ? ` ${cls}` : ''}`;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  // ---- OAuth PKCE: "Sign in with OpenRouter" issues a key the user controls -------------------
  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  async function startLogin() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    try {
      sessionStorage.setItem('xulj-or-verifier', verifier);
      sessionStorage.setItem('xulj-or-remember', $('remember') && $('remember').checked ? '1' : '');
      sessionStorage.setItem('xulj-prompt', promptEl.value);
    } catch { return setState('Your browser blocks storage, so sign-in cannot complete. Paste a key instead.'); }
    const callback = location.origin + location.pathname;
    location.href = `${OR}/auth?callback_url=${encodeURIComponent(callback)}&code_challenge=${challenge}&code_challenge_method=S256`;
  }

  async function finishLogin() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (!code) return;
    history.replaceState(null, '', location.pathname); // drop ?code= from the address bar
    let verifier = null, remember = false;
    try {
      verifier = sessionStorage.getItem('xulj-or-verifier');
      remember = sessionStorage.getItem('xulj-or-remember') === '1';
      promptEl.value = sessionStorage.getItem('xulj-prompt') || promptEl.value;
      sessionStorage.removeItem('xulj-or-verifier');
    } catch { }
    if (!verifier) return setState('Sign-in could not be completed (missing verifier). Please try again.');
    setState('Finishing sign-in…', true);
    try {
      const r = await fetch(`${OR}/api/v1/auth/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.key) throw new Error(body.error?.message || `HTTP ${r.status}`);
      apiKey = body.key;
      store.set('xulj-or-key', apiKey, remember);
      renderAuth();
      setState('Signed in with OpenRouter.');
    } catch (e) {
      setState(`Sign-in failed: ${e.message}`);
    }
  }

  // ---- models ------------------------------------------------------------------------------
  async function loadModels() {
    try {
      const r = await fetch(`${OR}/api/v1/models`);
      const { data } = await r.json();
      const usable = data.filter((m) => !m.id.endsWith(':batch')
        && (m.architecture?.output_modalities || ['text']).includes('text'))
        .sort((a, b) => a.id.localeCompare(b.id));
      const ids = new Set(usable.map((m) => m.id));
      modelEl.replaceChildren();
      const group = (label, list) => {
        const g = document.createElement('optgroup');
        g.label = label;
        for (const m of list) g.append(new Option(m.name || m.id, m.id));
        modelEl.append(g);
      };
      const suggested = SUGGESTED.filter((id) => ids.has(id)).map((id) => usable.find((m) => m.id === id));
      if (suggested.length) group('Suggested', suggested);
      group('All models', usable);
      let saved = null;
      try { saved = localStorage.getItem('xulj-model'); } catch { }
      modelEl.value = saved && ids.has(saved) ? saved : (suggested[0] || usable[0]).id;
    } catch (e) {
      modelEl.replaceChildren(new Option('anthropic/claude-sonnet-5.5', 'anthropic/claude-sonnet-5.5'));
      setState(`Could not load the model list (${e.message}); using the default.`);
    }
  }
  modelEl.addEventListener('change', () => { try { localStorage.setItem('xulj-model', modelEl.value); } catch { } });

  // ---- wire log and state --------------------------------------------------------------------
  function log(cls, text) {
    if (pause.checked || wire.hidden) return;
    const li = document.createElement('li');
    li.className = cls;
    li.textContent = text.length > 400 ? `${text.slice(0, 400)}…` : text;
    wireLog.append(li);
    while (wireLog.childElementCount > 400) wireLog.firstElementChild.remove();
    wireLog.scrollTop = wireLog.scrollHeight;
  }

  function setState(text, busy) {
    stateEl.textContent = text;
    stateEl.classList.toggle('busy', Boolean(busy));
  }

  function updateButtons() {
    const running = Boolean(controller);
    goBtn.disabled = running || !apiKey;
    stopBtn.disabled = !running;
    const hasUi = messages.length > 0;
    changeEl.disabled = running || !apiKey || !hasUi;
    changeBtn.disabled = changeEl.disabled;
  }

  // ---- applying model output, line by line -------------------------------------------------------
  function applyLine(raw) {
    const line = raw.trim();
    if (!line || line.startsWith('```')) return;
    if (!line.startsWith('{')) { log('note', `· ${line}`); return; } // stray prose: ignored
    let op;
    try { op = JSON.parse(line); } catch { log('rej', `✗ not JSON: ${line}`); return; }
    const errs = validate(op);
    if (errs.length) { log('rej', `✗ ${errs.slice(0, 2).join('; ')} · ${line}`); return; }
    if (op.op === 'download') { log('rej', '✗ download ops are not allowed here'); return; }
    const msg = { ...op, seq: ++seq };
    opCount++;
    count.textContent = `${opCount} ops`;
    log('in', `← ${JSON.stringify(msg)}`);
    ui.apply(msg);
  }

  // One model turn: stream a chat completion and apply each complete line as it arrives.
  async function turn(userContent, label) {
    if (!apiKey) { setState('Sign in or paste an OpenRouter key first.'); return; }
    messages.push({ role: 'user', content: userContent });
    controller = new AbortController();
    updateButtons();
    setState(label, true);
    let text = '', pending = '', usage = null;
    const started = performance.now();
    try {
      const r = await fetch(`${OR}/api/v1/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://xul-j.github.io/',
          'X-Title': 'XUL-J Generator',
        },
        body: JSON.stringify({
          model: modelEl.value,
          stream: true,
          temperature: 0.4,
          usage: { include: true },
          messages: [{ role: 'system', content: SYSTEM }, ...messages],
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        const why = body.error?.message || `HTTP ${r.status}`;
        if (r.status === 401) { apiKey = null; store.del('xulj-or-key'); renderAuth(); throw new Error(`the key was rejected (${why}). Sign in again.`); }
        if (r.status === 402) throw new Error(`not enough OpenRouter credits (${why}).`);
        throw new Error(why);
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let sse = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        sse += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = sse.indexOf('\n')) >= 0) {
          const ev = sse.slice(0, nl).trim();
          sse = sse.slice(nl + 1);
          if (!ev.startsWith('data:')) continue; // ": OPENROUTER PROCESSING" keep-alives
          const data = ev.slice(5).trim();
          if (data === '[DONE]') continue;
          let chunk;
          try { chunk = JSON.parse(data); } catch { continue; }
          if (chunk.error) throw new Error(chunk.error.message || 'stream error');
          if (chunk.usage) usage = chunk.usage;
          const delta = chunk.choices?.[0]?.delta?.content || '';
          if (!delta) continue;
          text += delta;
          pending += delta;
          let cut;
          while ((cut = pending.indexOf('\n')) >= 0) {
            applyLine(pending.slice(0, cut));
            pending = pending.slice(cut + 1);
          }
        }
      }
      applyLine(pending);
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      const cost = usage && typeof usage.cost === 'number' ? ` · $${usage.cost.toFixed(4)}` : '';
      const toks = usage ? ` · ${usage.completion_tokens ?? '?'} tokens out` : '';
      setState(`Done in ${secs}s${toks}${cost}.`);
    } catch (e) {
      applyLine(pending);
      setState(e.name === 'AbortError' ? 'Stopped.' : `Error: ${e.message}`);
      log('rej', `✗ ${e.message}`);
    } finally {
      // Keep what was produced, so the model knows what the user is looking at.
      messages.push({ role: 'assistant', content: text || '{"op":"notify","message":"(no output)"}' });
      controller = null;
      updateButtons();
    }
  }

  const enqueue = (fn) => { queue = queue.then(fn, fn); return queue; };

  // ---- intents: typing is buffered locally, actions go to the model ----------------------------
  function onIntent(intent) {
    log('out', `→ ${JSON.stringify(intent)}`);
    if (intent.op === 'input') { pendingInputs[intent.id] = intent.value; return; }
    if (intent.op !== 'do') return;
    const action = { do: intent.command, inputs: pendingInputs };
    pendingInputs = {};
    enqueue(() => turn(JSON.stringify(action), `The model is handling ${intent.command}…`));
  }

  goBtn.addEventListener('click', () => {
    const p = promptEl.value.trim();
    if (!p) { promptEl.focus(); return setState('Describe the interface first.'); }
    messages = [];
    pendingInputs = {};
    seq = 0;
    opCount = 0;
    ui.apply({ op: 'reset' });
    wireLog.replaceChildren();
    enqueue(() => turn(`Build this interface: ${p}`, 'Generating…'));
  });
  stopBtn.addEventListener('click', () => controller && controller.abort());
  $('refine').addEventListener('submit', (e) => {
    e.preventDefault();
    const c = changeEl.value.trim();
    if (!c) return;
    changeEl.value = '';
    enqueue(() => turn(`Change request: ${c}`, 'Applying your change…'));
  });
  promptEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) goBtn.click(); });
  $('wire-toggle').addEventListener('click', (e) => {
    wire.hidden = !wire.hidden;
    e.target.textContent = wire.hidden ? 'Show wire' : 'Hide wire';
  });
  if (window.matchMedia && window.matchMedia('(max-width: 700px)').matches) {
    wire.hidden = true;
    $('wire-toggle').textContent = 'Show wire';
  }
  for (const ex of EXAMPLES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = ex.split(':')[0];
    b.title = ex;
    b.addEventListener('click', () => { promptEl.value = ex; promptEl.focus(); });
    $('examples').append(b);
  }

  (async () => {
    renderAuth();
    try {
      const schema = await (await fetch('assets/schema.json')).json();
      validate = makeXulJValidator(schema);
    } catch (e) {
      setState(`Could not load the protocol schema (${e.message}); lines will not be validated.`);
    }
    await finishLogin();
    await loadModels();
    if (!stateEl.textContent) setState(apiKey ? 'Ready.' : 'Sign in with OpenRouter, or paste a key, to start.');
  })();

  // Exposed for tests.
  window.__xuljGenerator = { ui, get messages() { return messages; }, applyLine };
})();
