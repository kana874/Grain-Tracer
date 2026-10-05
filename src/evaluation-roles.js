export const ROI_EVALUATION_ROLES = Object.freeze(["training", "validation", "test"]);
export const IMAGE_EVALUATION_ROLES = Object.freeze(["development", "validation", "test"]);

export function normalizeRoiEvaluationRole(value) {
  return ROI_EVALUATION_ROLES.includes(value) ? value : null;
}

export function normalizeImageEvaluationRole(value) {
  return IMAGE_EVALUATION_ROLES.includes(value) ? value : null;
}

export function verifiedEvaluationRois(rois) {
  return (rois ?? []).filter(rect => rect?.verified !== false);
}

export function partitionEvaluationRois(rois) {
  const result = {
    training: [],
    validation: [],
    test: [],
    legacy: [],
    provisional: [],
  };
  for (const rect of rois ?? []) {
    if (!rect || rect.verified === false) {
      if (rect) result.provisional.push(rect);
      continue;
    }
    const role = normalizeRoiEvaluationRole(rect.evaluationRole);
    if (role) result[role].push(rect);
    else result.legacy.push(rect);
  }
  return result;
}

export function trainingEvaluationRois(rois) {
  const parts = partitionEvaluationRois(rois);
  // Legacy ROIs intentionally retain pre-Batch-1 behaviour until the user
  // explicitly assigns a role, preserving old project compatibility.
  return [...parts.training, ...parts.legacy];
}

export function validationEvaluationRois(rois) {
  return partitionEvaluationRois(rois).validation;
}

export function testEvaluationRois(rois) {
  return partitionEvaluationRois(rois).test;
}

export function guardEvaluationRois(rois) {
  const parts = partitionEvaluationRois(rois);
  // Validation is the preferred guard set. When none exists, use the
  // development/training set for backward-compatible operation. Test is never
  // included in parameter selection or guards.
  return parts.validation.length
    ? parts.validation
    : [...parts.training, ...parts.legacy];
}

export function summarizeEvaluationRoles(rois) {
  const parts = partitionEvaluationRois(rois);
  return {
    training: parts.training.length,
    validation: parts.validation.length,
    test: parts.test.length,
    legacyUnassigned: parts.legacy.length,
    provisional: parts.provisional.length,
    verifiedTotal: parts.training.length + parts.validation.length + parts.test.length + parts.legacy.length,
  };
}

export function maskExcludingRois(mask, width, height, rois) {
  if (!mask) return null;
  const result = mask.slice();
  for (const rect of rois ?? []) {
    if (!rect) continue;
    const x0 = Math.max(0, Math.min(width - 1, Math.round(Math.min(rect.x0, rect.x1))));
    const x1 = Math.max(0, Math.min(width - 1, Math.round(Math.max(rect.x0, rect.x1))));
    const y0 = Math.max(0, Math.min(height - 1, Math.round(Math.min(rect.y0, rect.y1))));
    const y1 = Math.max(0, Math.min(height - 1, Math.round(Math.max(rect.y0, rect.y1))));
    for (let y = y0; y <= y1; y += 1) {
      const start = y * width + x0;
      const end = y * width + x1 + 1;
      result.fill(0, start, end);
    }
  }
  return result;
}

export function tuningExcludedRois(rois) {
  const parts = partitionEvaluationRois(rois);
  return [...parts.validation, ...parts.test, ...parts.provisional];
}

export function guardExcludedRois(rois) {
  const parts = partitionEvaluationRois(rois);
  return [...parts.test, ...parts.provisional];
}

export function canTuneImage(imageRole) {
  return normalizeImageEvaluationRole(imageRole) !== "test";
}
