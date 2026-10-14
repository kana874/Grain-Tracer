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
// For large projects, use a streamed, compressed record archive rather than
// a single JSON document. This can be imported without ever creating a huge
// decompressed string in memory.
const ARCHIVE_VERSION='graintracer-record-archive-v1';
function *archiveRecords(root) {
  yield {archive:ARCHIVE_VERSION};
  const active=new Set();
  function* visit(value,path,depth=0) {
    if(depth>120)throw new Error('プロジェクトの入れ子が深すぎます');
    if(typeof value==='undefined'||typeof value==='symbol'||typeof value==='function') {
      yield {p:path,t:'v',v:null};return;
    }
    if(value===null||typeof value==='number'||typeof value==='boolean'){
      yield {p:path,t:'v',v:value};return;
    }
    if(typeof value==='bigint')throw new Error('BigIntは保存できません');
    if(typeof value==='string'){
      if(value.length<=500000){yield {p:path,t:'v',v:value};return;}
      yield {p:path,t:'s'};
      for(let i=0;i<value.length;i+=240000)yield {p:path,t:'sp',v:value.slice(i,i+240000)};
      return;
    }
    if(typeof value.toJSON==='function'){
      const output=value.toJSON();
      if(output!==value){yield* visit(output,path,depth+1);return;}
    }
    if(active.has(value))throw new Error('プロジェクトに循環参照があります');
    active.add(value);
    try{
      if(Array.isArray(value)){
        yield {p:path,t:'a',len:value.length};
        for(let i=0;i<value.length;i++)
          yield* visit(value[i],path.concat(i),depth+1);
      }else if(ArrayBuffer.isView(value)&&!(value instanceof DataView)){
        yield {p:path,t:'o'};
        for(let i=0;i<value.length;i+=2048){
          yield {p:path,t:'typed',i,v:Array.from(value.subarray(i,i+2048))};
        }
      }else{
        yield {p:path,t:'o'};
        for(const key of Object.keys(value)){
          if(value[key]===undefined||typeof value[key]==='function'||typeof value[key]==='symbol')continue;
          yield* visit(value[key],path.concat(key),depth+1);
        }
      }
    }finally{active.delete(value);}
  }
  yield* visit(root,[]);
}
export async function createProjectArchive(project){
  if(typeof CompressionStream==='undefined')throw new Error('gzip compression unavailable');
  const iterator=archiveRecords(project);
  const encoder=new TextEncoder();
  let buffer='';
  const stream=new ReadableStream({
    pull(controller){
      while(buffer.length<96*1024){
        const part=iterator.next();
        if(part.done)break;
        buffer+=JSON.stringify(part.value)+'\\n';
      }
      if(!buffer.length){controller.close();return;}
      controller.enqueue(encoder.encode(buffer));
      buffer='';
    }
  });
  return new Response(stream.pipeThrough(new CompressionStream('gzip'))).blob();
}
async function parseProjectArchive(file){
  if(typeof DecompressionStream==='undefined')throw new Error('gzip解凍にはEdge/Chromeが必要です');
  const stream=file.stream().pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(new TextDecoderStream());
  const reader=stream.getReader();
  let buffer='',project=null,validHeader=false;
  function record(line){
    if(!line)return;
    const row=JSON.parse(line);
    if(!validHeader){
      if(row.archive!==ARCHIVE_VERSION)throw new Error('対応していないバックアップ形式です');
      validHeader=true;return;
    }
    if(!Array.isArray(row.p))throw new Error('バックアップのデータパスが不正です');
    if(!row.p.length){
      if(row.t==='o')project={};
      else if(row.t==='a')project=[];
      else throw new Error('不正なプロジェクトのルートです');
      return;
    }
    let parent=project;
    for(let i=0;i<row.p.length-1;i++){
      parent=parent[row.p[i]];
      if(!parent)throw new Error('バックアップのデータ順序が不正です');
    }
    const key=row.p.at(-1);
    if(row.t==='v')parent[key]=row.v;
    else if(row.t==='o')parent[key]={};
    else if(row.t==='a')parent[key]=new Array(row.len);
    else if(row.t==='s')parent[key]='';
    else if(row.t==='sp')parent[key]+=row.v;
    else if(row.t==='typed'){
      const holder=row.p.reduce((value,part)=>value[part],project);
      for(let i=0;i<row.v.length;i++)holder[row.i+i]=row.v[i];
    }else throw new Error('未対応のバックアップ要素です');
  }
  while(true){
    const {value,done}=await reader.read();
    if(done)break;
    buffer+=value;
    if(buffer.length>3*1024*1024)throw new Error('不正な巨大レコードが含まれています');
    let index;
    while((index=buffer.indexOf('\\n'))>=0){
      record(buffer.slice(0,index));
      buffer=buffer.slice(index+1);
    }
  }
  if(buffer.trim())record(buffer);
  if(!validHeader||!project)throw new Error('バックアップが不完全です');
  return project;
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
    blob=await createProjectArchive(project);
    filename=baseName+'.graintracer.archive.gz';
  }
  return {blob,filename,bytes:blob.size,compressed:filename.endsWith('.gz')};
}
export async function parseProjectFile(file) {
  if(!file)throw new Error('プロジェクトファイルがありません');
  if(file.name.toLowerCase().endsWith('.archive.gz'))return parseProjectArchive(file);
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
