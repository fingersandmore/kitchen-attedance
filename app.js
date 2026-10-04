/*
 * Fingers & More - Kitchen Attendance scanner (tablet KITCHEN-01)
 * --------------------------------------------------------------------------
 * Static page (GitHub Pages, HTTPS). It only:
 *   1. reads a QR card with the tablet camera,
 *   2. sends the token to the Attendance App (Google Apps Script doPost),
 *   3. shows exactly what the server answered, beeps, and returns to READY.
 * It never writes to the Google Sheet and never decides Clock In / Clock Out:
 * the server does. "Success" is shown ONLY after the server confirms it.
 *
 * The web-app URL, tablet key and Terminal ID are NOT in this file (the code is
 * public). They are stored on the tablet once, by scanning the "Tablet setup"
 * code shown to managers in Google Sheets > Attendance System > Kitchen QR Management.
 */
(function () {
  'use strict';

  var STORE = 'fmKitchenScanner.v1';
  var CARD_RE = /^FMK-[0-9A-F]{32}$/;
  var SETUP_PREFIX = 'FMKSETUP:';
  var SAME_CARD_IGNORE_MS = 10000;      // client-side: the same card is ignored for 10 s
  var REQUEST_TIMEOUT_MS = 30000;
  var SHOW_OK_MS = 3000, SHOW_BAD_MS = 5000;
  var PING_EVERY_MS = 5 * 60 * 1000;
  var SCAN_EVERY_MS = 140;

  var $ = function (id) { return document.getElementById(id); };
  var cfg = load();
  var stream = null, detector = null, busy = false, lastText = '', lastTextAt = 0, scanTimer = null, resultTimer = null;
  var online = true, audioCtx = null, wakeLock = null, canvas = document.createElement('canvas');
  var ctx2d = canvas.getContext('2d', { willReadFrequently: true });

  /* ------------------------------ storage ------------------------------ */
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; }
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(cfg)); } catch (e) { /* private mode: works until reload */ }
  }
  function configured() { return !!(cfg.url && cfg.key && cfg.terminal); }

  /* ------------------------------ UI bits ------------------------------ */
  function setStatus(text, mode) {
    $('statusText').textContent = text;
    $('status').className = 'status' + (mode ? ' ' + mode : '');
  }
  function readyStatus() {
    if (!$('camerr').classList.contains('hidden')) setStatus('CAMERA PROBLEM', 'off');
    else if (!configured()) setStatus('TABLET NOT SET UP – SCAN SETUP CODE', 'off');
    else if (!online) setStatus('NO INTERNET – CHECK WI-FI', 'off');
    else setStatus('READY FOR SCAN');
  }
  function tick() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    $('clock').textContent = p(d.getHours()) + ':' + p(d.getMinutes());
    $('date').textContent = p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear();
    // fresh page every night at 03:00 (only while idle)
    if (d.getHours() === 3 && d.getMinutes() === 0 && !busy && Date.now() - performance.timeOrigin > 3600000) location.reload();
  }
  function showTerminal() { $('terminalLabel').textContent = configured() ? cfg.terminal + ' · ' + (cfg.urlLabel || '') : 'NOT SET UP'; }

  /**
   * kind: ok | out | warn | bad | busy.  Returns to READY automatically.
   */
  function showResult(kind, o) {
    clearTimeout(resultTimer);
    var r = $('result');
    r.className = kind;
    $('rIcon').className = 'ricon';
    $('rIcon').innerHTML = kind === 'busy' ? '' : (kind === 'ok' || kind === 'out' ? '&#10003;' : (kind === 'warn' ? '!' : '&#10005;'));
    if (kind === 'busy') $('rIcon').className = 'spinner';
    $('rTitle').textContent = o.title || '';
    $('rName').textContent = o.name || '';
    $('rName').classList.toggle('hidden', !o.name);
    $('rRole').textContent = o.role || '';
    $('rRole').parentNode.classList.toggle('hidden', !o.role);
    $('rWhen').innerHTML = o.time ? '<span>' + esc(o.date || '') + '</span><b>' + esc(o.time) + '</b>' : '';
    $('rMsg').textContent = o.message || '';
    if (kind !== 'busy') {
      resultTimer = setTimeout(hideResult, kind === 'ok' || kind === 'out' ? SHOW_OK_MS : SHOW_BAD_MS);
    }
  }
  function hideResult() {
    clearTimeout(resultTimer);
    $('result').className = 'hidden';
    busy = false;
    readyStatus();
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* ------------------------------ sound ------------------------------ */
  function beep(kind) {
    try {
      if (!audioCtx) return;
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var seq = kind === 'ok' ? [[880, 0, .12], [1320, .13, .16]] : (kind === 'warn' ? [[660, 0, .22]] : [[220, 0, .25], [180, .3, .35]]);
      seq.forEach(function (s) {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = kind === 'bad' ? 'square' : 'sine';
        o.frequency.value = s[0];
        var t = audioCtx.currentTime + s[1];
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(kind === 'bad' ? 0.25 : 0.5, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + s[2]);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t); o.stop(t + s[2] + 0.02);
      });
    } catch (e) { /* sound is a nice-to-have */ }
  }

  /* ------------------------------ camera ------------------------------ */
  function camError(title, text) {
    $('camerrTitle').textContent = title;
    $('camerrText').textContent = text;
    $('camerr').classList.remove('hidden');
    $('scanline').classList.add('hidden');
    setStatus('CAMERA PROBLEM', 'off');
  }

  function startCamera() {
    stopCamera();
    $('camerr').classList.add('hidden');
    $('scanline').classList.remove('hidden');
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      camError('CAMERA NOT AVAILABLE', 'This page must be opened over https:// in Chrome. Please open the GitHub Pages address.');
      return Promise.resolve();
    }
    setStatus('STARTING CAMERA…', 'busy');
    var video = cfg.deviceId ? { deviceId: { exact: cfg.deviceId } } : { facingMode: cfg.facing || 'user' };
    video.width = { ideal: 1920 }; video.height = { ideal: 1080 };
    return navigator.mediaDevices.getUserMedia({ video: video, audio: false }).then(function (s) {
      stream = s;
      var v = $('video');
      v.srcObject = s;
      var track = s.getVideoTracks()[0];
      var settings = track && track.getSettings ? track.getSettings() : {};
      $('viewer').classList.toggle('mirror', settings.facingMode ? settings.facingMode === 'user' : (cfg.facing || 'user') === 'user');
      track.addEventListener('ended', function () { setTimeout(startCamera, 1500); });   // camera dropped: recover
      try {   // sharp picture: continuous auto-focus where the tablet supports it
        var caps = track.getCapabilities ? track.getCapabilities() : {};
        if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
      } catch (e) { /* optional */ }
      return v.play().catch(function () { /* autoplay muted is allowed */ });
    }).then(function () {
      if (!stream) return;
      readyStatus();
      loopScan();
      fillCameraList();
    }).catch(function (err) {
      var name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        camError('CAMERA ACCESS DENIED', 'Allow the camera for this page: tap the lock icon next to the address › Permissions › Camera › Allow. Then tap TRY AGAIN.');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        if (cfg.deviceId) { cfg.deviceId = ''; save(); return startCamera(); }
        camError('NO CAMERA FOUND', 'This device has no usable camera.');
      } else if (name === 'NotReadableError') {
        camError('CAMERA IS BUSY', 'Another app is using the camera. Close it and tap TRY AGAIN.');
      } else {
        // Some browsers report a blocked camera with another error name: ask the permission state.
        var msg = String(err && err.message || err);
        var perm = navigator.permissions && navigator.permissions.query ? navigator.permissions.query({ name: 'camera' }) : Promise.reject();
        return perm.then(function (p) {
          if (p.state === 'denied') camError('CAMERA ACCESS DENIED', 'Allow the camera for this page: tap the lock icon next to the address › Permissions › Camera › Allow. Then tap TRY AGAIN.');
          else camError('CAMERA NOT AVAILABLE', msg);
        }, function () { camError('CAMERA NOT AVAILABLE', msg); });
      }
    });
  }

  function stopCamera() {
    clearTimeout(scanTimer);
    if (stream) stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    stream = null;
  }

  function fillCameraList() {
    if (!navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (list) {
      var cams = list.filter(function (d) { return d.kind === 'videoinput'; });
      var sel = $('camSelect');
      sel.innerHTML = '';
      [['', 'Front camera (default)', 'user'], ['', 'Back camera', 'environment']].forEach(function (o) {
        var opt = document.createElement('option'); opt.value = 'facing:' + o[2]; opt.textContent = o[1]; sel.appendChild(opt);
      });
      cams.forEach(function (c, i) {
        var opt = document.createElement('option'); opt.value = 'id:' + c.deviceId; opt.textContent = c.label || ('Camera ' + (i + 1)); sel.appendChild(opt);
      });
      sel.value = cfg.deviceId ? 'id:' + cfg.deviceId : 'facing:' + (cfg.facing || 'user');
    }).catch(function () {});
  }

  /* ------------------------------ decoding ------------------------------ */
  function initDetector() {
    if (!('BarcodeDetector' in window)) return Promise.resolve(null);
    try {
      return window.BarcodeDetector.getSupportedFormats().then(function (f) {
        return f.indexOf('qr_code') >= 0 ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
      }).catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  function loopScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(function () {
      if (!stream) return;
      var v = $('video');
      if (busy || v.readyState < 2 || !v.videoWidth) return loopScan();
      decodeFrame(v).then(function (text) {
        if (text) onCode(text);
        loopScan();
      }, function () { loopScan(); });
    }, SCAN_EVERY_MS);
  }

  var frameNo = 0;
  function decodeFrame(v) {
    frameNo++;
    // built-in reader on 2 of 3 frames, jsQR on every 3rd frame (some tablets' built-in reader misses printed cards)
    if (detector && frameNo % 3 !== 0) {
      return detector.detect(v).then(function (codes) { return codes && codes.length ? codes[0].rawValue : ''; })
        .catch(function () { detector = null; return ''; });   // fall back to jsQR
    }
    var big = frameNo % 2 === 0;   // alternate: fast (720) / sharp (1280) for small or far codes
    var scale = Math.min(1, (big ? 1280 : 720) / Math.max(v.videoWidth, v.videoHeight));
    var w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx2d.drawImage(v, 0, 0, w, h);
    var img = ctx2d.getImageData(0, 0, w, h);
    var res = window.jsQR ? window.jsQR(img.data, w, h, { inversionAttempts: big ? 'attemptBoth' : 'dontInvert' }) : null;
    return Promise.resolve(res ? res.data : '');
  }

  /* ------------------------------ a code was read ------------------------------ */
  function onCode(raw) {
    var text = String(raw || '').trim();
    if (!text || busy) return;
    var now = Date.now();
    if (text === lastText && now - lastTextAt < SAME_CARD_IGNORE_MS) return;   // same card still in front of the camera
    lastText = text; lastTextAt = now;

    if (text.indexOf(SETUP_PREFIX) === 0) return applySetup(text, true);

    busy = true;
    var token = text.toUpperCase();
    if (!CARD_RE.test(token)) {
      beep('bad');
      return showResult('bad', { title: 'INVALID EMPLOYEE CARD', message: 'This QR Code is not registered.\nPlease contact your manager.' });
    }
    if (!configured()) {
      beep('bad');
      return showResult('bad', { title: 'TABLET NOT SET UP', message: 'Please ask your manager to set up this tablet\n(Kitchen QR Management › Tablet setup).' });
    }
    if (navigator.onLine === false) {
      beep('bad');
      return showResult('bad', { title: 'NOT RECORDED', message: 'No internet connection.\nCheck the Wi-Fi, then scan your card again.' });
    }
    showResult('busy', { title: 'CHECKING…', message: 'Please wait' });
    setStatus('CHECKING…', 'busy');
    callServer({ action: 'scan', token: token }).then(function (res) {
      online = true;
      if (res && res.ok) {
        var kind = res.result === 'CLOCK_IN' ? 'ok' : (res.result === 'CLOCK_OUT' ? 'out' : 'warn');
        beep(kind === 'warn' ? 'warn' : 'ok');
        showResult(kind, { title: (kind === 'warn' ? '' : '✓ ') + res.title, name: res.name, role: res.role, date: res.date, time: res.time,
          message: kind === 'warn' ? res.message : (res.result === 'CLOCK_OUT' && res.totalHours ? 'In ' + res.timeIn + '  ·  ' + res.totalHours + ' h' : '') });
      } else {
        beep('bad');
        showResult('bad', { title: (res && res.title) || 'NOT RECORDED', name: res && res.name, role: res && res.role,
          message: (res && res.message) || 'Please scan your card again.' });
      }
    }, function (err) {
      if (err !== 'timeout') online = false;
      beep('bad');
      showResult('bad', { title: 'NOT RECORDED',
        message: err === 'timeout' ? 'No answer from the server.\nPlease scan your card again.' : 'No connection to the server.\nCheck the Wi-Fi, then scan your card again.' });
    });
  }

  /** POST to Apps Script. text/plain = no CORS pre-flight. Rejects with 'timeout' | 'offline' | 'bad-response'. */
  function callServer(body) {
    body.terminal = cfg.terminal;
    body.key = cfg.key;
    return new Promise(function (resolve, reject) {
      var done = false;
      var ctl = window.AbortController ? new AbortController() : null;
      var timer = setTimeout(function () { if (!done) { done = true; if (ctl) ctl.abort(); reject('timeout'); } }, REQUEST_TIMEOUT_MS);
      fetch(cfg.url, {
        method: 'POST', redirect: 'follow', cache: 'no-store', credentials: 'omit',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        signal: ctl ? ctl.signal : undefined
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (json) {
        if (done) return; done = true; clearTimeout(timer); resolve(json);
      }).catch(function (e) {
        if (done) return; done = true; clearTimeout(timer);
        reject(e && /HTTP|JSON|Unexpected/.test(String(e.message)) ? 'bad-response' : 'offline');
      });
    });
  }

  function ping(showMsg) {
    if (!configured()) { readyStatus(); return Promise.resolve(false); }
    return callServer({ action: 'ping' }).then(function (res) {
      online = true;
      if (!busy) readyStatus();
      if (showMsg) $('settingsMsg').textContent = res && res.ok ? 'Connected ✓  (' + (res.company || '') + ', server time ' + (res.serverTime || '') + ')' : 'Refused: ' + ((res && res.title) || 'unknown');
      return !!(res && res.ok);
    }, function (err) {
      online = false;
      if (!busy) readyStatus();
      if (showMsg) $('settingsMsg').textContent = 'No connection (' + err + ')';
      return false;
    });
  }

  /* ------------------------------ setup ------------------------------ */
  function applySetup(text, fromCamera) {
    var data = null;
    try { data = JSON.parse(text.slice(SETUP_PREFIX.length)); } catch (e) { data = null; }
    var okUrl = data && /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_\-]+\/exec$/.test(String(data.url || ''));
    var okKey = data && /^[a-f0-9]{64}$/.test(String(data.key || ''));
    if (!okUrl || !okKey || !data.terminal) {
      busy = true; beep('bad');
      showResult('bad', { title: 'SETUP CODE NOT VALID', message: okKey && !okUrl ? 'The web app address must end in /exec.\nCheck SETTINGS "Kitchen QR Web App URL".' : 'Please show the code from\nKitchen QR Management › Tablet setup.' });
      return false;
    }
    cfg.url = data.url; cfg.key = data.key; cfg.terminal = String(data.terminal).toUpperCase();
    cfg.urlLabel = data.url.replace(/^https:\/\/script\.google\.com\/macros\/s\//, '').slice(0, 8) + '…';
    save(); showTerminal();
    if (fromCamera) {
      busy = true;
      showResult('busy', { title: 'TESTING CONNECTION…' });
      ping(false).then(function (ok) {
        beep(ok ? 'ok' : 'bad');
        showResult(ok ? 'ok' : 'bad', ok ? { title: '✓ TABLET SET UP', role: cfg.terminal, message: 'Ready for Kitchen attendance.' }
          : { title: 'SAVED – BUT NO CONNECTION', message: 'Check the Wi-Fi and the web app deployment\n(Who has access: Anyone).' });
      });
    }
    return true;
  }

  /* ------------------------------ wake lock / visibility ------------------------------ */
  function keepAwake() {
    if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (l) {
      wakeLock = l;
      l.addEventListener('release', function () { wakeLock = null; setTimeout(keepAwake, 1000); });   // [24/7] take it back
    }).catch(function () { wakeLock = null; });
  }
  function enableSound() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { audioCtx = null; }
  }
  function begin() {   // switches the scanner on (START button, or automatically when the camera is already allowed)
    enableSound();
    keepAwake();
    $('start').classList.add('hidden');
    initDetector().then(function (d) { detector = d; return startCamera(); }).then(function () { ping(false); });
  }
  // [24/7] watchdog: every 30 s make sure the camera, the scan loop and the screen lock are still alive
  setInterval(function () {
    if (!$('start').classList.contains('hidden') || document.visibilityState !== 'visible') return;
    keepAwake();
    var tr = stream && stream.getVideoTracks()[0];
    if (!busy && (!tr || tr.readyState !== 'live') && $('camerr').classList.contains('hidden')) startCamera();
  }, 30000);
  // any touch re-enables the beep if the browser paused the sound
  document.addEventListener('pointerdown', function () { if ($('start').classList.contains('hidden')) enableSound(); }, true);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      keepAwake();
      if (!stream && $('start').classList.contains('hidden')) startCamera();   // came back after the screen was off
    }
  });
  window.addEventListener('online', function () { ping(false); });
  window.addEventListener('offline', function () { online = false; if (!busy) readyStatus(); });

  /* ------------------------------ wiring ------------------------------ */
  $('btnStart').addEventListener('click', begin);
  $('btnRetryCam').addEventListener('click', function () { startCamera(); });
  $('result').addEventListener('click', function () { if ($('result').className !== 'busy') hideResult(); });
  $('btnGear').addEventListener('click', function () {
    $('cfgView').innerHTML = configured()
      ? '<b>Terminal</b> ' + esc(cfg.terminal) + '<br><b>Web app</b> ' + esc(cfg.url) + '<br><b>Decoder</b> ' + (detector ? 'Built-in (BarcodeDetector)' : 'jsQR')
      : '<b>Not set up.</b> Scan the Tablet setup code.';
    $('settingsMsg').textContent = '';
    $('settings').classList.remove('hidden');
  });
  $('btnClose').addEventListener('click', function () { $('settings').classList.add('hidden'); });
  $('btnTest').addEventListener('click', function () { $('settingsMsg').textContent = 'Testing…'; ping(true); });
  $('btnFull').addEventListener('click', function () {
    var el = document.documentElement;
    (el.requestFullscreen ? el.requestFullscreen() : Promise.resolve()).catch(function () {});
  });
  $('btnSaveSetup').addEventListener('click', function () {
    var t = $('setupText').value.trim();
    if (applySetup(t, false)) { $('settingsMsg').textContent = 'Saved. Testing…'; ping(true); hideResult(); }
    else { hideResult(); $('settingsMsg').textContent = 'That is not a valid setup text.'; }
  });
  $('btnForget').addEventListener('click', function () {
    if (!confirm('Remove the setup from this tablet?')) return;
    cfg = { facing: cfg.facing, deviceId: cfg.deviceId }; save(); showTerminal(); readyStatus();
    $('settingsMsg').textContent = 'Setup removed.';
  });
  $('camSelect').addEventListener('change', function () {
    var v = this.value;
    if (v.indexOf('id:') === 0) { cfg.deviceId = v.slice(3); }
    else { cfg.deviceId = ''; cfg.facing = v.slice(7); }
    save(); startCamera();
  });

  tick(); setInterval(tick, 10000);
  // [24/7] after a restart / the nightly refresh: start by itself when the camera was already allowed (no START tap)
  try {
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'camera' }).then(function (p) { if (p.state === 'granted' && !$('start').classList.contains('hidden')) begin(); }, function () {});
    }
  } catch (e) { /* START button stays */ }
  setInterval(function () { if (!busy) ping(false); }, PING_EVERY_MS);
  showTerminal();
  readyStatus();
})();
