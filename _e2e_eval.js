
function dec(s){var bin=atob(s),o=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)o[i]=bin.charCodeAt(i);return o;}
function stat(){
  var svg=document.querySelector('#svgInner svg');
  if(!svg) return {err:'no-svg'};
  var s=new XMLSerializer().serializeToString(svg);
  var fills=[...(new Set((s.match(/fill="#([0-9a-fA-F]{6})"/g)||[]).map(f=>f.slice(7,-1))))];
  return {colors:fills.length, paths:(s.match(/<path[ >]/g)||[]).length, kb:(s.length/1024).toFixed(1)};
}
function load(name,b64){
  return new Promise(function(resolve,reject){
    try{
      var dt=new DataTransfer();
      dt.items.add(new File([dec(b64)],name,{type:'image/bmp'}));
      var fi=document.getElementById('fileInput');
      fi.files=dt.files;
      fi.dispatchEvent(new Event('change',{bubbles:true}));
      var t0=Date.now();
      var iv=setInterval(function(){
        var svg=document.querySelector('#svgInner svg');
        if(svg && Date.now()-t0>800){ clearInterval(iv); try{ resolve(stat()); }catch(e){reject(e);} }
        if(Date.now()-t0>20000){ clearInterval(iv); reject(new Error('convert timeout')); }
      },200);
    }catch(e){reject(e);}
  });
}
var out={};
try{ out.A=await load('A.bmp',window.__A_b64); }catch(e){ out.A={err:e.message}; }
try{ out.B=await load('B.bmp',window.__B_b64); }catch(e){ out.B={err:e.message}; }
try{
  var eps=window.__eps?window.__eps():'';
  out.eps={len:eps.length, moveto:(eps.match(/moveto/g)||[]).length, cmyk:(eps.match(/setcmykcolor/g)||[]).length, eof:eps.indexOf('%%EOF')>=0};
}catch(e){ out.eps={err:e.message}; }
out.qc=window.__qc||null;
return out;
