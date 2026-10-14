import { LocalPredictionRunner, LruPredictionCache, comparisonCacheKey, materializeLocalPrediction } from './local-ab-engine.js';
import { nextWheelZoom, zoomAroundCursor, dragViewport, eventToRoiPixel } from './local-ab-viewport.js';
import { selectFeedbackSegment, buildFeedbackConnection } from './feedback-learning.js';
import { positionLocalRoi, withinLocalRoi, localAbCounts, filterLocalReview } from './local-ab.js';
import { proposePreferenceCandidate, buildPreferenceVote, preferenceParameterSnapshot, recoverPreferenceChampion } from './preference-optimizer.js';
import { aggregatePreferenceAcrossRois, evaluateManualLabelEvidence } from './local-ab-learning.js';
import { rasterizeGuidedStroke } from './stroke-review.js';
import { recommendFeatureRoi } from './active-roi.js';

// Local A/B operates on the analysis-preview coordinate grid. The same global
// feature cache and exclusion mask are used for both candidates. A/B votes are
// preference data, not true-positive ground-truth or F1.
export function setupLocalAB({ getSnapshot, getFeatures, getLegacyFeatures, onVote, onFeedback, onAdopt, onUndo, onRedo, getHistoryState, onStartValidation }) {
  const openButton = document.getElementById('localAbButton');
  const dialog = document.createElement('dialog');
  dialog.className = 'local-ab-dialog';
  dialog.innerHTML = [
    '<header class="local-ab-header"><h2>局所A/B比較 <small>プレビュー解像度</small></h2><button data-k="close" type="button">閉じる</button></header>',
    '<div class="local-ab-layout">',
    '<section class="local-ab-selector"><h3>① 評価領域を選択</h3>',
    '<p class="help">画像をクリックして枠を移動。範囲はプレビュー画素です。元BMPのフル解像度評価ではありません。</p>',
    '<canvas data-k="overview" aria-label="ROIの選択"></canvas>',
    '<label>範囲サイズ <select data-k="roiSize"><option value="128">128px</option><option value="256" selected>256px</option><option value="512">512px</option></select></label>',
    '<p data-k="roiStatus" class="help"></p>',
    '<details class="local-ab-advanced-options"><summary>比較・学習の設定（詳細）</summary>',
    '<label>候補Bの条件 <select data-k="variant">',
    '<option value="plus8">感度 +8</option><option value="minus8">感度 -8</option>',
    '<option value="plus16">感度 +16</option><option value="toggleNms">NMS 切替</option>',
    '<option value="legacyEdge">旧・画像端処理（比較診断）</option>',
    '</select></label>',
    '<label class="check-row"><input type="checkbox" data-k="adaptive" checked> 選好からB候補を自動生成</label>',
    '<label class="check-row"><input type="checkbox" data-k="autoNext" checked> 選択後に次のA/Bを自動生成</label>',
    '<label class="check-row"><input type="checkbox" data-k="autoRoi" checked> 次のROIも自動推薦</label>',
    '<label class="check-row"><input type="checkbox" data-k="autoAdopt"> Validationで改善時だけ自動採用</label>',
    '</details>',
    '<button class="primary" data-k="generate" type="button">A/Bを比較</button>',
    '<button type="button" data-k="nextRoi">次の評価ROIを推薦</button>',
    '<button type="button" data-k="applyChampion">選択した最良設定を検証して採用</button>',
    '<button type="button" data-k="startValidation">Validation ROIを新規作成</button>',
    '<p data-k="proposalStatus" role="status" class="help">手動評価の間は「選択後に次のA/B」をOFFにしてください。</p>',
    '<p class="help">良い方を選ぶと次の候補・ROIへ進みます。複数ROIで確認後、独立したValidationで改善した設定だけを採用します。</p>',
    '<p data-k="message" class="help" role="status">BMP読み込み後に開始できます。</p>',
    '</section><section class="local-ab-results">',
    '<div class="local-ab-controls"><label>同期倍率 <select data-k="zoom"><option value="0.25">25%</option><option value="0.5">50%</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.5">150%</option><option value="2" selected>200%</option><option value="3">300%</option><option value="4">400%</option><option value="6">600%</option><option value="8">800%</option></select></label>',
    '<output data-k="zoomReadout">200%</output><span class="local-ab-nav-hint">ホイール: 拡大 / 中ドラッグ: 同期移動</span>',
    '<span data-k="difference"></span></div>',
    '<div class="local-ab-compare">',
    '<div class="local-ab-card" data-k="cardA"><h3>A：現在の設定</h3><div class="local-ab-scroll" data-k="scrollA"><div class="local-ab-stage" data-k="stageA"><canvas data-k="viewA"></canvas><canvas data-k="hoverA" class="local-ab-hover"></canvas></div></div><p data-k="countA"></p></div>',
    '<div class="local-ab-card" data-k="cardB"><h3>B：変更した設定</h3><div class="local-ab-scroll" data-k="scrollB"><div class="local-ab-stage" data-k="stageB"><canvas data-k="viewB"></canvas><canvas data-k="hoverB" class="local-ab-hover"></canvas></div></div><p data-k="countB"></p></div>',
    '</div><div class="local-ab-votes"><strong>② 良い方を選択（選好履歴へ保存）</strong>',
    '<button type="button" data-vote="a">Aが良い</button><button type="button" data-vote="b">Bが良い</button>',
    '<button type="button" data-vote="neither">両方不正解</button><button type="button" data-vote="uncertain">判断不能</button>',
    '</div><div class="local-ab-manual"><strong class="local-ab-review-heading">③ 手動補正</strong>',
    '<div class="local-ab-review-toolbar" role="group" aria-label="手動補正ツール">',
    '<div class="local-ab-review-choose"><button type="button" data-k="judgeA">Aを修正</button><button type="button" data-k="judgeB">Bを修正</button></div>',
    '<label>判定 <select data-k="tool"><option value="positive">正解</option><option value="negative">誤検出</option><option value="missing">検出漏れ（2点）</option></select></label>',
    '<label class="check-row"><input type="checkbox" data-k="strokeMode" checked> 一筆なぞり</label>',
    '<label>対象 <select data-k="pixels"><option value="1">1px</option><option value="3" selected>最大3px</option><option value="5">最大5px</option><option value="9">最大9px</option></select></label>',
    '<div class="local-ab-undo-bar"><button type="button" data-k="undo" title="Ctrl+Z">↶ Undo</button><button type="button" data-k="redo" title="Ctrl+Y">↷ Redo</button><span data-k="undoStatus" class="help"></span></div>',
    '</div>',
    '<p data-k="reviewStatus" role="status">A/B選択後、修正する側を指定してください。1ストロークをまとめてUndoできます。</p>',
    '</div></section></div>'
  ].join('');
  document.body.append(dialog);
  const el = name => dialog.querySelector('[data-k="' + name + '"]');
  const original = document.createElement('canvas');
  let current = null, roi = null, a = null, b = null, active = null;
  let pending = null, request = 0;
  let champion = null, challenger = null, proposal = null, localVotes = [];
  let round = 0, lastWinner = null, stroke = null, suppressClick = false, lastVote = null;
  let busy = false, scrollLock = false;
  let featuresCache=null, maskRevision=0, roiKey=null, keepPair=false;
  let interactionZoom=2,pan=null, generationTimes=[], comparisonAttempts=0;
  const predictionCache=new LruPredictionCache(10);
  const predictionRunner=new LocalPredictionRunner();
  const stats=()=>({requests:comparisonAttempts,cacheHits:predictionCache.hits,
    cacheMisses:predictionCache.misses,averageMs:generationTimes.length
      ? generationTimes.reduce((a,b)=>a+b,0)/generationTimes.length:0});
  const now=()=>performance.now();
  const candidateCanvas = { a: el('viewA'), b: el('viewB') };
  const hoverCanvas = { a: el('hoverA'), b: el('hoverB') };
  const bound = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
  const report = message => { el('message').textContent = message; };
  const validContext = () => {
    const next = getSnapshot();
    return Boolean(current && next?.fingerprint === current.fingerprint && next?.preview === current.preview);
  };
  function updateRoiAt(cx, cy) {
    if (!current) return;
    const newRoi=positionLocalRoi(current.preview.width, current.preview.height,
      Number(el('roiSize').value), cx, cy);
    const newKey=[newRoi.x,newRoi.y,newRoi.width,newRoi.height].join(',');
    const changed=roiKey!==newKey;
    roi=newRoi;roiKey=newKey;
    if(changed){
      a=b=null;active=null;pending=null;request++;
      for(const side of ['a','b']){
        const canvas=candidateCanvas[side];
        canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
        const hover=hoverCanvas[side];
        hover.getContext('2d').clearRect(0,0,hover.width,hover.height);
      }
      el('difference').textContent='新しいROIを比較してください';
    }
    el('roiStatus').textContent =
      'x=' + roi.x + ' y=' + roi.y + ' / ' + roi.width + '×' + roi.height + ' preview px';
    drawOverview();
    clearVote();
    if (a && b) drawCandidates();
  }
  function drawOverview() {
    const canvas = el('overview');
    if (!current || !roi) return;
    canvas.width = current.preview.width;
    canvas.height = current.preview.height;
    const context = canvas.getContext('2d');
    context.drawImage(original, 0, 0);
    context.fillStyle = 'rgba(255,216,74,0.12)';
    context.fillRect(roi.x, roi.y, roi.width, roi.height);
    context.lineWidth = Math.max(2, current.preview.width / 350 * 2);
    context.strokeStyle = '#ffe36c';
    context.strokeRect(roi.x, roi.y, roi.width, roi.height);
  }
  function clearVote() {
    active = null; pending = null;
    el('cardA').classList.remove('selected');
    el('cardB').classList.remove('selected');
    for (const button of dialog.querySelectorAll('[data-vote]')) button.classList.remove('selected');
    el('reviewStatus').textContent = 'A/Bの選好を選び、AかBを手動評価対象に指定してください。';
    drawHover();
  }
  function updateScale() {
    if (!roi) return;
    const zoom = interactionZoom;
    for (const side of ['A','B']) {
      const stage = el('stage' + side);
      stage.style.width = roi.width * zoom + 'px';
      stage.style.height = roi.height * zoom + 'px';
      for (const name of ['view','hover']) {
        const canvas = el(name + side);
        canvas.style.width = roi.width * zoom + 'px';
        canvas.style.height = roi.height * zoom + 'px';
      }
    }
  }
  function drawMask(side, mask) {
    const canvas = candidateCanvas[side];
    canvas.width = roi.width;
    canvas.height = roi.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(original, roi.x, roi.y, roi.width, roi.height, 0, 0, roi.width, roi.height);
    const painted = ctx.getImageData(0, 0, roi.width, roi.height);
    const data = painted.data, width = current.preview.width;
    const positive = current.referenceCenterline, negative = current.negativeCenterline;
    for (let yy = 0; yy < roi.height; yy++) {
      for (let xx = 0; xx < roi.width; xx++) {
        const p = (roi.y + yy) * width + roi.x + xx;
        const idx = (yy * roi.width + xx) * 4;
        if (current.exclusionMask?.[p]) {
          data[idx] = 125; data[idx + 1] = 125; data[idx + 2] = 125;
        } else if (positive?.[p]) {
          data[idx] = 255; data[idx + 1] = 223; data[idx + 2] = 30;
        } else if (negative?.[p]) {
          data[idx] = 255; data[idx + 1] = 138; data[idx + 2] = 0;
        } else if (mask[p]) {
          data[idx] = Math.round(data[idx] * 0.28);
          data[idx + 1] = Math.round(data[idx + 1] * 0.28 + 240 * 0.72);
          data[idx + 2] = Math.round(data[idx + 2] * 0.28 + 218 * 0.72);
        }
      }
    }
    ctx.putImageData(painted, 0, 0);
    hoverCanvas[side].width = roi.width;
    hoverCanvas[side].height = roi.height;
  }
  function drawCandidates() {
    if (!a || !b || !roi || !current) return;
    drawMask('a', a); drawMask('b', b);
    updateScale();
    const counts = localAbCounts(a, b, current.preview.width, roi, current.exclusionMask);
    el('countA').textContent = '抽出 ' + counts.a.toLocaleString() + ' px';
    el('countB').textContent = '抽出 ' + counts.b.toLocaleString() + ' px';
    el('difference').textContent = 'Aのみ ' + counts.onlyA + 'px / Bのみ ' + counts.onlyB + 'px';
  }
  function updateViewportZoom(newZoom,side='A',clientX=null,clientY=null){
    if(!roi)return;
    const pane=el('scroll'+side);
    const bounds=pane.getBoundingClientRect();
    const anchorX=clientX??bounds.left+bounds.width/2;
    const anchorY=clientY??bounds.top+bounds.height/2;
    const previous={scrollLeft:pane.scrollLeft,scrollTop:pane.scrollTop,scale:interactionZoom,
      clientX:anchorX,clientY:anchorY,viewportLeft:bounds.left,viewportTop:bounds.top};
    const offsets=zoomAroundCursor(previous,newZoom);
    interactionZoom=newZoom;
    el('zoomReadout').textContent=Math.round(newZoom*100)+'%';
    const select=el('zoom');
    if([...select.options].some(o=>Number(o.value)===newZoom))select.value=String(newZoom);
    else {select.value='';}
    updateScale();
    for(const key of ['A','B']){
      const view=el('scroll'+key);
      view.scrollLeft=offsets.scrollLeft;
      view.scrollTop=offsets.scrollTop;
    }
  }
  function variantOptions(base) {
    if (el('adaptive').checked && challenger) return { ...challenger };
    const kind = el('variant').value;
    if (kind === 'plus8') return { ...base, sensitivity: bound(base.sensitivity + 8, 1, 100) };
    if (kind === 'minus8') return { ...base, sensitivity: bound(base.sensitivity - 8, 1, 100) };
    if (kind === 'plus16') return { ...base, sensitivity: bound(base.sensitivity + 16, 1, 100) };
    if (kind === 'toggleNms') return { ...base, centerlineNms: !base.centerlineNms };
    return { ...base, edgeFrameGuard: 1 };
  }
  function prepareChallenger() {
    if (!champion || !el('adaptive').checked) return;
    const eligible = localVotes.filter(v => v.imageFingerprint === current?.fingerprint && v.eligibleForLearning !== false
      && v.schema === 'graintracer-preference-v2');
    proposal = proposePreferenceCandidate(champion, eligible, {round});
    challenger = proposal?.parameters ?? null;
    el('proposalStatus').textContent = proposal
      ? '探索 '+(round+1)+'回：'+proposal.actionKey+' / A(前回勝者) 対 B(新候補)'
      : 'これ以上、異なるB候補を生成できません。';
  }
  async function predict(features,params,scope,legacy=false){
    const featureKey=JSON.stringify(current.featureOptions)+(legacy?'|legacy':'|reflect');
    const key=comparisonCacheKey(current.fingerprint,scope,params,featureKey,maskRevision);
    const hit=predictionCache.get(key);
    if(hit)return hit;
    const output=await predictionRunner.compute(features,scope,params);
    const full=materializeLocalPrediction(output.mask,scope,
      current.preview.width,current.preview.height);
    predictionCache.set(key,full);
    return full;
  }
  async function generate(){
    if(!validContext()||busy||!roi)return;
    const sequence=++request, workRoi={...roi},started=now();
    busy=true;a=b=null;clearVote();
    if(el('adaptive').checked){
      if(!keepPair||!challenger)prepareChallenger();
      if(!challenger){busy=false;report('異なる候補を生成できません。');return;}
    }
    el('generate').disabled=true;
    report('指定したROIの候補を計算中…');
    try{
      const features=featuresCache??await getFeatures();
      featuresCache=features;
      if(sequence!==request||!validContext())return;
      const baseline=el('adaptive').checked?champion:current.boundaryOptions;
      const candidate=variantOptions(baseline);
      const aMask=await predict(features,baseline,workRoi);
      if(sequence!==request||!validContext())return;
      const legacy=!el('adaptive').checked&&el('variant').value==='legacyEdge';
      const candidateFeatures=legacy?await getLegacyFeatures():features;
      const bMask=await predict(candidateFeatures,candidate,workRoi,legacy);
      if(sequence!==request||!validContext())return;
      a=aMask;b=bMask;comparisonAttempts++;
      generationTimes.push(now()-started);
      if(generationTimes.length>100)generationTimes.shift();
      drawCandidates();
      if(el('adaptive').checked)
        el('proposalStatus').textContent='探索 '+(round+1)+'：'+proposal?.actionKey+
          ' / 比較済み領域の一致が必要';
      report('ROI計算 '+Math.round(generationTimes.at(-1))+'ms / '+
        'キャッシュ '+predictionCache.hits+'件命中 / '+(features===featuresCache?'特徴量保持':'')+
        '。A/B選好は正解画素とは別に保存します。');
    }catch(error){
      console.error('local A/B',error);
      report('比較失敗: '+error.message);
    }finally{
      busy=false;el('generate').disabled=false;
    }
  }
  function updateSelectionRoi(rect) {
    if (!rect) return;
    updateRoiAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
  }
  function recommendRoi(){
    if(!current||!featuresCache){report('ROI推薦には特徴量を先に計算してください。');return null;}
    const snapshot=getSnapshot();
    const base=el('adaptive').checked?champion:current.boundaryOptions;
    const candidate=variantOptions(base);
    const next=recommendFeatureRoi(featuresCache,base,candidate,
      Number(el('roiSize').value),{
        history:localVotes,
        protectedRois:snapshot?.protectedRois??[],
        exclusionMask:current.exclusionMask,
        labelMask:snapshot?.referenceCenterline,
        negativeLabelMask:snapshot?.negativeCenterline,
      });
    if(!next){report('保護領域以外に推薦可能なROIがありません。');return null;}
    updateSelectionRoi(next.roi);
    el('roiStatus').textContent+=' / 推薦スコア '+next.score.toFixed(2);
    return next;
  }
  function roiProtected() {
    const snapshot = getSnapshot();
    if (!snapshot?.canTune) return true;
    return (snapshot.protectedRois ?? []).some(rect => {
      const x0 = Math.min(rect.x0,rect.x1), x1 = Math.max(rect.x0,rect.x1);
      const y0 = Math.min(rect.y0,rect.y1), y1 = Math.max(rect.y0,rect.y1);
      return roi.x <= x1 && roi.x + roi.width - 1 >= x0 &&
        roi.y <= y1 && roi.y + roi.height - 1 >= y0;
    });
  }
  async function adoptChampion() {
    if (!champion || !validContext() || busy) return null;
    report('検証済みValidation ROIで候補を検証しています…');
    const expectedFingerprint = current.fingerprint;
    const result = await onAdopt({ ...champion }, expectedFingerprint);
    if (!validContext() || current.fingerprint !== expectedFingerprint) return result;
    report(result?.accepted
      ? 'Validation検証で改善：最良設定を採用しました。' +
        'F1 '+(result.after.f1*100).toFixed(1)+'%'
      : '設定は変更しません：'+(result?.reason ?? '検証不可'));
    if (result?.accepted) {
      current.boundaryOptions = { ...getSnapshot().boundaryOptions };
      champion = { ...current.boundaryOptions };
      proposal = challenger = null;
    }
    return result;
  }
  async function vote(winner) {
    if (!validContext() || !a || !b || busy) return;
    if (roiProtected()) {
      report('Development画像の学習用領域だけを比較選択できます。Validation/TestのROIや画像は対象外です。');
      return;
    }
    const counts = localAbCounts(a, b, current.preview.width, roi, current.exclusionMask);
    const adaptive = el('adaptive').checked;
    const configA = adaptive ? champion : current.boundaryOptions;
    const configB = variantOptions(configA);
    const record = adaptive
      ? buildPreferenceVote({ champion:configA, challenger:configB, winner,
          proposal, fingerprint:current.fingerprint, roi, round })
      : { schema:'graintracer-local-ab-v1', winner,
          imageFingerprint:current.fingerprint,
          createdAt:new Date().toISOString(), coordinateSystem:'analysis-preview',
          roi:{...roi}, aSettings:preferenceParameterSnapshot(configA), bSettings:preferenceParameterSnapshot(configB),
          variant:el('variant').value };
    Object.assign(record, {
      counts, featureOptions:{...current.featureOptions}, appVersion:current.appVersion,
      algorithmVersion:current.algorithmVersion, eligibleForLearning:true,
      manualEvidence:evaluateManualLabelEvidence(a,b,current.preview.width,
        current.preview.height,roi,current.referenceCenterline,
        current.negativeCenterline,{exclusionMask:current.exclusionMask}),
    });
    onVote(record);
    localVotes.push(record);
    if (localVotes.length > 500) localVotes.shift();
    lastVote = record;
    for (const button of dialog.querySelectorAll('[data-vote]'))
      button.classList.toggle('selected', button.dataset.vote === winner);
    if (winner === 'a' || winner === 'b') selectManualSide(winner);
    else {
      active=null; pending=null; drawHover();
      el('reviewStatus').textContent = '選好を保存。必要ならA/Bを選んで手動修正できます。';
    }
    let consensus=null;
    if(adaptive){
      consensus=aggregatePreferenceAcrossRois(champion,configB,localVotes,{
        fingerprint:current.fingerprint,featureOptions:current.featureOptions,
        algorithmVersion:current.algorithmVersion,minDistinctRois:2,
      });
      round++;
      lastWinner=winner;
      // A/B votes are tied to independent spatial cells; a single favorable
      // ROI cannot promote a global candidate.
      if(consensus.winner==='b') {
        champion={...configB};keepPair=false;
      } else if(consensus.winner==='a') {
        keepPair=false;
      } else {
        keepPair=true;
      }
      record.preferenceConsensus={...consensus};
      record.championAfter=preferenceParameterSnapshot(champion);
    }
    const canAdopt=adaptive && consensus?.winner==='b';
    report(adaptive
      ? '異なるROIの賛成 '+(consensus?.b??0)+' / 反対 '+(consensus?.a??0)+
        '。'+(consensus?.winner?'複数ROIで候補を確定しました。':'追加ROIで同じ設定を検証します。')
      : '選好を保存しました。');
    if(canAdopt&&el('autoAdopt').checked)await adoptChampion();
    if(!el('autoNext').checked||!adaptive)return;
    if(!validContext())return;
    // Recommend BEFORE generating the next ROI. Previously this happened
    // afterward, so the displayed mask never matched the yellow ROI frame.
    if(!keepPair)prepareChallenger();
    if(el('autoRoi').checked)recommendRoi();
    await generate();
  }
  function selectManualSide(side) {
    if (!a || !b) return;
    active = side; pending = null;
    el('cardA').classList.toggle('selected', side === 'a');
    el('cardB').classList.toggle('selected', side === 'b');
    el('reviewStatus').textContent =
      (side.toUpperCase()) + 'を手動評価中。正解/誤検出はクリック周辺の短い区間だけ、欠落は2点で指定します。';
    drawHover();
  }
  function pointFromEvent(event, side) {
    const rect = candidateCanvas[side].getBoundingClientRect();
    const p=eventToRoiPixel(event.clientX,event.clientY,rect,roi.width,roi.height);
    return p?{x:roi.x+p.x,y:roi.y+p.y}:null;
  }
  function candidateFor(side, point) {
    const mask = side === 'a' ? a : b, width = current.preview.width;
    const picked = selectFeedbackSegment(mask, width, current.preview.height, point, {
      searchRadius: 2, maxPixels: Number(el('pixels').value), exclusionMask: current.exclusionMask,
    });
    if (!picked || !withinLocalRoi(roi, picked.anchor.x, picked.anchor.y)) return null;
    const indices = filterLocalReview(picked.indices, width, roi, current.exclusionMask);
    return indices.length ? { indices, anchor: picked.anchor } : null;
  }
  function drawHover(event = null, side = null) {
    for (const key of ['a', 'b']) {
      const canvas = hoverCanvas[key];
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    }
    if (!side || side !== active || !event || !a || !b || !roi ||
        el('tool').value === 'missing') return;
    const point = pointFromEvent(event, side);
    const picked = point && candidateFor(side, point);
    if (!picked) return;
    const ctx = hoverCanvas[side].getContext('2d');
    ctx.fillStyle = el('tool').value === 'positive' ? '#58ff87' : '#ff526b';
    for (const index of picked.indices)
      ctx.fillRect(index % current.preview.width - roi.x,
        Math.floor(index / current.preview.width) - roi.y, 1, 1);
  }
  function renderStroke() {
    if (!stroke || !roi || !current) return;
    const ctx=hoverCanvas[stroke.side].getContext('2d');
    ctx.clearRect(0,0,roi.width,roi.height);
    const source=stroke.side==='a'?a:b;
    const indices=rasterizeGuidedStroke(stroke.points,source,current.preview.width,
      current.preview.height,{ snapRadius:2,roi,exclusionMask:current.exclusionMask });
    ctx.fillStyle=el('tool').value==='positive'?'#65ff91':'#ff526c';
    for(const p of indices)ctx.fillRect(p%current.preview.width-roi.x,
      Math.floor(p/current.preview.width)-roi.y,1,1);
    el('reviewStatus').textContent='なぞり候補：'+indices.length+
      'px（ドラッグ終了時に1操作として保存、Undo可能）';
  }
  function refreshHistoryButtons() {
    const status=getHistoryState?.() ?? {undo:0,redo:0};
    el('undo').disabled=!status.undo;
    el('redo').disabled=!status.redo;
    el('undoStatus').textContent='Undo '+(status.undo??0)+' / Redo '+(status.redo??0);
  }
  function reviewUndoRedo(direction) {
    if(!validContext() || busy) return;
    const action=direction==='undo'?onUndo:onRedo;
    if(typeof action!=='function') return;
    const ok=action();
    if(!ok) {refreshHistoryButtons();return;}
    stroke=null;pending=null;
    updateCurrentLabels();
    el('reviewStatus').textContent=direction==='undo'
      ? '直前の注釈を取り消しました。'
      : '注釈をやり直しました。';
    refreshHistoryButtons();
  }
  function updateCurrentLabels() {
    const updated=getSnapshot();
    if(updated) {
      current.referenceCenterline=updated.referenceCenterline;
      current.negativeCenterline=updated.negativeCenterline;
      current.boundaryOptions.negativeMask=updated.boundaryOptions.negativeMask;
      maskRevision++;
      predictionCache.clear();
    }
    if(lastVote&&a&&b)lastVote.manualEvidence=evaluateManualLabelEvidence(
      a,b,current.preview.width,current.preview.height,roi,
      current.referenceCenterline,current.negativeCenterline,
      {exclusionMask:current.exclusionMask});
    drawCandidates();
    refreshHistoryButtons();
  }
  function beginStroke(event,side) {
    if(!el('strokeMode').checked||el('tool').value==='missing'||busy||roiProtected()||
        !a||!b||side!==active||event.button!==0||!validContext())return;
    const point=pointFromEvent(event,side);
    if(!point)return;
    stroke={side,pointerId:event.pointerId,points:[point]};
    candidateCanvas[side].setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function continueStroke(event,side) {
    if(!stroke||stroke.side!==side||stroke.pointerId!==event.pointerId)return;
    const point=pointFromEvent(event,side);
    if(!point)return;
    const last=stroke.points.at(-1);
    if(Math.hypot(last.x-point.x,last.y-point.y)<0.5)return;
    if(stroke.points.length<2000)stroke.points.push(point);
    renderStroke();
  }
  function endStroke(event,side,cancel=false) {
    if(!stroke||stroke.side!==side||stroke.pointerId!==event.pointerId)return;
    const points=stroke.points;
    const point=pointFromEvent(event,side);
    if(point)points.push(point);
    stroke=null;
    const canvas=candidateCanvas[side];
    if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);
    const move=Math.max(...points.map(p=>Math.hypot(p.x-points[0].x,p.y-points[0].y)));
    if(cancel||move<1.5)return;
    suppressClick=true;
    // A normal pointer click is dispatched after pointerup. Do not let a
    // suppressed drag accidentally suppress the user's next separate click.
    setTimeout(() => { suppressClick=false; }, 0);
    const indices=rasterizeGuidedStroke(points,side==='a'?a:b,
      current.preview.width,current.preview.height,{
        snapRadius:2,roi,exclusionMask:current.exclusionMask,maxPixels:3000,
      });
    if(!indices.length) {
      el('reviewStatus').textContent='線が候補から離れています。候補に沿ってドラッグしてください。';
      drawHover();return;
    }
    const saved=onFeedback(indices,el('tool').value,points[0],{
      source:'local-ab',candidate:side,roi:{...roi},variant:el('adaptive').checked?'adaptive':el('variant').value,
      selection:'guided-stroke',
    });
    el('reviewStatus').textContent=saved
      ? '一筆評価 '+indices.length+'px を保存しました。Undoで1操作を戻せます。'
      : '同じ区間は評価済みです。';
    updateCurrentLabels();
  }
  function judge(event, side) {
    if (!validContext() || side !== active || !a || !b || busy || roiProtected()) {
      if(roiProtected()) {
        el('reviewStatus').textContent='この領域はValidation/Testのため学習用の手動補正を行いません。';
        return;
      }
      el('reviewStatus').textContent = 'A/Bを選択してから、選択した側の画像をクリックしてください。';
      return;
    }
    if(suppressClick) { suppressClick=false; return; }
    const point = pointFromEvent(event, side);
    if (!point || current.exclusionMask?.[point.y * current.preview.width + point.x]) return;
    const kind = el('tool').value;
    if (kind === 'missing') {
      if (!pending) {
        pending = point;
        el('reviewStatus').textContent = '検出漏れの終点をクリックしてください（最大80px）。';
        return;
      }
      if (!withinLocalRoi(roi, pending.x, pending.y)) pending = null;
      if (!pending) return;
      const path = buildFeedbackConnection(pending, point, current.preview.width, current.preview.height,
        { maxLength: 80, exclusionMask: current.exclusionMask });
      if (!path || path.indices.some(index => !withinLocalRoi(roi,
        index % current.preview.width, Math.floor(index / current.preview.width)))) {
        el('reviewStatus').textContent = 'ROI外・除外領域の横断、または80px超過です。終点を再指定してください。';
        return;
      }
      pending = null;
      const saved = onFeedback(path.indices, 'missing', path.anchor, {
        source: 'local-ab', candidate: side, roi: { ...roi }, variant: el('variant').value,
      });
      el('reviewStatus').textContent = saved ? '検出漏れを部分ラベルとして保存しました。' : '既存ラベルと重複しています。';
    } else {
      const picked = candidateFor(side, point);
      if (!picked) {
        el('reviewStatus').textContent = '候補がクリックから2px以内にありません。欠落を指定してください。';
        return;
      }
      const saved = onFeedback(picked.indices, kind, picked.anchor, {
        source: 'local-ab', candidate: side, roi: { ...roi }, variant: el('variant').value,
      });
      el('reviewStatus').textContent = saved
        ? kind === 'positive' ? '正解を保存しました。' : '誤検出を保存しました。'
        : '同じ画素は評価済みです。';
    }
    updateCurrentLabels();
  }
  function open() {
    const data = getSnapshot();
    if (!data?.preview?.imageData || !data.fingerprint) return;
    request++;
    current = data; a = b = null; busy = false;
    predictionRunner.terminate();predictionCache.clear();
    predictionCache.hits=0;predictionCache.misses=0;
    featuresCache=null;maskRevision=0;roiKey=null;keepPair=false;
    generationTimes=[];comparisonAttempts=0;interactionZoom=2;el('zoom').value='2';
    el('zoomReadout').textContent='200%';
    localVotes=[...(data.localAbReviews??[])];
    champion=recoverPreferenceChampion(data.boundaryOptions,localVotes,data.fingerprint,
      data.featureOptions,data.algorithmVersion);
    challenger=null;proposal=null;
    round=localVotes.filter(v=>v.schema==='graintracer-preference-v2'&&
      v.imageFingerprint===data.fingerprint).length;
    lastWinner=null;stroke=null;suppressClick=false;lastVote=null;
    const w = data.preview.width, h = data.preview.height;
    original.width = w; original.height = h;
    original.getContext('2d').putImageData(data.preview.imageData, 0, 0);
    el('roiSize').value = '256';
    updateRoiAt(w / 2, h / 2);
    dialog.showModal();
    refreshHistoryButtons();
    generate();
  }
  function close() {
    request++; current = null; a = b = null; roi = null; active = null; pending = null;
    stroke=null; champion=null; challenger=null; proposal=null;
    predictionRunner.terminate();predictionCache.clear();featuresCache=null;
    if (dialog.open) dialog.close();
  }
  openButton.addEventListener('click', open);
  el('close').addEventListener('click', close);
  dialog.addEventListener('close', () => { request++; current = null; });
  el('overview').addEventListener('click', event => {
    if (!current || busy) return;
    const rect = el('overview').getBoundingClientRect();
    const x = (event.clientX - rect.left) * current.preview.width / rect.width;
    const y = (event.clientY - rect.top) * current.preview.height / rect.height;
    updateRoiAt(x, y);
  });
  el('roiSize').addEventListener('change', () => {
    if (roi && current && !busy) updateRoiAt(roi.x + roi.width / 2, roi.y + roi.height / 2);
  });
  el('variant').addEventListener('change', () => { a = b = null; clearVote(); report('条件を変更しました。「この条件で比較」を押してください。'); });
  el('generate').addEventListener('click', generate);
  el('undo').addEventListener('click', () => reviewUndoRedo('undo'));
  el('redo').addEventListener('click', () => reviewUndoRedo('redo'));
  dialog.addEventListener('keydown', event => {
    if(!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key=event.key.toLowerCase();
    const direction=key==='y' || (key==='z' && event.shiftKey) ? 'redo' : key==='z' ? 'undo' : null;
    if(!direction) return;
    const tag=event.target?.tagName?.toLowerCase();
    if(['input','textarea','select'].includes(tag)) { event.stopPropagation(); return; }
    event.preventDefault();
    event.stopPropagation(); // avoid applying global Undo/Redo twice
    reviewUndoRedo(direction);
  });
  el('nextRoi').addEventListener('click', () => recommendRoi());
  el('applyChampion').addEventListener('click', () => adoptChampion());
  el('startValidation').addEventListener('click', () => {
    if(!current || busy)return;
    close();
    onStartValidation?.();
  });
  el('adaptive').addEventListener('change', () => {
    champion=current?{...current.boundaryOptions}:null;
    challenger=proposal=null;a=b=null;clearVote();
    report('方式を変更しました。A/Bを比較してください。');
  });
  el('zoom').addEventListener('change', () =>
    updateViewportZoom(Number(el('zoom').value)));
  for (const voteButton of dialog.querySelectorAll('[data-vote]'))
    voteButton.addEventListener('click', () => vote(voteButton.dataset.vote));
  el('judgeA').addEventListener('click', () => selectManualSide('a'));
  el('judgeB').addEventListener('click', () => selectManualSide('b'));
  el('tool').addEventListener('change', () => { pending = null; drawHover(); });
  el('pixels').addEventListener('change', () => drawHover());
  const pixelSelectLabel=el('pixels').closest('label');
  const refreshStrokeOption=()=>{pixelSelectLabel.hidden=el('strokeMode').checked;};
  el('strokeMode').addEventListener('change',refreshStrokeOption);
  refreshStrokeOption();
  for (const side of ['a','b']) {
    candidateCanvas[side].addEventListener('click', event => judge(event, side));
    candidateCanvas[side].addEventListener('pointerdown', event => beginStroke(event,side));
    candidateCanvas[side].addEventListener('pointermove', event => {
      if(stroke)continueStroke(event,side);
      else drawHover(event,side);
    });
    candidateCanvas[side].addEventListener('pointerup', event => endStroke(event,side));
    candidateCanvas[side].addEventListener('pointercancel', event => endStroke(event,side,true));
    candidateCanvas[side].addEventListener('pointerleave', () => {if(!stroke)drawHover();});
  }
  for(const side of ['A','B']){
    const pane=el('scroll'+side);
    pane.addEventListener('wheel',event=>{
      if(!current||stroke||pan)return;
      event.preventDefault();
      const zoom=nextWheelZoom(interactionZoom,event.deltaY);
      if(zoom!==interactionZoom)updateViewportZoom(zoom,side,event.clientX,event.clientY);
    },{passive:false});
    pane.addEventListener('pointerdown',event=>{
      if(event.button!==1||!current)return;
      event.preventDefault();event.stopPropagation();
      pan={side,id:event.pointerId,
        x:event.clientX,y:event.clientY,
        scrollLeft:pane.scrollLeft,scrollTop:pane.scrollTop};
      pane.setPointerCapture(event.pointerId);
      pane.classList.add('local-ab-panning');
    });
    pane.addEventListener('pointermove',event=>{
      if(!pan||pan.id!==event.pointerId||pan.side!==side)return;
      event.preventDefault();
      const position=dragViewport(pan,{x:event.clientX,y:event.clientY});
      pane.scrollLeft=position.scrollLeft;
      pane.scrollTop=position.scrollTop;
    });
    const stop=event=>{
      if(!pan||pan.id!==event.pointerId||pan.side!==side)return;
      pan=null;
      if(pane.hasPointerCapture(event.pointerId))pane.releasePointerCapture(event.pointerId);
      pane.classList.remove('local-ab-panning');
    };
    pane.addEventListener('pointerup',stop);
    pane.addEventListener('pointercancel',stop);
    pane.addEventListener('auxclick',event=>{
      if(event.button===1)event.preventDefault();
    });
  }
  for (const [left, right] of [['scrollA','scrollB'],['scrollB','scrollA']]) {
    el(left).addEventListener('scroll', () => {
      if (scrollLock) return;
      scrollLock = true;
      el(right).scrollLeft = el(left).scrollLeft;
      el(right).scrollTop = el(left).scrollTop;
      scrollLock = false;
    });
  }
  return { close, stats };
}
