import { computeFullEvaluationRoiMetrics } from './evaluation.js';
import { validationEvaluationRois, canTuneImage } from './evaluation-roles.js';
export function evaluatePreferenceAdoption(currentMask,candidateMask,reference,width,height,options={}) {
  if (!canTuneImage(options.imageRole)) return {accepted:false,reason:'development画像以外では採用禁止'};
  const validationRois=validationEvaluationRois(options.fullEvaluationRois);
  if (!validationRois.length) return {accepted:false,reason:'検証済みValidation ROIがありません。自動採用は保留'};
  if (!currentMask||!candidateMask||!reference||
      currentMask.length!==width*height||candidateMask.length!==width*height||
      reference.length!==width*height) return {accepted:false,reason:'比較用マスクの寸法が不正'};
  const args=[reference,width,height,validationRois,{
    tolerance:options.tolerance??2, exclusionMask:options.exclusionMask??null }];
  const before=computeFullEvaluationRoiMetrics(currentMask,...args);
  const after=computeFullEvaluationRoiMetrics(candidateMask,...args);
  const recallTolerance=options.maxRecallDrop??0.02;
  const precisionTolerance=options.maxPrecisionDrop??0.02;
  const requiredGain=options.minF1Gain??0.005;
  const minimumPixels=options.minReferencePixels??12;
  let reason=null;
  if(before.referencePixels<minimumPixels||after.referencePixels<minimumPixels)
    reason='Validation ROIのお手本線が不足';
  else if(after.recall + recallTolerance < before.recall)
    reason='Validation Recallの低下が許容値を超過';
  else if(after.precision + precisionTolerance < before.precision)
    reason='Validation Precisionの低下が許容値を超過';
  else if(after.f1 < before.f1 + requiredGain)
    reason='Validation F1の改善が閾値未満';
  return {accepted:reason==null,reason:reason??'Validation ROIで改善を確認',
    before:{f1:before.f1,precision:before.precision,recall:before.recall,referencePixels:before.referencePixels},
    after:{f1:after.f1,precision:after.precision,recall:after.recall,referencePixels:after.referencePixels},
    thresholds:{minF1Gain:requiredGain,maxRecallDrop:recallTolerance,maxPrecisionDrop:precisionTolerance},
    validationRoiCount:validationRois.length, testExcluded:true};
}
