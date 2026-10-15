import { trainLogisticBoundaryClassifier } from "./boundary-classifier.js";

self.onmessage=({data})=>{
  try {
    const p=data.packet;
    const model=trainLogisticBoundaryClassifier(p.features,p.positiveMask,p.negativeMask,p.options);
    self.postMessage({model});
  } catch(error) {
    self.postMessage({error:String(error?.message??error)});
  }
};
