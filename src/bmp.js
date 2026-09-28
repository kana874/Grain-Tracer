const BI_RGB = 0;

export class BmpError extends Error {
  constructor(message) {
    super(message);
    this.name = "BmpError";
  }
}

export async function parseBmpHeader(file) {
  if (!(file instanceof Blob)) {
    throw new BmpError("BMPファイルを読み込めません。");
  }

  const headerBytes = Math.min(file.size, 256);
  const buffer = await file.slice(0, headerBytes).arrayBuffer();
  if (buffer.byteLength < 54) {
    throw new BmpError("BMPヘッダーが短すぎます。");
  }

  const view = new DataView(buffer);
  if (view.getUint8(0) !== 0x42 || view.getUint8(1) !== 0x4d) {
    throw new BmpError("BMP形式ではありません。先頭シグネチャ BM を確認できません。");
  }

  const declaredFileSize = view.getUint32(2, true);
  const pixelOffset = view.getUint32(10, true);
  const dibSize = view.getUint32(14, true);
  if (dibSize < 40) {
    throw new BmpError(`未対応のDIBヘッダーです (${dibSize} bytes)。`);
  }

  const width = view.getInt32(18, true);
  const signedHeight = view.getInt32(22, true);
  const planes = view.getUint16(26, true);
  const bitDepth = view.getUint16(28, true);
  const compression = view.getUint32(30, true);

  if (planes !== 1) {
    throw new BmpError(`未対応のBMP planes値です: ${planes}`);
  }
  if (width <= 0 || signedHeight === 0) {
    throw new BmpError(`不正な画像サイズです: ${width} x ${signedHeight}`);
  }
  if (![24, 32].includes(bitDepth)) {
    throw new BmpError(`現在は24-bit / 32-bit BMPのみ対応しています。入力: ${bitDepth}-bit`);
  }
  if (compression !== BI_RGB) {
    throw new BmpError(`現在は非圧縮BMP (BI_RGB) のみ対応しています。compression=${compression}`);
  }

  const topDown = signedHeight < 0;
  const height = Math.abs(signedHeight);
  const bytesPerPixel = bitDepth / 8;
  const rowStride = Math.floor((bitDepth * width + 31) / 32) * 4;
  const expectedPixelBytes = rowStride * height;

  if (pixelOffset + expectedPixelBytes > file.size) {
    throw new BmpError("BMPの画素領域がファイルサイズを超えています。破損または未対応形式の可能性があります。");
  }

  return {
    width,
    height,
    signedHeight,
    topDown,
    bitDepth,
    bytesPerPixel,
    compression,
    compressionName: "BI_RGB (非圧縮)",
    pixelOffset,
    rowStride,
    dibSize,
    declaredFileSize,
    actualFileSize: file.size,
    expectedPixelBytes,
  };
}

export function computePreviewSize(width, height, maxWidth = 1800, maxHeight = 1400) {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

export async function decodeBmpPreview(file, header, options = {}) {
  const maxWidth = options.maxWidth ?? 1800;
  const maxHeight = options.maxHeight ?? 1400;
  const onProgress = options.onProgress ?? (() => {});
  const signal = options.signal;
  const target = computePreviewSize(header.width, header.height, maxWidth, maxHeight);
  const rgba = new Uint8ClampedArray(target.width * target.height * 4);

  const xMap = new Uint32Array(target.width);
  for (let tx = 0; tx < target.width; tx += 1) {
    xMap[tx] = Math.min(header.width - 1, Math.floor((tx + 0.5) * header.width / target.width));
  }

  // Only rows represented in the preview are read. This prevents a 400+ MB source
  // BMP from being expanded into a full RGBA canvas in browser memory.
  for (let ty = 0; ty < target.height; ty += 1) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const sourceY = Math.min(header.height - 1, Math.floor((ty + 0.5) * header.height / target.height));
    const fileY = header.topDown ? sourceY : (header.height - 1 - sourceY);
    const rowStart = header.pixelOffset + fileY * header.rowStride;
    const rowBuffer = await file.slice(rowStart, rowStart + header.rowStride).arrayBuffer();
    const row = new Uint8Array(rowBuffer);

    let out = ty * target.width * 4;
    for (let tx = 0; tx < target.width; tx += 1) {
      const sx = xMap[tx];
      const source = sx * header.bytesPerPixel;
      rgba[out] = row[source + 2];
      rgba[out + 1] = row[source + 1];
      rgba[out + 2] = row[source];
      rgba[out + 3] = 255;
      out += 4;
    }

    if (ty % 20 === 0 || ty === target.height - 1) {
      onProgress((ty + 1) / target.height);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  return {
    imageData: new ImageData(rgba, target.width, target.height),
    width: target.width,
    height: target.height,
    scale: target.scale,
  };
}
