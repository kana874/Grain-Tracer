export const PROJECT_FORMAT = "graintracer-project";
export const PROJECT_VERSION = 1;
export const APP_VERSION = "0.3.6.7-alpha";
export const ALGORITHM_VERSION = "boundary-v9-extended-gap-topology-diagnostic";

export function packBinaryMask(mask) {
  const bytes = new Uint8Array(Math.ceil(mask.length / 8));
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) bytes[i >> 3] |= 1 << (i & 7);
  }
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function unpackBinaryMask(base64, length) {
  const binary = atob(base64 || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const mask = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) mask[i] = (bytes[i >> 3] >> (i & 7)) & 1;
  return mask;
}

async function digestHex(parts) {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }
  const digest = await crypto.subtle.digest("SHA-256", merged);
  return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, "0")).join("");
}

export async function fingerprintSource(file, header) {
  const sampleSize = 64 * 1024;
  const first = await file.slice(0, Math.min(file.size, sampleSize)).arrayBuffer();
  const middleStart = Math.max(0, Math.floor(file.size / 2) - Math.floor(sampleSize / 2));
  const middle = await file.slice(middleStart, Math.min(file.size, middleStart + sampleSize)).arrayBuffer();
  const tailStart = Math.max(0, file.size - sampleSize);
  const tail = await file.slice(tailStart, file.size).arrayBuffer();
  const meta = new TextEncoder().encode(`${file.size}|${header.width}|${header.height}|${header.bitDepth}`).buffer;
  return digestHex([meta, first, middle, tail]);
}

export function createProjectSnapshot(input) {
  const {
    source,
    preview,
    settings,
    referenceMask,
    referenceCenterline,
    negativeMask,
    manualNegativeMask,
    negativeCenterline,
    closedNegativeSeeds,
    exclusionRects,
    fullEvaluationRois,
    localCalibration,
    history,
  } = input;
  return {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_VERSION,
    appVersion: APP_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    savedAt: new Date().toISOString(),
    source,
    preview: { width: preview.width, height: preview.height, scale: preview.scale },
    settings,
    reference: {
      mask: packBinaryMask(referenceMask),
      centerline: packBinaryMask(referenceCenterline),
    },
    nonBoundary: {
      mask: packBinaryMask(manualNegativeMask ?? negativeMask ?? new Uint8Array(referenceMask.length)),
      centerline: packBinaryMask(negativeCenterline ?? new Uint8Array(referenceMask.length)),
      closedFillSeeds: (closedNegativeSeeds ?? []).map(seed => ({
        x: Math.round(seed.x),
        y: Math.round(seed.y),
        borderAssisted: Boolean(seed.borderAssisted),
      })),
    },
    exclusionRects: (exclusionRects ?? []).map(rect => ({ ...rect })),
    fullEvaluationRois: (fullEvaluationRois ?? []).map(rect => ({ ...rect })),
    localCalibration: localCalibration ?? null,
    history: history ?? [],
  };
}

export function validateProject(project) {
  if (!project || project.format !== PROJECT_FORMAT) throw new Error("GrainTracerプロジェクトではありません。");
  if (project.formatVersion !== PROJECT_VERSION) throw new Error(`未対応のプロジェクト形式です: ${project.formatVersion}`);
  if (!project.preview?.width || !project.preview?.height) throw new Error("プレビュー情報がありません。");
  return project;
}

export function restoreReferenceMasks(project) {
  validateProject(project);
  const length = project.preview.width * project.preview.height;
  return {
    referenceMask: unpackBinaryMask(project.reference?.mask, length),
    referenceCenterline: unpackBinaryMask(project.reference?.centerline, length),
    negativeMask: unpackBinaryMask(project.nonBoundary?.mask, length),
    negativeCenterline: unpackBinaryMask(project.nonBoundary?.centerline, length),
    closedNegativeSeeds: Array.isArray(project.nonBoundary?.closedFillSeeds)
      ? project.nonBoundary.closedFillSeeds.map(seed => ({
        x: Math.round(Number(seed.x)),
        y: Math.round(Number(seed.y)),
        borderAssisted: Boolean(seed.borderAssisted),
      })).filter(seed => Number.isFinite(seed.x) && Number.isFinite(seed.y))
      : [],
    exclusionRects: Array.isArray(project.exclusionRects)
      ? project.exclusionRects.map(rect => ({ ...rect }))
      : [],
    fullEvaluationRois: Array.isArray(project.fullEvaluationRois)
      ? project.fullEvaluationRois.map(rect => ({ ...rect }))
      : [],
  };
}

export function downloadProject(project, fileName) {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
