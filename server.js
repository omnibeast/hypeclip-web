import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {ingest,makeClip,getClip,getClipLog,snapshot,stopRecording} from './recorder.js';
import {startServerCapture,stopServerCapture,serverCaptureStatus} from './server-hls.js';
import * as v2 from './v2-jobs.js';
const PORT=Number(process.env.PORT||4173),PASSWORD=process.env.HYPECLIP_PASSWORD||'',KEY=process.env.YOUTUBE_API_KEY||'';
if(process.env.NODE_ENV==='production'&&!PASSWORD)throw Error('Set HYPECLIP_PASSWORD');
const clients=new Set();let interval=null,session=0;
const DEFAULT_SETTINGS={autoBefore:25,autoAfter:20,manualBefore:25,manualAfter:10,quality:'1080'};
function normalizedSettings(input={},base=DEFAULT_SETTINGS){
  const settings={};
  for(const key of ['autoBefore','autoAfter','manualBefore','manualAfter']){
    const value=input[key]===undefined?base[key]:Number(input[key]);
    if(!Number.isInteger(value)||value<5||value>55)throw Error(key+' must be an integer between 5 and 55 seconds');
    settings[key]=value;
  }
  const quality=String(input.quality??base.quality);if(!['480','720','1080'].includes(quality))throw Error('Quality must be 480p, 720p or 1080p');settings.quality=quality;
  if(settings.autoBefore+settings.autoAfter>65||settings.manualBefore+settings.manualAfter>65)throw Error('Total clip duration cannot exceed 65 seconds');
  return settings;
}

const state={status:'idle',mode:'demo',title:'',url:'',count:0,rate:0,baseline:0,peak:0,messages:[],events:[],history:[],error:'',startedAt:null,apiKeyConfigured:!!KEY,recording:false,clipCount:0,clips:[],settings:{...DEFAULT_SETTINGS}};
function json(res,body,status=200){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body))}
function send(){Object.assign(state,snapshot());const data='data: '+JSON.stringify(state)+'\n\n';for(const w of clients){try{w.write(data)}catch{clients.delete(w)}}}
function add(text,author,at=Date.now()){state.messages.unshift({text,author,at});state.messages=state.messages.slice(0,55);state.count++;state.tick=(state.tick||[]);state.tick.push({at,author});state.tick=state.tick.filter(x=>x.at>Date.now()-120000)}
function analyze(){const now=Date.now(),recent=(state.tick||[]).filter(x=>x.at>now-10000),rate=recent.length,prev=state.history.slice(-24).map(x=>x.messages),base=prev.length?Math.max(1,prev.reduce((a,b)=>a+b,0)/prev.length):Math.max(1,rate);state.rate=rate;state.baseline=Math.round(base*10)/10;state.peak=Math.max(state.peak,rate);state.history.push({at:now,messages:rate});if(state.history.length>90)state.history.shift();const unique=new Set(recent.map(x=>x.author)).size,cfg=state.sensitivity==='high'?[7,1.8]:state.sensitivity==='low'?[22,3.2]:[12,2.4];if(rate>=cfg[0]&&rate>=base*cfg[1]&&unique>=4&&now-(state.lastEvent||0)>60000){state.lastEvent=now;const event={at:now,count:rate,unique,score:Math.min(100,Math.round(25+15*rate/base)),clip:'Waiting for recording...',clipStatus:'pending'};state.events.unshift(event);state.events=state.events.slice(0,35);makeClip({at:now,before:state.settings.autoBefore,after:state.settings.autoAfter,quality:state.settings.quality,onUpdate:update=>{if(update.status==='ready'){event.clip='Download MP4';event.clipStatus='ready';event.clipUrl=update.url;event.clipLogUrl=update.url.replace(/\.mp4$/,'.csv');event.clipJsonUrl=update.url.replace(/\.mp4$/,'.json')}else if(update.status==='failed'){event.clip=update.error;event.clipStatus='failed'}else{event.clip='Encoding MP4...';event.clipStatus='encoding'}send()}}).then(result=>{if(!result.ok&&event.clipStatus!=='failed'){event.clipStatus='failed';event.clip=result.error;send()}})}send()}
function stop(){session++;if(interval)clearInterval(interval);interval=null;state.status='idle';state.tick=[];send()}
function startDemo(opts){stop();const id=session;Object.assign(state,{status:'monitoring',mode:'demo',title:'Simulated live chat',url:opts.url||'',count:0,rate:0,peak:0,baseline:0,error:'',messages:[],events:[],history:[],lastEvent:0,sensitivity:opts.sensitivity||'balanced',startedAt:Date.now()});let sec=0;const names=['PixelPilot','NightOwl','Luna','OMNi','Gamer22','GG','SpeedRunner','Rex','Viewer','ChatFan','ProGamer','Nova'];interval=setInterval(()=>{if(id!==session)return;sec++;const burst=sec%70>=24&&sec%70<42,n=burst?8+Math.floor(Math.random()*8):Math.floor(Math.random()*3);for(let i=0;i<n;i++)add(burst?['OMG 🔥','CLIP THAT!','WHAT A PLAY','W W W','NO WAY'][i%5]:['gg','hello','nice','lets go'][i%4],names[Math.floor(Math.random()*names.length)]);if(sec%2===0)analyze()},1000);send()}
function youtubeId(url){const u=new URL(url);if(u.hostname==='youtu.be')return u.pathname.split('/')[1];if(['youtube.com','www.youtube.com','m.youtube.com'].includes(u.hostname))return u.searchParams.get('v')||u.pathname.match(/^\/live\/([\w-]{11})/)?.[1];throw Error('YouTube livestream URL required')}
async function youtube(endpoint,params){const u=new URL('https://www.googleapis.com/youtube/v3/'+endpoint);for(const [k,v] of Object.entries({...params,key:KEY}))u.searchParams.set(k,String(v));const resp=await fetch(u,{signal:AbortSignal.timeout(15000)});const obj=await resp.json();if(!resp.ok)throw Error(obj.error?.message||'YouTube API error');return obj}
async function startReal(opts){if(!KEY)throw Error('YouTube API key is not configured. Try demo mode.');const id=youtubeId(opts.url);if(!/^[\w-]{11}$/.test(id||''))throw Error('Invalid YouTube video ID');const info=await youtube('videos',{part:'snippet,liveStreamingDetails',id}),video=info.items?.[0];if(!video?.liveStreamingDetails?.activeLiveChatId)throw Error('Video is not live with publicly accessible chat');stop();const token=session;Object.assign(state,{status:'monitoring',mode:'youtube',title:video.snippet?.title||'YouTube livestream',url:opts.url,count:0,rate:0,peak:0,baseline:0,messages:[],events:[],history:[],error:'',startedAt:Date.now(),lastEvent:0,sensitivity:opts.sensitivity||'balanced'});const chatId=video.liveStreamingDetails.activeLiveChatId;let pageToken='',seen=new Set();interval=setInterval(()=>{if(token===session)analyze()},2000);send();(async()=>{while(token===session){let delay=5000;try{const params={part:'id,snippet,authorDetails',liveChatId:chatId,maxResults:200,...(pageToken?{pageToken}:{})},data=await youtube('liveChat/messages',params);pageToken=data.nextPageToken||pageToken;for(const m of data.items||[]){if(seen.has(m.id))continue;seen.add(m.id);if(seen.size>20000)seen.clear();add(m.snippet?.displayMessage||'',m.authorDetails?.displayName||'Viewer',Date.parse(m.snippet?.publishedAt)||Date.now())}delay=Math.max(1500,Number(data.pollingIntervalMillis||5000));state.error='';send()}catch(e){state.error=e.message;delay=15000;send()}await new Promise(r=>setTimeout(r,delay))}})()}
function authorized(req){if(!PASSWORD)return true;const h=req.headers.authorization||'';if(!h.startsWith('Basic '))return false;let raw='';try{raw=Buffer.from(h.slice(6),'base64').toString()}catch{return false}const i=raw.indexOf(':');if(i<0)return false;const a=Buffer.from(raw.slice(i+1)),b=Buffer.from(PASSWORD);return a.length===b.length&&crypto.timingSafeEqual(a,b)}
const html=fs.readFileSync(new URL('./index.html',import.meta.url));
const v2html=fs.readFileSync(new URL('./v2.html',import.meta.url));
const v2Rate=new Map();
function v2Limit(req){const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();const now=Date.now(),v=v2Rate.get(ip)||{at:now,count:0};if(now-v.at>60000){v.at=now;v.count=0}v.count++;v2Rate.set(ip,v);if(v.count>90)throw {error:'Too many requests. Please retry later.',status:429};if(v2Rate.size>5000){for(const [k,val] of v2Rate){if(now-val.at>60000)v2Rate.delete(k)}}}
async function v2Body(req){let body='';for await(const b of req){body+=b;if(body.length>4096)throw {error:'Request too large',status:413}}try{return JSON.parse(body||'{}')}catch{throw {error:'Invalid JSON request',status:400}}}
async function v2Route(req,res,path){
 try{
  v2Limit(req);
  if(path==='/api/v2/inspect'&&req.method==='POST')return json(res,v2.inspect((await v2Body(req)).url));
  if(path==='/api/v2/jobs'&&req.method==='POST')return json(res,await v2.start(await v2Body(req),req),201);
  const parts=/^\/api\/v2\/jobs\/([a-f0-9-]{36})(?:\/(stop|clips)(?:\/([a-f0-9-]{36})\.(mp4|csv|json))?)?$/.exec(path);
  if(!parts)return json(res,{error:'Not found'},404);
  const [,id,action,fileId,format]=parts,token=v2.tokenFromRequest(req);
  if(!action&&req.method==='GET')return json(res,v2.status(id,token));
  if(action==='stop'&&req.method==='POST')return json(res,v2.stop(id,token));
  if(action==='clips'&&!fileId&&req.method==='POST')return json(res,await v2.createClip(id,token,await v2Body(req)),202);
  if(action==='clips'&&fileId&&req.method==='GET'){
    const out=v2.download(id,token,fileId,format);
    res.writeHead(200,{'content-type':out.type,'content-length':out.bytes,'content-disposition':'attachment; filename="'+out.name+'"','cache-control':'no-store','x-content-type-options':'nosniff'});
    return fs.createReadStream(out.file).pipe(res);
  }
  return json(res,{error:'Unsupported operation'},405);
 }catch(e){return json(res,{error:e.error||e.message||'Request failed'},e.status||400)}
}

http.createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname;if(path==='/healthz')return json(res,{ok:true});if(path==='/v2'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(v2html)}if(path.startsWith('/api/v2/'))return v2Route(req,res,path);if(!authorized(req)){res.writeHead(401,{'www-authenticate':'Basic realm="HypeClip Testing"'});return res.end('Login required')}if(path==='/'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(html)}if(path==='/api/state'){Object.assign(state,snapshot());return json(res,state)}if(path==='/api/recording-status')return json(res,snapshot());
if(path==='/api/server-capture/start'&&req.method==='POST'){
 let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>8192)throw Error('Video source URL too long')}
 const opts=JSON.parse(raw||'{}');
 if(typeof opts.hlsUrl!=='string')throw Error('Provide an authorized direct HTTPS HLS URL.');
 const result=await startServerCapture(opts.hlsUrl);
 console.log('Authorized clean HLS server capture started for hostname:',result.sourceHost);
 send();return json(res,result);
}
if(path==='/api/server-capture/stop'&&req.method==='POST'){
 stopServerCapture();send();return json(res,{ok:true});
}if(path==='/api/segment'&&req.method==='POST'){const out=await ingest(req);Object.assign(state,snapshot());send();return json(res,out)}if(path==='/api/recording-stop'&&req.method==='POST'){stopRecording();send();return json(res,{ok:true})}if(path==='/api/settings'&&req.method==='POST'){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4096)throw Error('Settings request too large')}const opts=JSON.parse(raw||'{}');state.settings=normalizedSettings(opts,state.settings);send();return json(res,{ok:true,settings:state.settings})}if(path==='/api/clip'&&req.method==='POST'){const event={at:Date.now(),count:state.rate,unique:0,score:0,clip:'Encoding MP4...',clipStatus:'encoding',manual:true};state.events.unshift(event);state.events=state.events.slice(0,35);send();makeClip({at:event.at,before:state.settings.manualBefore,after:state.settings.manualAfter,quality:state.settings.quality,onUpdate:update=>{if(update.status==='ready'){event.clip='Download MP4';event.clipStatus='ready';event.clipUrl=update.url;event.clipLogUrl=update.url.replace(/\.mp4$/,'.csv');event.clipJsonUrl=update.url.replace(/\.mp4$/,'.json')}else if(update.status==='failed'){event.clip=update.error;event.clipStatus='failed'}send()}}).then(result=>{if(!result.ok&&event.clipStatus!=='failed'){event.clipStatus='failed';event.clip=result.error;send()}});return json(res,{ok:true})}if(path.startsWith('/api/clips/')&&req.method==='GET'&&/\.(csv|json)$/.test(path)){
 const match=/^\/api\/clips\/([a-zA-Z0-9_-]+)\.(csv|json)$/.exec(path);
 if(!match)return json(res,{error:'Invalid clip metadata link'},400);
 const file=getClipLog(match[1],match[2]);
 if(!file||!fs.existsSync(file))return json(res,{error:'The timestamp log has expired after a server restart.'},410);
 const size=fs.statSync(file).size;
 res.writeHead(200,{'content-type':match[2]==='csv'?'text/csv; charset=utf-8':'application/json; charset=utf-8',
 'content-disposition':'attachment; filename="hypeclip-'+match[1]+'-timestamps.'+match[2]+'"',
 'content-length':size,'cache-control':'no-store','x-content-type-options':'nosniff'});
 return fs.createReadStream(file).pipe(res);
}
if(path.startsWith('/api/clips/')&&req.method==='GET'){
 const match=/^\/api\/clips\/([a-zA-Z0-9_-]+)\.mp4$/.exec(path);
 if(!match)return json(res,{error:'Invalid MP4 clip URL'},400);
 const clip=getClip(match[1]);
 if(!clip||!fs.existsSync(clip.path))return json(res,{error:'This clip has expired or was lost after a server restart. Capture the stream and generate a new clip. Download promptly.'},410);
 const stats=fs.statSync(clip.path);
 if(stats.size<1000)return json(res,{error:'MP4 file is empty or incomplete. Please record again.'},422);
 res.writeHead(200,{'content-type':'video/mp4','content-disposition':'attachment; filename="hypeclip-'+clip.id+'.mp4"','content-length':stats.size,'cache-control':'no-store, no-cache, must-revalidate','x-content-type-options':'nosniff','accept-ranges':'none'});
 const stream=fs.createReadStream(clip.path);
 stream.on('error',err=>{console.error('Clip download read error:',err.message);if(!res.destroyed)res.destroy(err)});
 return stream.pipe(res);
}if(path==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});clients.add(res);res.write('data: '+JSON.stringify(state)+'\n\n');req.on('close',()=>clients.delete(res));return}if(path==='/api/stop'&&req.method==='POST'){stop();return json(res,{ok:true})}if(path==='/api/start'&&req.method==='POST'){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>8000)throw Error('Too much data')}const options=JSON.parse(raw||'{}');if(options.settings)state.settings=normalizedSettings(options.settings,state.settings);if(options.demo)startDemo(options);else await startReal(options);return json(res,{ok:true})}return json(res,{error:'Not found'},404)}catch(e){return json(res,{error:e.message},400)}}).listen(PORT,'0.0.0.0',()=>console.log('HypeClip listening on '+PORT));
