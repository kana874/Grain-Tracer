import { buildBoundaryMask } from './analysis.js';
import { selectFeedbackSegment, buildFeedbackConnection } from './feedback-learning.js';
import { positionLocalRoi, withinLocalRoi, localAbCounts, filterLocalReview } from './local-ab.js';

// Local A/B operates on the analysis-preview coordinate grid. The same global
// feature cache and exclusion mask are used for both candidates. A/B votes are
// preference data, not true-positive ground-truth or F1.
export function setupLocalAB({ getSnapshot, getFeatures, getLegacyFeatures, onVote, onFeedback }) {
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
    '<label>候補Bの条件 <select data-k="variant">',
    '<option value="plus8">感度 +8</option><option value="minus8">感度 -8</option>',
    '<option value="plus16">感度 +16</option><option value="toggleNms">NMS 切替</option>',
    '<option value="legacyEdge">旧・画像端処理（比較診断）</option>',
    '</select></label>',
    '<button class="primary" data-k="generate" type="button">この条件で比較</button>',
    '<p class="help">Aは現在の設定で再抽出した結果。Bは選んだ設定だけを変更し、同じ領域で比較します。学習やパラメータの自動適用は行いません。</p>',
    '<p data-k="message" class="help" role="status">BMP読み込み後に開始できます。</p>',
    '</section><section class="local-ab-results">',
    '<div class="local-ab-controls"><label>同期倍率 <select data-k="zoom"><option value="1">100%</option><option value="2" selected>200%</option><option value="4">400%</option><option value="8">800%</option></select></label>',
    '<span data-k="difference"></span></div>',
    '<div class="local-ab-compare">',
    '<div class="local-ab-card" data-k="cardA"><h3>A：現在の設定</h3><div class="local-ab-scroll" data-k="scrollA"><div class="local-ab-stage" data-k="stageA"><canvas data-k="viewA"></canvas><canvas data-k="hoverA" class="local-ab-hover"></canvas></div></div><p data-k="countA"></p></div>',
    '<div class="local-ab-card" data-k="cardB"><h3>B：変更した設定</h3><div class="local-ab-scroll" data-k="scrollB"><div class="local-ab-stage" data-k="stageB"><canvas data-k="viewB"></canvas><canvas data-k="hoverB" class="local-ab-hover"></canvas></div></div><p data-k="countB"></p></div>',
    '</div><div class="local-ab-votes"><strong>② 良い方を選択（選好履歴へ保存）</strong>',
    '<button type="button" data-vote="a">Aが良い</button><button type="button" data-vote="b">Bが良い</button>',
    '<button type="button" data-vote="neither">両方不正解</button><button type="button" data-vote="uncertain">判断不能</button>',
    '</div><div class="local-ab-manual"><strong>③ 選んだ候補を手動評価</strong>',
    '<p class="help">A/Bを選択後、該当する画像上でクリックします。「両方不正解」でも手動評価する候補を選べます。</p>',
    '<div><button type="button" data-k="judgeA">Aを修正</button><button type="button" data-k="judgeB">Bを修正</button></div>',
    '<label>判定 <select data-k="tool"><option value="positive">正解</option><option value="negative">誤検出</option><option value="missing">検出漏れ（2点）</option></select></label>',
    '<label>一度の対象 <select data-k="pixels"><option value="1">1px</option><option value="3" selected>最大3px</option><option value="5">最大5px</option><option value="9">最大9px</option></select></label>',
    '<p data-k="reviewStatus" role="status">A/Bを選択してください。既存お手本へ部分ラベルとして保存されます。</p>',
    '</div></section></div>'
  ].join('');
  document.body.append(dialog);
  const el = name => dialog.querySelector('[data-k="' + name + '"]');
  const original = document.createElement('canvas');
  let current = null, roi = null, a = null, b = null, active = null;
  let pending = null, request = 0;
  let busy = false, scrollLock = false;
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
    roi = positionLocalRoi(current.preview.width, current.preview.height,
      Number(el('roiSize').value), cx, cy);
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
    const zoom = Number(el('zoom').value);
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
  function variantOptions(base) {
    const kind = el('variant').value;
    if (kind === 'plus8') return { ...base, sensitivity: bound(base.sensitivity + 8, 1, 100) };
    if (kind === 'minus8') return { ...base, sensitivity: bound(base.sensitivity - 8, 1, 100) };
    if (kind === 'plus16') return { ...base, sensitivity: bound(base.sensitivity + 16, 1, 100) };
    if (kind === 'toggleNms') return { ...base, centerlineNms: !base.centerlineNms };
    return { ...base, edgeFrameGuard: 1 };
  }
  async function generate() {
    if (!validContext() || busy) return;
    const myRequest = ++request;
    busy = true;
    a = b = null; clearVote();
    const run = el('generate');
    run.disabled = true;
    report('特徴量とA/B候補を作成しています…');
    try {
      const features = await getFeatures();
      if (myRequest !== request || !validContext()) return;
      const base = current.boundaryOptions;
      const maskA = await buildBoundaryMask(features, { ...base, onProgress: () => {} });
      if (myRequest !== request || !validContext()) return;
      const old = el('variant').value === 'legacyEdge';
      const variantFeatures = old ? await getLegacyFeatures() : features;
      const maskB = await buildBoundaryMask(variantFeatures, {
        ...variantOptions(base), onProgress: () => {},
      });
      if (myRequest !== request || !validContext()) return;
      a = maskA; b = maskB;
      drawCandidates();
      report('同一範囲で比較できます。選好は正解データではなく別の履歴として保存されます。');
    } catch (error) {
      console.error('local A/B', error);
      report('比較に失敗しました: ' + error.message);
    } finally {
      busy = false;
      run.disabled = false;
    }
  }
  function vote(winner) {
    if (!validContext() || !a || !b || busy) return;
    const counts = localAbCounts(a, b, current.preview.width, roi, current.exclusionMask);
    onVote({
      schema: 'graintracer-local-ab-v1',
      createdAt: new Date().toISOString(),
      imageFingerprint: current.fingerprint,
      roi: { ...roi }, coordinateSystem: 'analysis-preview',
      winner,
      aSettings: {
        sensitivity: current.boundaryOptions.sensitivity,
        minComponent: current.boundaryOptions.minComponent,
        centerlineNms: current.boundaryOptions.centerlineNms,
        scoreMode: current.boundaryOptions.scoreMode,
      },
      variant: el('variant').value,
      bSettings: {
        sensitivity: variantOptions(current.boundaryOptions).sensitivity,
        centerlineNms: variantOptions(current.boundaryOptions).centerlineNms,
        edgeFrameGuard: variantOptions(current.boundaryOptions).edgeFrameGuard,
      },
      counts,
    });
    for (const button of dialog.querySelectorAll('[data-vote]'))
      button.classList.toggle('selected', button.dataset.vote === winner);
    if (winner === 'a' || winner === 'b') selectManualSide(winner);
    else {
      active = null; pending = null; drawHover();
      el('reviewStatus').textContent = '選好を保存しました。必要なら「Aを修正」「Bを修正」で手動評価できます。';
    }
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
    if (!rect.width || !rect.height) return null;
    const x = Math.floor((event.clientX - rect.left) * roi.width / rect.width);
    const y = Math.floor((event.clientY - rect.top) * roi.height / rect.height);
    if (x < 0 || x >= roi.width || y < 0 || y >= roi.height) return null;
    return { x: roi.x + x, y: roi.y + y };
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
  function judge(event, side) {
    if (!validContext() || side !== active || !a || !b || busy) {
      el('reviewStatus').textContent = 'A/Bを選択してから、選択した側の画像をクリックしてください。';
      return;
    }
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
      const saved = onFeedback(path.indices, 'missing', path.anchor);
      el('reviewStatus').textContent = saved ? '検出漏れを部分ラベルとして保存しました。' : '既存ラベルと重複しています。';
    } else {
      const picked = candidateFor(side, point);
      if (!picked) {
        el('reviewStatus').textContent = '候補がクリックから2px以内にありません。欠落を指定してください。';
        return;
      }
      const saved = onFeedback(picked.indices, kind, picked.anchor);
      el('reviewStatus').textContent = saved
        ? kind === 'positive' ? '正解を保存しました。' : '誤検出を保存しました。'
        : '同じ画素は評価済みです。';
    }
    const updated = getSnapshot();
    if (updated) {
      current.referenceCenterline = updated.referenceCenterline;
      current.negativeCenterline = updated.negativeCenterline;
    }
    drawCandidates();
  }
  function open() {
    const data = getSnapshot();
    if (!data?.preview?.imageData || !data.fingerprint) return;
    request++;
    current = data; a = b = null; busy = false;
    const w = data.preview.width, h = data.preview.height;
    original.width = w; original.height = h;
    original.getContext('2d').putImageData(data.preview.imageData, 0, 0);
    el('roiSize').value = '256';
    updateRoiAt(w / 2, h / 2);
    dialog.showModal();
    generate();
  }
  function close() {
    request++; current = null; a = b = null; roi = null; active = null; pending = null;
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
  el('zoom').addEventListener('change', updateScale);
  for (const voteButton of dialog.querySelectorAll('[data-vote]'))
    voteButton.addEventListener('click', () => vote(voteButton.dataset.vote));
  el('judgeA').addEventListener('click', () => selectManualSide('a'));
  el('judgeB').addEventListener('click', () => selectManualSide('b'));
  el('tool').addEventListener('change', () => { pending = null; drawHover(); });
  el('pixels').addEventListener('change', () => drawHover());
  for (const side of ['a','b']) {
    candidateCanvas[side].addEventListener('click', event => judge(event, side));
    candidateCanvas[side].addEventListener('pointermove', event => drawHover(event, side));
    candidateCanvas[side].addEventListener('pointerleave', () => drawHover());
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
  return { close };
}
