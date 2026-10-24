/* sync.js — синхронізація прогресу (tp_v2_*) через Telegram CloudStorage.
 *
 * Підключення (на КОЖНІЙ сторінці бота, після telegram-web-app.js):
 *   <script src="https://telegram.org/js/telegram-web-app.js"></script>
 *   <script src="sync.js"></script>
 *
 * Як це працює:
 *  - при відкритті сторінки підтягує дані з хмари Telegram і зливає їх з локальними;
 *  - кожні 4 секунди та при закритті/згортанні відправляє зміни в хмару;
 *  - тренажерам нічого міняти не треба: вони й далі пишуть у localStorage.
 *
 * API:
 *   TPSync.ready   — Promise, виконується після першої синхронізації (або через 6 с)
 *   TPSync.sync()  — примусова синхронізація
 *   TPSync.reset() — очистити прогрес і локально, і в хмарі (на всіх пристроях)
 *   TPSync.status  — 'off' | 'syncing' | 'ok' | 'error'
 *   події window: 'tpsync:status' (detail = статус), 'tpsync:updated' (дані оновилися)
 */
(function () {
  'use strict';

  var PREFIX = 'tp_v2_';
  var PROFILE_KEY = PREFIX + 'profile';     // локальний знімок, не синхронізується
  var ACTIVITY_KEY = PREFIX + 'activity';   // XP по днях, зливається по максимуму
  var LOCAL_ONLY = [PROFILE_KEY];
  var META_KEY = 'tp_meta';                 // у хмарі: { resetAt }
  var RESET_LOCAL = 'tpsync_resetAt';       // у localStorage, поза префіксом
  var CHUNK = 3500;                         // ліміт значення в CloudStorage — 4096 символів
  var PUSH_EVERY = 4000;
  var READY_TIMEOUT = 6000;

  var tg = window.Telegram && window.Telegram.WebApp;
  var cs = tg && tg.CloudStorage;
  var supported = !!(cs && tg.initData && typeof tg.isVersionAtLeast === 'function' && tg.isVersionAtLeast('6.9'));

  var cloud = {};        // що, як ми знаємо, зараз лежить у хмарі: { key: {str, n} }
  var pulled = false;
  var pulling = false;
  var pushing = false;
  var again = false;
  var locked = false;

  var api = { supported: supported, status: supported ? 'syncing' : 'off' };
  window.TPSync = api;

  function setStatus(s) {
    api.status = s;
    window.dispatchEvent(new CustomEvent('tpsync:status', { detail: s }));
  }

  function notifyUpdated() {
    window.dispatchEvent(new CustomEvent('tpsync:updated'));
  }

  function parse(str) {
    try {
      var o = JSON.parse(str);
      return (o && typeof o === 'object') ? o : null;
    } catch (e) {
      return null;
    }
  }

  function call(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve, reject) {
      try {
        args.push(function (err, res) {
          if (err) reject(new Error(String(err)));
          else resolve(res);
        });
        cs[method].apply(cs, args);
      } catch (e) {
        reject(e);
      }
    });
  }

  function syncKeys() {
    var out = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(PREFIX) === 0 && LOCAL_ONLY.indexOf(k) === -1) out.push(k);
    }
    return out;
  }

  function totalXP() {
    var sum = 0;
    syncKeys().forEach(function (k) {
      if (k === ACTIVITY_KEY) return;
      var o = parse(localStorage.getItem(k));
      sum += (o && Number(o.x)) || 0;
    });
    return sum;
  }

  // Як зливаємо дві версії одного ключа
  function mergeValue(key, localStr, remoteStr) {
    if (remoteStr == null || remoteStr === '') return localStr;
    if (localStr == null) return remoteStr;
    if (localStr === remoteStr) return localStr;
    var l = parse(localStr), r = parse(remoteStr);
    if (!l || !r) return localStr;

    if (key === ACTIVITY_KEY) {
      var out = {};
      Object.keys(l).forEach(function (d) { out[d] = Number(l[d]) || 0; });
      Object.keys(r).forEach(function (d) { out[d] = Math.max(out[d] || 0, Number(r[d]) || 0); });
      return JSON.stringify(out);
    }
    // Тренажери: перемагає версія з більшим XP, при рівності — локальна
    return (Number(r.x) || 0) > (Number(l.x) || 0) ? remoteStr : localStr;
  }

  function splitChunks(str) {
    var chunks = [];
    var i = 0;
    while (i < str.length) {
      var e = Math.min(i + CHUNK, str.length);
      var c = str.charCodeAt(e - 1);
      if (e < str.length && c >= 0xD800 && c <= 0xDBFF) e--; // не розрізаємо сурогатні пари
      chunks.push(str.slice(i, e));
      i = e;
    }
    if (!chunks.length) chunks.push('');
    return chunks;
  }

  // Читає значення ключів з хмари (кожен ключ збережений шматками key__0, key__1... + key__n)
  async function readRemote(keys) {
    var result = {};
    if (!keys.length) return result;

    var counts = await call('getItems', keys.map(function (k) { return k + '__n'; }));
    var plan = {};
    var chunkKeys = [];
    keys.forEach(function (k) {
      var n = parseInt(counts[k + '__n'], 10);
      if (n > 0) {
        plan[k] = n;
        for (var i = 0; i < n; i++) chunkKeys.push(k + '__' + i);
      }
    });

    var chunks = chunkKeys.length ? await call('getItems', chunkKeys) : {};
    keys.forEach(function (k) {
      if (!plan[k]) { result[k] = null; return; }
      var s = '';
      for (var i = 0; i < plan[k]; i++) s += chunks[k + '__' + i] || '';
      result[k] = { str: s, n: plan[k] };
    });
    return result;
  }

  async function writeRemote(key, str, prevN) {
    var chunks = splitChunks(str);
    await Promise.all(chunks.map(function (c, i) { return call('setItem', key + '__' + i, c); }));
    await call('setItem', key + '__n', String(chunks.length)); // лічильник — останнім
    if (prevN > chunks.length) {
      var old = [];
      for (var i = chunks.length; i < prevN; i++) old.push(key + '__' + i);
      await call('removeItems', old);
    }
    cloud[key] = { str: str, n: chunks.length };
  }

  function clearLocal() {
    Object.keys(localStorage)
      .filter(function (k) { return k.indexOf(PREFIX) === 0; })
      .forEach(function (k) { localStorage.removeItem(k); });
  }

  async function pull() {
    if (pulling) return;
    pulling = true;
    try {
      setStatus('syncing');
      var changed = false;
      var base = totalXP();

      var cloudKeys = await call('getKeys');

      // Чи робили скидання прогресу на іншому пристрої
      var metaRaw = cloudKeys.indexOf(META_KEY) !== -1 ? await call('getItem', META_KEY) : '';
      var meta = parse(metaRaw) || {};
      var remoteReset = Number(meta.resetAt) || 0;
      var localReset = Number(localStorage.getItem(RESET_LOCAL)) || 0;
      if (remoteReset > localReset) {
        clearLocal();
        localStorage.setItem(RESET_LOCAL, String(remoteReset));
        cloud = {};
        base = 0;
        changed = true;
      }

      var remoteKeys = cloudKeys
        .filter(function (k) { return k.indexOf(PREFIX) === 0 && k.slice(-3) === '__n'; })
        .map(function (k) { return k.slice(0, -3); })
        .filter(function (k) { return LOCAL_ONLY.indexOf(k) === -1; });

      var remote = await readRemote(remoteKeys);
      remoteKeys.forEach(function (k) {
        var r = remote[k];
        if (!r) return;
        cloud[k] = r;
        var l = localStorage.getItem(k);
        var merged = mergeValue(k, l, r.str);
        if (merged !== l) {
          localStorage.setItem(k, merged);
          changed = true;
        }
      });

      // XP, що прийшов з хмари, не повинен рахуватися як сьогоднішня активність
      var diff = totalXP() - base;
      if (diff !== 0) {
        var p = parse(localStorage.getItem(PROFILE_KEY));
        if (p && isFinite(Number(p.lastXP))) {
          p.lastXP = Math.max(0, Number(p.lastXP) + diff);
          localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
        }
      }

      pulled = true;
      if (changed) notifyUpdated();
    } finally {
      pulling = false;
    }
  }

  async function push() {
    if (!supported || !pulled || locked) return;
    if (pushing) { again = true; return; }
    pushing = true;
    var changed = false;
    try {
      do {
        again = false;
        var dirty = syncKeys().filter(function (k) {
          var s = localStorage.getItem(k);
          return s != null && (!cloud[k] || cloud[k].str !== s);
        });

        if (dirty.length) {
          setStatus('syncing');
          // Перед записом читаємо свіже значення з хмари, щоб не затерти прогрес з іншого пристрою
          var remote = await readRemote(dirty);
          for (var i = 0; i < dirty.length; i++) {
            var k = dirty[i];
            var local = localStorage.getItem(k);
            var r = remote[k];
            var merged = r ? mergeValue(k, local, r.str) : local;
            if (merged !== local) {
              localStorage.setItem(k, merged);
              changed = true;
            }
            if (!r || r.str !== merged) await writeRemote(k, merged, r ? r.n : 0);
            else cloud[k] = r;
          }
        }
      } while (again);
      setStatus('ok');
    } catch (e) {
      setStatus('error');
    } finally {
      pushing = false;
      if (changed) notifyUpdated();
    }
  }

  async function sync() {
    if (!supported) return;
    try {
      await pull();
      await push();
    } catch (e) {
      setStatus('error');
    }
  }

  async function reset() {
    locked = true;
    try {
      var now = Date.now();
      clearLocal();
      localStorage.setItem(RESET_LOCAL, String(now));
      cloud = {};
      if (supported) {
        setStatus('syncing');
        var keys = (await call('getKeys')).filter(function (k) { return k.indexOf(PREFIX) === 0; });
        if (keys.length) await call('removeItems', keys);
        await call('setItem', META_KEY, JSON.stringify({ resetAt: now }));
        pulled = true;
        setStatus('ok');
      }
    } catch (e) {
      setStatus('error');
    } finally {
      locked = false;
    }
  }

  function tick() {
    if (!supported) return;
    if (!pulled) sync();
    else push();
  }

  api.sync = sync;
  api.push = push;
  api.reset = reset;

  var firstSync = supported ? sync() : Promise.resolve();
  api.ready = Promise.race([
    firstSync.catch(function () {}),
    new Promise(function (resolve) { setTimeout(resolve, READY_TIMEOUT); })
  ]);

  if (supported) {
    setInterval(tick, PUSH_EVERY);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) push();
    });
    window.addEventListener('pagehide', function () { push(); });
  }
})();
