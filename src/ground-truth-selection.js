// Fractions refer to area, so each side scales by 1 / sqrt(denominator).
// Integer source pixels introduce at most half a pixel of rounding per side.
export function cropSizeForArea(width, height, denominator) {
  if (![width, height, denominator].every(Number.isInteger) || width < 1 || height < 1 || denominator < 8 || denominator > 32) {
    throw new Error('範囲サイズは元画像の面積の1/8〜1/32で指定してください。');
  }
  const scale = 1 / Math.sqrt(denominator);
  return {width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale))};
}

export function positionCrop(width, height, size, x, y) {
  return {
    x: Math.max(0, Math.min(width - size.width, Math.round(x))),
    y: Math.max(0, Math.min(height - size.height, Math.round(y))),
    width: size.width, height: size.height,
  };
}

export function resizeCropForArea(width, height, crop, denominator) {
  const size = cropSizeForArea(width, height, denominator);
  return positionCrop(width, height, size, crop.x + (crop.width - size.width) / 2, crop.y + (crop.height - size.height) / 2);
}

export function previewToSource(clientX, clientY, bounds, width, height) {
  return {
    x: Math.max(0, Math.min(width, (clientX - bounds.left) * width / bounds.width)),
    y: Math.max(0, Math.min(height, (clientY - bounds.top) * height / bounds.height)),
  };
}
