import { trainLogisticBoundaryClassifier } from "./boundary-classifier.js";

// Pack only labeled Training pixels for a short-lived Worker message.
// Never forward full-image feature planes or Validation/Test labels.
export function createCompactTrainingPacket(features, positiveMask, negativeMask, options = {}) {
  const n = features.width * features.height;
  if (positiveMask?.length !== n || negativeMask?.length !== n) throw new Error("Training mask size mismatch");
  const maxPerClass = Math.max(64, Math.round(options.maxSamplesPerClass ?? 12000));
  const minimum = Math.max(8, Math.round(options.minSamplesPerClass ?? 24));
  const positive = [], negative = [];
  for (let p = 0; p < n; p += 1) {
    if (options.roiMask && !options.roiMask[p]) continue;
    if (options.exclusionMask?.[p]) continue;
    if (positiveMask[p] && negativeMask[p]) throw new Error("Conflicting Positive/Negative Training labels");
    if (positiveMask[p]) positive.push(p);
    else if (negativeMask[p]) negative.push(p);
  }
  if (positive.length < minimum || negative.length < minimum) {
    throw new Error("Classifier Training data shortage: Positive " + positive.length + " / Negative " + negative.length);
  }
  const each = Math.min(positive.length, negative.length, maxPerClass);
  const sample = indices => {
    if (indices.length <= each) return indices;
    const step = indices.length / each;
    return Array.from({length:each},(_,i)=>indices[Math.min(indices.length-1,Math.floor((i+.5)*step))]);
  };
  const indices = sample(positive).concat(sample(negative));
  const planes = {};
  for (const key of ["dark","ridge","color","dendrite","dendriteLinePenalty","dendriteCoherence","ridgeScale"]) {
    const input = features[key];
    const output = new Uint8Array(indices.length);
    if (input) for (let i=0;i<indices.length;i++) output[i]=input[indices[i]];
    planes[key]=output;
  }
  const compactPositive = new Uint8Array(indices.length);
  const compactNegative = new Uint8Array(indices.length);
  compactPositive.fill(1,0,each);
  compactNegative.fill(1,each);
  return {
    features:{width:indices.length,height:1,...planes},
    positiveMask:compactPositive,
    negativeMask:compactNegative,
    sampleCounts:{positiveAvailable:positive.length,negativeAvailable:negative.length,
      positiveUsed:each,negativeUsed:each},
    options:{iterations:options.iterations,learningRate:options.learningRate,
      l2:options.l2,ridgeScaleDivisor:options.ridgeScaleDivisor},
  };
}

export async function trainClassifierInWorker(packet, { signal } = {}) {
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  const trainLocal = () => {
    const model=trainLogisticBoundaryClassifier(packet.features,packet.positiveMask,packet.negativeMask,packet.options);
    model.sampleCounts={...packet.sampleCounts};
    return model;
  };
  if (typeof Worker === "undefined") return trainLocal();
  let worker;
  try {
    worker = new Worker(new URL("./classifier-worker.js", import.meta.url), {type:"module"});
  } catch {
    return trainLocal();
  }
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(error,model)=>{
      if(settled)return;
      settled=true;
      signal?.removeEventListener("abort",cancel);
      worker.terminate();
      if(error)reject(error);
      else resolve({...model,sampleCounts:{...packet.sampleCounts}});
    };
    const cancel=()=>finish(new DOMException("Cancelled", "AbortError"));
    signal?.addEventListener("abort",cancel,{once:true});
    worker.onmessage=({data})=>data.error
      ? finish(new Error(data.error)) : finish(null,data.model);
    worker.onerror=event=>finish(new Error(event.message||"Classifier Worker failed"));
    if(signal?.aborted) return cancel();
    const transfer=Object.values(packet.features)
      .filter(value=>ArrayBuffer.isView(value)).map(value=>value.buffer);
    transfer.push(packet.positiveMask.buffer,packet.negativeMask.buffer);
    worker.postMessage({packet},transfer);
  });
}

export function verifyLearningPartitions(rois) {
  const eligible=(rois??[]).filter(roi=>roi && roi.verified !== false &&
    ["training","validation","test"].includes(roi.evaluationRole));
  const training=eligible.filter(roi=>roi.evaluationRole==="training");
  const validation=eligible.filter(roi=>roi.evaluationRole==="validation" && roi.verified === true);
  if (!training.length) return {ok:false,reason:"Explicit Training ROI required"};
  if (!validation.length) return {ok:false,reason:"Verified Validation ROI required"};
  const overlap=(a,b)=> Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0)+1)
    * Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0)+1);
  for (let i=0;i<eligible.length;i++) for(let j=i+1;j<eligible.length;j++){
    if(eligible[i].evaluationRole!==eligible[j].evaluationRole && overlap(eligible[i],eligible[j])>0)
      return {ok:false,reason:"Training/Validation/Test ROI overlap"};
  }
  return {ok:true,training,validation};
}

export function evaluateAutoClassifierGuard(before, after, options={}) {
  const minF1Gain=options.minF1Gain??0.005;
  const maxRecallDrop=options.maxRecallDrop??0.02;
  const maxPrecisionDrop=options.maxPrecisionDrop??0.02;
  const maxLeakageIncrease=options.maxLeakageIncrease??0.005;
  const maxClosureDrop=options.maxClosureDrop??0.02;
  const maxOpenIncrease=options.maxOpenIncrease??1;
  const reasons=[];
  if(!Number.isFinite(before?.f1)||!Number.isFinite(after?.f1)||
     !Number.isFinite(before?.precision)||!Number.isFinite(after?.precision)||
     !Number.isFinite(before?.recall)||!Number.isFinite(after?.recall)) reasons.push("invalid-validation-metrics");
  else {
    if(after.f1-before.f1<minF1Gain)reasons.push("validation-f1-not-improved");
    if(after.precision<before.precision-maxPrecisionDrop)reasons.push("validation-precision-drop");
    if(after.recall<before.recall-maxRecallDrop)reasons.push("validation-recall-drop");
  }
  if(!Number.isFinite(before?.negativeLeakage)||!Number.isFinite(after?.negativeLeakage))
    reasons.push("invalid-negative-leakage");
  else if(after.negativeLeakage>before.negativeLeakage+maxLeakageIncrease)
    reasons.push("validation-negative-leakage-increase");
  const b=before?.topology,c=after?.topology;
  if(Number.isFinite(b?.weightedClosureScore)&&Number.isFinite(c?.weightedClosureScore)&&
     c.weightedClosureScore<b.weightedClosureScore-maxClosureDrop)reasons.push("topology-closure-drop");
  if(Number.isFinite(b?.openAfterMaxRadius)&&Number.isFinite(c?.openAfterMaxRadius)&&
     c.openAfterMaxRadius>b.openAfterMaxRadius+maxOpenIncrease)reasons.push("topology-open-increase");
  return {accepted:reasons.length===0,reasons,
    delta:{f1:after?.f1-before?.f1,precision:after?.precision-before?.precision,
      recall:after?.recall-before?.recall,negativeLeakage:after?.negativeLeakage-before?.negativeLeakage},
    thresholds:{minF1Gain,maxRecallDrop,maxPrecisionDrop,maxLeakageIncrease,maxClosureDrop,maxOpenIncrease}};
}
