// QA-only stand-in for the extension APIs the content script uses. Served by scripts/qa/run.ts
// right after the inline QA script and before dist/content.js. run.ts prepends a small bundle
// that defines globalThis.__JEV_QA_SRC__ (keyOf, DEFAULT_SETTINGS, sigKey, providerKey, today),
// built from src/, so this shim speaks the exact storage and signalKey formats of the code under test.
//
// Query switches (all optional):
//   fail=429            classify answers { ok:false, error:"http-429" }
//   slowStorage=<ms>    every storage.local.get resolves <ms> late
//   slowStorage=hold    every storage.local.get waits for __QA_SHIM__.releaseStorage()
//   holdClassify=1      classify answers wait for __QA_SHIM__.releaseClassify()
//   ad|suggested|module=<keep|blur|hide>, siteEnabled=false   stored (non-default) settings
//   seedOverrides=<json>  pre-stored user answers for this site (src/overrides.ts), as a reload would find them
(function () {
  "use strict";
  var H = globalThis.__JEV_QA_SRC__;
  var site = globalThis.__JEV_QA_SITE__;
  if (!H || !site) throw new Error("[qa-shim] helper bundle or __JEV_QA_SITE__ missing");
  var q = new URLSearchParams(location.search);
  var CLASSIFY_DELAY = 150;
  function progress() { window.dispatchEvent(new Event("qa-progress")); }

  var settings = JSON.parse(JSON.stringify(H.DEFAULT_SETTINGS));
  ["ad", "suggested", "module"].forEach(function (c) {
    var v = q.get(c);
    if (v === "keep" || v === "blur" || v === "hide") settings.actions[c] = v;
  });
  if (q.get("siteEnabled") === "false") settings.sites[site].enabled = false;

  var store = { settings: settings };
  if (q.has("seedCache")) store[H.sigKey(site)] = JSON.parse(q.get("seedCache"));
  if (q.has("seedOverrides")) store[H.overrideKey(site)] = JSON.parse(q.get("seedOverrides"));
  var listeners = [];
  var slow = q.get("slowStorage");
  var storageHeld = slow === "hold";
  var storageWaiters = [];
  var classifyHeld = q.get("holdClassify") === "1";
  var classifyWaiters = [];

  var shim = (globalThis.__QA_SHIM__ = {
    settings: settings,
    calls: [],
    answers: [],
    storageLog: [],
    keyBroadcastAt: {},
    inflight: 0,
    snapshot: function () { return clone(store); },
    releaseStorage: function () {
      storageHeld = false;
      var w = storageWaiters.splice(0);
      for (var i = 0; i < w.length; i++) w[i]();
      return w.length;
    },
    releaseClassify: function () {
      classifyHeld = false;
      var w = classifyWaiters.splice(0);
      for (var i = 0; i < w.length; i++) w[i]();
      return w.length;
    }
  });

  function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  function pick(keys) {
    var out = {};
    if (keys === null || keys === undefined) {
      for (var k in store) out[k] = clone(store[k]);
      return out;
    }
    if (typeof keys === "string") keys = [keys];
    if (Array.isArray(keys)) {
      keys.forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = clone(store[k]);
      });
      return out;
    }
    for (var d in keys) out[d] = Object.prototype.hasOwnProperty.call(store, d) ? clone(store[d]) : keys[d];
    return out;
  }

  function delayGet() {
    if (storageHeld) return new Promise(function (r) { storageWaiters.push(r); });
    var ms = Number(slow);
    if (slow !== null && Number.isFinite(ms) && ms > 0) return new Promise(function (r) { setTimeout(r, ms); });
    return Promise.resolve();
  }

  function set(items) {
    var changes = {};
    for (var k in items) {
      changes[k] = { oldValue: clone(store[k]), newValue: clone(items[k]) };
      store[k] = clone(items[k]);
    }
    return Promise.resolve().then(function () {
      setTimeout(function () {
        for (var i = 0; i < listeners.length; i++) listeners[i](clone(changes), "local");
      }, 0);
    });
  }

  function withCallback(p, cb) {
    if (typeof cb === "function") p.then(cb);
    return p;
  }

  // The verdict follows the page, not the payload: a descriptor scores 0.9 in its data-qa-model
  // category when an element currently carrying data-qa-model has that exact signalKey.
  function modelKeys() {
    var map = {};
    var els = document.querySelectorAll("[data-qa-model]");
    for (var i = 0; i < els.length; i++) {
      map[H.keyOf(els[i], site)] = els[i].getAttribute("data-qa-model");
    }
    return map;
  }

  function classify(msg) {
    var rec = { at: performance.now(), site: msg.site, items: clone(msg.items), json: JSON.stringify(msg) };
    shim.calls.push(rec);
    shim.inflight++;
    var gate = classifyHeld ? new Promise(function (r) { classifyWaiters.push(r); }) : Promise.resolve();
    return gate
      .then(function () { return new Promise(function (r) { setTimeout(r, CLASSIFY_DELAY); }); })
      .then(function () {
        var res;
        if (q.get("fail") === "429") {
          res = { ok: false, error: "http-429" };
        } else {
          var mk = modelKeys();
          var scores = msg.items.map(function (d) {
            var cat = mk[d.key];
            return { ad: cat === "ad" ? 0.9 : 0.1, suggested: cat === "suggested" ? 0.9 : 0.1 };
          });
          res = { ok: true, scores: scores };
          var key = H.sigKey(site);
          var day = H.today();
          var pk = H.providerKey(settings);
          var cur = store[key];
          var cache = cur && cur.day === day && cur.providerKey === pk ? clone(cur) : { day: day, providerKey: pk, entries: {}, order: [] };
          msg.items.forEach(function (d, i) {
            if (!Object.prototype.hasOwnProperty.call(cache.entries, d.key)) cache.order.push(d.key);
            cache.entries[d.key] = scores[i];
          });
          var write = {};
          write[key] = cache;
          var at = performance.now();
          msg.items.forEach(function (d) { if (!(d.key in shim.keyBroadcastAt)) shim.keyBroadcastAt[d.key] = at; });
          set(write);
        }
        shim.answers.push({ at: performance.now(), res: clone(res), keys: msg.items.map(function (d) { return d.key; }) });
        shim.inflight--;
        progress();
        return res;
      });
  }

  var c = globalThis.chrome && typeof globalThis.chrome === "object" ? globalThis.chrome : {};
  c.storage = {
    local: {
      get: function (keys, cb) {
        var entry = { keys: clone(keys === undefined ? null : keys), calledAt: performance.now(), resolvedAt: -1 };
        shim.storageLog.push(entry);
        return withCallback(
          delayGet().then(function () {
            entry.resolvedAt = performance.now();
            progress();
            return pick(keys);
          }),
          cb
        );
      },
      set: function (items, cb) { return withCallback(set(items), cb); },
      remove: function (keys, cb) {
        var changes = {};
        (typeof keys === "string" ? [keys] : keys).forEach(function (k) {
          if (Object.prototype.hasOwnProperty.call(store, k)) {
            changes[k] = { oldValue: clone(store[k]) };
            delete store[k];
          }
        });
        return withCallback(Promise.resolve().then(function () {
          for (var i = 0; i < listeners.length; i++) listeners[i](clone(changes), "local");
        }), cb);
      }
    },
    onChanged: {
      addListener: function (f) { listeners.push(f); },
      removeListener: function (f) { listeners = listeners.filter(function (g) { return g !== f; }); },
      hasListener: function (f) { return listeners.indexOf(f) >= 0; }
    }
  };
  c.runtime = {
    id: "jev-declutter-qa",
    lastError: undefined,
    getURL: function (p) { return location.origin + "/" + String(p).replace(/^\//, ""); },
    sendMessage: function (msg, cb) {
      var p = msg && msg.type === "classify" ? classify(msg) : Promise.resolve({ ok: true });
      return withCallback(p, cb);
    }
  };
  globalThis.chrome = c;
})();
