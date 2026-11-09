/*
 * Rozhľad – tvorba a prezeranie 360° virtuálnych prehliadok
 * ---------------------------------------------------------
 * Celé beží v prehliadači (žiadny server, žiadna databáza).
 *   - panorámy zobrazuje knižnica Photo Sphere Viewer (vendor/)
 *   - rozpracovaná prehliadka sa ukladá do localStorage (nastavenia) a IndexedDB (nahraté fotky)
 *   - hotová prehliadka sa exportuje ako ZIP/JSON a publikuje cez GitHub Pages
 *   - prehliadku je možné chrániť PINom (šifrovanie AES-GCM, súbor pin-crypto.js)
 *
 * Štruktúra súboru:
 *   1. Konštanty a pomocné funkcie
 *   2. Vzorová prehliadka
 *   3. Úložisko (localStorage, IndexedDB)
 *   4. Model prehliadky
 *   5. Médiá (fotky, náhľady, šifrované médiá)
 *   6. Prehliadač panorám (Photo Sphere Viewer), body prechodu, smerový kruh
 *   7. Rozhranie: upozornenia, dialógy, zamykacia obrazovka
 *   8. Editor: scény, body prechodu, nastavenia, PIN
 *   9. Export a import
 *  10. Štart aplikácie
 */
(() => {
  'use strict';

  /* ===================================================================
     1. Konštanty a pomocné funkcie
     =================================================================== */
  const LS_TOUR = 'rozhlad:tour:v1';
  const LS_WELCOME = 'rozhlad:welcome:v1';
  const DB_NAME = 'rozhlad';
  const DB_STORE = 'media';
  const PUBLISHED_FILE = 'tour.json';
  const DEFAULT_ZOOM = 30; // 0–100
  const MIN_PIN = 4;

  const params = new URLSearchParams(location.search);
  const VIEWER_ONLY = params.get('mode') === 'tour'; // čistý režim pre návštevníka

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
  const wrap360 = (d) => ((d % 360) + 360) % 360;
  const round2 = (n) => Math.round(n * 100) / 100;
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const num = (v, fallback = 0) => (isNum(v) ? v : fallback);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uid = (p = 'x') => p + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 7);
  const safeId = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48);
  const cleanText = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

  const slug = (s) =>
    String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'panorama';

  /** Slovenské skloňovanie podľa počtu: 1 bod, 2–4 body, 5 bodov. */
  function plural(n, one, few, many) {
    if (n === 1) return one;
    if (n >= 2 && n <= 4) return few;
    return many;
  }

  /** Malý pomocník na skladanie DOM-u (text sa vkladá bezpečne cez textContent). */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== 'object') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(name, cls = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', ('icon ' + cls).trim());
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }

  function iconBtn(name, label, onClick, disabled = false, extra = '') {
    return h('button', { type: 'button', class: ('icon-btn ' + extra).trim(), title: label, 'aria-label': label, disabled, onclick: onClick }, icon(name));
  }

  function btn(label, iconName, onClick, extra = '') {
    return h('button', { type: 'button', class: ('btn ' + extra).trim(), onclick: onClick }, iconName ? icon(iconName) : null, label);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function sniffMime(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return 'image/webp';
    return 'image/jpeg';
  }

  /** Bezpečná relatívna cesta do ZIP-u (bez „..“ a úvodných lomiek). */
  const safePath = (p) => String(p).replace(/\\/g, '/').split('/').filter((x) => x && x !== '.' && x !== '..').join('/');

  /* ===================================================================
     2. Vzorová prehliadka (4 vygenerované miestnosti, pozri tools/generate_samples.py)
     =================================================================== */
  const SAMPLES = [
    { key: 'obyvacka', name: 'Obývačka', view: { yaw: -20, pitch: 0 } },
    { key: 'kuchyna', name: 'Kuchyňa', view: { yaw: 25, pitch: 0 } },
    { key: 'spalna', name: 'Spálňa', view: { yaw: 95, pitch: 0 } },
    { key: 'terasa', name: 'Terasa', view: { yaw: -25, pitch: 4 } },
  ].map((s) => ({ ...s, id: 's-' + s.key, file: `panoramas/${s.key}.jpg`, thumb: `panoramas/thumbs/${s.key}.jpg` }));

  // Súradnice dverí (yaw/pitch v stupňoch) – vypočítané generátorom panorám.
  const DEMO_LINKS = {
    obyvacka: [['kuchyna', -31.6, -8.4], ['spalna', 76.0, -7.8], ['terasa', 169.1, -9.6]],
    kuchyna: [['obyvacka', -164.5, -13.5]],
    spalna: [['obyvacka', -71.6, -11.5]],
    terasa: [['obyvacka', 0.0, -12.7]],
  };

  function sampleScene(s, withLinks) {
    return {
      id: s.id, name: s.name, file: s.file, thumb: s.thumb, view: { ...s.view },
      hotspots: withLinks
        ? DEMO_LINKS[s.key].map(([to, yaw, pitch]) => ({ id: `h-${s.key}-${to}`, yaw, pitch, target: 's-' + to, text: '' }))
        : [],
    };
  }

  function demoTour() {
    return { name: 'Vzorový byt', start: 's-obyvacka', pin: '', scenes: SAMPLES.map((s) => sampleScene(s, true)) };
  }

  /* ===================================================================
     3. Úložisko
     =================================================================== */
  const Store = {
    loadTour() {
      try { const raw = localStorage.getItem(LS_TOUR); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
    },
    saveTour(obj) {
      try { localStorage.setItem(LS_TOUR, JSON.stringify(obj)); return true; } catch (e) { return false; }
    },
    clearTour() { try { localStorage.removeItem(LS_TOUR); } catch (e) { /* nič */ } },
  };

  /** IndexedDB: tu sa ukladajú nahraté fotky (localStorage na ne nestačí). */
  const DB = {
    ok: true,
    _open: null,
    open() {
      if (!this._open) {
        this._open = new Promise((resolve, reject) => {
          if (!window.indexedDB) return reject(new Error('IndexedDB nie je dostupná'));
          const req = indexedDB.open(DB_NAME, 1);
          req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE, { keyPath: 'id' });
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      }
      return this._open;
    },
    async run(mode, fn) {
      try {
        const db = await this.open();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, mode);
          const req = fn(tx.objectStore(DB_STORE));
          tx.oncomplete = () => resolve(req ? req.result : undefined);
          tx.onerror = tx.onabort = () => reject(tx.error);
        });
      } catch (e) {
        this.ok = false;
        return undefined;
      }
    },
    async put(rec) { await this.run('readwrite', (s) => s.put(rec)); return this.ok; },
    async getAll() { return (await this.run('readonly', (s) => s.getAll())) || []; },
    del(id) { return this.run('readwrite', (s) => s.delete(id)); },
    clear() { return this.run('readwrite', (s) => s.clear()); },
  };

  /* ===================================================================
     4. Model prehliadky
     =================================================================== */
  const state = {
    mode: 'tour', // 'tour' | 'edit'
    tab: 'scenes', // 'scenes' | 'hotspots' | 'settings'
    currentId: null,
    selectedHotspot: null,
    placing: false,
    source: 'demo', // 'demo' | 'local' | 'published' | 'locked'
    cipher: null, // { key } – prehliadka načítaná zo zašifrovaných súborov (zatiaľ len na prezeranie)
    editingPin: false,
    showPin: false,
  };
  let tour = { name: '', start: null, pin: '', scenes: [] };

  const getScene = (id) => tour.scenes.find((s) => s.id === id) || null;
  const currentScene = () => getScene(state.currentId);

  /** Overí a vyčistí prehliadku z JSON-u (import, publikovaný súbor, lokálna kópia). */
  function normalizeTour(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.scenes)) {
      throw new Error('Súbor neobsahuje platnú prehliadku.');
    }
    const used = new Set();
    const scenes = [];
    const rawHotspots = [];
    for (const s of raw.scenes) {
      if (!s || typeof s !== 'object') continue;
      let id = safeId(s.id);
      if (!id || used.has(id)) id = uid('s');
      used.add(id);
      const view = s.view && typeof s.view === 'object' ? s.view : {};
      scenes.push({
        id,
        name: cleanText(s.name, 80) || `Scéna ${scenes.length + 1}`,
        file: typeof s.file === 'string' ? s.file : '',
        thumb: typeof s.thumb === 'string' ? s.thumb : '',
        view: {
          yaw: round2(wrap180(num(view.yaw))),
          pitch: round2(clamp(num(view.pitch), -90, 90)),
          ...(isNum(view.zoom) ? { zoom: clamp(Math.round(view.zoom), 0, 100) } : {}),
        },
        hotspots: [],
      });
      rawHotspots.push(Array.isArray(s.hotspots) ? s.hotspots : []);
    }
    const hsIds = new Set();
    scenes.forEach((scene, i) => {
      for (const hs of rawHotspots[i]) {
        if (!hs || typeof hs !== 'object') continue;
        const target = safeId(hs.target);
        if (!used.has(target) || target === scene.id) continue;
        let id = safeId(hs.id);
        if (!id || hsIds.has(id)) id = uid('h');
        hsIds.add(id);
        scene.hotspots.push({
          id,
          yaw: round2(wrap180(num(hs.yaw))),
          pitch: round2(clamp(num(hs.pitch), -90, 90)),
          target,
          text: cleanText(hs.text, 80),
        });
      }
    });
    const start = used.has(safeId(raw.start)) ? safeId(raw.start) : scenes.length ? scenes[0].id : null;
    return { name: cleanText(raw.name, 80) || 'Moja prehliadka', start, pin: '', scenes };
  }

  /** Konfigurácia prehliadky bez PINu a bez fotiek (to, čo ide do tour.json). */
  function serializeTour() {
    return {
      app: 'rozhlad',
      version: 1,
      name: tour.name,
      start: tour.start,
      scenes: tour.scenes.map((s) => ({
        id: s.id,
        name: s.name,
        file: s.file,
        thumb: s.thumb || '',
        view: { ...s.view },
        hotspots: s.hotspots.map((x) => ({ id: x.id, yaw: x.yaw, pitch: x.pitch, target: x.target, text: x.text || '' })),
      })),
    };
  }

  /* ---------- ukladanie rozpracovanej prehliadky ---------- */
  let saveTimer = null;
  function setSaveStatus(kind) {
    const el = $('#saveStatus');
    if (!el) return;
    el.dataset.state = kind;
    $('#saveStatusText').textContent =
      kind === 'saving' ? 'Ukladám…' : kind === 'error' ? 'Nepodarilo sa uložiť' : 'Uložené v tomto prehliadači';
  }
  function saveSoon() {
    if (VIEWER_ONLY) return;
    setSaveStatus('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 350);
  }
  function saveNow() {
    if (VIEWER_ONLY) return;
    clearTimeout(saveTimer);
    const ok = Store.saveTour({ ...serializeTour(), pin: tour.pin || '' });
    setSaveStatus(ok ? 'saved' : 'error');
  }

  /* ===================================================================
     5. Médiá: fotky, náhľady, šifrované súbory
     =================================================================== */
  /** sceneId -> { blob, thumbBlob, src, thumb } (src/thumb sú blob: adresy) */
  const media = new Map();

  function revokeUrl(u) { if (u && u.startsWith('blob:')) URL.revokeObjectURL(u); }
  function putMedia(id, parts) {
    const m = media.get(id) || {};
    if (parts.blob) { revokeUrl(m.src); m.blob = parts.blob; m.src = URL.createObjectURL(parts.blob); }
    if (parts.thumbBlob) { revokeUrl(m.thumb); m.thumbBlob = parts.thumbBlob; m.thumb = URL.createObjectURL(parts.thumbBlob); }
    media.set(id, m);
  }
  function dropMedia(id) {
    const m = media.get(id);
    if (m) { revokeUrl(m.src); revokeUrl(m.thumb); media.delete(id); }
  }
  const srcOf = (scene) => (media.get(scene.id) && media.get(scene.id).src) || scene.file;
  const thumbOf = (scene) => (media.get(scene.id) && media.get(scene.id).thumb) || scene.thumb || srcOf(scene);

  /** Načíta fotku, zistí rozmery a vyrobí náhľad 320×160. */
  async function analyzeImage(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = 320;
      c.height = 160;
      c.getContext('2d').drawImage(img, 0, 0, 320, 160);
      const thumbBlob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.8));
      return { width: img.naturalWidth, height: img.naturalHeight, thumbBlob };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Načíta uložené fotky z IndexedDB (len pre lokálnu rozpracovanú prehliadku). */
  async function hydrateMedia() {
    const recs = await DB.getAll();
    const ids = new Set(tour.scenes.map((s) => s.id));
    for (const r of recs) {
      if (ids.has(r.id) && r.blob) putMedia(r.id, { blob: r.blob, thumbBlob: r.thumb });
      else DB.del(r.id);
    }
  }

  async function resetStorage() {
    Store.clearTour();
    await DB.clear();
    Array.from(media.keys()).forEach(dropMedia);
  }

  /* ---------- šifrované médiá (prehliadka načítaná zo zašifrovaných súborov) ---------- */
  const encPath = (id) => `panoramas/${id}.enc`;
  const encThumbPath = (id) => `panoramas/${id}.thumb.enc`;

  async function fetchDecrypted(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const plain = await PinCrypto.decryptBytes(state.cipher.key, bytes);
    return new Blob([plain], { type: sniffMime(plain) });
  }

  async function ensureSceneMedia(scene) {
    if (!state.cipher) return;
    const m = media.get(scene.id);
    if (m && m.blob) return;
    const blob = await fetchDecrypted(encPath(scene.id));
    putMedia(scene.id, { blob });
    if (!(media.get(scene.id) || {}).thumbBlob) {
      try { putMedia(scene.id, { thumbBlob: await fetchDecrypted(encThumbPath(scene.id)) }); } catch (e) { /* náhľad nie je nutný */ }
    }
  }

  async function loadEncryptedThumbs() {
    await Promise.all(tour.scenes.map(async (s) => {
      try { putMedia(s.id, { thumbBlob: await fetchDecrypted(encThumbPath(s.id)) }); } catch (e) { /* nič */ }
    }));
  }

  /** Zmení načítanú šifrovanú prehliadku na bežný lokálny projekt (pred úpravami). */
  async function materialize() {
    if (!state.cipher) return;
    await withBusy('Pripravujem prehliadku na úpravy…', async () => {
      for (const s of tour.scenes) {
        try {
          await ensureSceneMedia(s);
          const m = media.get(s.id);
          if (m && m.blob) await DB.put({ id: s.id, blob: m.blob, thumb: m.thumbBlob });
        } catch (e) { s._error = true; }
      }
    });
    state.cipher = null;
    saveNow();
  }

  /* ===================================================================
     6. Prehliadač panorám, body prechodu, smerový kruh
     =================================================================== */
  let viewer = null;
  let markers = null;
  let autorotate = null;
  let navSeq = 0;
  let hasPanorama = false;
  const markerEls = new Map(); // hotspotId -> prvok tlačidla

  function createViewer() {
    viewer = new PSV.Viewer({
      container: $('#viewer'),
      navbar: false,
      mousewheelCtrlKey: false,
      touchmoveTwoFingers: false,
      defaultZoomLvl: DEFAULT_ZOOM,
      minFov: 30,
      maxFov: 100,
      moveInertia: true,
      loadingTxt: 'Načítavam…',
      canvasBackground: '#0f1b2d',
      lang: {
        loading: 'Načítavam…',
        loadError: 'Panorámu sa nepodarilo načítať',
        twoFingers: 'Na pohyb použite dva prsty',
        ctrlZoom: 'Na priblíženie použite Ctrl a koliesko myši',
        zoom: 'Priblíženie',
        zoomIn: 'Priblížiť',
        zoomOut: 'Oddialiť',
        fullscreen: 'Celá obrazovka',
        close: 'Zavrieť',
      },
      plugins: [
        [PSV.MarkersPlugin, { clickEventOnMarker: false }],
        [PSV.AutorotatePlugin, { autostartDelay: null, autostartOnIdle: false, autorotateSpeed: '1rpm' }],
      ],
    });
    markers = viewer.getPlugin(PSV.MarkersPlugin);
    autorotate = viewer.getPlugin(PSV.AutorotatePlugin);

    viewer.addEventListener('position-updated', updateDial);
    viewer.addEventListener('zoom-updated', updateDial);
    viewer.addEventListener('size-updated', updateDial);
    viewer.addEventListener('click', onViewerClick);
    autorotate.addEventListener('autorotate', (e) => {
      const on = e.autorotateEnabled;
      const b = $('#btnAutorotate');
      b.setAttribute('aria-pressed', String(on));
      b.querySelector('use').setAttribute('href', on ? '#i-pause' : '#i-play');
    });
  }

  /** Prejde na scénu. Vďaka počítadlu navSeq sa zahodí výsledok zrušeného prechodu. */
  async function goToScene(id, opts = {}) {
    const scene = getScene(id);
    if (!scene || !viewer) return;
    const seq = ++navSeq;
    cancelPlacing();
    if (!opts.keepSelection) state.selectedHotspot = null;
    state.currentId = id;
    markers.clearMarkers();
    markerEls.clear();
    scene._error = false;
    renderChrome();

    try {
      await ensureSceneMedia(scene);
      if (seq !== navSeq) return;
      const v = scene.view || {};
      const ok = await viewer.setPanorama(srcOf(scene), {
        position: { yaw: rad(num(v.yaw)), pitch: rad(num(v.pitch)) },
        zoom: isNum(v.zoom) ? v.zoom : DEFAULT_ZOOM,
        transition: hasPanorama && !opts.instant ? { speed: 1000, rotation: false, effect: 'fade' } : false,
        showLoader: true,
      });
      if (seq !== navSeq) return;
      if (ok === false) throw new Error('Načítanie bolo prerušené');
      hasPanorama = true;
    } catch (err) {
      if (seq !== navSeq) return;
      scene._error = true;
      renderSceneList();
      toast(`Fotku „${scene.name}“ sa nepodarilo načítať.`, 'error');
      return;
    }
    refreshMarkers();
    updateDial();
  }

  /* ---------- body prechodu (markery) ---------- */
  const hotspotLabel = (hs) => hs.text || (getScene(hs.target) ? getScene(hs.target).name : 'Prejsť ďalej');

  function hotspotElement(hs, index) {
    const editing = state.mode === 'edit';
    const label = hotspotLabel(hs);
    const el = h(
      'button',
      {
        type: 'button',
        class: 'hotspot' + (editing ? ' hotspot--edit' : '') + (hs.id === state.selectedHotspot ? ' is-selected' : ''),
        'aria-label': editing ? `Bod prechodu ${index + 1}: ${label}` : `Prejsť: ${label}`,
        dataset: { hid: hs.id },
      },
      h('span', { class: 'hotspot__pulse' }),
      h('span', { class: 'hotspot__disc' }, editing ? h('span', { class: 'hotspot__num', text: String(index + 1) }) : icon('arrow-up')),
      h('span', { class: 'hotspot__label', text: label })
    );
    if (editing) {
      attachDrag(el, hs);
      el.addEventListener('click', () => selectHotspot(hs.id));
    } else {
      el.addEventListener('click', () => goToScene(hs.target));
    }
    return el;
  }

  function refreshMarkers() {
    const scene = currentScene();
    if (!scene || !markers) return;
    markerEls.clear();
    markers.setMarkers(
      scene.hotspots.map((hs, i) => {
        const el = hotspotElement(hs, i);
        markerEls.set(hs.id, el);
        return {
          id: hs.id,
          position: { yaw: rad(hs.yaw), pitch: rad(hs.pitch) },
          element: el,
          size: { width: 56, height: 56 },
          anchor: 'center center',
        };
      })
    );
    rebuildDialDots();
  }

  /** Premiestnenie bodu ťahaním (len v editore). */
  function attachDrag(el, hs) {
    const stop = (e) => e.stopPropagation();
    el.addEventListener('mousedown', stop);
    el.addEventListener('touchstart', stop, { passive: true });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || state.placing) return;
      e.stopPropagation();
      selectHotspot(hs.id);
      const startX = e.clientX;
      const startY = e.clientY;
      let moved = false;
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* nič */ }
      const onMove = (ev) => {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        moved = true;
        const r = $('#viewer').getBoundingClientRect();
        const p = viewer.dataHelper.viewerCoordsToSphericalCoords({ x: ev.clientX - r.left, y: ev.clientY - r.top });
        hs.yaw = round2(wrap180(deg(p.yaw)));
        hs.pitch = round2(clamp(deg(p.pitch), -90, 90));
        markers.updateMarker({ id: hs.id, position: { yaw: p.yaw, pitch: p.pitch } });
        updateDialDots();
      };
      const onUp = () => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        if (moved) { saveSoon(); renderHotspots(); }
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    });
  }

  function onViewerClick(e) {
    const data = e.data;
    if (state.mode !== 'edit' || data.rightclick) return;
    if (state.placing) { finishPlacing(data.yaw, data.pitch); return; }
    if (state.selectedHotspot) selectHotspot(null);
  }

  /* ---------- smerový kruh ---------- */
  function buildDialTicks() {
    const g = $('#dialTicks');
    for (let i = 0; i < 24; i++) {
      const a = rad(i * 15);
      const long = i % 6 === 0;
      const r1 = long ? 31 : 34;
      const r2 = 37;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('class', 'dial__tick');
      line.setAttribute('x1', (50 + r1 * Math.sin(a)).toFixed(2));
      line.setAttribute('y1', (50 - r1 * Math.cos(a)).toFixed(2));
      line.setAttribute('x2', (50 + r2 * Math.sin(a)).toFixed(2));
      line.setAttribute('y2', (50 - r2 * Math.cos(a)).toFixed(2));
      g.append(line);
    }
  }

  function rebuildDialDots() {
    const g = $('#dialDots');
    g.replaceChildren();
    const scene = currentScene();
    if (!scene) return;
    scene.hotspots.forEach((hs) => {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('class', 'dial__dot');
      c.setAttribute('r', '6');
      c.dataset.hid = hs.id;
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = hotspotLabel(hs);
      c.append(title);
      c.addEventListener('click', () => {
        if (state.mode === 'edit') selectHotspot(hs.id, { look: true });
        else goToScene(hs.target);
      });
      g.append(c);
    });
    updateDialDots();
  }

  function updateDialDots() {
    const scene = currentScene();
    if (!scene) return;
    scene.hotspots.forEach((hs) => {
      const c = $(`#dialDots [data-hid="${hs.id}"]`);
      if (!c) return;
      c.setAttribute('cx', (50 + 37 * Math.sin(rad(hs.yaw))).toFixed(2));
      c.setAttribute('cy', (50 - 37 * Math.cos(rad(hs.yaw))).toFixed(2));
      c.classList.toggle('is-selected', hs.id === state.selectedHotspot);
    });
  }

  function updateDial() {
    if (!viewer || !currentScene()) return;
    let pos;
    try { pos = viewer.getPosition(); } catch (e) { return; }
    const yaw = deg(pos.yaw);
    $('#dialRing').setAttribute('transform', `rotate(${(-yaw).toFixed(2)} 50 50)`);
    $('#dialText').textContent = Math.round(wrap360(yaw)) + '°';
    const hfov = (viewer.state && isNum(viewer.state.hFov) && viewer.state.hFov) || 70;
    const half = rad(clamp(hfov, 20, 160) / 2);
    const R = 30;
    const x1 = 50 - R * Math.sin(half);
    const x2 = 50 + R * Math.sin(half);
    const y = 50 - R * Math.cos(half);
    $('#dialWedge').setAttribute('d', `M50 50 L${x1.toFixed(2)} ${y.toFixed(2)} A${R} ${R} 0 0 1 ${x2.toFixed(2)} ${y.toFixed(2)} Z`);
  }

  /* ===================================================================
     7. Rozhranie: upozornenia, dialógy, zamykacia obrazovka
     =================================================================== */
  function toast(text, kind = 'info', ms = 3600) {
    const el = h('div', { class: 'toast' + (kind === 'error' ? ' toast--error' : kind === 'ok' ? ' toast--ok' : ''), text });
    $('#toasts').append(el);
    setTimeout(() => {
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 300);
    }, ms);
  }

  async function withBusy(text, fn) {
    $('#busyText').textContent = text;
    $('#busy').hidden = false;
    try { return await fn(); } finally { $('#busy').hidden = true; }
  }

  function confirmDialog({ title, text, ok = 'Potvrdiť', cancel = 'Zrušiť', danger = false }) {
    return new Promise((resolve) => {
      const dlg = $('#dlgConfirm');
      $('#confirmTitle').textContent = title;
      $('#confirmText').textContent = text;
      $('#confirmCancel').textContent = cancel;
      const okBtn = $('#confirmOk');
      okBtn.textContent = ok;
      okBtn.className = 'btn ' + (danger ? 'btn--danger btn--solid' : 'btn--primary');
      const onClose = () => {
        dlg.removeEventListener('close', onClose);
        resolve(dlg.returnValue === 'ok');
      };
      dlg.addEventListener('close', onClose);
      dlg.returnValue = 'cancel';
      dlg.showModal();
    });
  }

  function pinErrorText(e) {
    if (e && e.message === 'BAD_PIN') return 'Nesprávny PIN. Skúste to znova.';
    if (!PinCrypto.available()) return 'Šifrovanie funguje len cez HTTPS alebo na localhost.';
    return 'Súbor sa nepodarilo odomknúť. Je poškodený?';
  }

  /** Dialóg na zadanie PINu; verify(pin) musí pri zlom PINe vyhodiť chybu. Vráti výsledok verify alebo null. */
  function askPin(verify, { title, text }) {
    return new Promise((resolve) => {
      const dlg = $('#dlgPin');
      const form = $('#pinForm');
      const input = $('#pinDlgInput');
      const err = $('#pinDlgError');
      const okBtn = $('#pinDlgOk');
      $('#pinDlgTitle').textContent = title;
      $('#pinDlgText').textContent = text;
      err.textContent = '';
      input.value = '';
      let result = null;
      const onSubmit = async (e) => {
        e.preventDefault();
        if (e.submitter && e.submitter.value === 'cancel') { dlg.close('cancel'); return; }
        const pin = input.value.trim();
        if (!pin) { input.focus(); return; }
        okBtn.disabled = true;
        try {
          result = await verify(pin);
          dlg.close('ok');
        } catch (e2) {
          err.textContent = pinErrorText(e2);
          input.select();
        } finally {
          okBtn.disabled = false;
        }
      };
      const onClose = () => {
        form.removeEventListener('submit', onSubmit);
        dlg.removeEventListener('close', onClose);
        resolve(dlg.returnValue === 'ok' ? result : null);
      };
      form.addEventListener('submit', onSubmit);
      dlg.addEventListener('close', onClose);
      dlg.returnValue = 'cancel';
      dlg.showModal();
      input.focus();
    });
  }

  /** Zamykacia obrazovka pre publikovanú prehliadku chránenú PINom. */
  function unlockScreen(envelope) {
    return new Promise((resolve) => {
      const lock = $('#lock');
      const form = $('#lockForm');
      const input = $('#lockPin');
      const err = $('#lockError');
      const button = $('#lockBtn');
      let attempts = 0;
      lock.hidden = false;
      input.focus();
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pin = input.value.trim();
        if (!pin) return;
        button.disabled = true;
        err.textContent = '';
        try {
          const res = await PinCrypto.openEnvelope(envelope, pin);
          lock.hidden = true;
          resolve({ ...res, pin: PinCrypto.normalizePin(pin) });
        } catch (e2) {
          attempts++;
          err.textContent = pinErrorText(e2);
          form.classList.remove('is-error');
          void form.offsetWidth; // reštart animácie
          form.classList.add('is-error');
          input.select();
          await sleep(Math.min(attempts * 400, 3000));
          button.disabled = false;
        }
      });
    });
  }

  /* ===================================================================
     8. Editor: scény, body prechodu, nastavenia, PIN
     =================================================================== */
  /* ---------- prepínanie režimu a kariet ---------- */
  async function setMode(mode) {
    if (mode === 'edit' && VIEWER_ONLY) return;
    if (mode === state.mode) return;
    if (mode === 'edit' && state.cipher) await materialize();
    state.mode = mode;
    cancelPlacing();
    document.body.classList.toggle('mode-edit', mode === 'edit');
    document.body.classList.toggle('mode-tour', mode === 'tour');
    $$('#modeSwitch button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
    renderAll();
    refreshMarkers();
    setTimeout(() => viewer && viewer.autoSize(), 380);
  }

  function setTab(tab) {
    state.tab = tab;
    $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $$('.sb-body > section').forEach((s) => { s.hidden = s.id !== 'panel-' + tab; });
    if (tab === 'settings') renderPinBlock();
  }

  /* ---------- vykresľovanie ---------- */
  function renderAll() {
    renderChrome();
    renderSceneList();
    renderSceneDetail();
    renderHotspots();
    renderSettings();
  }

  /** Názvy, pás scén, prázdny stav – všetko, čo závisí od aktuálnej scény. */
  function renderChrome() {
    const scene = currentScene();
    const n = tour.scenes.length;
    document.title = (tour.name ? tour.name + ' – ' : '') + 'Rozhľad';
    const chip = $('#titleChip');
    chip.hidden = !scene;
    if (scene) {
      $('#tourTitle').textContent = tour.name;
      $('#sceneTitle').textContent = n > 1 ? `${scene.name} (${tour.scenes.indexOf(scene) + 1}/${n})` : scene.name;
    }
    $('#countScenes').textContent = String(n);
    $('#countHotspots').textContent = String(scene ? scene.hotspots.length : 0);

    const empty = n === 0;
    $('#emptyState').hidden = !empty;
    $('#viewer').classList.toggle('is-hidden', empty);
    if (VIEWER_ONLY && empty) {
      $('#emptyTitle').textContent = 'Táto prehliadka je prázdna';
      $('#emptyText').textContent = 'Autor do nej zatiaľ nepridal žiadne panorámy.';
      $('#emptyActions').hidden = true;
    }
    $('#dial').hidden = empty;
    $('#controls').hidden = empty;
    renderStrip();
    renderSceneList();
    renderSceneDetail();
    renderHotspots();
  }

  function renderStrip() {
    const strip = $('#strip');
    const show = tour.scenes.length > 1;
    strip.hidden = !show;
    strip.replaceChildren();
    if (!show) return;
    tour.scenes.forEach((s) => {
      const active = s.id === state.currentId;
      strip.append(
        h('button', { type: 'button', class: 'frame' + (active ? ' is-active' : ''), 'aria-label': s.name, 'aria-current': active ? 'true' : null, onclick: () => goToScene(s.id) },
          h('img', { src: thumbOf(s), alt: '', draggable: false }),
          h('span', { class: 'frame__name', text: s.name }))
      );
    });
    const act = $('.frame.is-active', strip);
    if (act) act.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }

  function renderSceneList() {
    const list = $('#sceneList');
    if (!list) return;
    list.replaceChildren();
    const n = tour.scenes.length;
    $('#dropzone').classList.toggle('is-compact', n > 0);
    $('#dropzone strong').textContent = n > 0 ? 'Pridať ďalšie fotky' : 'Pridajte 360° fotky';
    tour.scenes.forEach((s, i) => {
      const count = s.hotspots.length;
      const thumb = thumbOf(s);
      list.append(
        h('li', { class: 'scene-item' + (s.id === state.currentId ? ' is-active' : '') },
          h('button', { type: 'button', class: 'scene-item__main', 'aria-label': `Otvoriť scénu ${s.name}`, onclick: () => goToScene(s.id) },
            thumb ? h('img', { src: thumb, alt: '', loading: 'lazy', draggable: false }) : h('span', { class: 'ph' }),
            h('span', { class: 'scene-item__text' },
              h('strong', { text: s.name }),
              h('span', { class: 'scene-item__meta' },
                h('span', { text: `${count} ${plural(count, 'bod', 'body', 'bodov')}` }),
                s.id === tour.start ? h('span', { class: 'badge', text: 'Úvodná' }) : null,
                s._error ? h('span', { class: 'badge badge--error' }, icon('triangle-alert'), 'Nenačítaná') : null))),
          h('div', { class: 'scene-item__tools' },
            iconBtn('chevron-up', 'Posunúť vyššie', () => moveScene(s.id, -1), i === 0),
            iconBtn('chevron-down', 'Posunúť nižšie', () => moveScene(s.id, 1), i === n - 1),
            iconBtn('trash-2', 'Odstrániť scénu', () => removeScene(s.id), false, 'icon-btn--danger')))
      );
    });
  }

  function renderSceneDetail() {
    const box = $('#sceneDetail');
    if (!box) return;
    box.replaceChildren();
    const s = currentScene();
    if (!s) return;
    const nameInput = h('input', {
      type: 'text', id: 'sceneName', value: s.name, maxlength: 80, autocomplete: 'off',
      oninput: (e) => {
        s.name = cleanText(e.target.value, 80) || 'Bez názvu';
        saveSoon();
        renderStrip();
        renderSceneList();
        $('#sceneTitle').textContent = tour.scenes.length > 1 ? `${s.name} (${tour.scenes.indexOf(s) + 1}/${tour.scenes.length})` : s.name;
      },
    });
    box.append(
      h('h3', { text: 'Vybraná scéna' }),
      h('div', { class: 'field' }, h('label', { for: 'sceneName', text: 'Názov scény' }), nameInput),
      h('div', { class: 'stack' },
        btn('Nastaviť aktuálny pohľad ako úvodný', 'crosshair', setStartView),
        btn('Nahradiť fotku', 'replace', () => $('#fileReplace').click()),
        s.id === tour.start
          ? h('p', { class: 'hint', style: 'margin:0', text: 'Táto scéna sa otvorí ako prvá.' })
          : btn('Nastaviť ako úvodnú scénu', 'star', () => setStartScene(s.id)))
    );
  }

  function renderHotspots() {
    const list = $('#hotspotList');
    if (!list) return;
    list.replaceChildren();
    const s = currentScene();
    const enough = tour.scenes.length >= 2;
    $('#btnAddHotspot').disabled = !s || !enough;
    $('#hotspotHint').textContent = !s
      ? 'Najprv pridajte aspoň dve scény.'
      : !enough
        ? 'Na vytvorenie bodu prechodu potrebujete aspoň dve scény.'
        : 'Bod prechodu je šípka v panoráme. Návštevník cez ňu prejde do inej miestnosti.';
    if (!s) return;
    if (enough && s.hotspots.length === 0) {
      list.append(h('li', { class: 'empty-note', text: 'V tejto scéne zatiaľ nie je žiadny bod prechodu.' }));
    }
    s.hotspots.forEach((hs, i) => list.append(hotspotCard(s, hs, i)));
  }

  function hotspotCard(scene, hs, index) {
    const open = hs.id === state.selectedHotspot;
    const title = h('strong', { text: hotspotLabel(hs) });
    const li = h('li', { class: 'hs' + (open ? ' is-open' : ''), dataset: { hid: hs.id } },
      h('button', { type: 'button', class: 'hs__head', 'aria-expanded': String(open), onclick: () => selectHotspot(open ? null : hs.id, { look: !open }) },
        h('span', { class: 'hs__num', text: String(index + 1) }),
        h('span', { class: 'hs__title' }, title, h('small', { text: `Smer ${Math.round(wrap360(hs.yaw))}°` })),
        icon(open ? 'chevron-up' : 'chevron-down'))
    );
    if (!open) return li;

    const textInput = h('input', {
      type: 'text', id: 'hsText', value: hs.text || '', maxlength: 80, autocomplete: 'off',
      placeholder: (getScene(hs.target) || {}).name || 'Popis bodu',
      oninput: (e) => { hs.text = cleanText(e.target.value, 80); syncHotspotLabel(hs, title); saveSoon(); },
    });
    const select = h('select', {
      id: 'hsTarget',
      onchange: (e) => {
        hs.target = e.target.value;
        textInput.placeholder = (getScene(hs.target) || {}).name || 'Popis bodu';
        syncHotspotLabel(hs, title);
        saveSoon();
      },
    }, tour.scenes.filter((s) => s.id !== scene.id).map((s) => h('option', { value: s.id, selected: s.id === hs.target, text: s.name })));

    li.append(h('div', { class: 'hs__body' },
      h('div', { class: 'field' }, h('label', { for: 'hsTarget', text: 'Cieľová scéna' }), select),
      h('div', { class: 'field' }, h('label', { for: 'hsText', text: 'Popis bodu' }), textInput),
      h('div', { class: 'hs__actions' },
        btn('Vyskúšať prechod', 'door-open', () => goToScene(hs.target), 'btn--sm'),
        btn('Odstrániť', 'trash-2', () => removeHotspot(hs.id), 'btn--sm btn--danger'))));
    return li;
  }

  /** Premietne zmenu popisu/cieľa do markera, kruhu a hlavičky karty bez prekreslenia všetkého. */
  function syncHotspotLabel(hs, titleEl) {
    const label = hotspotLabel(hs);
    if (titleEl) titleEl.textContent = label;
    const el = markerEls.get(hs.id);
    if (el) {
      const l = el.querySelector('.hotspot__label');
      if (l) l.textContent = label;
      el.setAttribute('aria-label', (state.mode === 'edit' ? 'Bod prechodu: ' : 'Prejsť: ') + label);
    }
    const dot = $(`#dialDots [data-hid="${hs.id}"] title`);
    if (dot) dot.textContent = label;
  }

  /* ---------- akcie so scénami ---------- */
  function uniquePath(path, exceptId) {
    const taken = new Set(tour.scenes.filter((s) => s.id !== exceptId).flatMap((s) => [s.file, s.thumb]));
    if (!taken.has(path)) return path;
    const dot = path.lastIndexOf('.');
    const base = path.slice(0, dot);
    const ext = path.slice(dot);
    let i = 2;
    while (taken.has(`${base}-${i}${ext}`)) i++;
    return `${base}-${i}${ext}`;
  }

  const isImageFile = (f) => /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name);
  const extOf = (f) => (/\.png$/i.test(f.name) || f.type === 'image/png' ? 'png' : /\.webp$/i.test(f.name) || f.type === 'image/webp' ? 'webp' : 'jpg');
  const baseName = (n) => n.replace(/\.[^.]+$/, '');
  const titleFromFile = (n) => {
    const t = baseName(n).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Scéna';
    return cleanText(t.charAt(0).toUpperCase() + t.slice(1), 80);
  };

  async function addFiles(fileList) {
    if (VIEWER_ONLY) return;
    const files = Array.from(fileList).filter(isImageFile);
    if (!files.length) { toast('Vyberte súbory vo formáte JPG, PNG alebo WebP.', 'error'); return; }
    if (state.cipher) await materialize();
    let firstNew = null;
    let added = 0;
    let dbWarned = false;
    await withBusy(files.length > 1 ? 'Spracúvam fotky…' : 'Spracúvam fotku…', async () => {
      for (const f of files) {
        try {
          const info = await analyzeImage(f);
          const ratio = info.width / info.height;
          if (Math.abs(ratio - 2) > 0.12) {
            toast(`Fotka „${f.name}“ má rozmery ${info.width}×${info.height}, nie 2:1. Panoráma sa môže zobraziť skreslene.`, 'error', 6000);
          }
          const id = uid('s');
          const base = slug(baseName(f.name));
          const scene = {
            id,
            name: titleFromFile(f.name),
            file: uniquePath(`panoramas/${base}.${extOf(f)}`),
            thumb: uniquePath(`panoramas/thumbs/${base}.jpg`),
            view: { yaw: 0, pitch: 0 },
            hotspots: [],
          };
          const saved = await DB.put({ id, blob: f, thumb: info.thumbBlob });
          if (!saved && !dbWarned) {
            dbWarned = true;
            toast('Fotky sa nepodarilo uložiť do prehliadača. Po obnovení stránky ich budete musieť nahrať znova, preto prehliadku stiahnite ako ZIP.', 'error', 7000);
          }
          putMedia(id, { blob: f, thumbBlob: info.thumbBlob });
          tour.scenes.push(scene);
          if (!tour.start) tour.start = id;
          if (!firstNew) firstNew = id;
          added++;
        } catch (e) {
          toast(`Súbor „${f.name}“ sa nepodarilo načítať ako obrázok.`, 'error');
        }
      }
    });
    if (added) {
      saveSoon();
      renderAll();
      await goToScene(firstNew);
      toast(`Pridané: ${added} ${plural(added, 'panoráma', 'panorámy', 'panorám')}.`, 'ok');
    }
  }

  async function addSamples() {
    if (state.cipher) await materialize();
    const have = new Set(tour.scenes.map((s) => s.file));
    const fresh = SAMPLES.filter((s) => !have.has(s.file));
    if (!fresh.length) { toast('Vzorové panorámy už v prehliadke sú.'); return; }
    let first = null;
    for (const s of fresh) {
      const ids = new Set(tour.scenes.map((x) => x.id));
      const scene = sampleScene(s, false);
      if (ids.has(scene.id)) scene.id = uid('s');
      tour.scenes.push(scene);
      if (!tour.start) tour.start = scene.id;
      if (!first) first = scene.id;
    }
    saveSoon();
    renderAll();
    await goToScene(first);
    toast(`Pridané vzorové panorámy: ${fresh.length}. Prepojte ich bodmi prechodu.`, 'ok');
  }

  async function replaceImage(file) {
    const scene = currentScene();
    if (!scene || !file) return;
    if (!isImageFile(file)) { toast('Vyberte súbor vo formáte JPG, PNG alebo WebP.', 'error'); return; }
    if (state.cipher) await materialize();
    try {
      await withBusy('Nahrádzam fotku…', async () => {
        const info = await analyzeImage(file);
        if (Math.abs(info.width / info.height - 2) > 0.12) {
          toast(`Fotka má rozmery ${info.width}×${info.height}, nie 2:1. Panoráma sa môže zobraziť skreslene.`, 'error', 6000);
        }
        const base = slug(baseName(file.name));
        scene.file = uniquePath(`panoramas/${base}.${extOf(file)}`, scene.id);
        scene.thumb = uniquePath(`panoramas/thumbs/${base}.jpg`, scene.id);
        await DB.put({ id: scene.id, blob: file, thumb: info.thumbBlob });
        putMedia(scene.id, { blob: file, thumbBlob: info.thumbBlob });
      });
      saveSoon();
      renderAll();
      await goToScene(scene.id, { instant: true, keepSelection: true });
      toast('Fotka bola nahradená.', 'ok');
    } catch (e) {
      toast('Fotku sa nepodarilo načítať.', 'error');
    }
  }

  function moveScene(id, dir) {
    const i = tour.scenes.findIndex((s) => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= tour.scenes.length) return;
    [tour.scenes[i], tour.scenes[j]] = [tour.scenes[j], tour.scenes[i]];
    saveSoon();
    renderChrome();
  }

  async function removeScene(id) {
    const scene = getScene(id);
    if (!scene) return;
    const incoming = tour.scenes.reduce((sum, s) => sum + s.hotspots.filter((x) => x.target === id).length, 0);
    const ok = await confirmDialog({
      title: `Odstrániť scénu „${scene.name}“?`,
      text: incoming
        ? `${incoming === 1 ? 'Odstráni sa aj 1 bod prechodu, ktorý na ňu smeruje.' : `${incoming < 5 ? 'Odstránia' : 'Odstráni'} sa aj ${incoming} ${plural(incoming, 'bod', 'body', 'bodov')} prechodu, ktoré na ňu smerujú.`} Túto akciu nie je možné vrátiť.`
        : 'Túto akciu nie je možné vrátiť.',
      ok: 'Odstrániť scénu',
      danger: true,
    });
    if (!ok) return;
    tour.scenes = tour.scenes.filter((s) => s.id !== id);
    tour.scenes.forEach((s) => { s.hotspots = s.hotspots.filter((x) => x.target !== id); });
    dropMedia(id);
    DB.del(id);
    if (tour.start === id) tour.start = tour.scenes.length ? tour.scenes[0].id : null;
    saveSoon();
    if (state.currentId === id) {
      state.currentId = null;
      if (tour.scenes.length) await goToScene(tour.start, { instant: true });
      else { markers.clearMarkers(); renderAll(); }
    } else {
      renderAll();
      refreshMarkers();
    }
    toast('Scéna bola odstránená.');
  }

  function setStartScene(id) {
    tour.start = id;
    saveSoon();
    renderSceneList();
    renderSceneDetail();
    toast('Úvodná scéna je nastavená.', 'ok');
  }

  function setStartView() {
    const scene = currentScene();
    if (!scene || !viewer) return;
    const p = viewer.getPosition();
    scene.view = { yaw: round2(wrap180(deg(p.yaw))), pitch: round2(deg(p.pitch)), zoom: Math.round(viewer.getZoomLevel()) };
    saveSoon();
    toast('Úvodný pohľad scény je uložený.', 'ok');
  }

  /* ---------- akcie s bodmi prechodu ---------- */
  function startPlacing() {
    const scene = currentScene();
    if (!scene) return;
    if (tour.scenes.length < 2) { toast('Najprv pridajte aspoň dve scény, aby ste ich mohli prepojiť.', 'error'); return; }
    state.placing = true;
    document.body.classList.add('is-placing');
    $('#placingBanner').hidden = false;
    markerEls.forEach((el) => el.blur());
  }

  function cancelPlacing() {
    if (!state.placing) return;
    state.placing = false;
    document.body.classList.remove('is-placing');
    $('#placingBanner').hidden = true;
    $('#ghost').hidden = true;
  }

  function pickDefaultTarget(scene) {
    const others = tour.scenes.filter((s) => s.id !== scene.id);
    const linked = new Set(scene.hotspots.map((x) => x.target));
    return others.find((s) => !linked.has(s.id)) || others[0];
  }

  function finishPlacing(yaw, pitch) {
    cancelPlacing();
    const scene = currentScene();
    if (!scene) return;
    const target = pickDefaultTarget(scene);
    const hs = {
      id: uid('h'),
      yaw: round2(wrap180(deg(yaw))),
      pitch: round2(clamp(deg(pitch), -90, 90)),
      target: target.id,
      text: '',
    };
    scene.hotspots.push(hs);
    state.selectedHotspot = hs.id;
    setTab('hotspots');
    saveSoon();
    renderChrome();
    refreshMarkers();
    afterHotspotSelected(true);
    toast('Bod prechodu je pridaný. Vyberte cieľovú scénu.', 'ok');
  }

  function selectHotspot(id, opts = {}) {
    state.selectedHotspot = id;
    if (id) setTab('hotspots');
    markerEls.forEach((el, hid) => el.classList.toggle('is-selected', hid === id));
    updateDialDots();
    renderHotspots();
    if (id && opts.look) {
      const hs = (currentScene() || { hotspots: [] }).hotspots.find((x) => x.id === id);
      if (hs && viewer) viewer.animate({ yaw: rad(hs.yaw), pitch: rad(hs.pitch), speed: 800 });
    }
    afterHotspotSelected(false);
  }

  function afterHotspotSelected(focusSelect) {
    if (!state.selectedHotspot) return;
    const card = $(`.hs[data-hid="${state.selectedHotspot}"]`);
    if (!card) return;
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (focusSelect) {
      const sel = $('select', card);
      if (sel) sel.focus({ preventScroll: true });
    }
  }

  function removeHotspot(id) {
    const scene = currentScene();
    if (!scene) return;
    scene.hotspots = scene.hotspots.filter((x) => x.id !== id);
    if (state.selectedHotspot === id) state.selectedHotspot = null;
    saveSoon();
    renderChrome();
    refreshMarkers();
    toast('Bod prechodu bol odstránený.');
  }

  /* ---------- nastavenia a PIN ---------- */
  function renderSettings() {
    const input = $('#tourName');
    if (input && document.activeElement !== input) input.value = tour.name;
    renderPinBlock();
  }

  const PIN_TEXT = {
    short: [1, `Zadajte aspoň ${MIN_PIN} znaky.`],
    weak: [2, 'Krátky číselný PIN odradí náhodných návštevníkov, ale nie cieleného útočníka.'],
    fair: [3, 'Dostatočné na bežné použitie. Pre vyššiu istotu použite aspoň 8 znakov.'],
    good: [4, 'Silný PIN.'],
  };

  function renderPinBlock() {
    const box = $('#pinBlock');
    if (!box) return;
    box.replaceChildren();
    box.append(h('h3', { text: 'Ochrana PINom' }));

    if (tour.pin && !state.editingPin) {
      const level = PinCrypto.strength(tour.pin);
      box.append(
        h('p', { text: 'Pri exporte sa fotky aj nastavenia zašifrujú. Návštevník prehliadku otvorí až po zadaní PINu.' }),
        h('div', { class: 'pin-state' }, icon('shield-check'),
          h('span', {}, 'PIN je nastavený: ', h('span', { class: 'pin-value', text: state.showPin ? tour.pin : '•'.repeat(Math.min(tour.pin.length, 14)) }))),
        h('div', { class: 'row', style: 'margin-top:10px' },
          btn(state.showPin ? 'Skryť PIN' : 'Zobraziť PIN', state.showPin ? 'eye-off' : 'eye', () => { state.showPin = !state.showPin; renderPinBlock(); }, 'btn--sm'),
          btn('Zmeniť PIN', 'key-round', () => { state.editingPin = true; renderPinBlock(); $('#pinInput') && $('#pinInput').focus(); }, 'btn--sm'),
          btn('Odstrániť PIN', 'trash-2', removePin, 'btn--sm btn--danger'))
      );
      if (level !== 'good') box.append(h('p', { class: 'hint', text: PIN_TEXT[level][1] }));
    } else {
      const meter = h('div', { class: 'pin-meter', 'data-level': '0' }, h('i'), h('i'), h('i'), h('i'));
      const msg = h('p', { class: 'hint', text: 'Každá prehliadka má vlastný PIN. Môže obsahovať aj písmená a znaky.' });
      const input = h('input', {
        type: state.showPin ? 'text' : 'password', id: 'pinInput', autocomplete: 'new-password', autocapitalize: 'off', spellcheck: false,
        placeholder: `Nový PIN (aspoň ${MIN_PIN} znaky)`,
        oninput: (e) => {
          const lv = PinCrypto.strength(e.target.value);
          meter.dataset.level = String(e.target.value ? PIN_TEXT[lv][0] : 0);
          msg.textContent = e.target.value ? PIN_TEXT[lv][1] : 'Každá prehliadka má vlastný PIN. Môže obsahovať aj písmená a znaky.';
        },
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); setPin(e.target.value); } },
      });
      box.append(
        h('p', { text: 'Nastavte PIN a exportované súbory sa zašifrujú. Návštevník ich otvorí až po zadaní PINu.' }),
        h('div', { class: 'pin-row' }, input,
          h('button', { type: 'button', class: 'btn', onclick: () => { state.showPin = !state.showPin; input.type = state.showPin ? 'text' : 'password'; } }, icon(state.showPin ? 'eye-off' : 'eye'), 'Zobraziť')),
        meter, msg,
        h('div', { class: 'row', style: 'margin-top:12px' },
          btn(tour.pin ? 'Uložiť nový PIN' : 'Nastaviť PIN', 'lock', () => setPin(input.value), 'btn--primary'),
          tour.pin ? btn('Zrušiť', null, () => { state.editingPin = false; renderPinBlock(); }) : null)
      );
    }
    box.append(h('p', { class: 'hint', text: 'PIN sa uloží len v tomto prehliadači a nikdy nie je súčasťou stiahnutých súborov. Súbory v repozitári zostávajú verejné, ale bez PINu sú nečitateľné. Čím dlhší PIN, tým lepšie.' }));
  }

  function setPin(value) {
    const pin = PinCrypto.normalizePin(value);
    if (pin.length < MIN_PIN) { toast(`PIN musí mať aspoň ${MIN_PIN} znaky.`, 'error'); return; }
    tour.pin = pin;
    state.editingPin = false;
    state.showPin = false;
    saveSoon();
    renderPinBlock();
    toast('PIN je nastavený. Pri ďalšom exporte sa súbory zašifrujú.', 'ok');
  }

  async function removePin() {
    const ok = await confirmDialog({
      title: 'Odstrániť PIN?',
      text: 'Pri ďalšom exporte sa súbory nezašifrujú a prehliadku uvidí každý, kto ju nájde.',
      ok: 'Odstrániť PIN',
      danger: true,
    });
    if (!ok) return;
    tour.pin = '';
    state.editingPin = false;
    saveSoon();
    renderPinBlock();
    toast('PIN bol odstránený.');
  }

  async function newTour() {
    const ok = await confirmDialog({
      title: 'Začať novú prehliadku?',
      text: 'Aktuálna prehliadka sa z tohto prehliadača odstráni. Ak ju chcete zachovať, najprv ju stiahnite ako ZIP.',
      ok: 'Začať odznova',
      danger: true,
    });
    if (!ok) return;
    await resetStorage();
    state.cipher = null;
    state.currentId = null;
    state.selectedHotspot = null;
    tour = { name: 'Nová prehliadka', start: null, pin: '', scenes: [] };
    hasPanorama = false;
    markers.clearMarkers();
    saveNow();
    renderAll();
    setTab('scenes');
  }

  async function loadDemo() {
    await resetStorage();
    state.cipher = null;
    tour = demoTour();
    hasPanorama = false;
    saveSoon();
    renderAll();
    await goToScene(tour.start, { instant: true });
  }

  async function resetToOriginal() {
    const ok = await confirmDialog({
      title: 'Obnoviť pôvodnú prehliadku?',
      text: 'Zmeny uložené v tomto prehliadači sa zahodia a načíta sa publikovaná (alebo vzorová) prehliadka.',
      ok: 'Obnoviť',
      danger: true,
    });
    if (!ok) return;
    await resetStorage();
    location.reload();
  }

  /* ===================================================================
     9. Export a import
     =================================================================== */
  const README_TEXT = (locked) => `Rozhľad – balík prehliadky
==========================

Obsah balíka:
  tour.json     nastavenia prehliadky (scény, body prechodu)${locked ? ' – ZAŠIFROVANÉ' : ''}
  panoramas/    fotky panorám a ich náhľady${locked ? ' – ZAŠIFROVANÉ' : ''}

Publikovanie na GitHub Pages:
  1. Rozbaľte tento ZIP.
  2. Súbor tour.json a priečinok panoramas skopírujte do koreňa repozitára
     (vedľa súboru index.html). Existujúci priečinok panoramas nahraďte.
  3. Na GitHube: Add file > Upload files, nahrajte súbory a potvrďte tlačidlom Commit changes.
  4. Po minúte-dvoch bude prehliadka dostupná na adrese
     https://<vase-meno>.github.io/<nazov-repozitara>/
     Čistý odkaz pre návštevníkov (bez editora) získate pridaním ?mode=tour na koniec adresy.
${locked ? `
Ochrana PINom:
  Súbory sú zašifrované PINom, ktorý ste nastavili v editore. PIN nie je súčasťou balíka.
  Návštevníkom ho pošlite samostatne, napríklad správou. Bez PINu sa prehliadka neotvorí.
` : ''}`;

  /** Konfigurácia pripravená na export: každá scéna má cestu k fotke aj k náhľadu. */
  function exportConfig() {
    const cfg = serializeTour();
    cfg.scenes.forEach((s) => {
      s.file = safePath(s.file) || `panoramas/${s.id}.jpg`;
      const base = s.file.split('/').pop().replace(/\.[^.]+$/, '');
      s.thumb = safePath(s.thumb) || `panoramas/thumbs/${base}.jpg`;
    });
    return cfg;
  }

  /** Fotka a náhľad scény – z pamäte, z IndexedDB alebo stiahnuté zo stránky. */
  async function getSceneBlobs(scene, cfgScene) {
    await ensureSceneMedia(scene);
    const m = media.get(scene.id) || {};
    let { blob, thumbBlob } = m;
    if (!blob) {
      const res = await fetch(scene.file);
      if (!res.ok) throw new Error(`Fotku „${scene.name}“ sa nepodarilo načítať (${scene.file}).`);
      blob = await res.blob();
    }
    if (!thumbBlob) {
      if (cfgScene.thumb && scene.thumb) {
        try { const r = await fetch(scene.thumb); if (r.ok) thumbBlob = await r.blob(); } catch (e) { /* vyrobíme nový */ }
      }
      if (!thumbBlob) thumbBlob = (await analyzeImage(blob)).thumbBlob;
    }
    return { blob, thumbBlob };
  }

  const fileStem = () => slug(tour.name) || 'prehliadka';

  async function exportTour(kind) {
    if (!tour.scenes.length) { toast('Prehliadka je prázdna. Najprv pridajte aspoň jednu panorámu.', 'error'); return; }
    const locked = !!tour.pin;
    if (locked && !PinCrypto.available()) {
      toast('Šifrovanie funguje len cez HTTPS alebo na localhost. Otvorte aplikáciu cez GitHub Pages alebo lokálny server.', 'error', 7000);
      return;
    }
    try {
      await withBusy(locked ? 'Šifrujem a pripravujem balík…' : 'Pripravujem balík…', async () => {
        const cfg = exportConfig();
        let tourJson;
        let key = null;
        if (locked) {
          const sealed = await PinCrypto.sealTour(cfg, tour.pin);
          key = sealed.key;
          tourJson = JSON.stringify(sealed.envelope, null, 2);
        } else {
          tourJson = JSON.stringify(cfg, null, 2);
        }
        if (kind === 'json') {
          downloadBlob(new Blob([tourJson], { type: 'application/json' }), 'tour.json');
          return;
        }
        const entries = [{ name: 'tour.json', data: tourJson }, { name: 'CITAJ-ME.txt', data: README_TEXT(locked) }];
        for (let i = 0; i < tour.scenes.length; i++) {
          const scene = tour.scenes[i];
          const cs = cfg.scenes[i];
          const { blob, thumbBlob } = await getSceneBlobs(scene, cs);
          if (locked) {
            entries.push(
              { name: encPath(scene.id), data: await PinCrypto.encryptBytes(key, new Uint8Array(await blob.arrayBuffer())) },
              { name: encThumbPath(scene.id), data: await PinCrypto.encryptBytes(key, new Uint8Array(await thumbBlob.arrayBuffer())) }
            );
          } else {
            entries.push({ name: cs.file, data: blob }, { name: cs.thumb, data: thumbBlob });
          }
        }
        downloadBlob(await Zip.create(entries), `${fileStem()}.zip`);
      });
      saveNow();
      toast(kind === 'json' ? 'Súbor tour.json je stiahnutý.' : 'Balík ZIP je stiahnutý. Postup publikovania nájdete v súbore CITAJ-ME.txt.', 'ok', 5000);
    } catch (e) {
      toast(e && e.message ? e.message : 'Export sa nepodaril.', 'error', 6000);
    }
  }

  async function importFile(file) {
    if (!file) return;
    try {
      const isZip = /\.zip$/i.test(file.name) || file.type === 'application/zip';
      let entries = null;
      let prefix = '';
      let text;
      if (isZip) {
        entries = await Zip.read(file);
        const te = entries.find((e) => !e.isDir && /(^|\/)tour\.json$/.test(e.name) && !e.name.startsWith('__MACOSX/'));
        if (!te) throw new Error('V ZIP súbore chýba tour.json.');
        prefix = te.name.slice(0, te.name.length - 'tour.json'.length);
        text = new TextDecoder().decode(await te.bytes());
      } else {
        text = await file.text();
      }
      let raw;
      try { raw = JSON.parse(text); } catch (e) { throw new Error('Súbor nie je platný JSON.'); }

      let cfg = raw;
      let cipher = null;
      let pin = '';
      if (PinCrypto.isEnvelope(raw)) {
        const res = await askPin(async (p) => ({ ...(await PinCrypto.openEnvelope(raw, p)), pin: PinCrypto.normalizePin(p) }), {
          title: 'Zadajte PIN prehliadky',
          text: 'Súbor je zašifrovaný. Na jeho otvorenie potrebujete PIN.',
        });
        if (!res) return;
        cfg = res.config;
        cipher = { key: res.key };
        pin = res.pin;
      }
      const next = normalizeTour(cfg);
      const ok = await confirmDialog({
        title: 'Nahradiť aktuálnu prehliadku?',
        text: `Importuje sa prehliadka „${next.name}“ (${next.scenes.length} ${plural(next.scenes.length, 'scéna', 'scény', 'scén')}). Aktuálna prehliadka v tomto prehliadači sa nahradí.`,
        ok: 'Importovať',
        danger: true,
      });
      if (!ok) return;

      await withBusy('Importujem prehliadku…', async () => {
        await resetStorage();
        tour = next;
        tour.pin = pin;
        state.cipher = null;
        state.currentId = null;
        hasPanorama = false;
        const find = (path) => entries && entries.find((e) => e.name === prefix + path);
        for (const s of tour.scenes) {
          if (!entries) continue;
          let blob = null;
          let thumbBlob = null;
          if (cipher) {
            const ei = find(encPath(s.id));
            const et = find(encThumbPath(s.id));
            if (ei) { const p = await PinCrypto.decryptBytes(cipher.key, await ei.bytes()); blob = new Blob([p], { type: sniffMime(p) }); }
            if (et) { const p = await PinCrypto.decryptBytes(cipher.key, await et.bytes()); thumbBlob = new Blob([p], { type: 'image/jpeg' }); }
          } else {
            const ei = find(safePath(s.file));
            const et = s.thumb ? find(safePath(s.thumb)) : null;
            if (ei) { const p = await ei.bytes(); blob = new Blob([p], { type: sniffMime(p) }); }
            if (et) { const p = await et.bytes(); thumbBlob = new Blob([p], { type: 'image/jpeg' }); }
          }
          if (blob) {
            if (!thumbBlob) thumbBlob = (await analyzeImage(blob)).thumbBlob;
            if (!s.thumb) s.thumb = `panoramas/thumbs/${safePath(s.file).split('/').pop().replace(/\.[^.]+$/, '')}.jpg`;
            await DB.put({ id: s.id, blob, thumb: thumbBlob });
            putMedia(s.id, { blob, thumbBlob });
          }
        }
        // šifrovaný JSON bez ZIP-u: fotky sa čítajú zo stránky, kým sa projekt neupraví
        if (cipher && !entries) {
          state.cipher = cipher;
          await loadEncryptedThumbs();
        }
      });
      saveNow();
      renderAll();
      setTab('scenes');
      if (tour.start) await goToScene(tour.start, { instant: true });
      else { markers.clearMarkers(); }
      $('#dlgShare').close();
      toast(`Prehliadka je importovaná: ${tour.scenes.length} ${plural(tour.scenes.length, 'scéna', 'scény', 'scén')}.`, 'ok');
    } catch (e) {
      toast(e && e.message ? e.message : 'Súbor sa nepodarilo importovať.', 'error', 6000);
    }
  }

  function openShare() {
    const base = location.origin === 'null' || location.protocol === 'file:' ? location.href.split(/[?#]/)[0] : location.origin + location.pathname;
    const url = `${base}?mode=tour`;
    $('#shareUrl').value = url;
    $('#shareEmbed').value = `<iframe src="${url}" title="${cleanText(tour.name, 80).replace(/"/g, '&quot;')}" width="100%" height="520" style="border:0" allow="fullscreen" allowfullscreen loading="lazy"></iframe>`;
    const note = $('#shareLockNote');
    note.replaceChildren();
    note.className = 'note ' + (tour.pin ? 'note--ok' : 'note--warn');
    if (tour.pin) {
      note.append(icon('shield-check'), h('div', { text: 'Prehliadka je chránená PINom. Súbory sa pri stiahnutí zašifrujú. PIN pošlite návštevníkom samostatne, nie je súčasťou balíka.' }));
    } else {
      note.append(icon('triangle-alert'), h('div', {},
        h('div', { text: 'Prehliadka nie je chránená PINom. Ktokoľvek s odkazom alebo prístupom do repozitára ju uvidí.' }),
        h('button', { type: 'button', class: 'btn btn--sm', onclick: () => { $('#dlgShare').close(); goToPinSettings(); } }, 'Nastaviť PIN')));
    }
    $('#dlgShare').showModal();
  }

  async function goToPinSettings() {
    await setMode('edit');
    setTab('settings');
    state.editingPin = !tour.pin;
    renderPinBlock();
    const i = $('#pinInput');
    if (i) i.focus();
  }

  async function copyText(el, label) {
    try {
      await navigator.clipboard.writeText(el.value);
    } catch (e) {
      el.select();
      document.execCommand('copy');
    }
    toast(`${label} je skopírovaný.`, 'ok');
  }

  /* ===================================================================
     10. Štart aplikácie
     =================================================================== */
  function bindUI() {
    // režim a karty
    $$('#modeSwitch button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    $$('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

    // ovládanie panorámy
    $('#btnZoomIn').addEventListener('click', () => viewer && viewer.zoomIn());
    $('#btnZoomOut').addEventListener('click', () => viewer && viewer.zoomOut());
    $('#btnAutorotate').addEventListener('click', () => autorotate && autorotate.toggle());
    const fsBtn = $('#btnFullscreen');
    if (!document.fullscreenEnabled) fsBtn.hidden = true;
    fsBtn.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    });
    document.addEventListener('fullscreenchange', () => {
      fsBtn.querySelector('use').setAttribute('href', document.fullscreenElement ? '#i-minimize' : '#i-maximize');
      setTimeout(() => viewer && viewer.autoSize(), 150);
    });

    // dialógy
    $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
    $$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d && d.id !== 'dlgPin') d.close(); }));
    $('#btnHelp').addEventListener('click', () => $('#dlgHelp').showModal());
    $('#btnShare').addEventListener('click', openShare);
    $('#btnShare2').addEventListener('click', openShare);
    $('#btnExportZip').addEventListener('click', () => exportTour('zip'));
    $('#btnExportJson').addEventListener('click', () => exportTour('json'));
    $('#btnImport').addEventListener('click', () => $('#fileImport').click());
    $('#fileImport').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; importFile(f); });
    $('#btnCopyUrl').addEventListener('click', () => copyText($('#shareUrl'), 'Odkaz'));
    $('#btnCopyEmbed').addEventListener('click', () => copyText($('#shareEmbed'), 'Kód'));

    // fotky a scény
    const pick = () => $('#fileImages').click();
    $('#btnAddImages').addEventListener('click', pick);
    $('#btnEmptyUpload').addEventListener('click', async () => { await setMode('edit'); pick(); });
    $('#btnEmptySamples').addEventListener('click', loadDemo);
    $('#fileImages').addEventListener('change', (e) => { const fs = Array.from(e.target.files); e.target.value = ''; addFiles(fs); });
    $('#fileReplace').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; replaceImage(f); });
    $('#btnAddSamples').addEventListener('click', addSamples);

    // body prechodu
    $('#btnAddHotspot').addEventListener('click', startPlacing);
    $('#btnCancelPlacing').addEventListener('click', cancelPlacing);
    $('#stage').addEventListener('pointermove', (e) => {
      if (!state.placing || e.pointerType !== 'mouse') return;
      const g = $('#ghost');
      g.hidden = false;
      g.style.left = e.clientX + 'px';
      g.style.top = e.clientY + 'px';
    });
    $('#stage').addEventListener('pointerleave', () => { $('#ghost').hidden = true; });

    // nastavenia
    $('#tourName').addEventListener('input', (e) => {
      tour.name = cleanText(e.target.value, 80) || 'Moja prehliadka';
      saveSoon();
      renderChrome();
    });
    $('#btnNew').addEventListener('click', newTour);
    $('#btnReset').addEventListener('click', resetToOriginal);

    // klávesnica
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.placing) { cancelPlacing(); return; }
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
      if (state.mode === 'edit' && state.selectedHotspot && !typing && (e.key === 'Delete' || e.key === 'Backspace') && !document.querySelector('dialog[open]')) {
        e.preventDefault();
        removeHotspot(state.selectedHotspot);
      }
    });

    // presun súborov myšou
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    const veil = $('#dropVeil');
    window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; if (!VIEWER_ONLY) veil.hidden = false; });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) veil.hidden = true; });
    window.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      veil.hidden = true;
      if (VIEWER_ONLY) return;
      if (state.mode !== 'edit') await setMode('edit');
      addFiles(e.dataTransfer.files);
    });

    // po animácii bočného panela prispôsobiť veľkosť panorámy
    $('#app').addEventListener('transitionend', (e) => { if (e.target === $('#app') && viewer) viewer.autoSize(); });
  }

  /** Zistí, odkiaľ načítať prehliadku: lokálna kópia > publikovaný tour.json > vzorová prehliadka. */
  async function loadInitialTour() {
    if (!VIEWER_ONLY) {
      const local = Store.loadTour();
      if (local) {
        try { const t = normalizeTour(local); t.pin = typeof local.pin === 'string' ? local.pin : ''; return { tour: t, source: 'local' }; } catch (e) { /* poškodená kópia, ignorujeme */ }
      }
    }
    try {
      const res = await fetch(PUBLISHED_FILE, { cache: 'no-cache' });
      if (res.ok) {
        const raw = await res.json();
        if (PinCrypto.isEnvelope(raw)) return { envelope: raw, source: 'locked' };
        return { tour: normalizeTour(raw), source: 'published' };
      }
    } catch (e) { /* súbor neexistuje alebo sa nedá načítať – použijeme vzorovú prehliadku */ }
    return { tour: demoTour(), source: 'demo' };
  }

  async function boot() {
    document.body.classList.toggle('viewer-only', VIEWER_ONLY);
    buildDialTicks();
    bindUI();
    createViewer();

    const init = await loadInitialTour();
    state.source = init.source;
    if (init.envelope) {
      const res = await unlockScreen(init.envelope);
      tour = normalizeTour(res.config);
      tour.pin = res.pin;
      state.cipher = { key: res.key };
      await loadEncryptedThumbs();
    } else {
      tour = init.tour;
      if (init.source === 'local') await hydrateMedia();
    }

    renderAll();
    setTab('scenes');
    setSaveStatus('saved');
    if (tour.start) await goToScene(tour.start, { instant: true });

    if (!VIEWER_ONLY && state.source === 'demo') {
      let seen = false;
      try { seen = !!localStorage.getItem(LS_WELCOME); localStorage.setItem(LS_WELCOME, '1'); } catch (e) { /* nič */ }
      if (!seen) $('#dlgHelp').showModal();
    }
  }

  // malé rozhranie na ladenie a automatické testy
  window.Rozhlad = {
    get tour() { return tour; },
    get state() { return state; },
    get viewer() { return viewer; },
    goToScene,
    setMode,
    ready: null,
  };

  window.Rozhlad.ready = boot().catch((err) => {
    console.error(err);
    toast('Aplikáciu sa nepodarilo spustiť: ' + (err && err.message ? err.message : err), 'error', 8000);
  });
})();
