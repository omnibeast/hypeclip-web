import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import youtubedl from 'youtube-dl-exec';
import {bestHlsUrl} from './server-hls.js';

const jobs=new Map(), ACTIVE_LIMIT=1, MAX_DURATION=10*60*1000, MAX_SEGMENTS=150, MAX_CLIPS=5, HISTORY_LIMIT=180;
const DEMO_SOURCE='demo://test-pattern';
const guid=()=>crypto.randomUUID(),safeId=s=>/^[a-f0-9-]{36}$/.test(s||'');
function error(message,status=400){return {error:message,status}}
const allowedHosts=()=>new Set((process.env.HYPECLIP_ALLOWED_HLS_HOSTS||'').split(',').map(h=>h.trim().toLowerCase()).filter(Boolean));
function provider(url){
 if(url===DEMO_SOURCE)return {provider:'Built-in video test',status:'ready',reason:'Self-generated test footage. Validates server recording, clean MP4 creation, CSV/JSON logs and downloads without YouTube access.'};
 let u;try{u=new URL(url)}catch{return {provider:'unknown',status:'invalid',reason:'Enter a full HTTPS livestream URL.'}}
 if(u.protocol!=='https:'||u.username||u.password)return {provider:'unknown',status:'invalid',reason:'Use a standard HTTPS URL without credentials.'};
 const host=u.hostname.toLowerCase();
 if(host==='youtube.com'||host==='www.youtube.com'||host==='m.youtube.com'||host==='youtu.be'){
 const beta=process.env.HYPECLIP_PRIVATE_BETA_CAPTURE==='true';
 return {provider:'YouTube',status:beta?'ready':'private-beta-disabled',reason:beta?'Private beta source-capture test. Only use for your own or authorized, publicly accessible livestream; compatibility is not guaranteed.':'YouTube video recording is disabled on this server until private-betacapture is enabled.'};
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
function cleanup(job){job.chatStop=true;if(job.hypeTimer)clearInterval(job.hypeTimer);if(job.extractor){try{job.extractor.kill('SIGTERM')}catch{}job.extractor=null}if(job.child){try{job.child.kill('SIGTERM')}catch{}job.child=null}if(job.timer)clearInterval(job.timer);job.timer=null;job.status='stopped';try{fs.rmSync(job.dir,{recursive:true,force:true})}catch{}}
function scan(job){
 if(!fs.existsSync(job.dir))return [];
 const names=fs.readdirSync(job.dir).filter(n=>/^part-\d{6}\.ts$/.test(n)).sort().slice(-MAX_SEGMENTS);
 return names.map(n=>{const file=path.join(job.dir,n),s=fs.statSync(file);return {file,at:s.mtimeMs,size:s.size}}).filter(s=>s.size>200);
}
function recordHype(job,rate,baseline=0,unique=0,source='chat'){
 const now=Date.now();const entry={at:now,rate:Math.max(0,Number(rate)||0),baseline:Math.max(0,Number(baseline)||0),unique:Math.max(0,Number(unique)||0),source};
 if(!job.hypeHistory)job.hypeHistory=[];
 job.hypeHistory.push(entry);if(job.hypeHistory.length>HISTORY_LIMIT)job.hypeHistory.splice(0,job.hypeHistory.length-HISTORY_LIMIT);
 return entry;
}
function view(job){
 const segs=scan(job);const bufferedBytes=segs.reduce((n,x)=>n+x.size,0);
 const recordingHealth=job.status==='starting'?'starting':job.status==='recording'&&!segs.length?'waiting-for-video':job.status==='recording'?'buffering':job.status;
 return {id:job.id,provider:job.provider,status:job.status,recordingHealth,createdAt:job.createdAt,expiresAt:job.expiresAt,segments:segs.length,bufferedBytes,elapsedSeconds:Math.round((Date.now()-job.createdAt)/1000),error:job.error,chat:job.chat,hypeHistory:job.hypeHistory||[],clips:job.clips.map(c=>({id:c.id,state:c.state,error:c.error,createdAt:c.createdAt,bytes:c.bytes||0,metadata:c.metadata||null}))}
}
function readJob(id,token){
 const job=jobs.get(id);
 // Render free instances use ephemeral memory; jobs expire on redeploy or restart.
 if(!job)throw error('Recording session expired or was lost after the server restarted. Start a new recording.',410);
 if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw error('Missing or invalid recording session token. Start a new recording.',401);
 const a=Buffer.from(token,'hex'),b=Buffer.from(job.token,'hex');
 if(a.length!==b.length||!crypto.timingSafeEqual(a,b))throw error('Recording session token does not match this job. Start a new recording.',403);
 return job;
}
function securityToken(req){return String(req.headers['x-hypeclip-token']||'')}
export async function start({url,confirmedRights,captureHlsUrl},req){
 if(!confirmedRights)throw error('Confirm you own or have permission to record this video source.');
 if(typeof url!=='string'||url.length>2048)throw error('Invalid video URL.');
 const active=[...jobs.values()].filter(j=>j.status==='recording');
 if(active.length>=ACTIVE_LIMIT)throw error('The test server is currently recording another stream. Try again after that job finishes.',429);
 const original=provider(url);
 const hasBackup=typeof captureHlsUrl==='string'&&captureHlsUrl.trim().length>0;
 if(hasBackup&&original.provider!=='YouTube')throw error('The optional authorized video feed is intended for YouTube Live.',422);
 if(hasBackup&&captureHlsUrl.length>2048)throw error('Authorized video feed URL is too long.');
 const source=hasBackup?captureHlsUrl.trim():url;
 const parsed=provider(source);if(parsed.status!=='ready')throw error(parsed.reason,422);
 if(hasBackup&&parsed.provider!=='Direct HLS')throw error('The alternate source must be an approved HTTPS .m3u8 playlist.',422);
 const isDemo=parsed.provider==='Built-in video test';
 const isDirectHls=parsed.provider==='Direct HLS';
 const validated=isDemo?DEMO_SOURCE:isDirectHls?await validateURL(source):new URL(source).toString();
 const playlist=isDirectHls?await bestHlsUrl(validated):validated;
 const id=guid(),token=crypto.randomBytes(32).toString('hex'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'hypeclip-v2-')),createdAt=Date.now();
 const job={id,token,dir,createdAt,expiresAt:createdAt+MAX_DURATION,status:'starting',provider:hasBackup?'YouTube + clean HLS':parsed.provider,chatVideoUrl:hasBackup?url:(parsed.provider==='YouTube'?validated:null),error:'',clips:[],child:null,extractor:null,timer:null,chat:{status:'inactive',count:0,lastEvent:null,recentRate:0,baseline:0},hypeHistory:[],chatStop:false};jobs.set(id,job);
 let extractor=null;
 const sourceInput=isDirectHls?playlist.toString():'pipe:0';
 const output=path.join(dir,'part-%06d.ts');
 // Built-in synthetic source makes the complete capture -> clip -> download path testable.
 const demoArgs=['-hide_banner','-loglevel','error','-nostdin','-re','-f','lavfi','-i','testsrc2=size=640x360:rate=15','-re','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','ultrafast','-g','30','-b:v','650k','-pix_fmt','yuv420p','-c:a','aac','-b:a','96k','-f','segment','-segment_time','3','-segment_format','mpegts','-reset_timestamps','1',output];
 const args=isDemo?demoArgs:['-hide_banner','-loglevel','error','-nostdin','-rw_timeout','15000000','-i',sourceInput,'-map','0:v:0','-map','0:a:0?','-c','copy','-f','segment','-segment_time','3','-segment_format','mpegts','-reset_timestamps','1',output];
 const child=spawn(ffmpeg,args,{stdio:[isDemo||isDirectHls?'ignore':'pipe','ignore','pipe']});job.child=child;job.status='recording';
 child.stderr.on('data',b=>{job.error=String(b).replace(/https?:\/\/[^\s]+/g,'[source]').slice(-350)});
 child.on('error',e=>{job.error='FFmpeg recorder launch failed: '+e.message;job.status='failed';job.child=null});
 child.on('close',c=>{if(job.child===child){job.child=null;job.status='failed';job.error=job.error||'Recorder closed unexpectedly ('+c+').' }});
 if(!isDirectHls&&!isDemo){
   // Only the canonical platform URL (never an arbitrary host) reaches the extractor.
   // No cookies, login state, special headers, DRM circumvention or bypass options.
   try{
     extractor=youtubedl.exec(validated,{
       output:'-',format:'best[height<=1080]/best',noPlaylist:true,
       noWarnings:true,noProgress:true,hlsUseMpegts:true
     },{timeout:MAX_DURATION+30000,killSignal:'SIGTERM'});
     job.extractor=extractor;
     const extractionFailure=err=>{
       // youtube-dl-exec is a promise-like subprocess. Rejections MUST be
       // handled or Node can exit, invalidating every in-memory job token.
       const message=String(err?.stderr||err?.message||err||'').slice(-1500);
       const botCheck=/sign in to confirm|not a bot|confirm you.re not a bot/i.test(message);
       job.error=botCheck
        ?'YouTube required sign-in/bot verification from this server. Server-side recording is unavailable for this stream; no authentication bypass is attempted.'
        :'Stream extraction failed: '+message.replace(/https?:\/\/[^\s]+/g,'[source]').slice(-300);
       if(job.status==='recording'||job.status==='starting')job.status=job.chatVideoUrl?'chat-only':'failed';
       job.chatStop=!job.chatVideoUrl;
       try{extractor.stdout.unpipe(child.stdin)}catch{}
       try{child.stdin.end()}catch{}
       try{child.kill('SIGTERM')}catch{}
     };
     if(typeof extractor.catch==='function')extractor.catch(extractionFailure);
     extractor.stdout.on('error',extractionFailure);
     child.stdin.on('error',e=>{
       if(e.code==='EPIPE'||e.code==='ERR_STREAM_DESTROYED')return;
       extractionFailure(e);
     });
     extractor.stdout.pipe(child.stdin);
     extractor.stderr.on('data',b=>{
       const msg=String(b);
       if(/sign in to confirm|not a bot|confirm you.re not a bot/i.test(msg)){
         job.error='YouTube required sign-in/bot verification from this server. Recording is unavailable for this stream.';
       }else if(job.status==='recording')job.error=msg.replace(/https?:\/\/[^\s]+/g,'[source]').slice(-300);
     });
     extractor.on('error',extractionFailure);
     extractor.on('close',c=>{
       if(job.extractor===extractor){
         job.extractor=null;
         if(job.status==='recording'){
           job.status=job.chatVideoUrl?'chat-only':'failed';
           job.error=job.error||'Extractor exited ('+c+'). Stream may be offline or blocked.';
           job.chatStop=!job.chatVideoUrl;
           try{child.kill('SIGTERM')}catch{}
         }
       }
     });
   }catch(e){job.status='failed';job.error='Could not launch public stream extractor: '+e.message;try{child.kill('SIGTERM')}catch{}}
 }
 job.timer=setInterval(()=>{if(job.status==='recording'&&Date.now()-job.createdAt>30000&&scan(job).length===0){job.error=job.error||'No video segments arrived within 30 seconds. Check whether this stream is accessible to the server.';job.status='failed';job.chatStop=true;if(job.extractor){try{job.extractor.kill('SIGTERM')}catch{}job.extractor=null}if(job.child){try{job.child.kill('SIGTERM')}catch{}job.child=null}}if(Date.now()>job.expiresAt&&(job.status==='recording'||job.status==='chat-only')){job.chatStop=true;if(job.hypeTimer)clearInterval(job.hypeTimer);job.status='finished';if(job.child){try{job.child.kill('SIGTERM')}catch{}job.child=null}if(job.extractor){try{job.extractor.kill('SIGTERM')}catch{}job.extractor=null}clearInterval(job.timer);job.timer=null}},5000);
 if(isDemo){job.chat.status='simulated';job.demoTick=0;job.hypeTimer=setInterval(()=>{if(job.status!=='recording'){clearInterval(job.hypeTimer);return}const t=job.demoTick++,spike=t%55>=26&&t%55<=36;const rate=spike?Math.floor(17+Math.random()*18):Math.floor(Math.random()*6);const baseline=5;job.chat.recentRate=rate;job.chat.baseline=baseline;recordHype(job,rate,baseline,spike?8:2,'demo');},2000)}
 if(job.chatVideoUrl&&process.env.YOUTUBE_API_KEY)void monitorChat(job,job.chatVideoUrl);
 return {job:view(job),token};
}

function videoId(raw){
 const u=new URL(raw);
 if(u.hostname==='youtu.be')return u.pathname.split('/')[1];
 if(u.pathname.startsWith('/live/'))return u.pathname.split('/')[2];
 return u.searchParams.get('v');
}
async function youtubeAPI(endpoint,query){
 const u=new URL('https://www.googleapis.com/youtube/v3/'+endpoint);
 for(const [k,v] of Object.entries({...query,key:process.env.YOUTUBE_API_KEY}))u.searchParams.set(k,String(v));
 const resp=await fetch(u,{signal:AbortSignal.timeout(12000)});
 const data=await resp.json();
 if(!resp.ok)throw Error(data.error?.message||'YouTube API unavailable');
 return data;
}
async function monitorChat(job,url){
 let seen=new Set(),page='',previous=[],lastEvent=0,started=false;
 try{
  const id=videoId(url);
  if(!/^[a-zA-Z0-9_-]{11}$/.test(id||''))throw Error('Invalid YouTube live video ID');
  const video=await youtubeAPI('videos',{part:'liveStreamingDetails',id});
  const chatId=video.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
  if(!chatId)throw Error('Live chat is disabled or stream is not currently live.');
  job.chat.status='monitoring';
  while(!job.chatStop&&(job.status==='recording'||job.status==='chat-only')){
   let pause=5000;
   try{
    const results=await youtubeAPI('liveChat/messages',{part:'id,snippet,authorDetails',liveChatId:chatId,maxResults:200,...(page?{pageToken:page}:{})});
    page=results.nextPageToken||page;pause=Math.max(3000,Number(results.pollingIntervalMillis||5000));
    const arrivals=[];
    for(const m of results.items||[]){
     if(seen.has(m.id))continue;
     seen.add(m.id);
     const t=Date.parse(m.snippet?.publishedAt)||Date.now();
     if(started&&t>Date.now()-15000)arrivals.push({at:t,author:m.authorDetails?.channelId||m.id});
    }
    if(seen.size>8000)seen=new Set([...seen].slice(-4000));
    started=true;const now=Date.now();
    previous.push(...arrivals);previous=previous.filter(m=>m.at>now-120000);
    const last10=previous.filter(m=>m.at>now-10000),unique=new Set(last10.map(m=>m.author)).size;
    const baseline=Math.max(1,(previous.length-last10.length)/11);
    job.chat.count+=arrivals.length;job.chat.recentRate=last10.length;job.chat.baseline=Math.round(baseline*10)/10;
    job.chat.status='monitoring';job.chat.error='';
    recordHype(job,last10.length,baseline,unique,'youtube-chat');
    if(job.status==='recording'&&scan(job).length>=2&&now-job.createdAt>30000&&last10.length>=12&&unique>=4&&last10.length>=baseline*2.4&&now-lastEvent>65000&&job.clips.length<MAX_CLIPS&&!job.clips.some(c=>c.state==='encoding')){
      lastEvent=now;job.chat.lastEvent=new Date(now).toISOString();
      void createClip(job.id,job.token,{before:25,after:20,quality:'1080',automatic:true}).catch(e=>{job.chat.error=e.error||e.message});
    }
   }catch(e){job.chat.error=String(e.message).slice(0,180);pause=15000}
   await new Promise(r=>setTimeout(r,pause));
  }
 }catch(e){job.chat.status='unavailable';job.chat.error=String(e.message).slice(0,180)}
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
export function stop(id,token){const job=readJob(id,token);if(job.status!=='stopped'){job.chatStop=true;if(job.hypeTimer)clearInterval(job.hypeTimer);if(job.extractor){try{job.extractor.kill('SIGTERM')}catch{}job.extractor=null}if(job.child){try{job.child.kill('SIGTERM')}catch{}job.child=null}if(job.timer)clearInterval(job.timer);job.timer=null;job.status='stopped'}return {ok:true,retainedClips:job.clips.filter(c=>c.state==='ready').length}}
export function download(id,token,clipId,ext){const job=readJob(id,token);if(!['mp4','csv','json'].includes(ext))throw error('Invalid file type');const clip=job.clips.find(c=>c.id===clipId&&c.state==='ready');if(!clip)throw error('Clip not ready or not found.',404);const file=path.join(job.dir,clip.id+'.'+ext);if(!fs.existsSync(file))throw error('Recording file has expired.',410);return {file,type:ext==='mp4'?'video/mp4':ext==='csv'?'text/csv; charset=utf-8':'application/json',bytes:fs.statSync(file).size,name:'hypeclip-'+clip.id+'.'+ext}}
export function tokenFromRequest(req){return securityToken(req)}
setInterval(()=>{for(const [id,job] of jobs){if(Date.now()>job.expiresAt+120000){cleanup(job);jobs.delete(id)}}},60000).unref();
