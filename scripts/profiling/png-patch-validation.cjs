/* Serve recorded native frames to the production PNG canvas renderer. */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const directory=path.resolve(process.argv[2]||'artifacts/profile-png-production');
http.createServer(async(req,res)=>{
 if(req.url==='/result'&&req.method==='POST'){
  let body='';for await(const chunk of req)body+=chunk;
  fs.writeFileSync(path.join(directory,'browser-validation.json'),body);res.end('ok');return;
 }
 const file=req.url==='/'?path.join(__dirname,'png-patch-validation.html'):req.url==='/preview-png.js'?path.resolve(__dirname,'../../media/preview-png.js'):
  /^\/(?:frames\.json|reference\.png|\d+\.png)$/.test(req.url)?path.join(directory,req.url.slice(1)):undefined;
 if(!file||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
 res.setHeader('content-type',file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.json')?'application/json':'image/png');res.end(fs.readFileSync(file));
}).listen(9387,'127.0.0.1',()=>console.log('PNG patch validation http://127.0.0.1:9387'));
