import { CONFIG } from './config.js?v=5.6';
import { icon, hydrateIcons } from './icons.js?v=5.6';
hydrateIcons();
import {fetchDevices} from './api.js?v=5.6';
import {map,loadGeography,getGeography,renderMarkers,onMarkerSelect,selectMarker,clearMarkerSelection,resetView,showUserLocation,clearUserLocation,drawRoute,clearRoute,isUsable,focusLocation,followLocation,onDemoLocationMoved,northUp,onRotate} from './map.js?v=5.6';
import {computeRoute,meters,routeProgress} from './routing.js?v=5.6';
const $=id=>document.getElementById(id);
let devices=[],serverTime=new Date().toISOString(),threshold=(()=>{try{return Number(localStorage.getItem('soundscape-noise-limit'))}catch{return 0}})()||CONFIG.DEFAULT_NOISE_LIMIT;
let selected=null,sheetExpanded=false,location=null,locationType=null,geoWatch=null,destination=null,routeMode='quieter',navigationActive=false,currentRoute=null,routeLastRerender=0;
function num(v,digits=1){return v===null||v===undefined||!Number.isFinite(Number(v))?'—':Number(v).toFixed(digits).replace(/\.0$/,'')}
function deviceById(id){return devices.find(x=>String(x.id)===String(id))}
function toast(message){const el=$('toast');el.textContent=message;el.classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('visible'),3600)}
function colorClass(d){if(!isUsable(d,serverTime))return 'unavailable';if(d.noise_clipped||d.noise_avg>threshold+10)return 'high';if(d.noise_avg>threshold)return 'near';return 'low'}
function showLimit(){const open=$('limitEditor').hidden;$('limitEditor').hidden=!open;$('limitToggle').setAttribute('aria-expanded',String(open));$('limitChevron').innerHTML=icon(open?'chevron-up':'chevron-down')}
$('limitToggle').addEventListener('click',showLimit);$('limitDone').addEventListener('click',()=>{if(!$('limitEditor').hidden)showLimit()});
function setLimit(v){threshold=Number(v);$('limitValue').textContent=`${threshold} dB`; $('noiseSlider').value=threshold;try{localStorage.setItem('soundscape-noise-limit',String(threshold))}catch{}refreshVisuals();if(destination){clearTimeout(setLimit.t);setLimit.t=setTimeout(()=>updateRoute(false),150)}}
$('noiseSlider').addEventListener('input',e=>setLimit(e.target.value));setLimit(Math.max(50,Math.min(100,threshold)));
function refreshVisuals(){renderMarkers(devices,threshold,serverTime);if(selected)updateSheet()}
// ---- Simulated nodes switch ----
let simOn=(()=>{try{const v=localStorage.getItem('soundscape-sim');return v===null?!!CONFIG.SIMULATED_ON_START:v==='1'}catch{return !!CONFIG.SIMULATED_ON_START}})();
if(!CONFIG.SIMULATED_BUTTON)simOn=!!CONFIG.SIMULATED_ON_START;
const hasTestPositions=Object.keys(CONFIG.TEST_POSITIONS||{}).length>0;
// The draggable demo position is offered while simulated nodes or test positions are on.
const demoAllowed=()=>simOn||hasTestPositions;
function syncSimButton(){const b=$('simBtn');b.hidden=!CONFIG.SIMULATED_BUTTON;b.setAttribute('aria-pressed',String(simOn));b.innerHTML=icon(simOn?'check':'plus')+' Simulated nodes'}
async function poll(){
 const response=await fetchDevices({simulated:simOn});
 devices=response.devices;serverTime=response.generated_at;
 renderMarkers(devices,threshold,serverTime);updateOutside();if(selected)updateSheet();
 const real=devices.filter(d=>d.source!=='simulated').length,sim=devices.length-real;
 const parts=[response.apiError?'Backend unreachable · retrying':`${real} real node${real===1?'':'s'}`];if(sim)parts.push(`${sim} simulated`);
 $('dataStatus').classList.toggle('error',!!response.apiError);
 $('dataStatus').innerHTML=`<span class="status-dot"></span><span>${parts.join(' · ')}</span>`;
 if(response.apiError)console.warn('Backend:',response.apiError);
 if(navigationActive&&destination&&Date.now()-routeLastRerender>12000){updateRoute(false);routeLastRerender=Date.now()}
}
// Nodes whose position is outside the festival map would be invisible: say so, with their id.
let outside=[];
function updateOutside(){
 const [[s,w],[n,e]]=CONFIG.MAP_BOUNDS;
 outside=devices.filter(d=>{const la=Number(d.latitude),lo=Number(d.longitude);return Number.isFinite(la)&&Number.isFinite(lo)&&(la<s||la>n||lo<w||lo>e)});
 const chip=$('outsideChip');chip.hidden=!outside.length;chip.innerHTML=icon('warning')+` ${outside.length} node${outside.length>1?'s':''} outside the map`;
}
$('outsideChip').addEventListener('click',()=>{if(!outside.length)return;
 alert('These nodes are outside the festival map, so they are not shown:\n\n'+outside.map(d=>`• ${d.name||d.id}\n  id: ${d.id}\n  position: ${Number(d.latitude).toFixed(5)}, ${Number(d.longitude).toFixed(5)}`).join('\n\n')+'\n\nFor tests, add the id to TEST_POSITIONS in js/config.js to show the node on the festival map.')});
function openSheet(id){const d=deviceById(id);if(!d)return;selected=id;closeRoute();selectMarker(id,d);refreshVisuals();$('deviceSheet').classList.add('visible');$('deviceSheet').setAttribute('aria-hidden','false');$('bottomTools').classList.add('hidden');setExpanded(false);updateSheet()}
function closeSheet(){selected=null;$('deviceSheet').classList.remove('visible','expanded');$('deviceSheet').setAttribute('aria-hidden','true');$('bottomTools').classList.remove('hidden');clearMarkerSelection();refreshVisuals()}
function setExpanded(v){sheetExpanded=v;$('deviceSheet').classList.toggle('expanded',v);$('sheetDetails').hidden=!v;$('sheetExpandBtn').setAttribute('aria-expanded',String(v));$('sheetExpandBtn').innerHTML=v?'Fewer details '+icon('chevron-up'):'More details '+icon('chevron-down')}
$('closeSheet').addEventListener('click',closeSheet);$('sheetExpandBtn').addEventListener('click',()=>setExpanded(!sheetExpanded));$('sheetHandle').addEventListener('click',()=>setExpanded(!sheetExpanded));$('sheetHandle').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setExpanded(!sheetExpanded)}});
let touchY=0;$('deviceSheet').addEventListener('touchstart',e=>{touchY=e.touches[0].clientY},{passive:true});$('deviceSheet').addEventListener('touchend',e=>{const dy=e.changedTouches[0].clientY-touchY;if(dy<-45)setExpanded(true);if(dy>55){if(sheetExpanded)setExpanded(false);else closeSheet()}},{passive:true});
function updateSheet(){const d=deviceById(selected);if(!d)return;const fresh=isUsable(d,serverTime),status=d.status==='sleeping'?'Paused':d.status==='offline'?'Unavailable':fresh?'Online':'Stale';
 $('sheetName').textContent=d.name||d.id;$('sheetStatus').textContent=status;$('sheetStatus').className='device-status '+(fresh?'online':'offline');
 $('sheetNoise').textContent=fresh?(d.noise_clipped?'≥127.5':num(d.noise_avg)):'—';$('sheetNoiseUnit').textContent=fresh?'dB average':'No current reading';
 const classification=$('sheetClassification');classification.className='classification '+colorClass(d);classification.textContent=fresh?(d.noise_clipped?'Very loud':d.noise_avg>threshold+10?'Above your limit':d.noise_avg>threshold?'Above your limit':'Below your limit'):(d.status==='sleeping'?'Paused, not quiet':'Reading unavailable');
 $('sheetPeak').textContent=fresh?(d.noise_clipped?'≥ 127.5 dB':num(d.noise_peak)+' dB'):'—';$('sheetTemperature').textContent=fresh&&d.temperature!==null?num(d.temperature)+' °C':'—';$('sheetHumidity').textContent=fresh&&d.humidity!==null?num(d.humidity,0)+'%':'—';
 // Battery: shown even for paused/stale nodes (it is node health, not a measurement of the place).
 $('sheetBatteryPct').textContent=d.battery_estimate_pct!==null&&d.battery_estimate_pct!==undefined?num(d.battery_estimate_pct,0)+'%':'—';
 {const hasV=d.battery_voltage!==null&&d.battery_voltage!==undefined&&Number.isFinite(Number(d.battery_voltage));$('sheetBatteryV').textContent=hasV?num(d.battery_voltage,2)+' V':'Not measured';$('sheetBatteryV').classList.toggle('muted-value',!hasV)}
 const net=d.crowd_source==='networks';$('crowdLabel').textContent='Estimated crowd';$('sheetCrowd').textContent=net?num(fresh?d.crowd_count:null,0):'Not calibrated';
 const ws=[];if(d.test_position)ws.push(`Test position — this real node is actually at ${Number(d.real_latitude).toFixed(5)}, ${Number(d.real_longitude).toFixed(5)}`);if(d.might_have_moved)ws.push('Position may be out of date');if(d.noise_clipped&&fresh)ws.push('Microphone reached its measuring limit');if(!fresh)ws.push('Previous measurements must not be interpreted as a quiet area');$('sheetWarnings').replaceChildren(...ws.map(s=>{const el=document.createElement('p');el.innerHTML=icon('warning');const t=document.createElement('span');t.textContent=s;el.append(t);return el}));
 const age=d.last_updated?Math.max(0,Math.round((Date.parse(serverTime)-Date.parse(d.last_updated))/60000)):null;$('sheetUpdated').textContent=age===null?'Never reported':`Last reading: ${age<1?'just now':age+' min ago'}`;
 $('sheetSource').innerHTML=d.source==='simulated'?icon('dot-dashed')+' Simulated':icon('dot')+' Real device';$('sheetSource').classList.toggle('simulated',d.source==='simulated');$('navigateBtn').disabled=!fresh;$('navigateBtn').innerHTML=fresh?icon('navigate')+' Take me there':'Navigation unavailable';
}
onMarkerSelect(openSheet);
function jumpToExtreme(mode){const pool=devices.filter(d=>isUsable(d,serverTime));if(!pool.length){toast('No current measurements available');return}pool.sort((a,b)=>a.noise_avg-b.noise_avg);openSheet(String((mode==='quiet'?pool[0]:pool[pool.length-1]).id))}
$('quietestBtn').addEventListener('click',()=>jumpToExtreme('quiet'));
const inFestival=pos=>{const [[a,b],[c,d]]=CONFIG.FESTIVAL_BOUNDS;return pos[0]>=a&&pos[0]<=c&&pos[1]>=b&&pos[1]<=d};
let realPosition=null,demoPositionActive=false,centerOnFix=false;
const demoGpsBtn=$('demoGpsBtn');demoGpsBtn.hidden=!demoAllowed();
function setLocation(lat,lon,accuracy=20,kind='gps'){
 location=[lat,lon];locationType=kind;
 $('locationStatus').textContent=kind==='demo'?'Demo position · drag the blue dot':inFestival(location)?'GPS active':'GPS · outside festival area';
 $('locationStatus').classList.toggle('demo',kind==='demo');
 showUserLocation(lat,lon,accuracy,kind==='demo');
 if(navigationActive){navStep();checkArrival()}
 if(destination&&(!currentRoute||kind==='demo'||Date.now()-routeLastRerender>5000)){updateRoute(false);routeLastRerender=Date.now()}
}
function trackLocation(center=false){
 centerOnFix=centerOnFix||center;
 if(!navigator.geolocation){if(demoAllowed())enableDemoLocation('No GPS in this browser — using a demo position',true);else toast('This browser does not support location services');return}
 if(geoWatch!==null)return;
 geoWatch=navigator.geolocation.watchPosition(pos=>{
  realPosition=[pos.coords.latitude,pos.coords.longitude,pos.coords.accuracy];
  if(demoPositionActive)return;
  if(!inFestival(realPosition)){
   // Outside the festival the real dot would be off the map: in demo mode switch to a visible demo position.
   if(demoAllowed()){enableDemoLocation('You are outside the festival — showing a demo position',true);return}
   const first=!location;setLocation(...realPosition,'gps');if(first||centerOnFix)toast('You are outside the festival area.');centerOnFix=false;return;
  }
  const first=!location;setLocation(...realPosition,'gps');
  if(first||centerOnFix){focusLocation(...location);centerOnFix=false}
 },err=>{console.warn(err);
  // Timeouts / temporary signal loss are normal (phone standing still, indoors): keep watching.
  if(err.code!==1&&realPosition)return;
  if(err.code===1){navigator.geolocation.clearWatch(geoWatch);geoWatch=null}
  centerOnFix=false;
  if(demoPositionActive)return;
  if(demoAllowed()){enableDemoLocation('GPS unavailable — showing a demo position',true);return}
  $('locationStatus').textContent='GPS unavailable';toast('Location unavailable. Allow location access (HTTPS required).')
 },{enableHighAccuracy:true,maximumAge:5000,timeout:15000})
}
function enableDemoLocation(message='Demo position — not your real GPS location',auto=false){
 if(demoPositionActive)return;
 demoPositionActive=true;demoGpsBtn.textContent='GPS';demoGpsBtn.setAttribute('aria-pressed','true');
 const pos=location&&locationType==='demo'?location:CONFIG.DEMO_START;
 setLocation(pos[0],pos[1],10,'demo');if(auto)resetView();else if(!destination)focusLocation(...pos);toast(message)
}
onDemoLocationMoved((lat,lon)=>{if(!demoPositionActive)return;if(!inFestival([lat,lon]))toast('Outside the routable festival area');setLocation(lat,lon,10,'demo')});
demoGpsBtn.addEventListener('click',()=>{
 if(!demoPositionActive){enableDemoLocation();return}
 if(!realPosition||!inFestival(realPosition)){toast(realPosition?'Your real GPS is outside the festival — staying on demo':'No real GPS fix yet — staying on demo');if(!realPosition)trackLocation(false);return}
 demoPositionActive=false;demoGpsBtn.textContent='Demo';demoGpsBtn.setAttribute('aria-pressed','false');
 setLocation(...realPosition,'gps');focusLocation(...location)
});
$('locateBtn').addEventListener('click',()=>{if(location)focusLocation(...location);else trackLocation(true)});$('resetMapBtn').addEventListener('click',resetView);
$('navigateBtn').addEventListener('click',()=>{const d=deviceById(selected);if(!d||!isUsable(d,serverTime))return;destination=d;closeSheet();$('routePanel').classList.add('visible');document.body.classList.add('routing');$('routePanel').setAttribute('aria-hidden','false');$('routeDestination').textContent=d.name||d.id;$('bottomTools').classList.add('hidden');$('demoLocationBtn').hidden=!!location;updateRoute();if(!location)trackLocation(false)});
function closeRoute(){if(navigationActive)setNavigation(false);document.body.classList.remove('routing');destination=null;currentRoute=null;clearRoute();$('routePanel').classList.remove('visible');$('routePanel').setAttribute('aria-hidden','true');$('bottomTools').classList.remove('hidden')}
$('closeRoute').addEventListener('click',closeRoute);
function setRouteMode(mode){if(mode===routeMode&&currentRoute)return;routeMode=mode;$('fastestTab').classList.toggle('active',mode==='fastest');$('quieterTab').classList.toggle('active',mode==='quieter');$('fastestTab').setAttribute('aria-pressed',String(mode==='fastest'));$('quieterTab').setAttribute('aria-pressed',String(mode==='quieter'));updateRoute()}
$('fastestTab').addEventListener('click',()=>setRouteMode('fastest'));$('quieterTab').addEventListener('click',()=>setRouteMode('quieter'));
$('demoLocationBtn').addEventListener('click',()=>{enableDemoLocation();$('demoLocationBtn').hidden=true;updateRoute()});
function tabLabel(id,ic,name,r){$(id).innerHTML=`<span>${icon(ic)} ${name}</span><small>${r?`${r.minutes} min · ~${Math.round(r.noiseAvg)} dB`:'—'}</small>`}
function routeInput(){return devices.filter(d=>isUsable(d,serverTime))}
function updateRoute(fit=true){if(!destination)return;
 if(!location){$('routeInfo').textContent='Waiting for your location…';$('routeStartBtn').disabled=true;$('demoLocationBtn').hidden=!demoAllowed();clearRoute();tabLabel('fastestTab','zap','Fastest');tabLabel('quieterTab','quiet','Quieter');return}
 const input=routeInput(),to=[Number(destination.latitude),Number(destination.longitude)];
 try{
  const routes={fastest:computeRoute(location,to,'fastest',input,threshold,getGeography()),quieter:computeRoute(location,to,'quieter',input,threshold,getGeography())};
  // The fastest option must never be slower than the quieter one.
  if(routes.quieter.distance<routes.fastest.distance)routes.fastest={...routes.quieter,mode:'fastest'};
  currentRoute=routes[routeMode];
  tabLabel('fastestTab','zap','Fastest',routes.fastest);tabLabel('quieterTab','quiet','Quieter',routes.quieter);
  const other=routes[routeMode==='quieter'?'fastest':'quieter'],dMin=currentRoute.minutes-other.minutes,dDb=Math.round(currentRoute.noiseAvg-other.noiseAvg);
  let compare='';
  if(routeMode==='quieter')compare=dDb<0?`${-dDb} dB quieter than the fastest route${dMin>0?`, +${dMin} min`:''}`:'The fastest route is already the quietest option';
  else compare=dDb>0?`${dDb} dB louder than the quieter route`:'Also the quietest option';
  $('routeInfo').innerHTML=`<strong>${Math.round(currentRoute.distance)} m · ~${currentRoute.minutes} min walk</strong><span>Estimated noise on the way: ~${Math.round(currentRoute.noiseAvg)} dB avg, peaks ~${Math.round(currentRoute.noisePeak)} dB</span><span>${compare}</span>${locationType==='demo'?'<em>Using demo position · drag the blue dot to change start</em>':''}`;
  $('routeStartBtn').disabled=false;$('routeStartBtn').textContent=navigationActive?'Stop navigation':'Start navigation';$('demoLocationBtn').hidden=true;
  drawRoute(currentRoute.points,routeMode,fit); // after the panel text is final, so the fit uses its real height
 }catch(err){currentRoute=null;clearRoute();$('routeStartBtn').disabled=true;$('routeInfo').textContent=err.message;tabLabel('fastestTab','zap','Fastest');tabLabel('quieterTab','quiet','Quieter');$('demoLocationBtn').hidden=!demoAllowed()||locationType==='demo';}}
function checkArrival(){if(!navigationActive||!destination||!location)return;if(meters(location,[Number(destination.latitude),Number(destination.longitude)])<=CONFIG.ARRIVAL_METERS){toast(`You have arrived at ${destination.name||'your destination'}`);setNavigation(false);updateRoute(false)}}
let headingUp=true,simTimer=null,lastReroute=0;
// Camera + panel update for the current position while navigating.
function navStep(){
 if(!navigationActive||!currentRoute||!location)return;
 const pr=routeProgress(currentRoute.points,location);
 followLocation(location[0],location[1],headingUp?pr.bearing:null);
 $('navRemaining').textContent=`${Math.round(pr.remaining)} m left · ~${Math.max(1,Math.round(pr.remaining/1.2/60))} min`;
 // Off the route by more than ~35 m: compute a new one from here.
 if(pr.offRoute>35&&Date.now()-lastReroute>4000){lastReroute=Date.now();updateRoute(false);toast('Route updated')}
}
function stopSimulation(){if(simTimer){clearInterval(simTimer);simTimer=null}}
// Demo only: walk the demo dot along the route (6× walking speed) to preview the navigation.
function simulateWalk(){
 stopSimulation();const pts=currentRoute.points.map(p=>p.slice());let i=1,pos=pts[0].slice();const step=1.2*6*0.5;
 simTimer=setInterval(()=>{if(!navigationActive||locationType!=='demo'){stopSimulation();return}
  let left=step;while(i<pts.length&&left>0){const d=meters(pos,pts[i]);if(d<=left){pos=pts[i].slice();left-=d;i++}else{const f=left/d;pos=[pos[0]+(pts[i][0]-pos[0])*f,pos[1]+(pts[i][1]-pos[1])*f];left=0}}
  setLocation(pos[0],pos[1],10,'demo');if(i>=pts.length)stopSimulation()},500);
}
function setNavigation(on){
 navigationActive=on;$('routeStartBtn').textContent=on?'Stop navigation':'Start navigation';$('routePanel').classList.toggle('navigating',on);document.body.classList.toggle('navigating',on);
 if(on){headingUp=true;navStep();if(locationType==='demo'){toast('Demo: simulating the walk along the route');simulateWalk()}else{toast('Follow the approximate route. Respect event signs and barriers.');trackLocation(false)}}
 else{stopSimulation();northUp()}
 updateCompass();
}
$('routeStartBtn').addEventListener('click',()=>{if(!currentRoute)return;setNavigation(!navigationActive);if(!navigationActive)toast('Navigation stopped')});
// Compass: shows where north is; tap to switch between heading-up and north-up.
function updateCompass(b=0){const btn=$('compassBtn');btn.hidden=!navigationActive&&Math.abs(b)<0.5;btn.querySelector('span').style.transform=`rotate(${-b}deg)`;btn.setAttribute('aria-pressed',String(navigationActive&&headingUp))}
onRotate(updateCompass);
$('compassBtn').addEventListener('click',()=>{if(navigationActive){headingUp=!headingUp;toast(headingUp?'Map turns with your route':'North up');if(headingUp)navStep();else northUp()}else northUp();updateCompass()});
$('helpBtn').addEventListener('click',()=>{alert('SoundScape\n\nNoise values are approximate, not certified dB(A). Your noise limit is a comfort preference, not a safety threshold.\n\nSensor data may be delayed. Paused and offline devices are not quiet locations.\n\nQuieter routes are experimental estimates based on sparse sensor readings. Festival restrictions and paths may differ from the map.\n\nMap data © OpenStreetMap contributors.');});
$('simBtn').addEventListener('click',async()=>{
 simOn=!simOn;try{localStorage.setItem('soundscape-sim',simOn?'1':'0')}catch{}
 syncSimButton();demoGpsBtn.hidden=!demoAllowed();
 if(selected&&!simOn&&String(selected).startsWith('sim-'))closeSheet();
 if(destination&&!simOn&&destination.source==='simulated')closeRoute();
 await poll();
 if(simOn){toast('Simulated nodes added (marked SIM)');if(!demoPositionActive&&(!location||!inFestival(location)))enableDemoLocation('Showing a demo position for the simulation',true)}
 else{toast('Simulated nodes removed');
  if(demoPositionActive&&!demoAllowed()){demoPositionActive=false;demoGpsBtn.textContent='Demo';demoGpsBtn.setAttribute('aria-pressed','false');
   if(realPosition){setLocation(...realPosition,'gps')}else{location=null;locationType=null;clearUserLocation();$('locationStatus').textContent='Locating you…';$('locationStatus').classList.remove('demo');trackLocation(false)}}}
 if(destination)updateRoute(false);
});
syncSimButton();
(async()=>{trackLocation(true);await poll();setInterval(()=>poll().catch(console.error),CONFIG.POLLING_INTERVAL);try{await loadGeography();if(destination)updateRoute()}catch(err){console.error(err);toast('Festival routing data failed to load')}})();
