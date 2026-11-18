import {mkdtempSync,writeFileSync,readFileSync,existsSync,readdirSync,statSync,unlinkSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
const ROOT=mkdtempSync(path.join(os.tmpdir(),'hypeclip-'));
const SEG=path.join(ROOT,'segments'),CLIPS=path.join(ROOT,'clips');
import {mkdirSync} from 'node:fs';mkdirSync(SEG);mkdirSync(CLIPS);
const MAX_SEGMENTS=42,MAX_CLIPS=8,MAX_SEGMENT_BYTES=10*1024*1024;
let segments=[],clips=[],recording=false,lastUpload=0,busy=false,jobSeq=0,epoch=0;
const sanitize=x=>String(x).replace(/[^a-zA-Z0-9_.-]/g,'');
export function snapshot(){return {recording:recording&&Date.now()-lastUpload<12000,clipCount:clips.length,clips:clips.map(({id,createdAt,size})=>({id,createdAt,size,url:'/api/clips/'+id+'.mp4'})),recordingNote:'Temporary clips are lost when the server restarts.'}}
export function stopRecording(){recording=false;epoch++;for(const s of segments){try{unlinkSync(s.file)}catch{}}segments=[]}
export async function ingest(req){
 let chunks=[],size=0;for await(const b of req){size+=b.length;if(size>MAX_SEGMENT_BYTES)throw Error('Recording segment exceeds 10 MB');chunks.push(b)}
 if(size<200)throw Error('Recording segment is empty');
 let buf=Buffer.concat(chunks),name=cryptoName();
 const file=path.join(SEG,name+'.webm');writeFileSync(file,buf);
 if(!recording){stopRecording();recording=true}
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
 if(!recording||Date.now()-lastUpload>12000)return {ok:false,error:'Video capture inactive. Start Capture Tab and share the livestream tab.'};
 busy=true;onUpdate({status:'encoding',id});
 try {
   if(after>0)await new Promise(r=>setTimeout(r,after*1000));
   if(myEpoch!==epoch)throw Error('Recording session changed');
   const selection=segments.filter(s=>s.at>=at-before*1000-6500&&s.at<=at+after*1000+3000);
   if(selection.length<2)throw Error('Not enough recorded video for a clip');
   const out=path.join(CLIPS,id+'.mp4');await convert(selection.map(s=>s.file),out,quality);
   clips.unshift({id,createdAt:Date.now(),size:statSync(out).size,path:out});
   while(clips.length>MAX_CLIPS){let old=clips.pop();try{unlinkSync(old.path)}catch{}}
   onUpdate({status:'ready',id,url:'/api/clips/'+id+'.mp4'});
   return {ok:true,id,url:'/api/clips/'+id+'.mp4'};
 }catch(e){onUpdate({status:'failed',id,error:e.message});return {ok:false,error:e.message}}
 finally{busy=false}
}
export function getClip(id){return clips.find(c=>c.id===sanitize(id))}
export function cleanup(){stopRecording();try{rmSync(ROOT,{recursive:true,force:true})}catch{}}
