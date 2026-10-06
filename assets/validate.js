// Minimal JSON Schema subset validator (const, enum, type, required, properties,
// additionalProperties, items, minimum, maximum, pattern, $ref, allOf, oneOf).
// oneOf branches are pre-filtered on the `op` const, so errors point at the right branch.
(function (root) {
'use strict';

function makeValidator(schema) {
  function resolve(ref) {
    return ref.replace(/^#\//, '').split('/').reduce((o, k) => o[k], schema);
  }

  function typeOf(v) {
    if (Array.isArray(v)) return 'array';
    if (v === null) return 'null';
    if (typeof v === 'number' && Number.isInteger(v)) return 'integer';
    return typeof v;
  }

  function check(s, v, path, errs) {
    if (s.$ref) return check(resolve(s.$ref), v, path, errs);
    if ('const' in s && v !== s.const) errs.push(`${path}: expected ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.includes(v)) errs.push(`${path}: ${JSON.stringify(v)} not in [${s.enum.join(', ')}]`);
    if (s.type) {
      const t = typeOf(v);
      const ok = s.type === t || (s.type === 'number' && t === 'integer');
      if (!ok) { errs.push(`${path}: expected ${s.type}, got ${t}`); return; }
    }
    if (typeof v === 'number' && 'minimum' in s && v < s.minimum) errs.push(`${path}: below ${s.minimum}`);
    if (typeof v === 'number' && 'maximum' in s && v > s.maximum) errs.push(`${path}: above ${s.maximum}`);
    if (typeof v === 'string' && s.pattern && !new RegExp(s.pattern).test(v)) errs.push(`${path}: does not match ${s.pattern}`);
    if (s.allOf) s.allOf.forEach((sub) => check(sub, v, path, errs));
    if (s.oneOf) {
      let branches = s.oneOf;
      if (v && typeof v.op === 'string') {
        branches = branches.filter((b) => (b.$ref ? resolve(b.$ref) : b).properties?.op?.const === v.op);
        if (!branches.length) { errs.push(`${path}.op: unknown op ${JSON.stringify(v.op)}`); return; }
      }
      const results = branches.map((b) => { const e = []; check(b, v, path, e); return e; });
      const passing = results.filter((e) => !e.length).length;
      if (passing !== 1) errs.push(...(results.length === 1 ? results[0] : [`${path}: matches ${passing} of oneOf`]));
    }
    if (typeOf(v) === 'object') {
      (s.required || []).forEach((k) => { if (!(k in v)) errs.push(`${path}: missing "${k}"`); });
      for (const [k, val] of Object.entries(v)) {
        if (s.properties && k in s.properties) check(s.properties[k], val, `${path}.${k}`, errs);
        else if (typeof s.additionalProperties === 'object') check(s.additionalProperties, val, `${path}.${k}`, errs);
        else if (s.additionalProperties === false) errs.push(`${path}: unexpected "${k}"`);
      }
    }
    if (Array.isArray(v) && s.items) v.forEach((item, i) => check(s.items, item, `${path}[${i}]`, errs));
  }

  return function validate(op) {
    const errs = [];
    check(schema, op, '$', errs);
    return errs;
  };
}

if (typeof module === 'object' && module.exports) {
  const schema = require('./schema.json');
  module.exports = { validate: makeValidator(schema), makeValidator, schema };
} else {
  root.makeXulJValidator = makeValidator;
}
})(this);
