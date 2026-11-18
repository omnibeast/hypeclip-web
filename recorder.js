import {mkdtempSync,writeFileSync,readFileSync,existsSync,readdirSync,statSync,unlinkSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import {getServerSegments,serverCaptureStatus,stopServerCapture} from './server-hls.js';
const ROOT=mkdtempSync(path.join(os.tmpdir(),'hypeclip-'));
const SEG=path.join(ROOT,'segments'),CLIPS=path.join(ROOT,'clips');
import {mkdirSync} from 'node:fs';mkdirSync(SEG);mkdirSync(CLIPS);
const MAX_SEGMENTS=42,MAX_CLIPS=8,MAX_SEGMENT_BYTES=10*1024*1024;
let segments=[],clips=[],recording=false,lastUpload=0,busy=false,jobSeq=0,epoch=0;
const sanitize=x=>String(x).replace(/[^a-zA-Z0-9_.-]/g,'');
let browserStartedAt=null;
const iso=ts=>new Date(ts).toISOString();
const hms=sec=>{const s=Math.max(0,Math.round(sec));return String(Math.floor(s/3600)).padStart(2,'0')+':'+String(Math.floor(s%3600/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')};

export function snapshot(){
 const server=serverCaptureStatus();
 return {recording:(recording&&Date.now()-lastUpload<12000)||(server.active&&server.segmentCount>0),
 serverCapture:server,clipCount:clips.length,
 clips:clips.map(({id,createdAt,size,metadata})=>({id,createdAt,size,metadata,url:'/api/clips/'+id+'.mp4',logUrl:'/api/clips/'+id+'.csv',jsonUrl:'/api/clips/'+id+'.json'})),
 recordingNote:'Temporary clips are lost when the server restarts.'}
}
export function stopRecording(){recording=false;browserStartedAt=null;epoch++;for(const s of segments){try{unlinkSync(s.file)}catch{}}segments=[]}
export async function ingest(req){
 let chunks=[],size=0;for await(const b of req){size+=b.length;if(size>MAX_SEGMENT_BYTES)throw Error('Recording segment exceeds 10 MB');chunks.push(b)}
 if(size<200)throw Error('Recording segment is empty');
 let buf=Buffer.concat(chunks),name=cryptoName();
 const file=path.join(SEG,name+'.webm');writeFileSync(file,buf);
 if(!recording){stopRecording();recording=true;browserStartedAt=Date.now()}
 lastUpload=Date.now();segments.push({at:lastUpload,file});
 while(segments.length>MAX_SEGMENTS){const old=segments.shift();try{unlinkSync(old.file)}catch{}}
 return {ok:true,segments:segments.length};
}
function cryptoName(){return String(Date.now())+'-'+Math.random().toString(36).slice(2,12)}
function convert(files,out,quality='1080'){
 return new Promise((resolve,reject)=>{
 const list=path.join(ROOT,cryptoName()+'.txt');
 writeFileSync(list,files.map(f=>"file '"+f.replace(/'/g,"'\\''")+"'").join('\n'));
 const presets={'480':{height:480,crf:24,bitrate:'2200k'},'720':{height:720,crf:23,bitrate:'4500k'},'1080':{height:1080,crf:21,bitrate:'8500k'}};
 const preset=presets[String(quality)]||presets['1080'];
 // Preserve source aspect ratio and never upscale low-resolution input.
 const scale='scale=-2:trunc(min(ih\\,'+preset.height+')/2)*2';
 const args=['-hide_banner','-loglevel','error','-nostdin','-y','-f','concat','-safe','0','-i',list,'-vf',scale,'-c:v','libx264','-preset','veryfast','-crf',String(preset.crf),'-maxrate',preset.bitrate,'-bufsize',preset.bitrate,'-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-movflags','+faststart','-t','70',out];
 const proc=spawn(ffmpeg,args,{stdio:['ignore','ignore','pipe']});let err='';
 proc.stderr.on('data',x=>{err+=x.toString().slice(0,2000)});
 proc.on('error',e=>{try{unlinkSync(list)}catch{}reject(e)});
 proc.on('close',code=>{try{unlinkSync(list)}catch{}code===0&&existsSync(out)&&statSync(out).size>500?resolve():reject(Error('MP4 encoding failed: '+err.slice(-600)))});
 });
}
export async function makeClip({at=Date.now(),before=25,after=20,quality='1080',onUpdate=()=>{}}={}){
 const myEpoch=epoch,id=cryptoName();
 if(busy)return {ok:false,error:'Another clip is already encoding'};
 const server=serverCaptureStatus();
 const usingServer=server.active&&server.segmentCount>0;
 if(!usingServer&&(!recording||Date.now()-lastUpload>12000))return {ok:false,error:'No active video source. Start authorized server HLS capture, or browser tab capture.'};
 busy=true;onUpdate({status:'encoding',id});
 try {
   if(after>0)await new Promise(r=>setTimeout(r,after*1000));
   if(!usingServer&&myEpoch!==epoch)throw Error('Recording session changed');
   const available=usingServer?getServerSegments():segments;
   const selection=available.filter(s=>s.at>=at-before*1000-6500&&s.at<=at+after*1000+3000);
   if(selection.length<2)throw Error('Not enough recorded video for a clip. Allow the server to buffer more footage.');
   const out=path.join(CLIPS,id+'.mp4');await convert(selection.map(s=>s.file),out,quality);
   const recordingStart=usingServer?server.startedAt:browserStartedAt;
   const first=selection[0].at,last=selection[selection.length-1].at;
   const metadata={
    clipId:id,source:usingServer?'server-hls-clean-video':'browser-tab',
    eventUTC:iso(at),clipWindowStartUTC:iso(first),clipWindowEndUTC:iso(last),
    streamElapsedAtEvent:recordingStart?hms((at-recordingStart)/1000):'unknown',
    eventOffsetSeconds:recordingStart?Math.max(0,Math.round((at-recordingStart)/1000)):null,
    requestedBeforeSeconds:before,requestedAfterSeconds:after,outputQuality:quality+'p',
    videoOnlyNoWebpageOverlay:usingServer
   };
   const csvFields=['clipId','source','eventUTC','clipWindowStartUTC','clipWindowEndUTC','streamElapsedAtEvent','eventOffsetSeconds','requestedBeforeSeconds','requestedAfterSeconds','outputQuality','videoOnlyNoWebpageOverlay'];
   const csv=['field,value',...csvFields.map(key=>key+',"'+String(metadata[key]??'').replace(/"/g,'""')+'"')].join('\n')+'\n';
   const logPath=path.join(CLIPS,id+'.csv'),jsonPath=path.join(CLIPS,id+'.json');
   writeFileSync(logPath,csv);writeFileSync(jsonPath,JSON.stringify(metadata,null,2)+'\n');
   clips.unshift({id,createdAt:Date.now(),size:statSync(out).size,path:out,logPath,jsonPath,metadata});
   while(clips.length>MAX_CLIPS){let old=clips.pop();for(const file of [old.path,old.logPath,old.jsonPath]){try{unlinkSync(file)}catch{}}}
   onUpdate({status:'ready',id,url:'/api/clips/'+id+'.mp4'});
   return {ok:true,id,url:'/api/clips/'+id+'.mp4'};
 }catch(e){onUpdate({status:'failed',id,error:e.message});return {ok:false,error:e.message}}
 finally{busy=false}
}
export function getClip(id){return clips.find(c=>c.id===sanitize(id))}
export function getClipLog(id,format='csv'){const clip=getClip(id);return clip&&format==='json'?clip.jsonPath:clip?.logPath}

export function cleanup(){stopServerCapture();stopRecording();try{rmSync(ROOT,{recursive:true,force:true})}catch{}}
