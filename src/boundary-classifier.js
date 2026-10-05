export const CLASSIFIER_SCHEMA = "graintracer-boundary-logreg-v1";

export const CLASSIFIER_FEATURES = Object.freeze([
  "dark",
  "ridge",
  "color",
  "dendriteDifference",
  "dendriteLinePenalty",
  "coherence",
  "ridgeScale",
]);

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function sigmoid(value) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function featureVectorAt(features, p, ridgeScaleDivisor = 2) {
  return [
    (features.dark?.[p] ?? 0) / 255,
    (features.ridge?.[p] ?? 0) / 255,
    (features.color?.[p] ?? 0) / 255,
    (features.dendrite?.[p] ?? 0) / 255,
    (features.dendriteLinePenalty?.[p] ?? 0) / 255,
    (features.dendriteCoherence?.[p] ?? 0) / 255,
    clamp01((features.ridgeScale?.[p] ?? 0) / Math.max(1, ridgeScaleDivisor)),
  ];
}

function deterministicSubsample(indices, limit) {
  if (indices.length <= limit) return indices;
  const out = new Array(limit);
  const step = indices.length / limit;
  for (let i = 0; i < limit; i += 1) {
    out[i] = indices[Math.min(indices.length - 1, Math.floor((i + 0.5) * step))];
  }
  return out;
}

function collectLabelIndices(labelMask, roiMask, exclusionMask = null) {
  const out = [];
  if (!labelMask) return out;
  for (let p = 0; p < labelMask.length; p += 1) {
    if (!labelMask[p]) continue;
    if (roiMask && !roiMask[p]) continue;
    if (exclusionMask?.[p]) continue;
    out.push(p);
  }
  return out;
}

export function buildRoiMask(width, height, rois = []) {
  const mask = new Uint8Array(width * height);
  for (const rect of rois ?? []) {
    if (!rect || rect.verified === false) continue;
    const x0 = Math.max(0, Math.min(width - 1, Math.round(Math.min(rect.x0, rect.x1))));
    const x1 = Math.max(0, Math.min(width - 1, Math.round(Math.max(rect.x0, rect.x1))));
    const y0 = Math.max(0, Math.min(height - 1, Math.round(Math.min(rect.y0, rect.y1))));
    const y1 = Math.max(0, Math.min(height - 1, Math.round(Math.max(rect.y0, rect.y1))));
    for (let y = y0; y <= y1; y += 1) {
      mask.fill(1, y * width + x0, y * width + x1 + 1);
    }
  }
  return mask;
}

export function trainLogisticBoundaryClassifier(features, positiveMask, negativeMask, options = {}) {
  const length = features.width * features.height;
  if (!positiveMask || positiveMask.length !== length) {
    throw new Error("Classifier学習用Positive maskが不正です。");
  }
  if (!negativeMask || negativeMask.length !== length) {
    throw new Error("Classifier学習用Negative maskが不正です。");
  }

  const roiMask = options.roiMask ?? null;
  const exclusionMask = options.exclusionMask ?? null;
  const maxSamplesPerClass = Math.max(64, Math.round(options.maxSamplesPerClass ?? 12000));
  const minSamplesPerClass = Math.max(8, Math.round(options.minSamplesPerClass ?? 24));
  const iterations = Math.max(20, Math.min(800, Math.round(options.iterations ?? 220)));
  const learningRate = Math.max(0.001, Math.min(1, Number(options.learningRate ?? 0.14)));
  const l2 = Math.max(0, Number(options.l2 ?? 0.002));

  const allPositive = collectLabelIndices(positiveMask, roiMask, exclusionMask);
  const allNegative = collectLabelIndices(negativeMask, roiMask, exclusionMask);
  if (allPositive.length < minSamplesPerClass || allNegative.length < minSamplesPerClass) {
    throw new Error(`Classifier学習データ不足です。Positive ${allPositive.length} / Negative ${allNegative.length}（各${minSamplesPerClass}以上必要）`);
  }

  const balancedLimit = Math.min(maxSamplesPerClass, allPositive.length, allNegative.length);
  const positive = deterministicSubsample(allPositive, balancedLimit);
  const negative = deterministicSubsample(allNegative, balancedLimit);
  const ridgeScaleDivisor = Math.max(1, options.ridgeScaleDivisor ?? 2);
  const sampleCount = positive.length + negative.length;
  const featureCount = CLASSIFIER_FEATURES.length;
  const means = new Float64Array(featureCount);
  const variances = new Float64Array(featureCount);

  const accumulate = (indices) => {
    for (const p of indices) {
      const vector = featureVectorAt(features, p, ridgeScaleDivisor);
      for (let j = 0; j < featureCount; j += 1) means[j] += vector[j];
    }
  };
  accumulate(positive);
  accumulate(negative);
  for (let j = 0; j < featureCount; j += 1) means[j] /= sampleCount;

  const accumulateVariance = (indices) => {
    for (const p of indices) {
      const vector = featureVectorAt(features, p, ridgeScaleDivisor);
      for (let j = 0; j < featureCount; j += 1) {
        const delta = vector[j] - means[j];
        variances[j] += delta * delta;
      }
    }
  };
  accumulateVariance(positive);
  accumulateVariance(negative);
  const stds = Array.from(variances, value => Math.sqrt(value / sampleCount) || 1);
  const coefficients = new Float64Array(featureCount);
  let bias = 0;

  const trainIndices = positive.concat(negative);
  const labels = new Uint8Array(sampleCount);
  labels.fill(1, 0, positive.length);

  for (let iter = 0; iter < iterations; iter += 1) {
    const grad = new Float64Array(featureCount);
    let gradBias = 0;
    for (let i = 0; i < sampleCount; i += 1) {
      const vector = featureVectorAt(features, trainIndices[i], ridgeScaleDivisor);
      let z = bias;
      for (let j = 0; j < featureCount; j += 1) {
        z += coefficients[j] * ((vector[j] - means[j]) / stds[j]);
      }
      const error = sigmoid(z) - labels[i];
      gradBias += error;
      for (let j = 0; j < featureCount; j += 1) {
        grad[j] += error * ((vector[j] - means[j]) / stds[j]);
      }
    }
    bias -= learningRate * gradBias / sampleCount;
    for (let j = 0; j < featureCount; j += 1) {
      coefficients[j] -= learningRate * (grad[j] / sampleCount + l2 * coefficients[j]);
    }
  }

  return {
    schema: CLASSIFIER_SCHEMA,
    featureNames: [...CLASSIFIER_FEATURES],
    means: Array.from(means),
    stds,
    coefficients: Array.from(coefficients),
    bias,
    ridgeScaleDivisor,
    sampleCounts: {
      positiveAvailable: allPositive.length,
      negativeAvailable: allNegative.length,
      positiveUsed: positive.length,
      negativeUsed: negative.length,
    },
    training: {
      iterations,
      learningRate,
      l2,
      balanced: true,
      unknownUsed: false,
    },
    trainedAt: new Date().toISOString(),
  };
}

export function isUsableClassifierModel(model) {
  return Boolean(
    model
    && model.schema === CLASSIFIER_SCHEMA
    && Array.isArray(model.coefficients)
    && model.coefficients.length === CLASSIFIER_FEATURES.length
    && Array.isArray(model.means)
    && model.means.length === CLASSIFIER_FEATURES.length
    && Array.isArray(model.stds)
    && model.stds.length === CLASSIFIER_FEATURES.length
    && Number.isFinite(model.bias),
  );
}

export function predictBoundaryProbability(features, p, model) {
  if (!isUsableClassifierModel(model)) return null;
  const vector = featureVectorAt(features, p, model.ridgeScaleDivisor ?? 2);
  let z = model.bias;
  for (let j = 0; j < model.coefficients.length; j += 1) {
    const std = Math.max(1e-8, Number(model.stds[j]) || 1);
    z += Number(model.coefficients[j]) * ((vector[j] - Number(model.means[j] ?? 0)) / std);
  }
  return sigmoid(z);
}

export function buildClassifierProbabilityMap(features, model) {
  if (!isUsableClassifierModel(model)) {
    throw new Error("利用可能なClassifier modelがありません。");
  }
  const out = new Float32Array(features.width * features.height);
  for (let p = 0; p < out.length; p += 1) {
    out[p] = predictBoundaryProbability(features, p, model) ?? 0;
  }
  return out;
}

export function maskedNegativeLeakage(prediction, negativeMask, roiMask = null, exclusionMask = null) {
  if (!negativeMask) return { leakage: 0, negativePixels: 0, predictedPixels: 0 };
  let negativePixels = 0;
  let predictedPixels = 0;
  for (let p = 0; p < negativeMask.length; p += 1) {
    if (!negativeMask[p]) continue;
    if (roiMask && !roiMask[p]) continue;
    if (exclusionMask?.[p]) continue;
    negativePixels += 1;
    if (prediction[p]) predictedPixels += 1;
  }
  return {
    leakage: negativePixels ? predictedPixels / negativePixels : 0,
    negativePixels,
    predictedPixels,
  };
}

export function evaluateClassifierGuard(baseline, candidate, options = {}) {
  const maxRecallDrop = Number(options.maxRecallDrop ?? 0.02);
  const maxF1Drop = Number(options.maxF1Drop ?? 0.005);
  const maxClosureDrop = Number(options.maxClosureDrop ?? 0.02);
  const maxOpenIncrease = Math.max(0, Math.round(options.maxOpenIncrease ?? 1));
  const minLeakageImprovement = Number(options.minLeakageImprovement ?? 0.001);

  const recallOk = candidate.recall >= baseline.recall - maxRecallDrop;
  const f1Ok = candidate.f1 >= baseline.f1 - maxF1Drop;
  const baselineLeakage = baseline.negativeLeakage ?? 0;
  const candidateLeakage = candidate.negativeLeakage ?? 0;
  const leakageImprovement = baselineLeakage - candidateLeakage;
  const leakageOk = baselineLeakage <= minLeakageImprovement
    ? candidateLeakage <= baselineLeakage + 1e-9
    : leakageImprovement >= minLeakageImprovement;

  let topologyOk = true;
  const topologyReasons = [];
  if (baseline.topology && candidate.topology) {
    const baseScore = baseline.topology.weightedClosureScore;
    const candidateScore = candidate.topology.weightedClosureScore;
    if (Number.isFinite(baseScore) && Number.isFinite(candidateScore)
      && candidateScore < baseScore - maxClosureDrop) {
      topologyOk = false;
      topologyReasons.push("weighted-closure-drop");
    }
    const baseOpen = baseline.topology.openAfterMaxRadius;
    const candidateOpen = candidate.topology.openAfterMaxRadius;
    if (Number.isFinite(baseOpen) && Number.isFinite(candidateOpen)
      && candidateOpen > baseOpen + maxOpenIncrease) {
      topologyOk = false;
      topologyReasons.push("open-at-max-increase");
    }
  }

  const reasons = [];
  if (!recallOk) reasons.push("validation-recall-drop");
  if (!f1Ok) reasons.push("validation-f1-drop");
  if (!leakageOk) reasons.push("validation-negative-leakage-not-improved");
  if (!topologyOk) reasons.push(...topologyReasons);

  return {
    accepted: reasons.length === 0,
    reasons,
    thresholds: {
      maxRecallDrop,
      maxF1Drop,
      minLeakageImprovement,
      maxClosureDrop,
      maxOpenIncrease,
    },
    delta: {
      recall: candidate.recall - baseline.recall,
      f1: candidate.f1 - baseline.f1,
      negativeLeakage: candidateLeakage - baselineLeakage,
      weightedClosureScore: Number.isFinite(candidate.topology?.weightedClosureScore)
        && Number.isFinite(baseline.topology?.weightedClosureScore)
        ? candidate.topology.weightedClosureScore - baseline.topology.weightedClosureScore
        : null,
      openAfterMaxRadius: Number.isFinite(candidate.topology?.openAfterMaxRadius)
        && Number.isFinite(baseline.topology?.openAfterMaxRadius)
        ? candidate.topology.openAfterMaxRadius - baseline.topology.openAfterMaxRadius
        : null,
    },
  };
}
