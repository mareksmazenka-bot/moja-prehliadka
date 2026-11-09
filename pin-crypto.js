/*
 * Rozhľad – šifrovanie projektu PINom
 *
 * Statický web nemá server, ktorý by PIN overoval, preto sa PIN používa ako kľúč
 * na skutočné šifrovanie dát: kľúč vznikne z PINu cez PBKDF2-SHA256 (600 000 iterácií)
 * a dáta sa šifrujú AES-256-GCM (Web Crypto API). Bez správneho PINu sa fotky ani
 * nastavenia prehliadky nedajú prečítať ani po stiahnutí súborov z repozitára.
 *
 * Formát šifrovaného súboru (.enc):  "RZH1" | IV (12 B) | šifrový text + autentifikačný tag
 * Formát tour.json pri ochrane PINom: obálka { format, version, kdf{salt,iterations}, data }
 *
 * Poznámka: sila ochrany závisí od dĺžky PINu. Krátky číselný PIN odradí náhodných
 * návštevníkov, ale cielený útočník, ktorý si stiahne šifrované súbory, ho dokáže
 * vyskúšať hrubou silou. Pre skutočné súkromie používajte aspoň 8 znakov.
 */
(function (global) {
  'use strict';

  const MAGIC = [0x52, 0x5a, 0x48, 0x31]; // "RZH1"
  const ITERATIONS = 600000;
  const MIN_ITER = 100000;
  const MAX_ITER = 5000000;
  const FORMAT = 'rozhlad-encrypted';
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function available() {
    return !!(global.crypto && global.crypto.subtle && global.isSecureContext !== false);
  }

  function b64encode(bytes) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  function b64decode(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function normalizePin(pin) {
    return String(pin || '').trim().normalize('NFKC');
  }

  async function deriveKey(pin, salt, iterations) {
    const material = await global.crypto.subtle.importKey(
      'raw', enc.encode(normalizePin(pin)), 'PBKDF2', false, ['deriveKey']);
    return global.crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function encryptBytes(key, bytes) {
    const iv = global.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await global.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
    const out = new Uint8Array(16 + ct.length);
    out.set(MAGIC, 0);
    out.set(iv, 4);
    out.set(ct, 16);
    return out;
  }

  async function decryptBytes(key, data) {
    if (data.length < 33 || MAGIC.some((b, i) => data[i] !== b)) {
      throw new Error('BAD_FORMAT');
    }
    try {
      const plain = await global.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: data.subarray(4, 16) }, key, data.subarray(16));
      return new Uint8Array(plain);
    } catch (e) {
      throw new Error('BAD_PIN');
    }
  }

  function isEnvelope(obj) {
    return !!obj && typeof obj === 'object' && obj.format === FORMAT &&
      typeof obj.data === 'string' && obj.kdf && typeof obj.kdf.salt === 'string';
  }

  /** Zašifruje konfiguráciu prehliadky. Vráti obálku (pre tour.json) a kľúč na šifrovanie súborov. */
  async function sealTour(config, pin) {
    const salt = global.crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(pin, salt, ITERATIONS);
    const data = await encryptBytes(key, enc.encode(JSON.stringify(config)));
    const envelope = {
      format: FORMAT,
      version: 1,
      cipher: 'AES-256-GCM',
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: b64encode(salt) },
      data: b64encode(data),
    };
    return { envelope, key };
  }

  /** Otvorí obálku pomocou PINu. Pri zlom PINe vyhodí Error('BAD_PIN'). */
  async function openEnvelope(envelope, pin) {
    const iterations = Math.min(MAX_ITER, Math.max(MIN_ITER, Number(envelope.kdf.iterations) || ITERATIONS));
    const key = await deriveKey(pin, b64decode(envelope.kdf.salt), iterations);
    const plain = await decryptBytes(key, b64decode(envelope.data));
    return { config: JSON.parse(dec.decode(plain)), key };
  }

  /** Odhad sily PINu pre nápovedu v rozhraní. */
  function strength(pin) {
    const p = normalizePin(pin);
    if (p.length < 4) return 'short';
    if (/^\d+$/.test(p) && p.length < 8) return 'weak';
    if (p.length < 8) return 'fair';
    return 'good';
  }

  global.PinCrypto = { available, encryptBytes, decryptBytes, isEnvelope, sealTour, openEnvelope, strength, normalizePin, ITERATIONS };
})(window);
