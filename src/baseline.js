function metricAtTolerance(multiTolerance, tolerance) {
  return (multiTolerance ?? []).find(item => Number(item?.tolerance) === tolerance) ?? null;
}

export function buildBaselineSnapshot(input = {}) {
  const {
    sourceFingerprint = null,
    appVersion = null,
    algorithmVersion = null,
    generatedAt = new Date().toISOString(),
    multiTolerance = [],
    metrics = null,
    fullEvaluationRoi = null,
    topology = null,
    boundaryPixelCount = 0,
    unknownPredictionCount = null,
    evaluationRoles = null,
    imageEvaluationRole = null,
  } = input;

  const recall = {};
  for (const tolerance of [1, 2, 3, 4]) {
    recall[`at${tolerance}px`] = metricAtTolerance(multiTolerance, tolerance)?.positiveRecall ?? null;
  }

  const profile = topology?.regionClosure?.profile ?? null;
  const base = topology?.regionClosure ?? null;

  return {
    schema: "graintracer-baseline-v1",
    generatedAt,
    sourceFingerprint,
    appVersion,
    algorithmVersion,
    imageEvaluationRole,
    evaluationRoles,
    positiveRecall: recall,
    negativeLeakage: metrics?.negativeLeakage ?? null,
    macroNegativeLeakage: metrics?.macroNegativeLeakage ?? null,
    verifiedRoi: {
      roiCount: fullEvaluationRoi?.roiCount ?? 0,
      precision: fullEvaluationRoi?.roiCount ? fullEvaluationRoi.precision : null,
      recall: fullEvaluationRoi?.roiCount ? fullEvaluationRoi.recall : null,
      f1: fullEvaluationRoi?.roiCount ? fullEvaluationRoi.f1 : null,
    },
    alignmentError: {
      mean: metrics?.alignmentError?.mean ?? null,
      median: metrics?.alignmentError?.median ?? null,
      p90: metrics?.alignmentError?.p90 ?? null,
    },
    topology: {
      weightedClosureScore: profile?.weightedClosureScore ?? null,
      meanRequiredRadius: profile?.meanRequiredRadiusCapped ?? null,
      openAt3: profile?.maxRadius === 3 ? profile.openAfterMaxRadius : null,
      exactClosureRate: base?.baseClosureRate ?? null,
      exactClosedRegions: base?.baseClosedRegions ?? null,
      exactOpenRegions: base?.baseOpenRegions ?? null,
    },
    boundaryPixelCount: Number(boundaryPixelCount) || 0,
    unknownPredictionCount: unknownPredictionCount ?? metrics?.unknownPrediction ?? null,
  };
}

export function baselineKey(snapshot) {
  return [
    snapshot?.sourceFingerprint ?? "unknown",
    snapshot?.algorithmVersion ?? "unknown",
    snapshot?.appVersion ?? "unknown",
  ].join("|");
}
