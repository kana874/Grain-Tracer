import { verifyLearningPartitions } from "./classifier-learning.js";
import { canTuneImage } from "./evaluation-roles.js";

// This assessment is a display-only operation. No training, segmentation or
// model adoption may be triggered by rendering the wizard.
export function assessClassifierWizard(input = {}) {
  const {width=0,height=0,rois=[],positiveMask=null,negativeMask=null,
    exclusionMask=null,imageRole=null,learning=null,classifier=null} = input;
  const details={trainingRois:0,validationRois:0,positive:0,negative:0,
    conflicts:0,requiredPerClass:24};
  const base=(step,title,instruction,action,canTrain=false)=>({
    step,title,instruction,action,canTrain,details,
  });
  if(!width||!height||!positiveMask||!negativeMask)
    return base("image","BMP画像を開く",
      "最初にBMPを読み込んでください。保存済みのプロジェクトも復元できます。","none");
  if(!canTuneImage(imageRole))
    return base("blocked","この画像は学習対象外です",
      "画像の役割がValidation/Testです。学習用画像ではDevelopmentを選択してください。","none");

  const training=(rois??[]).filter(r=>r?.evaluationRole==="training"&&r.verified!==false);
  const validation=(rois??[]).filter(r=>r?.evaluationRole==="validation"&&
    r.verified===true&&r.source==="validation-wizard-confirmed");
  details.trainingRois=training.length;
  details.validationRois=validation.length;
  if(!training.length)
    return base("training","① Training ROIを作成",
      "「Training範囲を指定」を押して画像上で矩形を描いてください。既存のValidation ROIとは重ねないでください。","create-training");

  // Fast early-exit at 24 samples/class: don't scan the full 2.4M preview
  // in frequently updated UI controls. Only the training areas are inspected.
  const minCount=24;
  for(const roi of training) {
    const x0=Math.max(0,Math.min(width-1,Math.round(Math.min(roi.x0,roi.x1))));
    const x1=Math.max(0,Math.min(width-1,Math.round(Math.max(roi.x0,roi.x1))));
    const y0=Math.max(0,Math.min(height-1,Math.round(Math.min(roi.y0,roi.y1))));
    const y1=Math.max(0,Math.min(height-1,Math.round(Math.max(roi.y0,roi.y1))));
    for(let y=y0;y<=y1;y++) {
      const baseIndex=y*width;
      for(let x=x0;x<=x1;x++) {
        const p=baseIndex+x;
        if(exclusionMask?.[p]) continue;
        const pos=!!positiveMask[p],neg=!!negativeMask[p];
        if(pos&&neg)details.conflicts++;
        else if(pos&&details.positive<minCount)details.positive++;
        else if(neg&&details.negative<minCount)details.negative++;
      }
      if(details.positive>=minCount&&details.negative>=minCount&&details.conflicts===0)
        break;
    }
    if(details.positive>=minCount&&details.negative>=minCount&&details.conflicts===0)break;
  }
  if(details.conflicts)
    return base("blocked","教師ラベルが競合しています",
      "Training ROI内でPositiveとNegativeが重なっています。線・塗りつぶしを修正してください。","edit-positive");
  if(details.positive<minCount||details.negative<minCount)
    return base("labels","② お手本線と非粒界を入力",
      `Training ROIで粒界（Positive）${details.positive}/24以上、非粒界（Negative）${details.negative}/24以上を入力してください。描画中はClassifierを起動しません。`,
      details.positive<minCount?"edit-positive":"edit-negative");

  const split=verifyLearningPartitions(rois);
  if(!validation.length)
    return base("validation","③ 独立Validation ROIを確認",
      "未使用の領域を選び、検出漏れ・誤検出を修正して「確認完了」を押します。Training ROIとは重複できません。","create-validation");
  if(!split.ok)
    return base("blocked","ROIの分離を修正",
      "Training・Validation・Test ROIの重複や役割設定を確認してください: "+split.reason,"none");
  const trainedCurrent=learning?.lastTrainedRevision===learning?.revision
    && Number.isInteger(learning?.revision);
  if(trainedCurrent&&classifier?.accepted)
    return base("complete","⑤ 学習・検証が完了",
      "採用済みClassifierを利用できます。次の教師ラベル修正後も再学習は自動開始しません。","retrain",true);
  if(trainedCurrent&&learning?.status==="rejected")
    return base("ready","④ 候補は棄却されました",
      "旧Classifierは維持しています。教師ラベルを追加・修正してから再度「学習・検証を実行」を押してください。","train",true);
  return base("ready","④ Classifierを学習・検証",
    "入力は揃いました。学習・独立Validation・安全な採用判定はボタンを押した時だけ実行します。","train",true);
}
