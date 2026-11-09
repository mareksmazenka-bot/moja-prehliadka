/*
 * Rozhľad – minimálna podpora ZIP súborov (bez externých knižníc)
 *
 *   Zip.create([{ name, data }])  -> Promise<Blob>      (metóda "store", bez kompresie; JPG/PNG sú už komprimované)
 *   Zip.read(blobAleboBuffer)     -> Promise<Entry[]>   (podporuje store aj deflate; deflate cez DecompressionStream)
 *
 * Entry: { name, isDir, bytes(): Promise<Uint8Array> }
 */
(function (global) {
  'use strict';

  const te = new TextEncoder();
  const td = new TextDecoder();

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosTime(d) {
    return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  }
  function dosDate(d) {
    return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  }

  async function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (typeof data === 'string') return te.encode(data);
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    throw new Error('Nepodporovaný typ údajov pre ZIP.');
  }

  async function create(entries) {
    const now = new Date();
    const time = dosTime(now);
    const date = dosDate(now);
    const parts = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
      const name = te.encode(entry.name);
      const bytes = await toBytes(entry.data);
      const crc = crc32(bytes);

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true); // názvy v UTF-8
      lh.setUint16(8, 0, true); // store
      lh.setUint16(10, time, true);
      lh.setUint16(12, date, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, bytes.length, true);
      lh.setUint32(22, bytes.length, true);
      lh.setUint16(26, name.length, true);
      lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, bytes);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, time, true);
      ch.setUint16(14, date, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, bytes.length, true);
      ch.setUint32(24, bytes.length, true);
      ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);

      offset += 30 + name.length + bytes.length;
    }

    let cdSize = 0;
    for (const c of central) cdSize += c.length;
    if (entries.length > 0xffff || offset + cdSize > 0xffffffff) {
      throw new Error('Balík je príliš veľký na ZIP (limit 4 GB).');
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Tento prehliadač nevie rozbaliť komprimovaný ZIP. Použite novší prehliadač alebo ZIP vytvorený cez Rozhľad.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function read(source) {
    const buf = source instanceof ArrayBuffer ? source : await source.arrayBuffer();
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);

    // koniec centrálneho adresára
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65535); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Súbor nie je platný ZIP.');
    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);

    const entries = [];
    for (let n = 0; n < count; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) throw new Error('Poškodený ZIP (centrálny adresár).');
      const method = view.getUint16(p + 10, true);
      const csize = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      const name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (csize === 0xffffffff || localOffset === 0xffffffff) throw new Error('ZIP64 nie je podporovaný.');

      entries.push({
        name,
        isDir: name.endsWith('/'),
        async bytes() {
          const ln = view.getUint16(localOffset + 26, true);
          const le = view.getUint16(localOffset + 28, true);
          const start = localOffset + 30 + ln + le;
          const raw = u8.subarray(start, start + csize);
          if (method === 0) return raw;
          if (method === 8) return inflateRaw(raw);
          throw new Error('Nepodporovaná kompresia v ZIP súbore.');
        },
      });
    }
    return entries;
  }

  global.Zip = { create, read, crc32 };
})(window);
