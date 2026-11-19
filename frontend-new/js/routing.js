// Pedestrian routing for the festival. Not certified navigation.
// Graph = mapped roads/paths from the OSM export (exact geometry) + a coarse "open field" lattice
// that is more expensive to walk on. Routes therefore follow paths and only cut across fields for
// short access legs or when the detour on paths would be much longer.
// Mapped water is impassable; the railway can only be crossed where a mapped road/path crosses it.
// Fences, stages and temporary barriers are unknown.
import { CONFIG } from './config.js?v=5.6';
const R=6371000,latRef=CONFIG.FESTIVAL_CENTER[0]*Math.PI/180;
const meterX=R*Math.cos(latRef)*Math.PI/180,meterY=R*Math.PI/180;
function xy(lat,lon){return [(lon-CONFIG.FESTIVAL_CENTER[1])*meterX,(lat-CONFIG.FESTIVAL_CENTER[0])*meterY]}
function ll(x,y){return [CONFIG.FESTIVAL_CENTER[0]+y/meterY,CONFIG.FESTIVAL_CENTER[1]+x/meterX]}
export function meters(a,b){const x=xy(a[0],a[1]),y=xy(b[0],b[1]);return Math.hypot(x[0]-y[0],x[1]-y[1])}
const WALK_SPEED=1.2;           // m/s, crowded festival walking pace
const LATTICE=20;               // m, spacing of the open-field lattice
const OFFROAD=CONFIG.OFFROAD_FACTOR||2.2; // walking 1 m across a field "costs" this many metres of path
const ROAD_FACTOR={primary:1.4,secondary:1.1,tertiary:1.05};

function withinPolygon(pt,v){let inside=false;for(let i=0,j=v.length-1;i<v.length;j=i++){const a=v[i],b=v[j];if(((a[1]>pt[1])!==(b[1]>pt[1]))&&(pt[0]<(b[0]-a[0])*(pt[1]-a[1])/(b[1]-a[1])+a[0]))inside=!inside}return inside}
function segIntersect(p,p2,q,q2){const r0=p2[0]-p[0],r1=p2[1]-p[1],s0=q2[0]-q[0],s1=q2[1]-q[1],d=r0*s1-r1*s0;if(Math.abs(d)<1e-9)return false;const t=((q[0]-p[0])*s1-(q[1]-p[1])*s0)/d,u=((q[0]-p[0])*r1-(q[1]-p[1])*r0)/d;return t>=0&&t<=1&&u>=0&&u<=1}
class Heap{constructor(){this.a=[]}push(item){let a=this.a,i=a.length;a.push(item);while(i){let p=(i-1)>>1;if(a[p][0]<=item[0])break;a[i]=a[p];i=p}a[i]=item}pop(){let a=this.a,top=a[0],last=a.pop();if(a.length){let i=0;while(true){let l=i*2+1,r=l+1;if(l>=a.length)break;let c=r<a.length&&a[r][0]<a[l][0]?r:l;if(a[c][0]>=last[0])break;a[i]=a[c];i=c}a[i]=last}return top}get size(){return this.a.length}}

// ---------- Graph (built once per geography) ----------
let graphCache=null;
function buildGraph(geo){
 if(graphCache&&graphCache.geo===geo)return graphCache;
 const b=CONFIG.FESTIVAL_BOUNDS,[x0,y0]=xy(b[0][0],b[0][1]),[x1,y1]=xy(b[1][0],b[1][1]);
 const inside=(x,y)=>x>=x0&&x<=x1&&y>=y0&&y<=y1;
 const X=[],Y=[],road=[],adj=[];
 const addNode=(x,y,isRoad)=>{X.push(x);Y.push(y);road.push(isRoad);adj.push([]);return X.length-1};
 const addEdge=(a,c,factor)=>{const len=Math.hypot(X[a]-X[c],Y[a]-Y[c]);adj[a].push(c,len*factor);adj[c].push(a,len*factor)};

 const water=geo.features.filter(f=>f.properties.kind==='water'&&f.geometry.type==='Polygon').map(f=>{const rings=f.geometry.coordinates.map(r=>r.map(p=>xy(p[1],p[0])));let bx0=Infinity,by0=Infinity,bx1=-Infinity,by1=-Infinity;for(const [x,y] of rings[0]){bx0=Math.min(bx0,x);bx1=Math.max(bx1,x);by0=Math.min(by0,y);by1=Math.max(by1,y)}return {rings,bx0,by0,bx1,by1}});
 const inWater=(x,y)=>water.some(w=>x>=w.bx0&&x<=w.bx1&&y>=w.by0&&y<=w.by1&&withinPolygon([x,y],w.rings[0])&&!w.rings.slice(1).some(h=>withinPolygon([x,y],h)));
 const railSegs=[];for(const f of geo.features)if(f.properties.kind==='rail'&&f.geometry.type==='LineString'){const c=f.geometry.coordinates.map(p=>xy(p[1],p[0]));for(let i=1;i<c.length;i++)railSegs.push([c[i-1],c[i]])}
 const crossesRail=(ax,ay,bx,by)=>railSegs.some(([p,q])=>segIntersect([ax,ay],[bx,by],p,q));
 // A straight walk across open ground: no rail crossing, no water along the way.
 const openWalk=(ax,ay,bx,by)=>{if(crossesRail(ax,ay,bx,by))return false;const n=Math.max(1,Math.ceil(Math.hypot(bx-ax,by-ay)/8));for(let k=1;k<n;k++){if(inWater(ax+(bx-ax)*k/n,ay+(by-ay)*k/n))return false}return true};

 // 1) Roads and paths with their exact geometry. Shared OSM vertices join the network.
 const vkey=new Map();
 const roadNode=(x,y)=>{const k=Math.round(x*2)+','+Math.round(y*2);let id=vkey.get(k);if(id===undefined){id=addNode(x,y,true);vkey.set(k,id)}return id};
 for(const f of geo.features){if(f.properties.kind!=='road'||f.geometry.type!=='LineString')continue;
  const factor=ROAD_FACTOR[f.properties.roadType]||1;const c=f.geometry.coordinates.map(p=>xy(p[1],p[0]));
  for(let i=1;i<c.length;i++){const [ax,ay]=c[i-1],[bx,by]=c[i];if(!inside(ax,ay)&&!inside(bx,by))continue;
   const n=Math.max(1,Math.ceil(Math.hypot(bx-ax,by-ay)/20));let prev=roadNode(ax,ay);
   for(let k=1;k<=n;k++){const cur=roadNode(ax+(bx-ax)*k/n,ay+(by-ay)*k/n);if(cur!==prev)addEdge(prev,cur,factor);prev=cur}}
 }
 const roadCount=X.length;
 // 2) Open-field lattice.
 const cols=Math.floor((x1-x0)/LATTICE)+1,rows=Math.floor((y1-y0)/LATTICE)+1,lat=new Int32Array(cols*rows).fill(-1);
 for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){const x=x0+i*LATTICE,y=y0+j*LATTICE;if(!inWater(x,y))lat[j*cols+i]=addNode(x,y,false)}
 for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){const a=lat[j*cols+i];if(a<0)continue;
  for(const [di,dj] of [[1,0],[0,1],[1,1],[1,-1]]){const ni=i+di,nj=j+dj;if(ni<0||nj<0||ni>=cols||nj>=rows)continue;const c=lat[nj*cols+ni];if(c<0)continue;
   if(!crossesRail(X[a],Y[a],X[c],Y[c])&&!inWater((X[a]+X[c])/2,(Y[a]+Y[c])/2))addEdge(a,c,OFFROAD)}}
 // 3) Connect every road vertex to the surrounding lattice points (stepping off the path).
 const latticeNear=(x,y,r)=>{const out=[],i0=Math.floor((x-r-x0)/LATTICE),i1=Math.ceil((x+r-x0)/LATTICE),j0=Math.floor((y-r-y0)/LATTICE),j1=Math.ceil((y+r-y0)/LATTICE);
  for(let j=Math.max(0,j0);j<=Math.min(rows-1,j1);j++)for(let i=Math.max(0,i0);i<=Math.min(cols-1,i1);i++){const id=lat[j*cols+i];if(id>=0&&Math.hypot(X[id]-x,Y[id]-y)<=r)out.push(id)}return out};
 for(let r=0;r<roadCount;r++)for(const id of latticeNear(X[r],Y[r],LATTICE*1.05))if(openWalk(X[r],Y[r],X[id],Y[id]))addEdge(r,id,OFFROAD);
 // Spatial hash of road vertices for snapping start/end.
 const bucket=new Map(),B=40;for(let r=0;r<roadCount;r++){const k=Math.floor(X[r]/B)+','+Math.floor(Y[r]/B);(bucket.get(k)||bucket.set(k,[]).get(k)).push(r)}
 const roadNear=(x,y,rad)=>{const out=[];const bi=Math.floor(x/B),bj=Math.floor(y/B),s=Math.ceil(rad/B);for(let dj=-s;dj<=s;dj++)for(let di=-s;di<=s;di++){for(const r of bucket.get((bi+di)+','+(bj+dj))||[])if(Math.hypot(X[r]-x,Y[r]-y)<=rad)out.push(r)}return out};
 graphCache={geo,X,Y,road,adj,inside,openWalk,inWater,latticeNear,roadNear,size:X.length,roadCount};
 return graphCache;
}

// ---------- Noise model ----------
const SIGMA=110; // m, how far a sensor's reading is assumed to spread
function makeNoiseField(devices,limit){
 const pts=devices.map(d=>{const p=xy(Number(d.latitude),Number(d.longitude));return {x:p[0],y:p[1],db:Number(d.noise_avg)}});
 return {
  penalty(x,y){let p=0;for(const s of pts){const d2=(s.x-x)**2+(s.y-y)**2;if(d2>(3*SIGMA)**2)continue;const w=Math.exp(-.5*d2/SIGMA**2);
   const loud=Math.max(0,Math.min(1.3,(s.db-55)/35))**2,over=Math.max(0,Math.min(2,(s.db-limit)/15));p+=w*(loud+over)}return Math.min(p,4)},
  estimate(x,y){let ws=0,v=0;for(const s of pts){const d2=(s.x-x)**2+(s.y-y)**2;const w=Math.exp(-.5*d2/SIGMA**2);ws+=w;v+=w*s.db}const base=55;return ws<.05?base:(v+base*.05)/(ws+.05)}
 };
}

export function computeRoute(start,end,mode,devices,threshold,geography){
 if(!geography)throw Error('Map geography is still loading…');
 if(!Number.isFinite(start[0])||!Number.isFinite(end[0]))throw Error('Invalid GPS coordinates');
 const G=buildGraph(geography),{X,Y,adj}=G;
 const [sx,sy]=xy(start[0],start[1]),[ex,ey]=xy(end[0],end[1]);
 if(!G.inside(sx,sy)||!G.inside(ex,ey))throw Error('Start or destination is outside the mapped festival area.');
 // Temporary start/end nodes linked to nearby paths and field points.
 const S=G.size,E=G.size+1,extra=[[],[]];
 const link=(x,y,slot)=>{for(const rad of [35,80,160]){const cand=[...G.roadNear(x,y,rad),...G.latticeNear(x,y,Math.min(rad,30))];let n=0;
   for(const id of cand){if(G.openWalk(x,y,X[id],Y[id])){extra[slot].push(id,Math.hypot(X[id]-x,Y[id]-y)*OFFROAD);n++}}if(n)return}
  throw Error(slot?'The destination cannot be reached on foot.':'Your position cannot be reached on foot.')};
 link(sx,sy,0);link(ex,ey,1);
 const px=i=>i===S?sx:i===E?ex:X[i],py=i=>i===S?sy:i===E?ey:Y[i];
 const field=makeNoiseField(devices,threshold),W=mode==='quieter'?6:0;
 const total=G.size+2,pen=new Float32Array(total).fill(-1);
 const penaltyAt=i=>{if(pen[i]<0)pen[i]=field.penalty(px(i),py(i));return pen[i]};
 const g=new Float64Array(total).fill(Infinity),parent=new Int32Array(total).fill(-1),done=new Uint8Array(total);
 // Edges into E come from the end's link list.
 const toEnd=new Map();for(let k=0;k<extra[1].length;k+=2)toEnd.set(extra[1][k],extra[1][k+1]);
 g[S]=0;const heap=new Heap();heap.push([0,S]);let found=false;
 const relax=(cur,nb,base)=>{const cost=g[cur]+base*(W?1+W*(penaltyAt(cur)+penaltyAt(nb))/2:1);if(cost<g[nb]){g[nb]=cost;parent[nb]=cur;heap.push([cost+Math.hypot(px(nb)-ex,py(nb)-ey),nb])}};
 while(heap.size){const [,cur]=heap.pop();if(done[cur])continue;done[cur]=1;if(cur===E){found=true;break}
  const list=cur===S?extra[0]:adj[cur];
  for(let k=0;k<list.length;k+=2){const nb=list[k];if(!done[nb])relax(cur,nb,list[k+1])}
  if(toEnd.has(cur)&&!done[E])relax(cur,E,toEnd.get(cur));
 }
 if(!found)throw Error('No walkable route found inside the mapped area.');
 const chain=[];for(let c=E;c!==-1;c=parent[c])chain.push(c);chain.reverse();

 // Straighten zig-zags across open fields (never alters mapped path geometry).
 const offroad=i=>i===S||i===E||!G.road[i];
 const lineCost=(a,b)=>{const ax=px(a),ay=py(a),bx=px(b),by=py(b);if(!G.openWalk(ax,ay,bx,by))return Infinity;const len=Math.hypot(bx-ax,by-ay);if(!W)return len*OFFROAD;
  const n=Math.max(1,Math.ceil(len/15));let s=0;for(let k=0;k<=n;k++)s+=field.penalty(ax+(bx-ax)*k/n,ay+(by-ay)*k/n);return len*OFFROAD*(1+W*s/(n+1))};
 const kept=[chain[0]];let a=0;
 while(a<chain.length-1){let best=a+1;
  if(offroad(chain[a])||offroad(chain[a+1])){for(let b=Math.min(chain.length-1,a+60);b>a+1;b--){let ok=true;for(let m=a+1;m<b;m++)if(!offroad(chain[m])){ok=false;break}
    if(ok&&lineCost(chain[a],chain[b])<=(g[chain[b]]-g[chain[a]])*1.02+1){best=b;break}}}
  kept.push(chain[best]);a=best}
 const pts=kept.map(i=>i===S?[start[0],start[1]]:i===E?[end[0],end[1]]:ll(X[i],Y[i]));

 let distance=0,noiseSum=0,noiseLen=0,noisePeak=0,onPath=0;
 for(let k=1;k<pts.length;k++){const len=meters(pts[k-1],pts[k]);distance+=len;if(!offroad(kept[k-1])&&!offroad(kept[k]))onPath+=len;
  const n=Math.max(1,Math.ceil(len/15));for(let t=0;t<n;t++){const p=xy(pts[k-1][0]+(pts[k][0]-pts[k-1][0])*(t+.5)/n,pts[k-1][1]+(pts[k][1]-pts[k-1][1])*(t+.5)/n);const db=field.estimate(p[0],p[1]);noiseSum+=db*len/n;noiseLen+=len/n;noisePeak=Math.max(noisePeak,db)}}
 return {points:pts,distance,minutes:Math.max(1,Math.round(distance/WALK_SPEED/60)),noiseAvg:noiseLen?noiseSum/noiseLen:null,noisePeak,onPathShare:distance?onPath/distance:0,estimated:true,mode};
}

// Where the user is on the route: distance off the line, distance left, and the compass bearing
// (degrees, 0 = north) of the route a little ahead — used to rotate the map while navigating.
export function routeProgress(points,pos,lookahead=30){
 const P=points.map(p=>xy(p[0],p[1])),[ux,uy]=xy(pos[0],pos[1]);
 let best=Infinity,bi=0,bt=0;
 for(let i=1;i<P.length;i++){const [ax,ay]=P[i-1],[bx,by]=P[i],dx=bx-ax,dy=by-ay,l2=dx*dx+dy*dy||1;let t=((ux-ax)*dx+(uy-ay)*dy)/l2;t=Math.max(0,Math.min(1,t));const d=Math.hypot(ax+dx*t-ux,ay+dy*t-uy);if(d<best){best=d;bi=i;bt=t}}
 const seg=i=>Math.hypot(P[i][0]-P[i-1][0],P[i][1]-P[i-1][1]);
 let remaining=seg(bi)*(1-bt);for(let i=bi+1;i<P.length;i++)remaining+=seg(i);
 // Point `lookahead` metres further along the route.
 let need=lookahead,i=bi,t=bt,tx=P[P.length-1][0],ty=P[P.length-1][1];
 while(i<P.length){const l=seg(i)*(1-t);if(l>=need){const f=t+need/(seg(i)||1);tx=P[i-1][0]+(P[i][0]-P[i-1][0])*f;ty=P[i-1][1]+(P[i][1]-P[i-1][1])*f;break}need-=l;i++;t=0}
 const [qx,qy]=[P[bi-1][0]+(P[bi][0]-P[bi-1][0])*bt,P[bi-1][1]+(P[bi][1]-P[bi-1][1])*bt];
 let dx=tx-qx,dy=ty-qy;if(Math.hypot(dx,dy)<1){dx=P[bi][0]-P[bi-1][0];dy=P[bi][1]-P[bi-1][1]}
 const bearing=(Math.atan2(dx,dy)*180/Math.PI+360)%360;
 return {offRoute:best,remaining,bearing};
}
