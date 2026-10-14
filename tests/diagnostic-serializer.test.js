import test from "node:test";
import assert from "node:assert/strict";
import { serializeDiagnosticJson } from "../src/diagnostic-serializer.js";

test("diagnostic export omits big pixel buffers without enumerating millions of indexed keys", () => {
  const pixels = new Uint8Array(4_000_000); pixels[0]=100;
  const report={schema:"graintracer-diagnostic-v20",source:{name:"sample.bmp"},
    preview:{width:1000,height:1000},evaluation:{fullEvaluationRoi:{f1:0.72}},
    topology:{mask:pixels},localAbReview:{recentVotes:[{winner:"b"}]}};
  const result=serializeDiagnosticJson(report);
  assert.ok(result.json.length < 5000);
  const saved=JSON.parse(result.json);
  assert.equal(saved.evaluation.fullEvaluationRoi.f1,0.72);
  assert.equal(saved.topology.mask.diagnosticOmitted,"binary-image-buffer");
  assert.equal(saved.topology.mask.length,4_000_000);
  assert.ok(saved.diagnosticExport.warnings.length>0);
});

test("huge tuning arrays are bounded and relevant metrics survive", () => {
  const report={schema:"graintracer-diagnostic-v20",appVersion:"0.8.1-alpha",
    evaluation:{positiveRecall:0.84,fullEvaluationRoi:{f1:0.51}},
    tuningTrace:Array.from({length:12000},(_,i)=>({iteration:i,value:i%10}))};
  const result=serializeDiagnosticJson(report);
  const saved=JSON.parse(result.json);
  assert.equal(saved.evaluation.fullEvaluationRoi.f1,0.51);
  assert.equal(saved.tuningTrace.length,1501);
  assert.equal(saved.tuningTrace[1500].diagnosticOmitted,"array-tail");
  assert.ok(saved.diagnosticExport.warnings.length>0);
});

test("size-limit fallback keeps ROI metrics and records truncation reason", () => {
  const detail=Array.from({length:1200},(_,i)=>({i,data:"x".repeat(130)}));
  const report={schema:"graintracer-diagnostic-v20",source:{name:"test.bmp"},
    preview:{width:64,height:64},appVersion:"0.8.1-alpha",
    evaluation:{fullEvaluationRoi:{f1:0.45,recall:0.67}},
    referenceCoverage:{referencePixels:350},
    topology:detail,topologyGraph:detail,regionSegmentation:detail,
    tuningTrace:detail,hotspots:detail,repairPaths:detail,postProcessing:detail};
  const result=serializeDiagnosticJson(report,{maxLength:8000});
  assert.equal(result.reduced,true);
  const saved=JSON.parse(result.json);
  assert.equal(saved.evaluation.fullEvaluationRoi.f1,0.45);
  assert.equal(saved.diagnosticExport.reduced,true);
  assert.ok(result.json.length < 16000);
});

test("normal-sized report remains structured diagnostic JSON", () => {
  const report={schema:"graintracer-diagnostic-v20",evaluation:{f1:0.48},
    topology:{components:[{pixels:10},{pixels:40}]},localAbReview:{counts:{reviewed:4}}};
  const json=serializeDiagnosticJson(report);
  assert.equal(json.reduced,false);
  assert.deepEqual(JSON.parse(json.json),report);
});
