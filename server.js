const express=require("express");
const cors=require("cors");
const http=require("http");
const https=require("https");
const {URL}=require("url");
const path=require("path");
const fs=require("fs");
const os=require("os");
const crypto=require("crypto");
const {spawn}=require("child_process");
let ffmpegBin="ffmpeg";
try{ffmpegBin=require("ffmpeg-static")||"ffmpeg"}catch{}
const httpAgent=new http.Agent({keepAlive:true,maxSockets:100,maxFreeSockets:20,keepAliveMsecs:10000});
const httpsAgent=new https.Agent({keepAlive:true,maxSockets:100,maxFreeSockets:20,keepAliveMsecs:10000});

const app=express();
const PORT=process.env.PORT||3000;
app.use(cors());
app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname,"public")));

app.get("/api/health",(req,res)=>res.json({
  ok:true,version:"4.2.0",node:process.version,time:new Date().toISOString()
}));

function normalizeServer(v){
  let s=String(v||"").trim();
  if(!s) throw new Error("URL do servidor vazia.");
  if(!/^https?:\/\//i.test(s)) s="http://"+s;
  return s.replace(/\/+$/,"");
}

function xtreamUrl(server,user,pass,action,params={}){
  const u=new URL(normalizeServer(server)+"/player_api.php");
  u.searchParams.set("username",user);
  u.searchParams.set("password",pass);
  if(action)u.searchParams.set("action",action);
  for(const [k,v] of Object.entries(params||{}))if(v!==undefined&&v!==null&&v!=="")u.searchParams.set(k,String(v));
  return u;
}

async function apiRequest(server,user,pass,action,params={}){
  const url=xtreamUrl(server,user,pass,action,params);
  const r=await fetch(url,{redirect:"follow"});
  const text=await r.text();
  let data=null; try{data=JSON.parse(text)}catch{}
  return {status:r.status,text,data,contentType:r.headers.get("content-type")||"",url:r.url};
}

/*
  Follow live-stream redirects. Many IPTV panels return a short-lived 301/302
  URL for /live/...ts. The previous version stopped at the redirect, so
  mpegts.js received HTML instead of MPEG-TS bytes.
*/
function requestFollowingRedirects(startUrl, options={}, maxRedirects=6){
  return new Promise((resolve,reject)=>{
    let current=startUrl, hops=0, req=null, settled=false;

    const fail=e=>{if(!settled){settled=true;reject(e)}};

    const go=()=>{
      let u;
      try{u=new URL(current)}catch(e){return fail(new Error("URL inválida: "+e.message))}
      const mod=u.protocol==="https:"?https:http;
      const headers=Object.assign({
        "User-Agent":"VLC/3.0.20 MetaPlay/3.16",
        "Accept":"*/*",
        "Connection":"keep-alive"
      },options.headers||{});
      req=mod.request(u,{method:options.method||"GET",headers,timeout:120000,agent:u.protocol==="https:"?httpsAgent:httpAgent},res=>{
        const code=res.statusCode||0;
        if([301,302,303,307,308].includes(code) && res.headers.location){
          if(hops++>=maxRedirects){
            res.resume();
            return fail(new Error("Limite de redirecionamentos excedido."));
          }
          const next=new URL(res.headers.location,current).toString();
          res.resume();
          current=next;
          return go();
        }
        if(settled)return;
        settled=true;
        resolve({res,finalUrl:current,redirects:hops});
      });
      req.setTimeout(120000,()=>req.destroy(new Error("timeout")));
      req.on("error",fail);
      req.end();
    };
    go();
  });
}

function probeStream(target){
  return new Promise((resolve)=>{
    requestFollowingRedirects(target,{headers:{
      "User-Agent":"VLC/3.0.20 MetaPlay/3.16",
      "Accept":"*/*"
    }}).then(({res,finalUrl,redirects})=>{
      const ct=res.headers["content-type"]||"";
      let total=0,chunks=[],finished=false;
      const finish=()=>{
        if(finished)return; finished=true;
        const buf=Buffer.concat(chunks);
        resolve({
          ok:res.statusCode>=200&&res.statusCode<400,
          status:res.statusCode,
          contentType:ct,
          contentLength:res.headers["content-length"]||null,
          bytes:buf.length,
          firstBytes:buf.subarray(0,16).toString("hex"),
          mpegTsSync:buf.length>=188 && buf[0]===0x47,
          redirects,
          originalUrl:target,
          finalUrl
        });
      };
      res.on("data",b=>{
        if(total<188*16){
          const take=b.subarray(0,Math.max(0,188*16-total));
          chunks.push(take); total+=take.length;
        }
        if(total>=188*16)res.destroy();
      });
      res.on("end",finish);
      res.on("close",finish);
      res.on("error",e=>resolve({ok:false,error:e.message,finalUrl,redirects}));
    }).catch(e=>resolve({ok:false,error:e.message,originalUrl:target}));
  });
}

app.post("/api/test",async(req,res)=>{
  try{
    const {server,user,pass}=req.body||{};
    if(!server||!user||!pass)return res.status(400).json({ok:false,error:"Preencha servidor, usuário e senha."});
    const r=await apiRequest(server,user,pass);
    res.json({ok:r.status>=200&&r.status<300,http:r.status,json:!!r.data,contentType:r.contentType,preview:r.text.slice(0,1000)});
  }catch(e){res.json({ok:false,error:e.message})}
});

app.post("/api/login",async(req,res)=>{
  try{
    const {server,user,pass}=req.body||{};
    if(!server||!user||!pass)return res.status(400).json({ok:false,error:"Preencha servidor, usuário e senha."});
    const r=await apiRequest(server,user,pass);
    if(r.status<200||r.status>=300)return res.json({ok:false,error:`Servidor respondeu HTTP ${r.status}.`,http:r.status});
    if(!r.data)return res.json({ok:false,error:"Resposta não é JSON válido.",preview:r.text.slice(0,500)});
    if(!r.data.user_info)return res.json({ok:false,error:"API sem user_info; confirme compatibilidade Xtream."});
    if(String(r.data.user_info.auth)==="0")return res.json({ok:false,error:"Usuário ou senha recusados."});
    res.json({ok:true,server:normalizeServer(server),user_info:r.data.user_info});
  }catch(e){res.json({ok:false,error:e.message})}
});

const actions=new Set(["get_live_categories","get_live_streams","get_vod_categories","get_vod_streams","get_series_categories","get_series"]);
app.post("/api/list",async(req,res)=>{
  try{
    const {server,user,pass,action}=req.body||{};
    if(!actions.has(action))return res.status(400).json({ok:false,error:"Ação inválida."});
    const r=await apiRequest(server,user,pass,action);
    if(r.status<200||r.status>=300)return res.json({ok:false,error:`HTTP ${r.status}`,preview:r.text.slice(0,500)});
    if(!r.data)return res.json({ok:false,error:"Resposta inválida."});
    res.json({ok:true,data:Array.isArray(r.data)?r.data:[]});
  }catch(e){res.json({ok:false,error:e.message})}
});

// V3.16: detalhes completos de séries (temporadas/episódios).
app.post("/api/series-info",async(req,res)=>{
  try{
    const {server,user,pass,series_id}=req.body||{};
    if(!series_id)return res.status(400).json({ok:false,error:"series_id ausente."});
    const r=await apiRequest(server,user,pass,"get_series_info",{series_id});
    if(r.status<200||r.status>=300)return res.json({ok:false,error:`HTTP ${r.status}`,preview:r.text.slice(0,500)});
    if(!r.data||typeof r.data!=="object")return res.json({ok:false,error:"O provedor não retornou detalhes válidos da série."});
    res.json({ok:true,data:r.data});
  }catch(e){res.json({ok:false,error:e.message})}
});

// V3.16: EPG curto do canal. Nem todo provedor Xtream disponibiliza esta ação.
app.post("/api/epg",async(req,res)=>{
  try{
    const {server,user,pass,stream_id,limit=6}=req.body||{};
    if(!stream_id)return res.status(400).json({ok:false,error:"stream_id ausente."});
    const r=await apiRequest(server,user,pass,"get_short_epg",{stream_id,limit:Math.max(1,Math.min(12,Number(limit)||6))});
    if(r.status<200||r.status>=300)return res.json({ok:false,error:`HTTP ${r.status}`});
    const listings=r.data&&Array.isArray(r.data.epg_listings)?r.data.epg_listings:[];
    res.json({ok:true,data:listings});
  }catch(e){res.json({ok:false,error:e.message})}
});



// Mobile HLS bridge (iPhone/iPad): converts an MPEG-TS live stream to HLS.
// Each playback gets an isolated short-lived session.
const hlsRoot=path.join(os.tmpdir(),"meta-play-hls");
fs.mkdirSync(hlsRoot,{recursive:true});
const hlsSessions=new Map();
function cleanupHls(id){
  const s=hlsSessions.get(id); if(!s)return;
  try{s.proc&&s.proc.kill("SIGKILL")}catch{}
  try{fs.rmSync(s.dir,{recursive:true,force:true})}catch{}
  hlsSessions.delete(id);
}
setInterval(()=>{const now=Date.now();for(const [id,s] of hlsSessions)if(now-s.touched>10*60*1000)cleanupHls(id)},60000).unref();

app.post("/api/mobile-hls",async(req,res)=>{
  const b=req.body||{};
  let raw=String(b.url||"").trim();
  // Prefer rebuilding the Xtream live URL from normalized credentials. This
  // prevents malformed hosts such as "example.sitelive/..." on mobile.
  if(b.server&&b.user&&b.pass&&b.stream_id){
    try{
      const base=normalizeServer(b.server);
      const ext=String(b.ext||"ts").replace(/^\./,"")||"ts";
      raw=base+"/live/"+encodeURIComponent(String(b.user))+"/"+encodeURIComponent(String(b.pass))+"/"+encodeURIComponent(String(b.stream_id))+"."+ext;
    }catch(e){return res.status(400).json({ok:false,error:"Servidor inválido: "+e.message})}
  }
  if(!raw)return res.status(400).json({ok:false,error:"URL ausente."});
  try{const u=new URL(raw);if(!/^https?:$/.test(u.protocol))throw new Error("Protocolo inválido.")}catch(e){return res.status(400).json({ok:false,error:"URL inválida: "+e.message})}
  try{
    const rr=await requestFollowingRedirects(raw,{headers:{"User-Agent":"VLC/3.0.20 MetaPlay/4.2","Accept":"*/*"}});
    const finalUrl=rr.finalUrl; try{rr.res.destroy()}catch{}
    const id=crypto.randomBytes(12).toString("hex"), dir=path.join(hlsRoot,id);
    fs.mkdirSync(dir,{recursive:true});
    const playlist=path.join(dir,"index.m3u8");
    const args=["-hide_banner","-loglevel","warning","-user_agent","VLC/3.0.20 MetaPlay/4.2","-i",finalUrl,
      "-map","0:v:0?","-map","0:a:0?","-c:v","copy","-c:a","aac","-ar","48000","-ac","2","-b:a","128k",
      "-f","hls","-hls_time","2","-hls_list_size","6","-hls_flags","delete_segments+append_list+omit_endlist+independent_segments",
      "-hls_segment_filename",path.join(dir,"seg%06d.ts"),playlist];
    let spawnError=null;
    const proc=spawn(ffmpegBin,args,{stdio:["ignore","ignore","pipe"]});
    proc.on("error",e=>{spawnError=e});
    let stderr=""; proc.stderr&&proc.stderr.on("data",b=>{stderr=(stderr+b.toString()).slice(-5000)});
    hlsSessions.set(id,{proc,dir,touched:Date.now(),stderr});
    proc.on("exit",()=>{const x=hlsSessions.get(id);if(x)x.stderr=stderr});
    const deadline=Date.now()+15000;
    while(Date.now()<deadline){
      if(spawnError)break;
      if(fs.existsSync(playlist) && fs.statSync(playlist).size>30){
        hlsSessions.get(id).touched=Date.now();
        return res.json({ok:true,playlist:`/hls/${id}/index.m3u8`,source:raw,finalUrl});
      }
      if(proc.exitCode!==null)break;
      await new Promise(r=>setTimeout(r,250));
    }
    cleanupHls(id);
    if(spawnError)return res.status(502).json({ok:false,error:"O FFmpeg integrado não foi encontrado. Execute npm install novamente dentro da pasta do Meta Play.",detail:spawnError.message});
    return res.status(502).json({ok:false,error:"FFmpeg não conseguiu gerar HLS.",detail:stderr.slice(-1200)});
  }catch(e){return res.status(502).json({ok:false,error:e.message,source:raw})}
});

app.get("/hls/:id/:file",(req,res)=>{
  const id=String(req.params.id||""), file=String(req.params.file||"");
  if(!/^[a-f0-9]{24}$/.test(id)||!/^[-a-zA-Z0-9_.]+$/.test(file))return res.sendStatus(400);
  const s=hlsSessions.get(id);if(!s)return res.sendStatus(404);s.touched=Date.now();
  const f=path.join(s.dir,file);if(!fs.existsSync(f))return res.sendStatus(404);
  res.setHeader("Cache-Control","no-store");res.setHeader("Access-Control-Allow-Origin","*");
  res.type(file.endsWith(".m3u8")?"application/vnd.apple.mpegurl":"video/mp2t");
  res.sendFile(f);
});

app.post("/api/diagnose-stream",async(req,res)=>{
  try{
    const {url}=req.body||{};
    if(!url)return res.status(400).json({ok:false,error:"URL ausente."});
    res.json(await probeStream(url));
  }catch(e){res.json({ok:false,error:e.message})}
});

/*
  V3.12 relay:
  - follows 301/302/303/307/308
  - resolves relative Location headers
  - pipes final live response directly to browser
  - preserves Range and useful response headers
*/

// Logo proxy: many IPTV panels expose logos over HTTP or block browser hotlinking.
// The browser requests the image from Meta Play, while the server fetches the
// provider image and follows redirects. This also avoids mixed-content/CORS issues.
const logoCache=new Map();
app.get("/image",async(req,res)=>{
  const raw=String(req.query.url||"");
  if(!raw)return res.status(400).send("URL ausente.");
  let u; try{u=new URL(raw)}catch{return res.status(400).send("URL inválida.")}
  if(!/^https?:$/.test(u.protocol))return res.status(400).send("Protocolo inválido.");
  const key=u.toString();
  const cached=logoCache.get(key);
  if(cached && cached.expires>Date.now()){
    res.statusCode=200;
    res.setHeader("Content-Type",cached.type);
    res.setHeader("Cache-Control","public,max-age=86400");
    return res.end(cached.body);
  }
  try{
    const r=await fetch(key,{redirect:"follow",headers:{
      "User-Agent":"Mozilla/5.0 (Meta Play/3.16)",
      "Accept":"image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
    }});
    if(!r.ok)return res.status(r.status).send("Falha ao carregar logo.");
    const type=r.headers.get("content-type")||"image/png";
    if(!/^image\//i.test(type))return res.status(415).send("O endereço não retornou uma imagem.");
    const body=Buffer.from(await r.arrayBuffer());
    if(body.length===0)return res.status(404).send("Logo vazia.");
    logoCache.set(key,{body,type,expires:Date.now()+86400000});
    // Keep cache bounded.
    if(logoCache.size>500){const first=logoCache.keys().next().value;logoCache.delete(first)}
    res.statusCode=200;
    res.setHeader("Content-Type",type);
    res.setHeader("Cache-Control","public,max-age=86400");
    res.setHeader("Access-Control-Allow-Origin","*");
    res.end(body);
  }catch(e){res.status(502).send("Não foi possível carregar a logo.")}
});

app.get("/stream",async(req,res)=>{
  const raw=String(req.query.url||"");
  if(!raw)return res.status(400).send("URL ausente.");

  try{
    new URL(raw);
  }catch(e){return res.status(400).send("URL inválida: "+e.message)}

  try{
    const headers={
      "User-Agent":"VLC/3.0.20 MetaPlay/3.16",
      "Accept":"*/*",
      "Connection":"keep-alive"
    };
    if(req.headers.range)headers.Range=req.headers.range;

    const {res:upstream,finalUrl,redirects}=await requestFollowingRedirects(raw,{headers});
    res.statusCode=upstream.statusCode||502;

    const map=[
      ["content-type",upstream.headers["content-type"]],
      ["content-length",upstream.headers["content-length"]],
      ["content-range",upstream.headers["content-range"]],
      ["accept-ranges",upstream.headers["accept-ranges"]||"bytes"],
      ["cache-control","no-store, no-cache, must-revalidate"],
      ["pragma","no-cache"],
      ["access-control-allow-origin","*"],
      ["x-meta-play-final-url",finalUrl],
      ["x-meta-play-redirects",String(redirects)]
    ];
    for(const [k,v] of map)if(v!==undefined)res.setHeader(k,v);

    if(upstream.statusCode>=400){
      let body="",n=0;
      upstream.on("data",b=>{if(n<4096){body+=b.toString();n+=b.length}});
      upstream.on("end",()=>res.end(body));
      return;
    }

    const close=()=>{try{upstream.destroy()}catch{}};
    res.on("close",close);
    upstream.on("error",e=>{console.error("[UPSTREAM]",e.message);if(!res.writableEnded)res.end()});
    upstream.pipe(res);
  }catch(e){
    console.error("[RELAY]",e.message);
    if(!res.headersSent)res.status(502).send("Falha no stream: "+e.message);
    else res.end();
  }
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`Meta Play V4.1 rodando em http://localhost:${PORT}`));
