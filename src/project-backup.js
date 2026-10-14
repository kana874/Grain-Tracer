// Project export deliberately does not call JSON.stringify(project): large
// historical tuning traces can exceed the JS engine's maximum string size.
// Incremental serialization retains all project fields, including old logs.
const CHUNK_SIZE=128*1024;
export function *projectJsonChunks(value,chunkSize=CHUNK_SIZE){
  let buffer='',active=new Set();
  function* append(part){
    if(typeof part!=='string')part=String(part);
    if(!part.length)return;
    for(let i=0;i<part.length;i+=chunkSize){
      buffer+=part.slice(i,i+chunkSize);
      if(buffer.length>=chunkSize){yield buffer;buffer='';}
    }
  }
  function* writeString(value){
    yield* append('"');
    // Never stringify a giant string in one operation.
    for(let i=0;i<value.length;i+=chunkSize/2){
      const piece=JSON.stringify(value.slice(i,i+chunkSize/2));
      yield* append(piece.slice(1,-1));
    }
    yield* append('"');
  }
  function* write(value,inArray=false){
    if(value===null){yield* append('null');return;}
    if(typeof value==='string'){yield* writeString(value);return;}
    if(typeof value==='number'){yield* append(Number.isFinite(value)?String(value):'null');return;}
    if(typeof value==='boolean'){yield* append(value?'true':'false');return;}
    if(typeof value==='bigint')throw new TypeError('BigInt is not JSON serializable');
    if(typeof value==='undefined'||typeof value==='function'||typeof value==='symbol'){
      if(inArray)yield* append('null');
      return;
    }
    if(typeof value!=='object')throw new TypeError('Cannot serialize project');
    if(active.has(value))throw new TypeError('プロジェクトに循環参照があります');
    if(typeof value.toJSON==='function') {
      const encoded=value.toJSON();
      if(encoded!==value){yield* write(encoded,inArray);return;}
    }
    active.add(value);
    try{
      if(Array.isArray(value)){
        yield* append('[');
        for(let i=0;i<value.length;i++){
          if(i)yield* append(',');
          yield* write(value[i],true);
        }
        yield* append(']');
      }else if(ArrayBuffer.isView(value)&&!(value instanceof DataView)){
        // Retain JSON.stringify's numeric-keyed object representation for
        // compatibility with older projects and classifier snapshots.
        yield* append('{');
        for(let i=0;i<value.length;i++){
          if(i)yield* append(',');
          yield* writeString(String(i));yield* append(':');yield* write(value[i],false);
        }
        yield* append('}');
      }else{
        yield* append('{');
        let first=true;
        for(const key of Object.keys(value)){
          const entry=value[key];
          if(entry===undefined||typeof entry==='symbol'||typeof entry==='function')continue;
          if(!first)yield* append(',');
          first=false;
          yield* writeString(key);
          yield* append(':');
          yield* write(entry,false);
        }
        yield* append('}');
      }
    }finally{active.delete(value);}
  }
  yield* write(value);
  if(buffer)yield buffer;
}
export async function createProjectExport(project,baseName,options={}){
  const fragments=[];
  let total=0,steps=0;
  const maxBytes=options.maxBytes??1024*1024*1024;
  for(const part of projectJsonChunks(project)){
    total+=part.length*3; // upper bound on UTF-8 bytes for JS code units
    if(total>maxBytes)throw new RangeError('バックアップが1GBを超えています。履歴サイズを調査してください。既存データは維持します。');
    fragments.push(part);
    if((++steps)%64===0)await new Promise(resolve=>setTimeout(resolve,0));
  }
  let blob=new Blob(fragments,{type:'application/json'});
  let filename=baseName+'.graintracer.json';
  if(blob.size>(options.compressAboveBytes??8*1024*1024)&&typeof CompressionStream!=='undefined'){
    const compressed=await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
    // The gzip file may always be loaded again using importProjectFile.
    blob=compressed;filename+='.gz';
  }
  return {blob,filename,bytes:blob.size,compressed:filename.endsWith('.gz')};
}
export async function parseProjectFile(file) {
  if(!file)throw new Error('プロジェクトファイルがありません');
  let data=file;
  if(file.name.toLowerCase().endsWith('.gz')){
    if(typeof DecompressionStream==='undefined')throw new Error('このブラウザではgzipを展開できません');
    data=await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
  }
  return JSON.parse(await data.text());
}
export function downloadProjectBlob(blob,fileName){
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=fileName;
  document.body.appendChild(a);a.click();a.remove();
  // Slow disk/download managers can take longer to start than 1 second.
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
export function backupName(base,kind='backup'){
  const time=new Date().toISOString().replace(/[:.]/g,'-');
  return base.replace(/\.bmp$/i,'')+'_'+kind+'_'+time;
}
