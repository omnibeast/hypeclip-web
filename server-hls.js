import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import {spawn} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';

// Only explicitly allowed hosts may be fetched by FFmpeg. Never accept arbitrary URLs.
let child=null, timer=null, directory=null, startedAt=null, lastError='',sourceHost='',fileSeq=0,closing=false;
let files=[];
const SEGMENT_LIMIT=48, BYTES_LIMIT=320*1024*1024;
function privateIp(ip) {
 if(net.isIP(ip)===4){const p=ip.split('.').map(Number);return p[0]===10||p[0]===127||p[0]===0||p[0]===169&&p[1]===254||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===192&&p[1]===168||p[0]>=224}
 if(net.isIP(ip)===6)return ip==='::1'||ip==='::'||ip.startsWith('fc')||ip.startsWith('fd')||ip.startsWith('fe80')||ip.includes('::ffff:');
 return true;
}
async function validate(urlString){
 let u;
 try{u=new URL(urlString)}catch{throw Error('Enter a valid HLS URL.')}
 if(u.protocol!=='https:')throw Error('The source must be an HTTPS HLS URL.');
 if(u.username||u.password||u.port&&u.port!=='443')throw Error('Use HTTPS without embedded credentials or custom ports.');
 if(!/\.m3u8(?:$|\?)/i.test(u.pathname+u.search))throw Error('This server-capture mode requires a direct .m3u8 HLS playlist, not a YouTube watch URL.');
 const allowed=(process.env.HYPECLIP_ALLOWED_HLS_HOSTS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
 if(!allowed.length)throw Error('Server capture needs HYPECLIP_ALLOWED_HLS_HOSTS configured in Render (your streaming CDN hostname).');
 if(!allowed.includes(u.hostname.toLowerCase()))throw Error('Stream hostname is not in the server-side allowlist.');
 const records=await dns.lookup(u.hostname,{all:true});
 if(!records.length||records.some(x=>privateIp(x.address)))throw Error('The HLS server resolves to a restricted network address.');
 return u;
}
async function bestHlsUrl(url){
 // Choose the highest advertised variant from a standard HLS master playlist.
 // Media playlists (already a variant) are used unchanged.
 let body;
 try{
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(8000),headers:{accept:'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain'}});
  if(!response.ok)throw Error('HLS playlist returned '+response.status);
  const contentLength=Number(response.headers.get('content-length')||0);
  if(contentLength>1024*1024)throw Error('HLS playlist is too large');
  body=await response.text();
  if(body.length>1024*1024||!body.trimStart().startsWith('#EXTM3U'))throw Error('Invalid HLS playlist');
 }catch(e){throw Error('Could not read the authorized HLS playlist: '+e.message)}
 const lines=body.split(/\r?\n/).map(s=>s.trim()),variants=[];
 for(let i=0;i<lines.length-1;i++){
  if(!lines[i].startsWith('#EXT-X-STREAM-INF:'))continue;
  let j=i+1;while(j<lines.length&&(!lines[j]||lines[j].startsWith('#')))j++;
  if(j>=lines.length)continue;
  const data=lines[i],resolution=/RESOLUTION=(\d+)x(\d+)/i.exec(data),bandwidth=/BANDWIDTH=(\d+)/i.exec(data);
  const candidate=new URL(lines[j],url);
  try{await validate(candidate.href)}catch{continue}
  variants.push({url:candidate,score:(resolution?Number(resolution[1])*Number(resolution[2]):0)*100000000+(bandwidth?Number(bandwidth[1]):0)});
 }
 if(!variants.length)return url;
 variants.sort((a,b)=>b.score-a.score);
 return variants[0].url;
}

function scan(){
 if(!directory)return;
 try{
  const names=fs.readdirSync(directory).filter(n=>/^segment-\d{8}\.ts$/.test(n)).sort();
  files=names.map(n=>{const f=path.join(directory,n),st=fs.statSync(f);return {at:st.mtimeMs,file:f,bytes:st.size,source:'server-hls'}}).filter(x=>x.bytes>1000);
  let total=files.reduce((a,f)=>a+f.bytes,0);
  while(files.length>SEGMENT_LIMIT||total>BYTES_LIMIT){const old=files.shift();total-=old.bytes;try{fs.unlinkSync(old.file)}catch{}}
 }catch(e){lastError='Recording segment scan failed: '+e.message}
}
export function getServerSegments(){scan();return [...files]}
export function serverCaptureStatus(){scan();return {active:!!child,startedAt,segmentCount:files.length,sourceHost,lastError,mode:'server-hls'}}
export function stopServerCapture(){
 closing=true;if(timer)clearInterval(timer);timer=null;
 if(child){try{child.kill('SIGTERM')}catch{}child=null}
 if(directory){try{fs.rmSync(directory,{recursive:true,force:true})}catch{}directory=null}
 startedAt=null;sourceHost='';files=[];lastError='';
}
export async function startServerCapture(url){
 const authorized=await validate(url);
 const u=await bestHlsUrl(authorized);
 stopServerCapture();closing=false;
 directory=fs.mkdtempSync(path.join(os.tmpdir(),'hypeclip-hls-'));
 sourceHost=u.hostname;startedAt=Date.now();
 const output=path.join(directory,'segment-%08d.ts');
 // Source is a direct HLS playlist provided by its authorized publisher.
 // Copy native video/audio streams: no chat overlay or browser pixels.
 const args=['-hide_banner','-loglevel','warning','-nostdin','-rw_timeout','20000000','-i',u.toString(),
 '-map','0:v:0','-map','0:a:0?','-c','copy','-f','segment','-segment_time','3','-segment_format','mpegts',
 '-reset_timestamps','1',output];
 child=spawn(ffmpeg,args,{stdio:['ignore','ignore','pipe']});
 const spawned=child;
 let errors='';
 spawned.stderr.on('data',data=>{const msg=String(data).trim();errors=(errors+msg+'\n').slice(-1200);lastError=errors.replace(/https?:\/\/[^\s]+/g,'[stream URL]')});
 spawned.on('error',e=>{lastError='Recorder failed to start: '+e.message;if(child===spawned)child=null});
 spawned.on('close',(code)=>{if(child===spawned){child=null;if(!closing)lastError='The direct HLS recording process exited ('+code+'). '+lastError}});
 timer=setInterval(scan,2500);
 return {ok:true,...serverCaptureStatus()};
}
