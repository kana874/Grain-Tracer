import { buildBoundaryMask } from './analysis.js';
import { positionLocalRoi } from './local-ab.js';
export const LOCAL_AB_HALO = 64;
function cropPlane(plane, fullWidth, rect) {
  const output=new plane.constructor(rect.width*rect.height);
  for(let y=0;y<rect.height;y++)
    output.set(plane.subarray((rect.y+y)*fullWidth+rect.x,
      (rect.y+y)*fullWidth+rect.x+rect.width),y*rect.width);
  return output;
}
export function makeLocalFeaturePacket(features, roi, options={}, halo=LOCAL_AB_HALO) {
  const {width,height}=features;
  if(roi.x<0||roi.y<0||roi.x+roi.width>width||roi.y+roi.height>height)
    throw new RangeError('ROI is outside source preview');
  const x=Math.max(0,roi.x-halo),y=Math.max(0,roi.y-halo);
  const right=Math.min(width,roi.x+roi.width+halo);
  const bottom=Math.min(height,roi.y+roi.height+halo);
  const rect={x,y,width:right-x,height:bottom-y};
  const n=width*height;
  const cropped={...features,width:rect.width,height:rect.height};
  for(const [key,value] of Object.entries(features)){
    if(ArrayBuffer.isView(value) && value.length===n) cropped[key]=cropPlane(value,width,rect);
  }
  const copied={...options};
  for(const key of ['negativeMask','exclusionMask']){
    const mask=options[key];
    if(mask?.length===n)copied[key]=cropPlane(mask,width,rect);
  }
  // Local calibration interpolation is in full-frame coordinates; falling
  // back to full-frame processing avoids silently shifting its grid.
  const needsGlobal=Boolean(options.localCalibration?.values?.length);
  return {features:cropped,options:copied,rect,roi:{...roi},
    globalWidth:width,globalHeight:height,needsGlobal};
}
export function cropLocalPrediction(prediction,packet) {
  const {rect,roi}=packet;
  if(prediction.length!==rect.width*rect.height)throw new Error('ROI packet size mismatch');
  const output=new Uint8Array(roi.width*roi.height);
  const offsetX=roi.x-rect.x,offsetY=roi.y-rect.y;
  for(let y=0;y<roi.height;y++)
    output.set(prediction.subarray((offsetY+y)*rect.width+offsetX,
      (offsetY+y)*rect.width+offsetX+roi.width),y*roi.width);
  return output;
}
export function materializeLocalPrediction(localMask,roi,width,height){
  if(localMask?.length!==roi.width*roi.height)throw new Error('Invalid local prediction length');
  const output=new Uint8Array(width*height);
  for(let y=0;y<roi.height;y++)
    output.set(localMask.subarray(y*roi.width,(y+1)*roi.width),(roi.y+y)*width+roi.x);
  return output;
}
export function comparisonCacheKey(fingerprint,roi,settings,featureKey,maskRevision=0){
  const values=['sensitivity','darkWeight','ridgeWeight','colorWeight',
    'dendriteWeight','negativeEvidenceWeight','minComponent','centerlineNms',
    'scoreMode','edgeFrameGuard'].map(key=>settings[key]??null);
  return JSON.stringify([fingerprint,roi.x,roi.y,roi.width,roi.height,
    values,featureKey,maskRevision,settings.hysteresis??null,
    settings.localCalibration?.values??null]);
}
export class LruPredictionCache {
  constructor(limit=10){this.limit=limit;this.items=new Map();this.hits=0;this.misses=0;}
  get(key){const value=this.items.get(key);if(!value){this.misses++;return null;}
    this.items.delete(key);this.items.set(key,value);this.hits++;return value;}
  set(key,value){this.items.delete(key);this.items.set(key,value);
    while(this.items.size>this.limit)this.items.delete(this.items.keys().next().value);}
  clear(){this.items.clear();}
}
export async function buildLocalPrediction(features,roi,settings,options={}){
  const packet=makeLocalFeaturePacket(features,roi,settings,options.halo??LOCAL_AB_HALO);
  if(packet.needsGlobal){
    const full=await buildBoundaryMask(features,settings);
    const out=new Uint8Array(roi.width*roi.height);
    for(let y=0;y<roi.height;y++)
      out.set(full.subarray((roi.y+y)*features.width+roi.x,
        (roi.y+y)*features.width+roi.x+roi.width),y*roi.width);
    return {mask:out,mode:'global-calibration-fallback'};
  }
  const result=await buildBoundaryMask(packet.features,packet.options);
  return {mask:cropLocalPrediction(result,packet),mode:'roi-halo-64'};
}
// Worker is optional. A shared worker is created lazily, and only the small
// halo feature packet crosses the thread boundary (never full preview planes).
export class LocalPredictionRunner {
  constructor(){this.worker=null;this.pending=new Map();this.seq=0;this.enabled=typeof Worker!=='undefined';}
  async compute(features,roi,settings){
    const packet=makeLocalFeaturePacket(features,roi,settings);
    if(packet.needsGlobal || !this.enabled)return buildLocalPrediction(features,roi,settings);
    try{
      if(!this.worker){
        this.worker=new Worker(new URL('./local-ab-worker.js',import.meta.url),{type:'module'});
        this.worker.onmessage=event=>{
          const {id,error,mask}=event.data;
          const job=this.pending.get(id);if(!job)return;
          this.pending.delete(id);
          if(error)job.reject(new Error(error));
          else job.resolve(mask);
        };
        this.worker.onerror=event=>{
          for(const job of this.pending.values())job.reject(new Error(event.message||'Worker error'));
          this.pending.clear();this.worker?.terminate();this.worker=null;this.enabled=false;
        };
      }
      const id=++this.seq;
      const mask=await new Promise((resolve,reject)=>{
        this.pending.set(id,{resolve,reject});
        this.worker.postMessage({id,features:packet.features,options:packet.options});
      });
      return {mask:cropLocalPrediction(mask,packet),mode:'roi-worker'};
    }catch(error){
      this.enabled=false;this.terminate();
      return buildLocalPrediction(features,roi,settings);
    }
  }
  terminate(){this.worker?.terminate();this.worker=null;
    for(const job of this.pending.values())job.reject(new Error('A/B worker terminated'));
    this.pending.clear();}
}
