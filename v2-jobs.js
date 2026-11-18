import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import youtubedl from 'youtube-dl-exec';
import {bestHlsUrl} from './server-hls.js';

const jobs=new Map(), ACTIVE_LIMIT=1, MAX_DURATION=10*60*1000, MAX_SEGMENTS=150, MAX_CLIPS=5;
const guid=()=>crypto.randomUUID(),safeId=s=>/^[a-f0-9-]{36}$/.test(s||'');
function error(message,status=400){return {error:message,status}}
const allowedHosts=()=>new Set((process.env.HYPECLIP_ALLOWED_HLS_HOSTS||'').split(',').map(h=>h.trim().toLowerCase()).filter(Boolean));
function provider(url){
 let u;try{u=new URL(url)}catch{return {provider:'unknown',status:'invalid',reason:'Enter a full HTTPS livestream URL.'}}
 if(u.protocol!=='https:'||u.username||u.password)return {provider:'unknown',status:'invalid',reason:'Use a standard HTTPS URL without credentials.'};
 const host=u.hostname.toLowerCase();
 if(host==='youtube.com'||host==='www.youtube.com'||host==='m.youtube.com'||host==='youtu.be'){
 const approved=process.env.HYPECLIP_YOUTUBE_CAPTURE_APPROVED==='true';
 return {provider:'YouTube',status:approved?'ready':'platform-approval-required',reason:approved?'Provider-approved YouTube recording enabled for this server. Source must be publicly accessible and you must have the right to record.':'YouTube does not authorize general download/recording from public URLs. This server requires prior YouTube approval before enabling automatic capture.'};
}
 if(host==='twitch.tv'||host==='www.twitch.tv')return {provider:'Twitch',status:'ready',reason:'Experimental public-stream extractor available. Only record content you have rights and platform permission to use; access/DRM failures may occur.'};
 if(host==='kick.com'||host==='www.kick.com')return {provider:'Kick',status:'ready',reason:'Experimental public-stream extractor available. Only record content you have rights and platform permission to use; access/DRM failures may occur.'};
 if(host==='facebook.com'||host==='www.facebook.com'||host==='fb.watch')return {provider:'Facebook Live',status:'integration-required',reason:'Automatic capture requires an authorized provider integration and may require login.'};
 if(host==='instagram.com'||host==='www.instagram.com')return {provider:'Instagram Live',status:'integration-required',reason:'This provider needs an approved recording integration.'};
 if(host==='tiktok.com'||host==='www.tiktok.com')return {provider:'TikTok LIVE',status:'integration-required',reason:'This provider needs an approved recording integration.'};
 if(u.pathname.toLowerCase().endsWith('.m3u8')){
  const allow=allowedHosts().has(host);
  return {provider:'Direct HLS',status:allow?'ready':'needs-admin-setup',reason:allow?'Approved HLS video source. Recording can run on the server.':'This direct HLS hostname is not approved in the server configuration.'};
 }
 return {provider:host,status:'unsupported',reason:'No compatible public recording integration is currently available for this URL.'};
}
export function inspect(url){return provider(String(url||'').slice(0,2048))}
function privateIP(ip){if(ip.includes(':'))return !/^(2|3)[0-9a-f]{3}:/i.test(ip);const a=ip.split('.').map(Number);return a[0]===0||a[0]===10||a[0]===127||a[0]===169&&a[1]===254||a[0]===172&&a[1]>=16&&a[1]<=31||a[0]===192&&a[1]===168||a[0]>=224}
async function validateURL(raw){
 const u=new URL(raw),p=provider(raw);
 if(p.status!=='ready')throw error(p.reason,422);
 if(u.port&&u.port!=='443'||u.username||u.password)throw error('Custom ports and embedded credentials are not supported.');
 const addresses=await dns.lookup(u.hostname,{all:true});if(!addresses.length||addresses.some(a=>privateIP(a.address)))throw error('Restricted source address.');
 return u.toString();
}
function cleanup(job){if(job.extractor){try{job.extractor.kill('SIGTERM')}catch{}job.extractor=null}if(job.child){try{job.child.kill('SIGTERM')}catch{}job.child=null}if(job.timer)clearInterval(job.timer);job.timer=null;job.status='stopped';try{fs.rmSync(job.dir,{recursive:true,force:true})}catch{}}
function scan(job){
 if(!fs.existsSync(job.dir))return [];
 const names=fs.readdirSync(job.dir).filter(n=>/^part-\d{6}\.ts$/.test(n)).sort().slice(-MAX_SEGMENTS);
 return names.map(n=>{const file=path.join(job.dir,n),s=fs.statSync(file);return {file,at:s.mtimeMs,size:s.size}}).filter(s=>s.size>200);
}
function view(job){const segs=scan(job);return {id:job.id,provider:job.provider,status:job.status,createdAt:job.createdAt,expiresAt:job.expiresAt,segments:segs.length,elapsedSeconds:Math.round((Date.now()-job.createdAt)/1000),error:job.error,clips:job.clips.map(c=>({id:c.id,state:c.state,error:c.error,createdAt:c.createdAt,bytes:c.bytes||0,metadata:c.metadata||null}))}}
function readJob(id,token){const job=jobs.get(id);if(!job||!token||token!==job.token)throw error('Job not found or access token invalid.',404);return job}
function securityToken(req){const h=req.headers['authorization']||'';return h.startsWith('Bearer ')?h.slice(7):''}
export async function start({url,confirmedRights},req){
 if(!confirmedRights)throw error('Confirm you own or have permission to record this video source.');
 if(typeof url!=='string'||url.length>2048)throw error('Invalid video URL.');
 const active=[...jobs.values()].filter(j=>j.status==='recording');
 if(active.length>=ACTIVE_LIMIT)throw error('The test server is currently recording another stream. Try again after that job finishes.',429);
 const parsed=provider(url);if(parsed.status!=='ready')throw error(parsed.reason,422);
 const isDirectHls=parsed.provider==='Direct HLS';
 const validated=isDirectHls?await validateURL(url):new URL(url).toString();
 const playlist=isDirectHls?await bestHlsUrl(validated):validated;
 const id=guid(),token=crypto.randomBytes(32).toString('hex'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'hypeclip-v2-')),createdAt=Date.now();
 const job={id,token,dir,createdAt,expiresAt:createdAt+MAX_DURATION,status:'starting',provider:parsed.provider,error:'',clips:[],child:null,extractor:null,timer:null};jobs.set(id,job);
 let extractor=null;
 const sourceInput=isDirectHls?playlist.toString():'pipe:0';
 const args=['-hide_banner','-loglevel','error','-nostdin','-rw_timeout','15000000','-i',sourceInput,'-map','0:v:0','-map','0:a:0?','-c','copy','-f','segment','-segment_time','3','-segment_format','mpegts','-reset_timestamps','1',path.join(dir,'part-%06d.ts')];
 const child=spawn(ffmpeg,args,{stdio:[isDirectHls?'ignore':'pipe','ignore','pipe']});job.child=child;job.status='recording';
 child.stderr.on('data',b=>{job.error=String(b).replace(/https?:\/\/[^\s]+/g,'[source]').slice(-350)});
 child.on('error',e=>{job.error='FFmpeg recorder launch failed: '+e.message;job.status='failed';job.child=null});
 child.on('close',c=>{if(job.child===child){job.child=null;job.status='failed';job.error=job.error||'Recorder closed unexpectedly ('+c+').' }});
 if(!isDirectHls){
   // Only the canonical platform URL (never an arbitrary host) reaches the extractor.
   // No cookies, login state, special headers, DRM circumvention or bypass options.
   try{
     extractor=youtubedl.exec(validated,{
       output:'-',format:'best[height<=1080]/best',noPlaylist:true,
       noWarnings:true,noProgress:true,hlsUseMpegts:true
     },{timeout:MAX_DURATION+30000,killSignal:'SIGTERM'});
     job.extractor=extractor;
     extractor.stdout.pipe(child.stdin);
     extractor.stderr.on('data',b=>{job.error=String(b).replace(/https?:\/\/[^\s]+/g,'[source]').slice(-350)});
     extractor.on('error',e=>{job.error='Stream extractor failed: '+e.message;job.status='failed';try{child.kill('SIGTERM')}catch{}});
     extractor.on('close',c=>{
       if(job.extractor===extractor){job.extractor=null;if(job.status==='recording'){job.status='failed';job.error=job.error||'Extractor stopped ('+c+'). The stream may be unavailable, blocked or offline.'}}
     });
   }catch(e){job.status='failed';job.error='Could not launch public stream extractor: '+e.message;try{child.kill('SIGTERM')}catch{}}
 }
 job.timer=setInterval(()=>{if(Date.now()>job.expiresAt)cleanup(job)},5000);
 return {job:view(job),token};
}
function encode(files,out,quality){
 return new Promise((resolve,reject)=>{
 const list=out+'.txt';fs.writeFileSync(list,files.map(f=>"file '"+f.replace(/'/g,"'\\''")+"'").join('\n'));
 const h=quality==='480'?480:quality==='720'?720:1080,crf=quality==='480'?'24':quality==='720'?'23':'21';
 const vf='scale=-2:trunc(min(ih\\,'+h+')/2)*2';
 const proc=spawn(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-f','concat','-safe','0','-i',list,'-vf',vf,'-c:v','libx264','-preset','ultrafast','-crf',crf,'-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart','-t','65',out],{stdio:['ignore','ignore','pipe']});
 let stderr='';proc.stderr.on('data',d=>stderr=(stderr+String(d)).slice(-350));proc.on('error',reject);proc.on('close',code=>{try{fs.unlinkSync(list)}catch{}code===0&&fs.existsSync(out)?resolve():reject(Error('Video encoding failed: '+stderr))});
 });
}
export async function createClip(id,token,settings={}){
 const job=readJob(id,token);if(job.status!=='recording')throw error('Recording is not active.');
 if(job.clips.some(c=>c.state==='encoding'))throw error('Another clip is encoding.',429);
 if(job.clips.length>=MAX_CLIPS)throw error('This demo job has reached its clip limit of '+MAX_CLIPS+'.');
 const before=Number(settings.before??20),after=Number(settings.after??10),quality=String(settings.quality||'1080');
 if(!Number.isInteger(before)||!Number.isInteger(after)||before<5||after<5||before+after>65||!['480','720','1080'].includes(quality))throw error('Select 5+ seconds before/after, maximum 65 seconds total, and a supported quality.');
 const event=Date.now(),clip={id:guid(),state:'encoding',error:'',createdAt:event};job.clips.unshift(clip);
 void (async()=>{try{
 await new Promise(r=>setTimeout(r,after*1000));if(job.status!=='recording')throw Error('Recording ended before the clip was complete.');
 const parts=scan(job).filter(p=>p.at>=event-before*1000-6000&&p.at<=event+after*1000+3000);
 if(parts.length<2)throw Error('Not enough buffered footage. Allow the recording to run longer.');
 const output=path.join(job.dir,clip.id+'.mp4');await encode(parts.map(x=>x.file),output,quality);
 const start=parts[0].at,end=parts[parts.length-1].at;
 clip.metadata={triggerUTC:new Date(event).toISOString(),clipStartUTC:new Date(start).toISOString(),clipEndUTC:new Date(end).toISOString(),elapsedFromRecordingStartSeconds:Math.round((event-job.createdAt)/1000),requestedSecondsBefore:before,requestedSecondsAfter:after,quality:quality+'p',source:job.provider,cleanSourceVideo:true};
 fs.writeFileSync(path.join(job.dir,clip.id+'.json'),JSON.stringify(clip.metadata,null,2));
 fs.writeFileSync(path.join(job.dir,clip.id+'.csv'),'key,value\n'+Object.entries(clip.metadata).map(([k,v])=>k+',"'+String(v).replace(/"/g,'""')+'"').join('\n')+'\n');
 clip.state='ready';clip.bytes=fs.statSync(output).size;
 }catch(e){clip.state='failed';clip.error=e.message}})();
 return {id:clip.id,state:clip.state};
}
export function status(id,token){return view(readJob(id,token))}
export function stop(id,token){const job=readJob(id,token);cleanup(job);jobs.delete(id);return {ok:true}}
export function download(id,token,clipId,ext){const job=readJob(id,token);if(!['mp4','csv','json'].includes(ext))throw error('Invalid file type');const clip=job.clips.find(c=>c.id===clipId&&c.state==='ready');if(!clip)throw error('Clip not ready or not found.',404);const file=path.join(job.dir,clip.id+'.'+ext);if(!fs.existsSync(file))throw error('Recording file has expired.',410);return {file,type:ext==='mp4'?'video/mp4':ext==='csv'?'text/csv; charset=utf-8':'application/json',bytes:fs.statSync(file).size,name:'hypeclip-'+clip.id+'.'+ext}}
export function tokenFromRequest(req){return securityToken(req)}
setInterval(()=>{for(const [id,job] of jobs){if(Date.now()>job.expiresAt+120000){cleanup(job);jobs.delete(id)}}},60000).unref();
