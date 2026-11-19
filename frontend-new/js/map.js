// MapLibre map: vector basemap from the OSM extract, sound "blobs", labels, user position, route.
import { CONFIG } from './config.js?v=5.6';
const V='5.6';
const ll2=([lat,lon])=>[lon,lat];
const MPP=78271.517*Math.cos(CONFIG.FESTIVAL_CENTER[0]*Math.PI/180); // metres per pixel at zoom 0
// Circle radius given in metres (feature property or number), correct at every zoom level.
const metresToPx=r=>['interpolate',['exponential',2],['zoom'],10,['*',r,1024/MPP],22,['*',r,4194304/MPP]];
// Road widths in pixels at zoom 16, doubled for every zoom step.
const roadWidth=['match',['get','roadType'],'primary',5,'secondary',4.5,'tertiary',4,'residential',3,'unclassified',3,'living_street',3,'service',2.5,2];
const roadW=k=>['interpolate',['exponential',2],['zoom'],13,['*',roadWidth,k/8],16,['*',roadWidth,k],20,['*',roadWidth,k*16]];

const empty={type:'FeatureCollection',features:[]};
const [[s,w],[n,e]]=CONFIG.MAP_BOUNDS;
export const map=new maplibregl.Map({
 container:'map',
 style:{version:8,sources:{
   festival:{type:'geojson',data:empty},
   nodes:{type:'geojson',data:empty},
   route:{type:'geojson',data:empty},
   accuracy:{type:'geojson',data:empty}},
  layers:[
   {id:'bg',type:'background',paint:{'background-color':'#edf3e9'}},
   {id:'green',type:'fill',source:'festival',filter:['==',['get','kind'],'green'],paint:{'fill-color':'#d7e9d2'}},
   {id:'water',type:'fill',source:'festival',filter:['==',['get','kind'],'water'],paint:{'fill-color':'#b9dcea','fill-outline-color':'#a9d0e0'}},
   {id:'rail',type:'line',source:'festival',filter:['==',['get','kind'],'rail'],paint:{'line-color':'#a9b0a8','line-width':['interpolate',['linear'],['zoom'],14,1,18,3],'line-dasharray':[2,3]}},
   {id:'road-case',type:'line',source:'festival',filter:['==',['get','kind'],'road'],layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#dfe6da','line-width':roadW(1.35)}},
   {id:'road',type:'line',source:'festival',filter:['==',['get','kind'],'road'],layout:{'line-cap':'round','line-join':'round'},
    paint:{'line-color':['match',['get','roadType'],'primary','#efcfb3','secondary','#f4e0c8','tertiary','#f6e9d7','residential','#fdf9ee','#fffefd'],'line-width':roadW(1)}},
   // Sound blobs: a wide soft halo and a stronger core, both fading to transparent.
   {id:'blob-halo',type:'circle',source:'nodes',paint:{'circle-radius':metresToPx(['get','r']),'circle-color':['get','color'],'circle-blur':1,'circle-opacity':['interpolate',['linear'],['zoom'],15,['case',['get','fresh'],.6,.3],18,['case',['get','fresh'],.32,.18]],'circle-pitch-alignment':'map'}},
   {id:'blob-core',type:'circle',source:'nodes',paint:{'circle-radius':metresToPx(['*',['get','r'],.42]),'circle-color':['get','color'],'circle-blur':.9,'circle-opacity':['interpolate',['linear'],['zoom'],15,['case',['get','fresh'],.55,.25],18,['case',['get','fresh'],.35,.15]],'circle-pitch-alignment':'map'}},
   {id:'route-case',type:'line',source:'route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#ffffff','line-width':['interpolate',['linear'],['zoom'],14,6,18,13]}},
   {id:'route',type:'line',source:'route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':['get','color'],'line-width':['interpolate',['linear'],['zoom'],14,3.5,18,8]}},
   {id:'accuracy',type:'fill',source:'accuracy',paint:{'fill-color':'#2e86ff','fill-opacity':.12,'fill-outline-color':'#2e86ff'}}
  ]},
 bounds:[[CONFIG.HOME_BOUNDS[0][1],CONFIG.HOME_BOUNDS[0][0]],[CONFIG.HOME_BOUNDS[1][1],CONFIG.HOME_BOUNDS[1][0]]],
 // The camera can never leave the drawn area, so no empty background ever shows.
 maxBounds:[[w,s],[e,n]],
 maxZoom:18.5,attributionControl:false,dragRotate:false,pitchWithRotate:false,fadeDuration:0
});
map.touchZoomRotate.disableRotation();map.keyboard.disableRotation();
const ready=new Promise(res=>map.once('load',res));

// Safety net: without maplibre-gl.css markers are misplaced.
{const t=document.createElement('div');t.className='maplibregl-marker';document.body.appendChild(t);
 if(getComputedStyle(t).position!=='absolute'){console.error('MapLibre CSS is not loaded: check vendor/maplibre/maplibre-gl.css');document.body.insertAdjacentHTML('beforeend','<div style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#c8504b;color:#fff;padding:10px;font:600 13px system-ui;text-align:center">Map styles failed to load. Reload the page.</div>')}
 t.remove()}

// ---------- Geography ----------
let geography=null;
const geoPromise=fetch(new URL(`../data/festival.geojson?v=${V}`,import.meta.url)).then(r=>{if(!r.ok)throw new Error('Unable to load festival geography');return r.json()});
geoPromise.then(async g=>{geography=g;await ready;map.getSource('festival').setData(g)}).catch(err=>console.error(err));
export async function loadGeography(){return geography||geoPromise}
export function getGeography(){return geography;}

// Camera padding: keep things visible between the top controls and whichever bottom panel is open.
function padding(){
 const routing=document.body.classList.contains('routing');
 const top=routing?70:(document.querySelector('.top-controls')?.getBoundingClientRect().bottom||120)+8;
 const panel=[...document.querySelectorAll('.sheet.visible,.route-panel.visible')][0];
 const wide=innerWidth>=700;
 const bottom=panel&&!wide?panel.getBoundingClientRect().height+16:100;
 const right=panel&&wide?panel.getBoundingClientRect().width+40:30;
 return {top,bottom,left:30,right};
}
function homeBounds(){const [[a,b],[c,d]]=CONFIG.HOME_BOUNDS;return [[b,a],[d,c]]}
// MapLibre adds the camera padding to fitBounds' own padding, so set the camera padding first.
function fitView(bounds,opts={}){map.setPadding(padding());map.fitBounds(bounds,{padding:8,...opts})}
export function resetView(){fitView(homeBounds(),{bearing:0,duration:600})}
ready.then(()=>fitView(homeBounds(),{duration:0}));

// ---------- Sensor nodes ----------
let selectedId=null;let onSelect=()=>{};
export function onMarkerSelect(fn){onSelect=fn;}
export function markerAvailability(device){return device.status==='online' && Number.isFinite(device.noise_avg);}
export function isUsable(device,serverTime){if(!markerAvailability(device))return false; if(!device.last_updated)return false; const age=Date.parse(serverTime)-Date.parse(device.last_updated);return Number.isFinite(age)&&age>=-60000&&age<=15*60000;}
export function category(d,threshold,fresh){if(!fresh)return 'unavailable';if(d.noise_clipped)return 'high';if(d.noise_avg>threshold+10)return 'high';if(d.noise_avg>threshold)return 'near';return 'low'}
const COLORS={low:'#16a07f',near:'#f0a020',high:'#e2453c',unavailable:'#8f9a96'};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels=new Map();
function syncLabels(){map.getContainer().classList.toggle('show-labels',map.getZoom()>=CONFIG.LABEL_ZOOM)}
map.on('zoom',syncLabels);syncLabels();
let lastNodes=null;
export function renderMarkers(devices,threshold,serverTime){
 const features=[],ids=new Set();
 for(const d of devices){const lat=Number(d.latitude),lon=Number(d.longitude);if(!Number.isFinite(lat)||!Number.isFinite(lon))continue;
  const id=String(d.id),fresh=isUsable(d,serverTime),cat=category(d,threshold,fresh);ids.add(id);
  // Louder places get a bigger blob: ~70 m at 50 dB up to ~190 m at 100 dB.
  const r=fresh?Math.max(55,Math.min(160,60+(Number(d.noise_avg)-50)*2)):40;
  features.push({type:'Feature',geometry:{type:'Point',coordinates:[lon,lat]},properties:{id,color:COLORS[cat],r,fresh}});
  const val=fresh?(d.noise_clipped?'127+':Math.round(d.noise_avg)):'–';
  const html=`<span class="lbl-db">${val}${fresh?'<small>dB</small>':''}${d.source==='simulated'?'<span class="lbl-sim">SIM</span>':''}</span><span class="lbl-name">${esc(d.name||id)}</span>`;
  let m=labels.get(id);
  if(!m){const el=document.createElement('button');el.type='button';el.className='node-label';el.setAttribute('aria-label',d.name||id);el.addEventListener('click',ev=>{ev.stopPropagation();onSelect(id)});
   m=new maplibregl.Marker({element:el,anchor:'center'}).setLngLat([lon,lat]).addTo(map);el.setAttribute('aria-label',d.name||id);labels.set(id,m)}
  else m.setLngLat([lon,lat]);
  const el=m.getElement();if(el._html!==html){el.innerHTML=html;el._html=html}
  for(const c of ['low','near','high','unavailable'])el.classList.toggle(c,c===cat);el.classList.toggle('selected',selectedId===id);
 }
 for(const [id,m] of labels)if(!ids.has(id)){m.remove();labels.delete(id)}
 lastNodes={type:'FeatureCollection',features};
 if(map.getSource('nodes'))map.getSource('nodes').setData(lastNodes);
 return labels.size;
}
ready.then(()=>{if(lastNodes)map.getSource('nodes').setData(lastNodes)});
// Tapping a blob (not only its label) also opens the place.
map.on('click','blob-core',e=>{const f=e.features&&e.features[0];if(f)onSelect(f.properties.id)});
map.on('mouseenter','blob-core',()=>map.getCanvas().style.cursor='pointer');map.on('mouseleave','blob-core',()=>map.getCanvas().style.cursor='');

export function selectMarker(id,device){
 selectedId=id;
 if(device)requestAnimationFrame(()=>map.easeTo({center:[Number(device.longitude),Number(device.latitude)],zoom:Math.max(map.getZoom(),CONFIG.LABEL_ZOOM),padding:padding(),duration:450}));
}
export function clearMarkerSelection(){selectedId=null;}

// ---------- User location ----------
let me=null,meDemo=null,onDemoMove=()=>{};
export function onDemoLocationMoved(fn){onDemoMove=fn;}
function circlePolygon(lat,lon,r){const pts=[];for(let k=0;k<=48;k++){const a=k/48*2*Math.PI;pts.push([lon+r*Math.sin(a)/(111320*Math.cos(lat*Math.PI/180)),lat+r*Math.cos(a)/110540])}return {type:'Feature',geometry:{type:'Polygon',coordinates:[pts]}}}
export function clearUserLocation(){if(me){me.remove();me=null}if(map.getSource('accuracy'))map.getSource('accuracy').setData(empty)}
export function showUserLocation(lat,lon,accuracy=20,isDemo=false){
 if(me&&meDemo!==isDemo)clearUserLocation();
 if(!me){
  const el=document.createElement('div');el.className='me'+(isDemo?' demo':'');
  el.innerHTML=`<div class="me-pulse"></div><div class="me-heading"></div><div class="me-dot"></div>${isDemo?'<div class="me-tag">DEMO</div>':''}`;
  me=new maplibregl.Marker({element:el,anchor:'center',draggable:isDemo}).setLngLat([lon,lat]).addTo(map);meDemo=isDemo;
  if(isDemo)me.on('dragend',()=>{const p=me.getLngLat();onDemoMove(p.lat,p.lng)});
 } else me.setLngLat([lon,lat]);
 const acc=isDemo?0:Math.min(accuracy||20,300);
 const set=()=>map.getSource('accuracy')&&map.getSource('accuracy').setData(acc>8?{type:'FeatureCollection',features:[circlePolygon(lat,lon,acc)]}:empty);
 if(map.getSource('accuracy'))set();else ready.then(set);
}
export function focusLocation(lat,lon){map.easeTo({center:[lon,lat],zoom:Math.max(map.getZoom(),15.3),padding:padding(),duration:500})}

// ---------- Navigation camera ----------
// Heading-up: the next stretch of the route always points to the top of the screen.
export function followLocation(lat,lon,bearing=null){
 const opts={center:[lon,lat],zoom:Math.max(map.getZoom(),16.3),padding:padding(),duration:600};
 if(bearing!==null)opts.bearing=bearing;
 map.easeTo(opts);
 const el=me&&me.getElement();if(el)el.classList.toggle('navigating',bearing!==null);
}
export function northUp(){map.easeTo({bearing:0,padding:padding(),duration:500});const el=me&&me.getElement();if(el)el.classList.remove('navigating')}
export function getBearing(){return map.getBearing()}
export function onRotate(fn){map.on('rotate',()=>fn(map.getBearing()))}

// ---------- Route ----------
export function drawRoute(latlngs,mode,fit=true){
 const data={type:'FeatureCollection',features:[{type:'Feature',properties:{color:mode==='quieter'?'#0f8a6c':'#2a73e0'},geometry:{type:'LineString',coordinates:latlngs.map(ll2)}}]};
 const apply=()=>{map.getSource('route').setData(data);
  if(fit){let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(const [la,lo] of latlngs){x0=Math.min(x0,lo);x1=Math.max(x1,lo);y0=Math.min(y0,la);y1=Math.max(y1,la)}
   fitView([[x0,y0],[x1,y1]],{maxZoom:16.8,bearing:0,duration:500})}};
 if(map.getSource('route'))apply();else ready.then(apply);
}
export function clearRoute(){if(map.getSource('route'))map.getSource('route').setData(empty)}
