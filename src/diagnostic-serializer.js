// Protect diagnostic export from unexpectedly large nested arrays, typed
// pixel buffers, and JSON.stringify's V8 "Invalid string length" failure.
// Binary images are exported separately as PNG/JPEG, never embedded in JSON.
const DEFAULT_MAX_TEXT = 24 * 1024 * 1024;
const arraySampleLimit = 1500;
const maxTextField = 200000;
function truncatedValue(what, total, exported) {
  return { diagnosticOmitted: what, totalItems: total, exportedItems: exported };
}
export function serializeDiagnosticJson(report, options = {}) {
  const maxLength = Math.max(4096, Number(options.maxLength ?? DEFAULT_MAX_TEXT));
  const notes = [];
  let visited = 0;
  const replacer = (key, value) => {
    visited++;
    if (visited > 600000) {
      // A pathological object often comes from a mask serialized as indexed
      // properties. Do not try to stringify hundreds of megabytes.
      throw new RangeError('diagnostic JSON node limit exceeded');
    }
    if (ArrayBuffer.isView(value)) {
      notes.push('binary array skipped: ' + key);
      return { diagnosticOmitted:'binary-image-buffer',type:value.constructor?.name ?? 'TypedArray',
        length:value.length ?? value.byteLength };
    }
    if (value instanceof ArrayBuffer) {
      notes.push('ArrayBuffer skipped: ' + key);
      return { diagnosticOmitted:'ArrayBuffer',byteLength:value.byteLength };
    }
    if (Array.isArray(value) && value.length > arraySampleLimit) {
      notes.push('array truncated: ' + key);
      return [...value.slice(0,arraySampleLimit),truncatedValue('array-tail',value.length,arraySampleLimit)];
    }
    if (typeof value === 'string' && value.length > maxTextField) {
      notes.push('string truncated: ' + key);
      return value.slice(0,maxTextField) + '[...diagnostic string truncated; original '+value.length+' chars]';
    }
    return value;
  };
  function encode(input) {return JSON.stringify(input, replacer);}
  let json, fallback = false;
  try {
    json = encode(report);
    if (json.length > maxLength) throw new RangeError('diagnostic JSON size limit exceeded');
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    fallback=true;
    notes.push('Reduced diagnostic used: '+error.message);
    // Retain verifiable evaluation, extraction settings and annotation logs,
    // and omit optional heavyweight topological paths and tuning traces.
    const reduced = { ...report,
      topology:{ diagnosticOmitted:'oversized-topology', availableInFullReport:false },
      topologyGraph:{ diagnosticOmitted:'oversized-skeleton-graph' },
      tuningTrace:{ diagnosticOmitted:'oversized-tuning-trace' },
      regionSegmentation:{ diagnosticOmitted:'oversized-region-detail' },
      repairPaths:{ diagnosticOmitted:'oversized-path-detail' },
      postProcessing:{ diagnosticOmitted:'oversized-postprocessing-detail' },
      hotspots:{ diagnosticOmitted:'oversized-hotspots' },
      localCalibration:{ diagnosticOmitted:'oversized-calibration-detail' },
    };
    json = encode(reduced);
    if (json.length > maxLength) {
      const essential = {
        schema:report.schema, generatedAt:report.generatedAt,appVersion:report.appVersion,
        algorithmVersion:report.algorithmVersion,source:report.source,preview:report.preview,
        settings:report.settings,evaluation:report.evaluation,referenceCoverage:report.referenceCoverage,
        evaluationRoles:report.evaluationRoles,
        localAbReview:report.localAbReview,preferenceAdoption:report.preferenceAdoption,
        feedbackReview:report.feedbackReview,
        diagnosticExport:{fallback:'essential-fields-only',reason:'oversized diagnostic document'},
      };
      json=encode(essential);
      if (json.length > maxLength) throw new RangeError(
        '診断JSONの縮小版も上限を超過しました。');
    }
  }
  if (!json) throw new Error('診断JSONを生成できませんでした。');
  // Note: metadata travels inside the document, not only the console.
  // Re-encode only when necessary to report loss/truncation.
  if (notes.length) {
    const parsed = JSON.parse(json);
    parsed.diagnosticExport = {
      ...(parsed.diagnosticExport ?? {}),
      safeSerialization:true, reduced:fallback,
      warnings:[...new Set(notes)].slice(0,50), jsonBytes:new TextEncoder().encode(json).length,
    };
    json=JSON.stringify(parsed);
  }
  return { json, reduced:fallback, warnings:[...new Set(notes)].slice(0,50) };
}
