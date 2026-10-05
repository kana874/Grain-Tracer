# GrainTracer Batch 2 実施内容まとめ

**対象バージョン:** v0.4.2-alpha  
**対象リポジトリ:** `kana874/Grain-Tracer`  
**P1ブランチ:** `feature/boundary-suppression` / PR #12  
**P2ブランチ:** `feature/hysteresis-tracking` / PR #13  
**作成日:** 2026-10-05

---

## 1. Batch 2 の目的

Batch 2 は次の2段階を対象とする。

1. **P1: False Positive削減**
   - 粒内デンドライト・粒内暗線等を粒界として拾う誤検出を減らす。
   - 従来Boundary Scoreを残したまま、独立Negative Evidenceと小型Classifierを追加する。
   - Auto TuneがF1改善と引き換えにRecallを大きく落とすケースをGuardする。

2. **P2: Hysteresis Boundary Tracking**
   - Sensitivityを全体的に上げず、Strong Boundaryへ接続するWeak Boundaryのみ復活させる。
   - Negative / Exclusion、方向、曲率、距離をGuardする。
   - Continuous NMSの前後順序を比較可能にする。

---

## 2. バージョン

- App Version: `0.4.2-alpha`
- Project Format Version: `3`
- Diagnostic Schema: `graintracer-diagnostic-v17`
- Algorithm Version: `boundary-v15-hysteresis-tracking`

Project FormatはP1でv3へ更新した。P2のHysteresis設定は既存の `settings.hysteresis` に保存するため、P2ではformatVersionを追加更新していない。

---

## 3. P1 — False Positive削減

### 3.1 Dendrite Suppression v2

`src/dendrite.js` に `computeDendriteLinePenalty()` を追加した。

主な根拠:

- Ridge強度
- Color差が弱いこと
- Structure Tensorの左右連続性
- 線方向の長距離連続性
- 近傍平行線Support
- 既存DendriteDifferenceによるBoundary側Guard

出力は独立特徴 `dendriteLinePenalty` とし、既存のDendriteDifferenceを置換しない。

### 3.2 Positive / Negative Evidence

Boundary Scoreに以下のモードを追加した。

- `legacy`: 従来の非負加重平均
- `evidence`: Positive Evidence - Negative Evidence
- `classifier`: Guard合格済みClassifierのP(boundary)

Legacyを残して後方互換性とrevert経路を維持する。

### 3.3 Browser Logistic Classifier

新規 `src/boundary-classifier.js`。

入力特徴:

- Dark
- Ridge
- Color
- Dendrite Difference
- Dendrite Line Penalty
- Coherence
- Ridge Scale

条件:

- ブラウザ内完結
- 外部通信なし
- GPU不要
- Positive / Negativeのみ教師に使用
- Unknownは教師にしない
- 明示的Training ROIのみ学習
- Validation/Testは学習から除外

### 3.4 Classifier Guard

Validation ROIで以下を確認してから自動採用する。

- Recallの許容低下以内
- F1非悪化Guard
- Negative Leakage改善
- Weighted Closure重大悪化なし
- Open数重大悪化なし

Test ROIはGuardにも使用しない。

### 3.5 Auto Tune Recall Guard

Batch 1で確認された、MinComponent変更によりF1が上がる一方でRecall@1が大きく低下するケースへの対策を追加した。

Auto Tune開始時のprocessed Recallを基準に、既定で **2 percentage pointsを超えるRecall低下を不採用** とする。

---

## 4. P2 — Hysteresis Boundary Tracking

### 4.1 Dual Threshold

新規 `src/hysteresis.js`。

- High Threshold以上 → Strong Boundary
- Low Threshold以上High未満 → Weak Boundary
- Low未満 → Reject

### 4.2 Strong-seeded Weak Tracking

WeakはStrongからの到達経路が存在する場合のみ候補とし、次のGuardを通過した画素だけ採用する。

- Boundary Score連続性
- Ridge evidence
- Color evidence
- Ridge normal方向連続
- Boundary tangentとの整合
- 曲率変化上限
- 最大追跡距離
- Negative Hard Reject
- Exclusion Hard Reject

Strong seedを持たない孤立Weak Lineは昇格させない。

### 4.3 NMS順序

2方式を実装した。

- `before-tracking`: NMS → Strong/Weak追跡
- `after-tracking`: Strong/Weak追跡 → NMS

Synthetic Testでは両経路を実行する。現時点のUI既定値は `before-tracking`。

### 4.4 Staged Default

実画像Baseline比較が未実施のため、既存Projectに対するHysteresisの初期値は **OFF** とした。

このためv0.4.2-alphaを読み込んだだけでは、既存の単一閾値抽出結果を自動変更しない。

---

## 5. UI

粒界検出設定へ以下を追加した。

### P1

- Boundary Score mode
- 粒内線Penalty weight
- Classifier学習・検証
- Classifier解除
- Classifier Guard状態

### P2

- Hysteresis ON/OFF
- High Threshold
- Low Threshold
- 最大追跡距離
- 最大方向差
- NMS順序
- Strong / Weak / 採用 / Reject状態

---

## 6. Diagnostic

Diagnostic Schemaをv17へ更新した。

追加:

- `dendriteLinePenalty` feature statistics
- Classifier coefficients
- Classifier normalization parameters
- Classifier sample counts
- Classifier Guard結果
- Hysteresis settings
- Strong count
- Weak candidate count
- Accepted weak count
- Rejected weak count
- Reject reason counts
- NMS order
- `dendrite-line-penalty.png`

---

## 7. Project互換

Project Formatはv3。

- v1/v2 → v3 migrationを維持
- Classifier model / Guard stateを保存
- Hysteresis設定を `settings.hysteresis` に保存
- Hysteresis未設定の旧ProjectはOFFとして扱う
- Legacy Boundary Scoreを維持

---

## 8. 自動テスト

GitHub Actions / Node.js 22で最新headを確認。

```text
tests 39
pass 39
fail 0
```

Batch 2追加項目:

- Negative EvidenceによるFalse Line抑制
- Logistic ClassifierのPositive/Negative分離
- Unknownを教師にしないこと
- Classifier Guard
- Auto Tune Recall Guard
- Strong / Weak分類
- Strong-seeded Weak回復
- StrongなしWeak LineのReject
- Negative crossing Reject
- Exclusion crossing Reject
- Direction / Tangent Guard
- Max Tracking Distance
- NMS-before path
- NMS-after path
- Hysteresis settings persistence

Batch 1の既存回帰試験も同時に全て通過している。

---

## 9. Batch 1 Baseline

Batch 2の実画像比較基準はBatch 1で固定した以下。

```text
Recall @1 px             81.843%
Recall @2 px             90.290%
Recall @3 px             94.282%
Recall @4 px             96.604%
Negative Leakage          3.792%
Macro Negative Leakage    3.957%
Complete ROI Precision   36.393%
Complete ROI Recall      78.985%
Complete ROI F1          49.828%
Alignment Mean            1.026 px
Alignment Median          1 px
Alignment p90             2 px
Weighted Closure Score   43.269%
Mean Required Radius      2.269 px
Open @3                   5
Exact Closure Rate        0%
Unknown Prediction       174,346
```

---

## 10. 実画像評価

**未実施 / Manual Gate。**

理由:

- 上記Baselineを取得したBMPおよびProject実データはリポジトリへ含めていない。
- CIではSynthetic TestとProject migrationは再現できるが、実画像のRecall / Precision / Leakage / Alignment / Closure比較は実データなしでは算出できない。

したがって、Batch 2のコード実装・自動試験は完了しているが、正式な受入判定は次の実画像比較後とする。

---

## 11. Batch 2 実画像受入で記録する値

P1単独、P1+P2それぞれについて以下を保存する。

```text
Recall @1 px
Recall @2 px
Recall @3 px
Recall @4 px

Negative Leakage
Macro Negative Leakage

Complete ROI Precision
Complete ROI Recall
Complete ROI F1

Alignment mean
Alignment median
Alignment p90

Weighted Closure Score
Mean Required Radius
Open @3
Exact Closure

Boundary Pixel Count
Unknown Prediction Count
```

特に確認する。

- P1でPrecision / Negative Leakageが改善するか
- Dendrite / False Lineが減るか
- Recallを大きく落としていないか
- P2でWeak Boundaryが復元されるか
- Open@3 / Closureが悪化しないか
- Negative / Exclusionを跨いだ誤接続がないか

---

## 12. 変更ファイル

Batch 1 headからBatch 2最終headまでの主要変更:

### 新規

- `src/boundary-classifier.js`
- `src/hysteresis.js`
- `tests/batch2-p1.test.js`
- `tests/batch2-p2.test.js`

### 更新

- `src/analysis.js`
- `src/dendrite.js`
- `src/app.js`
- `src/diagnostics.js`
- `src/project.js`
- `index.html`
- `package.json`
- `tests/dom-integrity.test.js`
- `tests/project-migration.test.js`
- `CHANGELOG.md`

---

## 13. 現時点の判定

### コード / Synthetic Gate

**PASS**

- Syntax PASS
- DOM regression PASS
- Project migration PASS
- Batch 1 regression PASS
- P1 Synthetic PASS
- P2 Synthetic PASS
- GitHub Actions 39/39 PASS

### Real-image Gate

**PENDING**

実画像Baseline比較前なので、Hysteresisを既定ONにはしない。

### Batch 3移行

P3 Topology Repair v4の実装を開始する前に、v0.4.2-alphaで固定Baseline画像を再実行し、Batch 2受入指標を記録する。
