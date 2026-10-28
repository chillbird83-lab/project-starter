// Minimal ZIP writer/reader for backups. Files are stored uncompressed (audio is already compressed),
// so a backup opens with any unzip tool and the recordings play as normal files.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const MAX = 0xffffffff;

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Builds a ZIP Blob from [{ name, data: Blob | string, date? }]. Reads each file once (for its checksum)
 * but keeps references to the original Blobs, so large recordings are not copied in memory.
 */
export async function makeZip(files, { onProgress } = {}) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const blob = typeof f.data === 'string' ? new Blob([f.data]) : f.data;
    const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
    const name = enc.encode(f.name);
    const { time, date } = dosTime(f.date ?? new Date());
    if (offset + 30 + name.length + blob.size > MAX) throw new Error('Backup is larger than 4 GB');

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, blob.size, true);
    local.setUint32(22, blob.size, true);
    local.setUint16(26, name.length, true);
    parts.push(local.buffer, name, blob);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, blob.size, true);
    cd.setUint32(24, blob.size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd.buffer, name);

    offset += 30 + name.length + blob.size;
    onProgress?.((i + 1) / files.length);
  }
  const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

/**
 * Reads the file list of an uncompressed ZIP (like the ones makeZip writes).
 * Returns Map(name → Blob slice); throws on anything it cannot read.
 */
export async function readZip(blob) {
  const tailSize = Math.min(blob.size, 22 + 0xffff);
  const tail = new DataView(await blob.slice(blob.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  const cd = new DataView(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const out = new Map();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged ZIP file');
    const method = cd.getUint16(p + 10, true);
    const size = cd.getUint32(p + 20, true);
    const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
    const local = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    if (method !== 0) throw new Error('Compressed ZIP files are not supported');
    const head = new DataView(await blob.slice(local, local + 30).arrayBuffer());
    if (head.getUint32(0, true) !== 0x04034b50) throw new Error('Damaged ZIP file');
    const start = local + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    out.set(name, blob.slice(start, start + size));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
