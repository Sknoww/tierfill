// Crop MJ icon: trim white margin, center-square, apply rounded-corner alpha mask.
// Renders via headless Chrome canvas (data-URI to dodge tainted-canvas), outputs PNGs.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const HERE = process.cwd();
const RPCT = Number(process.argv[2] ?? 0.20);   // corner radius as fraction of size
const SIZES = [512, 128, 48, 16];

const dataUri = 'data:image/png;base64,' + readFileSync('src-icon.png').toString('base64');
const BT = Number(process.argv[3] ?? 140);   // brightness >= BT ...
const NT = Number(process.argv[4] ?? 42);    // ... AND neutral (max-min <= NT) => background

const html = (N, R) => `<!doctype html><meta charset="utf-8"><pre id="out">loading</pre><script>
const BT=${BT},NT=${NT};
const img=new Image();
img.onerror=()=>document.getElementById('out').textContent='ERR';
img.onload=()=>{
 // 1) full-res: key out light+neutral background (white + gray halo); gold is warm, survives
 const nc=document.createElement('canvas');nc.width=img.naturalWidth;nc.height=img.naturalHeight;
 const nx=nc.getContext('2d');nx.drawImage(img,0,0);
 const W=nc.width,H=nc.height,id=nx.getImageData(0,0,W,H),d=id.data;
 const isBg=(r,g,b)=>{const mx=Math.max(r,g,b),mn=Math.min(r,g,b);return (r+g+b)/3>=BT&&(mx-mn)<=NT;};
 for(let i=0;i<d.length;i+=4){if(isBg(d[i],d[i+1],d[i+2]))d[i+3]=0;}
 nx.putImageData(id,0,0);
 // bbox of remaining opaque content
 let minX=W,minY=H,maxX=0,maxY=0;
 for(let Y=0;Y<H;Y++)for(let X=0;X<W;X++){if(d[(Y*W+X)*4+3]>24){if(X<minX)minX=X;if(X>maxX)maxX=X;if(Y<minY)minY=Y;if(Y>maxY)maxY=Y;}}
 const bw=maxX-minX+1,bh=maxY-minY+1,side=Math.max(bw,bh);
 const cx=(minX+maxX)/2,cy=(minY+maxY)/2,sx=Math.round(cx-side/2),sy=Math.round(cy-side/2);
 // 2) downscale the alpha'd source into N (blends into transparency, no white fringe)
 const N=${N},R=${R};
 const oc=document.createElement('canvas');oc.width=N;oc.height=N;const ox=oc.getContext('2d');
 ox.imageSmoothingEnabled=true;ox.imageSmoothingQuality='high';
 ox.drawImage(nc,sx,sy,side,side,0,0,N,N);
 // 3) clean rounded-rect alpha mask
 ox.globalCompositeOperation='destination-in';
 ox.beginPath();ox.moveTo(R,0);ox.arcTo(N,0,N,N,R);ox.arcTo(N,N,0,N,R);ox.arcTo(0,N,0,0,R);ox.arcTo(0,0,N,0,R);ox.closePath();
 ox.fillStyle='#000';ox.fill();ox.globalCompositeOperation='source-over';
 document.getElementById('out').textContent=oc.toDataURL('image/png')+'|TRIM '+JSON.stringify({W,H,bw,bh,side,sx,sy});
};
img.src=${JSON.stringify(dataUri)};
</script>`;

for (const N of SIZES) {
  const R = Math.round(N * RPCT);
  writeFileSync('_work.html', html(N, R));
  const dump = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files',
    '--virtual-time-budget=10000', '--dump-dom', `${HERE}/_work.html`,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const m = dump.match(/<pre id="out">([\s\S]*?)<\/pre>/);
  const payload = m ? m[1] : '';
  if (!payload.startsWith('data:image/png;base64,')) {
    console.error(`size ${N}: FAILED ->`, payload.slice(0, 80)); continue;
  }
  const [durl, trim] = payload.split('|');
  const b64 = durl.replace(/^data:image\/png;base64,/, '');
  writeFileSync(`icon-${N}.png`, Buffer.from(b64, 'base64'));
  if (N === 512) console.log('trim/layout:', trim);
  console.log(`wrote icon-${N}.png`);
}
unlinkSync('_work.html');
