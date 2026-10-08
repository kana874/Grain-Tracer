import {paintStroke,fillInterior,labelGrains,decodeBmpCrop,MAX_CROP_PIXELS} from './ground-truth.js';
import {cropSizeForArea,positionCrop,resizeCropForArea} from './ground-truth-selection.js';
import {setupImageViewport} from './image-viewport.js';
import {APP_VERSION} from './project.js';
import {saveAutosave,loadAutosave} from './storage.js';
import {buildStoredZip} from './zip.js';
import {downloadBlob,imageDataToBlob} from './diagnostics.js';
export function setupGroundTruth(getSource) {
 const button=document.getElementById('groundTruthButton');
 const dialog=document.createElement('dialog');dialog.className='truth-dialog';
 dialog.innerHTML=`<h2>正解データ作成 <small>v${APP_VERSION}</small></h2>
 <div class="truth-workspace"><section class="truth-selector" aria-label="編集範囲の選択">
 <h3>編集範囲</h3><label>サイズ（元画像の面積）<select data-k="fraction">${Array.from({length:25},(_,i)=>`<option value="${i+8}" ${i+8===16?'selected':''}>1/${i+8}（${(100/(i+8)).toFixed(2)}%）</option>`).join('')}<option value="saved" hidden>保存範囲のサイズ</option></select></label>
 <p id="truth-selection-help">画像をクリックして位置を選択。枠はドラッグで移動できます。ホイールで拡大縮小、中ボタンドラッグで画像を移動。矢印キーで枠を調整できます（Shiftで10px）。</p>
 <div class="truth-overview" data-k="overview" tabindex="0" role="group" aria-label="元画像プレビュー・編集範囲の位置選択" aria-describedby="truth-selection-help"><div class="truth-stage" data-k="previewStage"><canvas data-k="preview"></canvas><div class="truth-selection" data-k="selection"></div></div></div><div class="truth-controls"><button data-action="previewFit">全体表示</button><button data-action="previewActual">100%</button><output data-k="previewZoom"></output></div>
 <p data-k="selectionInfo" aria-live="polite"></p>
 <div class="truth-controls"><label>X <input data-k="x" type="number" value="0" min="0" step="1"></label><label>Y <input data-k="y" type="number" value="0" min="0" step="1"></label><label>幅 <input data-k="width" type="number" readonly></label><label>高さ <input data-k="height" type="number" readonly></label></div>
 <button data-action="crop">選択範囲を開く</button><label>保存範囲<select data-k="regions"><option value="">選択</option></select></label>
 </section><section class="truth-editor" aria-label="正解データ編集">
 <div class="truth-controls"><select data-k="tool" aria-label="編集ツール"><option value="pan">移動</option><option value="1" selected>粒界（黄）</option><option value="2">粒内（緑）</option><option value="3">除外（赤）</option><option value="0">未確認へ戻す</option><option value="fill">粒内を閉領域塗り</option><option value="inspect">粒を確認</option></select>ブラシ半径(px)<input data-k="radius" type="number" value="2" min="0.5" max="100" step="0.5"><button data-action="undo">Undo</button><button data-action="redo">Redo</button><label><input data-k="overlay" type="checkbox" checked>注釈表示</label>倍率<select data-k="zoom"><option>1</option><option>2</option><option>4</option><option>8</option><option value="custom" hidden>任意</option></select><button data-action="fit">全体表示</button><button data-action="actual">100%</button><output data-k="zoomLabel"></output></div>
 <div class="truth-controls">状態<select data-k="status"><option value="draft">編集中</option><option value="review">確認待ち</option><option value="confirmed">確定（部分正解も可）</option></select>区分<select data-k="split"><option value="train">学習</option><option value="validation">検証</option><option value="test">最終評価</option></select>µm/px<input data-k="scale" type="number" min="0" step="any" placeholder="未設定"><button data-action="save">JSON保存</button><label>JSON読込<input data-k="import" type="file" accept=".json"></label><button data-action="export">正解ZIP出力</button><button data-action="close">閉じる</button></div>
 <p data-k="message" role="status"></p><div class="truth-scroll" data-k="viewer" tabindex="0" role="group" aria-label="正解データ画像ビューア"><div class="truth-stage" data-k="editorStage" hidden><canvas data-k="editor"></canvas></div></div></section></div>`;
 document.body.append(dialog);
 const el=k=>dialog.querySelector(`[data-k="${k}"]`),canvas=el('editor'),ctx=canvas.getContext('2d');
 let catalog={},source,doc,rgba,mask,undo=[],redo=[],stroke=null,saveChain=Promise.resolve(),selection=null,drag=null,opening=false,initializing=false;
 const say=t=>el('message').textContent=t;
 const viewer=el('viewer');
 const editView=setupImageViewport(viewer,el('editorStage'),{getSize:()=>({width:canvas.width,height:canvas.height}),enabled:()=>Boolean(mask)&&!opening&&!initializing,canZoom:()=>!stroke,leftPan:()=>el('tool').value==='pan',onChange:v=>{el('zoomLabel').textContent=`${Math.round(v.scale*100)}%`;el('zoom').value=[1,2,4,8].includes(v.scale)?String(v.scale):'custom';}});
 const previewView=setupImageViewport(el('overview'),el('previewStage'),{getSize:()=>({width:source.preview.width,height:source.preview.height}),enabled:()=>Boolean(source)&&!opening&&!initializing,canZoom:()=>!drag,onChange:v=>{el('previewZoom').textContent=`${Math.round(v.scale*100)}%`;el('selection').style.borderWidth=2/v.scale+'px';el('selection').style.boxShadow=`0 0 0 ${1/v.scale}px #000, inset 0 0 0 ${1/v.scale}px #000`;}});
 const key=()=>`ground-truth:${source.fingerprint}`;
 function setSelection(r){
  selection=r;
  for(const k of ['x','y','width','height'])el(k).value=r[k];
  el('x').max=source.header.width-r.width;el('y').max=source.header.height-r.height;
  const frame=el('selection');
  Object.assign(frame.style,{left:r.x*source.preview.width/source.header.width+'px',top:r.y*source.preview.height/source.header.height+'px',width:r.width*source.preview.width/source.header.width+'px',height:r.height*source.preview.height/source.header.height+'px'});
  const tooLarge=r.width*r.height>MAX_CROP_PIXELS;
  dialog.querySelector('[data-action="crop"]').disabled=opening||initializing||tooLarge;
  el('selectionInfo').textContent=`${r.width.toLocaleString()} × ${r.height.toLocaleString()} px / 面積 ${(100*r.width*r.height/(source.header.width*source.header.height)).toFixed(2)}%`+(tooLarge?'。読込上限を超えています。より小さいサイズを選んでください。':'');
 }
 function selectSavedSize(r){const n=Array.from({length:25},(_,i)=>i+8).find(n=>{const size=cropSizeForArea(source.header.width,source.header.height,n);return size.width===r.width&&size.height===r.height;});el('fraction').value=n?String(n):'saved';setSelection({...r});}
 function sourcePoint(e){const p=previewView.point(e);return{x:p.x*source.header.width/source.preview.width,y:p.y*source.header.height/source.preview.height};}
 el('fraction').addEventListener('change',()=>{if(opening||initializing||el('fraction').value==='saved')return;setSelection(resizeCropForArea(source.header.width,source.header.height,selection,Number(el('fraction').value)));});
 for(const k of ['x','y'])el(k).addEventListener('change',()=>{if(!opening&&!initializing)setSelection(positionCrop(source.header.width,source.header.height,selection,Number(el('x').value)||0,Number(el('y').value)||0));});
 el('overview').addEventListener('pointerdown',e=>{
  if(opening||initializing||e.button!==0||!selection)return;e.preventDefault();el('overview').focus();const p=sourcePoint(e);if(p.x<0||p.y<0||p.x>source.header.width||p.y>source.header.height)return;
  const inside=p.x>=selection.x&&p.x<=selection.x+selection.width&&p.y>=selection.y&&p.y<=selection.y+selection.height;
  drag={pointerId:e.pointerId,x:inside?p.x-selection.x:selection.width/2,y:inside?p.y-selection.y:selection.height/2};
  setSelection(positionCrop(source.header.width,source.header.height,selection,p.x-drag.x,p.y-drag.y));el('overview').setPointerCapture(e.pointerId);
 });
 el('overview').addEventListener('pointermove',e=>{if(!drag||drag.pointerId!==e.pointerId)return;const p=sourcePoint(e);setSelection(positionCrop(source.header.width,source.header.height,selection,p.x-drag.x,p.y-drag.y));});
 for(const event of ['pointerup','pointercancel','lostpointercapture'])el('overview').addEventListener(event,()=>{drag=null;});
 el('overview').addEventListener('keydown',e=>{
  if(opening||initializing||!selection)return;const deltas={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]},d=deltas[e.key];if(!d)return;e.preventDefault();const n=e.shiftKey?10:1;setSelection(positionCrop(source.header.width,source.header.height,selection,selection.x+d[0]*n,selection.y+d[1]*n));
 });
 function prepareSelection(){
  const preview=source.preview;
  const c=el('preview');c.width=preview.width;c.height=preview.height;c.getContext('2d').putImageData(preview.imageData,0,0);
  el('overview').style.aspectRatio=source.header.width+'/'+source.header.height;el('previewStage').style.width=preview.width+'px';el('previewStage').style.height=preview.height+'px';
  el('fraction').value='16';
  const size=cropSizeForArea(source.header.width,source.header.height,16);
  setSelection(positionCrop(source.header.width,source.header.height,size,(source.header.width-size.width)/2,(source.header.height-size.height)/2));
 }
 function snapshot(){return {...doc,appVersion:APP_VERSION,status:el('status').value,split:el('split').value,micrometersPerPixel:Number(el('scale').value)||null,labels:mask.slice(),updatedAt:new Date().toISOString()};}
 function regionKey(r){return [r.x,r.y,r.width,r.height].join(',');}
 function regionMenu(){const select=el('regions');select.replaceChildren(new Option('保存範囲を選択',''));for(const [k,d] of Object.entries(catalog))select.add(new Option(`${k} / ${d.status}`,k));}
 function persist(){if(!doc)return;doc=snapshot();for(const d of Object.values(catalog))d.split=doc.split;catalog[regionKey(doc.crop)]=doc;regionMenu();const value={schema:'ground-truth-catalog-v1',regions:structuredClone(catalog),last:regionKey(doc.crop)},k=key();saveChain=saveChain.catch(()=>{}).then(()=>saveAutosave(k,value)).catch(e=>say('自動保存失敗: '+e.message));}
 function draw(){if(!mask)return;const data=new Uint8ClampedArray(rgba),colors=[[0,0,0],[255,220,0],[0,240,100],[255,50,60]];if(el('overlay').checked)for(let p=0;p<mask.length;p++){if(mask[p])for(let c=0;c<3;c++)data[p*4+c]=Math.round(data[p*4+c]*.5+colors[mask[p]][c]*.5);}ctx.putImageData(new ImageData(data,canvas.width,canvas.height),0,0);}
 async function open(r,restored=null){
  if(opening)return;
  opening=true;finish();persist();
  for(const k of ['fraction','x','y','regions','import'])el(k).disabled=true;
  dialog.querySelector('[data-action="crop"]').disabled=true;say('選択範囲を元解像度で読み込んでいます…');
  try{
   const pixels=await decodeBmpCrop(source.file,source.header,r);rgba=pixels;
   doc=restored??{schema:'graintracer-ground-truth-v1',source:{name:source.file.name,fingerprint:source.fingerprint,width:source.header.width,height:source.header.height},crop:{...r},status:'draft',split:Object.values(catalog)[0]?.split??'train',strokes:[]};
   mask=restored?Uint8Array.from(restored.labels):new Uint8Array(r.width*r.height);canvas.width=r.width;canvas.height=r.height;el('editorStage').hidden=false;el('editorStage').style.width=r.width+'px';el('editorStage').style.height=r.height+'px';editView.resetPan();editView.fit();undo=[];redo=[];
   setSelection({...r});el('status').value=doc.status;el('split').value=doc.split;el('scale').value=doc.micrometersPerPixel??'';draw();say(`編集中: X ${r.x} / Y ${r.y} / ${r.width} × ${r.height}px。元解像度で編集しています。`);persist();
  }finally{opening=false;for(const k of ['fraction','x','y','regions','import'])el(k).disabled=false;setSelection(selection);}
 }
 function validate(d){if(d.schema!=='graintracer-ground-truth-v1'||d.source?.fingerprint!==source.fingerprint||!(Array.isArray(d.labels)||d.labels instanceof Uint8Array)||d.labels.length!==d.crop?.width*d.crop?.height||d.labels.some(v=>!Number.isInteger(v)||v<0||v>3)||!Array.isArray(d.strokes)||!['draft','review','confirmed'].includes(d.status)||!['train','validation','test'].includes(d.split))throw new Error('この画像の正解JSONではありません。');}
 function remember(){undo.push({mask:mask.slice(),strokes:structuredClone(doc.strokes)});while(undo.length>25||(undo.length>1&&undo.length*mask.byteLength>67108864))undo.shift();redo=[];el('status').value='draft';}
 function point(e){const p=editView.point(e);return p.x>=0&&p.y>=0&&p.x<canvas.width&&p.y<canvas.height?p:null;}
 viewer.addEventListener('pointerdown',e=>{if(opening||initializing||!mask||e.button!==0||el('tool').value==='pan')return;const p=point(e);if(!p)return;e.preventDefault();viewer.focus({preventScroll:true});const tool=el('tool').value;if(tool==='inspect'){const {ids,grains}=labelGrains(mask,canvas.width,canvas.height);const g=grains[ids[Math.floor(p.y)*canvas.width+Math.floor(p.x)]-1];say(g?`粒ID ${g.id} / ${g.pixels}px / ${g.incomplete?'端・未確認・除外に接触（不完全）':'閉領域'}。`:'確認する粒内をクリックしてください。');return;}remember();if(tool==='fill'){const n=fillInterior(mask,canvas.width,canvas.height,Math.floor(p.y)*canvas.width+Math.floor(p.x));doc.strokes.push({tool:'fill',point:p});draw();persist();say(`${n}px塗りました。隣の粒への漏れを確認してください。`);return;}stroke={label:Number(tool),radius:Math.max(.5,Math.min(100,Number(el('radius').value)||2)),points:[p]};viewer.setPointerCapture(e.pointerId);paintStroke(mask,canvas.width,canvas.height,[p],stroke.label,stroke.radius);draw();});
 viewer.addEventListener('pointermove',e=>{if(!stroke)return;const p=point(e);if(!p)return;const last=stroke.points.at(-1);stroke.points.push(p);paintStroke(mask,canvas.width,canvas.height,[last,p],stroke.label,stroke.radius);draw();});
 function finish(){if(stroke){doc.strokes.push(stroke);stroke=null;persist();}}viewer.addEventListener('pointerup',finish);viewer.addEventListener('pointercancel',finish);viewer.addEventListener('lostpointercapture',finish);
 el('overlay').addEventListener('change',draw);el('zoom').addEventListener('change',()=>{if(mask&&el('zoom').value!=='custom')editView.zoom(Number(el('zoom').value));});el('tool').addEventListener('change',()=>viewer.classList.toggle('pan-mode',el('tool').value==='pan'));
 const resizeObserver=new ResizeObserver(()=>{if(dialog.open&&!opening&&!initializing){previewView.fit();if(mask)editView.fit();}});resizeObserver.observe(viewer);resizeObserver.observe(el('overview'));
 dialog.addEventListener('keydown',e=>{e.stopPropagation();if(e.target.matches('input,select,textarea'))return;if(!(e.ctrlKey||e.metaKey)||e.altKey)return;const k=e.key.toLowerCase();if(k==='z'||k==='y'){e.preventDefault();dialog.querySelector(`[data-action="${k==='y'||e.shiftKey?'redo':'undo'}"]`).click();}});
 for(const k of ['status','split','scale'])el(k).addEventListener('change',()=>{if(!opening)persist();});
 dialog.addEventListener('cancel',e=>{if(opening||initializing){e.preventDefault();return;}finish();persist();});
 el('regions').addEventListener('change',async()=>{try{if(el('regions').value){const selected=el('regions').value;finish();const d=catalog[selected];await open(d.crop,d);selectSavedSize(d.crop);}}catch(e){say(e.message);}});
 el('import').addEventListener('change',async e=>{try{const d=JSON.parse(await e.target.files[0].text());validate(d);await open(d.crop,d);selectSavedSize(d.crop);}catch(e){say(e.message);}finally{el('import').value='';}});
 dialog.addEventListener('click',async e=>{const a=e.target.dataset.action;if(!a)return;try{
 if(opening||initializing)throw new Error('範囲の読込完了を待ってください。');
 if(a==='close'){finish();persist();editView.resetPan();previewView.resetPan();dialog.close();return;}
 if(a==='previewFit'){previewView.fit();return;}if(a==='previewActual'){previewView.actual();return;}
 if(a==='fit'){if(mask)editView.fit();return;}if(a==='actual'){if(mask)editView.actual();return;}
 if(a==='crop'){finish();const r={...selection};await open(r,catalog[regionKey(r)]??null);return;}
 if(!doc)throw new Error('先に範囲を開いてください。');
 if(a==='undo'||a==='redo'){const from=a==='undo'?undo:redo,to=a==='undo'?redo:undo;if(from.length){to.push({mask:mask.slice(),strokes:structuredClone(doc.strokes)});const v=from.pop();mask=v.mask;doc.strokes=v.strokes;el('status').value='draft';draw();persist();}return;}
 doc={...snapshot(),labels:Array.from(mask)};if(a==='save'){downloadBlob(new Blob([JSON.stringify(doc)],{type:'application/json'}),'ground-truth.json');return;}
 if(a==='export'){
 const w=canvas.width,h=canvas.height,{ids,grains}=labelGrains(mask,w,h),counts=[0,0,0,0];for(const v of mask)counts[v]++;
 const entries=[{name:'annotations.json',data:JSON.stringify(doc)},{name:'image.png',data:await imageDataToBlob(new ImageData(rgba,w,h),'image/png')}];
 for(const [name,predicate] of [['boundary',v=>v===1],['interior',v=>v===2],['valid',v=>v===1||v===2],['exclusion',v=>v===3]]){const data=new Uint8ClampedArray(w*h*4);for(let p=0;p<mask.length;p++){data[p*4]=data[p*4+1]=data[p*4+2]=predicate(mask[p])?255:0;data[p*4+3]=255;}entries.push({name:name+'.png',data:await imageDataToBlob(new ImageData(data,w,h),'image/png')});}
 const binary=new Uint8Array(ids.length*4),view=new DataView(binary.buffer);ids.forEach((id,p)=>view.setUint32(p*4,id,true));entries.push({name:'grain-ids.u32',data:binary},{name:'manifest.json',data:JSON.stringify({schema:doc.schema,appVersion:APP_VERSION,source:doc.source,crop:doc.crop,split:doc.split,status:doc.status,micrometersPerPixel:doc.micrometersPerPixel,counts,completeCoverage:counts[0]===0,grains,grainIds:{file:'grain-ids.u32',dtype:'uint32',endianness:'little',shape:[h,w],background:0},labelValues:{unknown:0,boundary:1,interior:2,excluded:3},note:'粒IDは確認済み粒内のみ。同一元画像は同じ学習区分にまとめてください。'},null,2)});
 downloadBlob(await buildStoredZip(entries),'ground-truth.zip');say(`出力完了。未確認 ${counts[0]}px / 完全な粒 ${grains.filter(g=>!g.incomplete).length} / 不完全な粒 ${grains.filter(g=>g.incomplete).length}。`);persist();}
 }catch(e){say('エラー: '+e.message);}});
 button.addEventListener('click',async()=>{if(opening||initializing)return;source=getSource();if(!source.file||!source.header||!source.fingerprint||!source.preview){alert('先にBMPの読込完了を待ってください。');return;}doc=null;mask=null;el('editorStage').hidden=true;editView.resetPan();previewView.resetPan();ctx.clearRect(0,0,canvas.width,canvas.height);prepareSelection();dialog.showModal();previewView.fit();initializing=true;button.disabled=true;for(const k of ['fraction','x','y','regions','import'])el(k).disabled=true;dialog.querySelector('[data-action="crop"]').disabled=true;say('保存データを確認しています…');try{await saveChain;const d=await loadAutosave(key());catalog={};if(d){if(d.schema==='ground-truth-catalog-v1'){catalog=d.regions;const last=catalog[d.last];validate(last);await open(last.crop,last);selectSavedSize(last.crop);}else{validate(d);await open(d.crop,d);selectSavedSize(d.crop);}}else{say('プレビューで位置とサイズを選び「選択範囲を開く」を押してください。');}}catch(e){say(e.message);}finally{initializing=false;button.disabled=false;for(const k of ['fraction','x','y','regions','import'])el(k).disabled=false;setSelection(selection);regionMenu();}});
}
