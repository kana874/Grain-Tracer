import { buildBoundaryMask } from './analysis.js?v=0.9.0-alpha';
self.onmessage=async ({data})=>{
  const {id,features,options}=data;
  try {
    const mask=await buildBoundaryMask(features,{...options,onProgress:()=>{}});
    self.postMessage({id,mask},[mask.buffer]);
  } catch(error) { self.postMessage({id,error:String(error?.message??error)}); }
};