import os, time, uuid, threading, shutil
from pathlib import Path
from urllib.parse import urlparse
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import BaseModel
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError
import imageio_ffmpeg

ROOT=Path(__file__).resolve().parent
STORE=Path("/tmp/omni-video-downloads")
STORE.mkdir(parents=True,exist_ok=True)
app=FastAPI(title="OMNi Video Downloader")
jobs={}
lock=threading.RLock()
quality={"best":None,"1080":1080,"720":720,"480":480,"360":360}
MAX_ACTIVE=1
TTL=3600

class Request(BaseModel):
    url:str
    quality:str="best"

def valid(url):
    try:
        p=urlparse(url.strip())
        host=(p.hostname or "").lower().rstrip(".")
        if p.scheme not in ("https","http") or host not in {"www.youtube.com","youtube.com","m.youtube.com","youtu.be","music.youtube.com"} or p.username or p.password or p.port not in (None,80,443):
            return False
        return bool(p.path.strip("/")) if host=="youtu.be" else p.path=="/watch" or p.path.startswith(("/live/","/shorts/"))
    except Exception:
        return False

def purge():
    now=time.time()
    for jid,j in list(jobs.items()):
        if now-j["created"]>TTL and j["status"] not in ("downloading","fetching","processing"):
            shutil.rmtree(STORE/jid,ignore_errors=True)
            jobs.pop(jid,None)

def work(jid,url,q):
    directory=STORE/jid
    directory.mkdir(exist_ok=True)
    j=jobs[jid]
    def hook(d):
        with lock:
            if d.get("status")=="downloading":
                j["status"]="downloading"
                done=d.get("downloaded_bytes") or 0
                total=d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                j["progress"]=min(99,round(done/total*100,1)) if total else 0
                speed=d.get("speed") or 0
                j["speed"]=f"{speed/1048576:.2f} MB/s" if speed else ""
            elif d.get("status")=="finished":
                j["status"]="processing"
                j["progress"]=99
    try:
        maxheight=quality[q]
        fmt="bv*+ba/b" if maxheight is None else f"bv*[height<={maxheight}]+ba/b[height<={maxheight}]"
        ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
        opts={"format":fmt,"noplaylist":True,"outtmpl":str(directory/"%(title).120B [%(id)s].%(ext)s"),
              "merge_output_format":"mp4","ffmpeg_location":ffmpeg,
              "progress_hooks":[hook],"quiet":True,"no_warnings":True,
              "retries":3,"fragment_retries":3,"socket_timeout":20}
        j["status"]="fetching"
        with YoutubeDL(opts) as dl:
            info=dl.extract_info(url,download=False)
            j["title"]=info.get("title") or "Untitled video"
            dl.download([url])
        files=sorted((p for p in directory.iterdir() if p.is_file() and not p.name.endswith((".part",".ytdl"))),key=lambda p:p.stat().st_size,reverse=True)
        if not files: raise RuntimeError("No finished file found")
        with lock:
            j.update(status="ready",progress=100,filename=files[0].name,speed="")
    except Exception as e:
        with lock:
            j.update(status="error",error=str(e).replace("ERROR: ","")[:250],speed="")

@app.get("/",response_class=HTMLResponse)
def home():
    return (ROOT/"index.html").read_text(encoding="utf8")

@app.get("/health")
def health():
    return {"status":"ok"}

@app.post("/api/jobs",status_code=202)
def start(req:Request):
    if not valid(req.url): raise HTTPException(400,"Enter a valid individual YouTube video URL.")
    if req.quality not in quality: raise HTTPException(400,"Invalid quality.")
    with lock:
        purge()
        active=sum(j["status"] in ("queued","fetching","downloading","processing") for j in jobs.values())
        if active>=MAX_ACTIVE: raise HTTPException(429,"A demo download is already running. Try again later.")
        jid=uuid.uuid4().hex
        jobs[jid]={"id":jid,"title":"Preparing video…","status":"queued","progress":0,"speed":"","error":"","filename":"","created":time.time()}
    threading.Thread(target=work,args=(jid,req.url,req.quality),daemon=True).start()
    return jobs[jid]

@app.get("/api/jobs/{jid}")
def status(jid:str):
    with lock:
        purge()
        j=jobs.get(jid)
        if not j: raise HTTPException(404,"Job expired or not found.")
        return j

@app.get("/api/jobs/{jid}/file")
def download(jid:str):
    with lock:
        j=jobs.get(jid)
        if not j or j["status"]!="ready":raise HTTPException(404,"File unavailable.")
        path=STORE/jid/j["filename"]
    if not path.is_file():raise HTTPException(404,"File expired.")
    return FileResponse(path,filename=j["filename"],media_type="application/octet-stream")
