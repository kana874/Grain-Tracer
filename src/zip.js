const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const ZIP_VERSION = 20;
const UINT32_MAX = 0xffffffff;

let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

function crc32(bytes) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  return {
    time: ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f),
  };
}

function writeU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

async function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  throw new TypeError("ZIP entry data must be a Blob, string, Uint8Array, or ArrayBuffer.");
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error("ZIPに追加するファイルがありません。");
  }
  if (entries.length > 0xffff) {
    throw new Error("ZIP32のファイル数上限を超えています。");
  }
  const seen = new Set();
  for (const entry of entries) {
    if (!entry?.name || typeof entry.name !== "string") {
      throw new Error("ZIP entry name is required.");
    }
    if (seen.has(entry.name)) {
      throw new Error(`ZIP entry name is duplicated: ${entry.name}`);
    }
    seen.add(entry.name);
  }
}

export async function buildStoredZip(entries, options = {}) {
  validateEntries(entries);
  const encoder = new TextEncoder();
  const modifiedAt = options.modifiedAt ?? new Date();
  const prepared = [];

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const bytes = await toUint8Array(entry.data);
    if (nameBytes.length > 0xffff) {
      throw new Error(`ZIP entry name is too long: ${entry.name}`);
    }
    if (bytes.byteLength > UINT32_MAX) {
      throw new Error(`ZIP32のファイルサイズ上限を超えています: ${entry.name}`);
    }
    prepared.push({
      ...entry,
      nameBytes,
      bytes,
      crc: crc32(bytes),
      modifiedAt: entry.modifiedAt ?? modifiedAt,
    });
  }

  const chunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of prepared) {
    const stamp = dosDateTime(entry.modifiedAt);
    const local = new Uint8Array(30 + entry.nameBytes.length);
    const view = new DataView(local.buffer);
    writeU32(view, 0, 0x04034b50);
    writeU16(view, 4, ZIP_VERSION);
    writeU16(view, 6, UTF8_FLAG);
    writeU16(view, 8, STORE_METHOD);
    writeU16(view, 10, stamp.time);
    writeU16(view, 12, stamp.date);
    writeU32(view, 14, entry.crc);
    writeU32(view, 18, entry.bytes.byteLength);
    writeU32(view, 22, entry.bytes.byteLength);
    writeU16(view, 26, entry.nameBytes.length);
    writeU16(view, 28, 0);
    local.set(entry.nameBytes, 30);

    const central = new Uint8Array(46 + entry.nameBytes.length);
    const centralView = new DataView(central.buffer);
    writeU32(centralView, 0, 0x02014b50);
    writeU16(centralView, 4, ZIP_VERSION);
    writeU16(centralView, 6, ZIP_VERSION);
    writeU16(centralView, 8, UTF8_FLAG);
    writeU16(centralView, 10, STORE_METHOD);
    writeU16(centralView, 12, stamp.time);
    writeU16(centralView, 14, stamp.date);
    writeU32(centralView, 16, entry.crc);
    writeU32(centralView, 20, entry.bytes.byteLength);
    writeU32(centralView, 24, entry.bytes.byteLength);
    writeU16(centralView, 28, entry.nameBytes.length);
    writeU16(centralView, 30, 0);
    writeU16(centralView, 32, 0);
    writeU16(centralView, 34, 0);
    writeU16(centralView, 36, 0);
    writeU32(centralView, 38, 0);
    writeU32(centralView, 42, offset);
    central.set(entry.nameBytes, 46);

    chunks.push(local, entry.bytes);
    centralChunks.push(central);
    offset += local.byteLength + entry.bytes.byteLength;
    if (offset > UINT32_MAX) {
      throw new Error("ZIP32の合計サイズ上限を超えています。");
    }
  }

  const centralOffset = offset;
  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (centralSize > UINT32_MAX || centralOffset + centralSize > UINT32_MAX) {
    throw new Error("ZIP32のCentral Directory上限を超えています。");
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeU32(endView, 0, 0x06054b50);
  writeU16(endView, 4, 0);
  writeU16(endView, 6, 0);
  writeU16(endView, 8, prepared.length);
  writeU16(endView, 10, prepared.length);
  writeU32(endView, 12, centralSize);
  writeU32(endView, 16, centralOffset);
  writeU16(endView, 20, 0);

  return new Blob([...chunks, ...centralChunks, end], { type: "application/zip" });
}
