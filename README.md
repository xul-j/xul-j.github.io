# xul-j.github.io

The project site for [XUL-J](https://github.com/xul-j/xul-j): <https://xul-j.github.io/>.

A static page with no build step. `demo.html` runs the real XUL-J renderer; `assets/demo-app.js`
plays the server's part in the browser, so the demo works without a backend.
`assets/xulj.js` and `assets/xul.css` are copies of `public/` from
[xul-j/xul-j](https://github.com/xul-j/xul-j); refresh them when the client changes.

`generate.html` is the LLM generator: bring your own OpenRouter key (OAuth PKCE sign-in or a
pasted key, stored only in the browser). `assets/generate.js` streams a chat completion and applies
each complete JSON line, validated with `assets/validate.js` and `assets/schema.json`, which are
also copies from the base repo.

Preview locally: `python3 -m http.server` in this folder, then open http://localhost:8000/.
