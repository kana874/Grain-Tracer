# GrainTracer Batch 3 実施内容まとめ

**対象バージョン:** v0.5.0-alpha  
**対象リポジトリ:** `kana874/Grain-Tracer`  
**実装ブランチ:** `feature/topology-v4`  
**基点:** `feature/hysteresis-tracking` / Batch 2 最終 `v0.4.3-alpha`  
**作成日:** 2026-10-05  
**状態:** v4.1実画像再評価で単独Repair判定の過剰Rejectを検出 → v4.2 Bundle Repair修正・Synthetic/CI完了、再実画像評価待ち

---

## 1. Batch 3 の目的

Batch 3 / P3では、「数px膨張すれば閉じる」状態を診断するだけでなく、Final Boundary Maskそのものを安全に閉じるための **Topology Repair v4** を追加する。

重点は次の4点。

1. Final Boundary CenterlineをSkeleton Graphへ変換する。
2. Endpoint→Endpointだけでなく、Endpoint→Existing Boundary、Endpoint→Junctionを明示的に扱う。
3. 直線補間だけでなく、画像Evidenceに沿ったA*型経路探索を行う。
4. Recall / Negative Leakage / Verified ROI Precisionを守った上でTopologyが改善したRepairだけを採用し、全Repairをrevert可能にする。

---

## 2. バージョン

- App Version: `0.5.0-alpha`
- Project Format Version: `4`
- Diagnostic Schema: `graintracer-diagnostic-v19`
- Algorithm Version: `boundary-v17-topology-repair-v4`

Project Format v4では `settings.topologyRepair` を保存する。v1～v3 Projectは既存データを維持したままv4へmigrationする。旧ProjectにTopology Repair設定がない場合、設定を勝手に生成せずUI既定値へフォールバックする。

---

## 3. Skeleton Graph

新規:

```text
src/topology-repair.js
```

Final Boundary Centerlineを8近傍接続でグラフ化する。

ノード分類:

```text
degree = 1   endpoint
degree = 2   ordinary boundary
degree >= 3  junction
```

隣接するjunction pixel群は1つの論理junction nodeへまとめる。

Graph edgeは最低限以下を保持する。

```js
{
  id,
  startNodeId,
  endNodeId,
  pixels,
  lengthPx,
  meanBoundaryScore,
  meanRidge,
  meanColor,
  curvature
}
```

診断JSONへは巨大なpixel配列をそのまま保存せず、`compactSkeletonGraph()` でノード・エッジ情報を制限して保存する。

---

## 4. Repair候補

Topology Repair v4は以下を別種別として生成する。

```text
endpoint-endpoint
endpoint-boundary
endpoint-junction
```

候補生成時に以下を確認する。

- 最大探索距離
- Endpoint outward tangent
- 相手Endpointの向き
- Junction進入角
- 既存Boundaryとの位置関係
- Protected frame

同一Endpointを1回のRepair passで複数Repairへ使用しない。

---

## 5. A* Evidence Path

Extended Gapの直線補間とは別に、画像空間上でA*型探索を行う。

概念コスト:

```text
PathCost =
    StepLength
  + (1 - BoundaryProbability) × EvidenceWeight
  + CurvaturePenalty
  + DendritePenalty
  + DirectionMismatchPenalty
```

BoundaryProbabilityが直接存在しない通常のアプリ経路では、Ridge / Color evidenceから経路Evidenceを構成する。

Hard Reject:

```text
Negative
Exclusion
Protected frame
既存Boundary crossing（意図したtarget以外）
```

Repair後は局所背景連結成分数を比較し、過度なSplit増加を拒否する。

---

## 6. Topology Repair Guard

自動採用は加重F1で一括判定せず、優先順位付きで判定する。

```text
1. Positive Recall
2. Negative Leakage
3. Verified ROI Precision
4. Exact Closure / Closure Profile
5. Alignment / F1
```

既定Guard:

- Recall: Repair前から0.1ptを超えて低下しない
- Negative Leakage: 0.1ptを超えて増加しない
- Verified ROI Precision: 0.2ptを超えて低下しない
- 上記通過後、Exact Closure / Weighted Closure / Open@3 / Mean Required Radiusのいずれかが改善すること

Repairは追加型であり、

```text
Base Boundary Mask ⊆ Final Boundary Mask
```

を必須不変条件とする。

診断:

```text
baseBoundaryPixels
finalBoundaryPixels
basePixelsRemovedByRepair
preservationInvariant
guard.checks
```

---

## 7. UI

詳細チューニング・診断へTopology Repair v4パネルを追加した。

設定:

- 自動最適化でTopology Repair v4を使用
- 最大探索距離
- 最小Path Evidence
- 最大曲率変化
- Repair候補プレビュー

Safe / Extended Gapと同じ適用・revert経路を使うため、複数段階のRepair後でも「Gap / Repair適用を戻す」でRepair開始前のBase Maskへ戻せる。

旧Projectの動作を変えないため、Topology Repair v4の自動最適化への組込みは初期状態OFFとする。

---

## 8. One-click Optimization

有効時の処理順:

```text
Global Auto Tune
↓
Local Calibration
↓
Safe Gap Guard
↓
Extended Gap Guard
↓
Topology Repair v4 Guard
↓
Final Evaluation
```

Topology Repair v4がOFF、候補なし、またはGuard不合格の場合はそのstageだけをskipし、それ以前のaccepted maskを維持する。

---

## 9. Diagnostic v19

追加:

```text
topologyGraph
repairPaths
postProcessing.topologyRepair
performance.topologyRepairMs
```

`repairPaths` には種別、始終点、距離、長さ、Path Evidence、Ridge/Color/Dendrite evidence、最大曲率、Split増加、Score、追加pixel数、経路座標を保存する。

巨大な内部配列（mask / degree map等）はDiagnostic JSONへそのまま出力しない。

---

## 10. Project Format v4

`currentSettings()` に以下を追加。

```js
topologyRepair: {
  enabled,
  maxSearchDistance,
  minPathEvidence,
  maxCurvatureDeg,
  maxEndpointAngleDeg,
  junctionMinAngleDeg,
  negativeGuardRadius,
  protectedFrameMargin,
  maxLocalSplitIncrease,
  maxAcceptedRepairs
}
```

Project v1/v2/v3 → v4 migrationを自動テストする。

---

## 11. Synthetic Test

新規:

```text
tests/batch3-p3.test.js
```

確認済み:

- Skeleton GraphのEndpoint / Junction / Edge生成
- Edge diagnostic fields
- 1 px gap repair
- 2 px gap repair
- 3 px gap repair
- Negative crossing Hard Reject
- Exclusion crossing Hard Reject
- Endpoint → Existing Boundary
- Endpoint → Junction
- 完成済みT/Y系junctionに不要なRepairを作らない
- 曲線状の高Evidence経路をA*探索できる
- 1 Endpointの多重使用禁止
- Exact Closure改善
- Open@3非悪化
- Mean Required Radius改善
- Guard優先順位（Recallを最初に判定）
- Base pixel preservation invariant

GitHub ActionsのNode regression suiteは `feature/topology-v4` 上でPASSしている。

---

## 12. 変更ファイル

### 新規

```text
src/topology-repair.js
tests/batch3-p3.test.js
GrainTracer_Batch3_実施内容_v0.5.0-alpha.md
```

### 更新

```text
src/app.js
src/diagnostics.js
src/project.js
index.html
package.json
tests/project-migration.test.js
tests/dom-integrity.test.js
README.md
docs/DESIGN.md
CHANGELOG.md
```

---

## 13. Batch 2 Baselineとの比較

Batch 3の実画像回帰は、Batch 2最終確認で使用した同一BMP / Project / 条件で実施する。

| 指標 | Batch 2 accepted baseline | Batch 3 |
|---|---:|---:|
| Recall @1 px | 82.596% | **実画像評価待ち** |
| Recall @2 px | 90.867% | **実画像評価待ち** |
| Recall @3 px | 94.747% | **実画像評価待ち** |
| Recall @4 px | 96.919% | **実画像評価待ち** |
| Negative Leakage | 3.817% | **実画像評価待ち** |
| Macro Negative Leakage | 3.553% | **実画像評価待ち** |
| Complete ROI Precision | 36.932% | **実画像評価待ち** |
| Complete ROI Recall | 80.041% | **実画像評価待ち** |
| Complete ROI F1 | 50.543% | **実画像評価待ち** |
| Alignment Mean | 1.000 px | **実画像評価待ち** |
| Alignment Median | 1 px | **実画像評価待ち** |
| Alignment p90 | 2 px | **実画像評価待ち** |
| Weighted Closure Score | 44.643% | **実画像評価待ち** |
| Mean Required Radius | 2.214 px | **実画像評価待ち** |
| Open @3 | 6 | **実画像評価待ち** |
| Exact Closure Rate | 0% | **実画像評価待ち** |
| Boundary Pixel Count | 193,274 | **実画像評価待ち** |
| Unknown Prediction | 172,187 | **実画像評価待ち** |

Synthetic Testの改善を実画像の改善値として代用しない。

---

## 14. 実画像受入で確認する項目

最低限:

1. Topology Repair v4 OFFでBatch 2相当値を再現できること。
2. Topology Repair v4 ONでRecall Guard内であること。
3. Negative / Macro Negative LeakageがGuard内であること。
4. Verified ROI PrecisionがGuard内であること。
5. Exact Closureが改善すること。
6. Open@3が改善または維持すること。
7. Mean Required Radiusが改善すること。
8. 不自然なSplitが増えていないこと。
9. Repair pathをDiagnostic JSONで追跡できること。
10. Revert後にRepair前Boundary Maskへ完全復帰すること。

---

## 15. 初回実画像評価とv4.1修正

初回実画像評価では、Batch 2 Final Baselineの再現自体はPASSした。一方でTopology Repair v4候補は次の状態だった。

```text
Skeleton Endpoint        25,295
Skeleton Junction        18,479
Source candidates           240
Accepted local repairs       89
Added pixels                361
Global topology gain          0
Guard result               REJECT
```

Recall / Negative Leakage / Verified ROI Precision Guardは通過したが、Exact Closure / Weighted Closure / Open@3 / Mean Required Radiusがすべて不変だったため、最終Guardが正しく拒否した。

原因は主に次の2点。

1. Endpoint→Endpointを先に全探索してcandidate capへ詰める構造だったため、Endpoint→Boundary / Junctionが候補枠から押し出された。
2. 画像全体の「繋ぎやすいEndpoint」を探索しており、Closed-Negative Closure評価対象へ直接向いていなかった。

v4.1では以下へ変更した。

- Closed-Negative componentをTopology targetとして明示
- Exact Closureしていないtarget周辺だけを優先探索
- Endpoint / Junctionを空間Gridで局所検索
- Endpoint→Endpoint / Boundary / Junctionへ候補枠を均等配分
- candidateごとに対象targetの局所Closure signatureをbefore/after評価
- topology寄与0のcandidateをPath採用前にreject
- 同一targetへ複数Repairする場合もincremental topology gainを再確認
- candidate種別・target数・topology寄与数をDiagnosticへ追加

これにより、初回実画像で約24.8秒を要した全域探索の主要ボトルネックも同時に除去した。

### v4.1 実画像再評価

v4.1では探索時間が約24.8秒から約2.0秒へ短縮され、候補選択も

```text
Endpoint→Endpoint  120
Endpoint→Boundary  120
Endpoint→Junction  120
```

へ均等化した。一方、Hard Guard / Evidenceを通過した候補のうち70件が `topologyNoGain` となり、Accepted Repairは0だった。

この結果から、実画像では1つのTopology Targetに複数Gapが存在し、

```text
Repair Aだけ   → まだOpen
Repair Bだけ   → まだOpen
Repair A + B   → Closure改善
```

となるケースを単独Repair判定が捨てていると判断した。

### v4.2 Bundle Repair

v4.2では、安全条件を通過したRepair候補をTopology Target単位でGroupingし、Targetごとに最大6候補から1～3本のBundleを探索する。

```text
Safe candidate paths
↓
Group by Topology Target
↓
1-path / 2-path / 3-path bundle
↓
Bundle全体のClosure Signatureを評価
↓
改善Bundleだけ採用
↓
Global Recall / Leakage / Precision / Topology Guard
```

単独RepairがTopology中立でも、Bundle全体でExact Closure / Required Radius / Weighted Closure / Open@3等が改善する場合は採用可能とした。

Negative / Exclusion / Protected frame / Path Evidence / Curvature / Endpoint重複 / Target重複 / 各PathのLocal Split Guardは緩和しない。Bundle全体を広い矩形でLocal Split再判定すると「意図した粒の閉鎖」自体をSplitとして誤検出するため、Bundleでは各Pathが既に通過したLocal Split Guardを維持し、Target-level Closure Signatureで最終判定する。

Diagnosticには以下を追加した。

```text
acceptedBundles
bundleSearch
individuallyImprovingCandidateCount
bundleId
bundleSize
bundleRank
individualTopologyContribution
topologyContribution (Bundle全体)
```

Synthetic Testには「2つのGapのどちらも単独ではTopology改善0だが、2本BundleならExact Closureする」回帰ケースを追加した。

---

## 16. 既知の課題

- v4.1の実画像再評価で探索時間と候補種別分布を確認する必要がある。
- Junction clusterの8近傍統合が複雑な太いjunctionで過統合しないか実画像確認が必要。
- Ridge/Colorから構成するBoundary evidenceの既定重みはSynthetic受入済みだが、実画像での最適値は未確定。
- Local Split Guardは局所背景component数を使う近似であり、最終的な求積法Split/Merge評価そのものではない。
- Classifier利用時のP(boundary)をTopology path costへ直接渡す統合は将来拡張可能だが、Batch 3初期版は既存Ridge/Color evidenceを標準とする。

---

## 17. Batch 3 完了判定

### コード / Synthetic

- [x] Skeleton Graph
- [x] Endpoint / Junction extraction
- [x] Endpoint→Endpoint
- [x] Endpoint→Boundary
- [x] Endpoint→Junction
- [x] A* Evidence Path
- [x] Negative / Exclusion / Protected frame Guard
- [x] Tangent / Junction angle / Curvature / Evidence Guard
- [x] Endpoint多重使用禁止
- [x] Split増加Guard
- [x] Recall / Leakage / Precision / Topology優先Guard
- [x] Revert経路
- [x] Project v4保存・migration
- [x] Diagnostic v19
- [x] Synthetic regression
- [x] GitHub Actions

### 実画像

- [x] Batch 2 Baseline再現
- [ ] Topology Repair v4 ON比較
- [ ] Exact Closure改善
- [ ] Open@3改善または維持
- [ ] Mean Required Radius改善
- [ ] Recall / Precision / Leakage Guard確認
- [ ] Repair path目視確認
- [ ] Revert完全復帰確認

**判定:** Batch 2互換性は確認済み。初回Topology RepairはGuard REJECT、v4.1では単独Repair判定による全候補Rejectを確認し、v4.2 Bundle Repairへ修正済み。再実画像受入が完了するまではBatch 4へ正式移行しない。
