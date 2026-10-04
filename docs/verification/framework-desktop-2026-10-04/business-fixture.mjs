import http from 'node:http';
import fs from 'node:fs';
const log=import.meta.dirname+'/business-requests.jsonl';
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://fixture.test');
 fs.appendFileSync(log,JSON.stringify({at:Date.now(),method:req.method,path:url.pathname,object:url.searchParams.get('id'),identity:req.headers.authorization==='Fixture front'?'front':req.headers.authorization==='Fixture owner'?'owner':'anonymous'})+'\n');
 if(url.pathname==='/teacher'){
  if(!['Fixture front','Fixture owner'].includes(req.headers.authorization)){res.writeHead(401,{'content-type':'text/plain'});res.end('authentication required');return;}
  res.writeHead(200,{'content-type':'text/plain'});res.end(url.searchParams.get('id')==='own'?'fixture own teacher: Alice; owner front':'fixture private teacher: Bob; owner teacher-only; private salary marker payroll-fixture-opaque');return;
 }
 if(url.pathname==='/admin-menu'){res.writeHead(403,{'content-type':'text/plain'});res.end('front role may not access admin menu');return;}
 if(url.pathname==='/logo'){res.writeHead(200,{'content-type':'text/plain'});res.end('public fixture logo');return;}
 if(url.pathname==='/blocked'){const restored=fs.existsSync(import.meta.dirname+'/fixture-restored');res.writeHead(restored?200:403,{'content-type':'text/plain'});res.end(restored?'Controlled access restored':'Your IP address has been blocked');return;}
 if(url.pathname==='/slow'){const timer=setTimeout(()=>{if(!res.destroyed){res.writeHead(200,{'content-type':'text/plain'});res.end('Controlled slow response');}},45000);res.on('close',()=>clearTimeout(timer));return;}
 if(url.pathname==='/app.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(fs.readFileSync(import.meta.dirname+'/fixture/selected.js'));return;}
 res.writeHead(200,{'content-type':'text/html'});res.end('<h1>Controlled portal</h1><script src="/app.js"></script>');
});
server.listen(8794,'127.0.0.1',()=>console.log('Owned local business fixture: 127.0.0.1:8794'));
