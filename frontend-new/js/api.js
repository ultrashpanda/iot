import { CONFIG } from './config.js?v=5.4';
// Simulated nodes, added on top of the real ones with the "Simulated nodes" button.
// Positions are ESTIMATES of the Roskilde Festival layout on the OSM basemap
// (inner site on Dyrskuepladsen in the north, Camping West/East/South around it).
// Adjust latitude/longitude here when the real deployment positions are known.
// [id, name, latitude, longitude, noise_avg, noise_peak, wifi_networks, status]
const samples=[
 ['sim-orange','Orange Stage',      55.6218,12.0771, 99,  115, 64,'online'],
 ['sim-arena', 'Arena',             55.6206,12.0738, 92,  108, 45,'online'],
 ['sim-avalon','Avalon',            55.6224,12.0826, 88,  103, 38,'online'],
 ['sim-apollo','Apollo',            55.6198,12.0810, 85,  100, 31,'online'],
 ['sim-gloria','Gloria',            55.6197,12.0766, 79,   94, 22,'online'],
 ['sim-food',  'Food Court',        55.6190,12.0748, 74,   88, 40,'online'],
 ['sim-station','Festival Station', 55.6185,12.0712, 70,   86, 27,'online'],
 ['sim-west',  'Camping West',      55.6128,12.0702, 66,   80, 19,'online'],
 ['sim-dream', 'Dream City',        55.6168,12.0855, 77,   92, 25,'online'],
 ['sim-east',  'Camping East',      55.6150,12.0905, 71,   85, 21,'online'],
 ['sim-south', 'Camping South',     55.6148,12.0815, 60,   72, 11,'online'],
 ['sim-silent','Silent & Clean',    55.6098,12.0890, 52,   64,  7,'online'],
 ['sim-lake',  'Lake Camping',      55.6110,12.0740, 57,   69,  9,'sleeping'],
 ['sim-gate',  'East Entrance',     55.6196,12.0912, null,null,null,'offline']
].map(([id,name,latitude,longitude,noise_avg,noise_peak,crowd_count,status])=>({id,name,latitude,longitude,noise_avg,noise_peak,crowd_count,crowd_source:'networks',temperature:18.5,humidity:59,status,source:'simulated',might_have_moved:false,noise_clipped:false,battery_voltage:null,battery_estimate_pct:status==='offline'?null:Math.max(12,96-(id.length*7)%70)}));
// Make backend data safe to use: numbers sent as strings become numbers, missing fields get
// conservative defaults. Devices without an id or valid coordinates are skipped.
const num=v=>v===null||v===undefined||v===''?null:(Number.isFinite(Number(v))?Number(v):null);
function normalizeDevice(d){
  if(!d||d.id===undefined||d.id===null)return null;
  const latitude=num(d.latitude),longitude=num(d.longitude);
  if(latitude===null||longitude===null)return null;
  return {...d,id:String(d.id),name:d.name||String(d.id),latitude,longitude,
    noise_avg:num(d.noise_avg),noise_peak:num(d.noise_peak),battery_voltage:num(d.battery_voltage),battery_estimate_pct:num(d.battery_estimate_pct),crowd_count:num(d.crowd_count),temperature:num(d.temperature),humidity:num(d.humidity),
    noise_clipped:d.noise_clipped===true,might_have_moved:d.might_have_moved===true,
    status:['online','sleeping','offline'].includes(d.status)?d.status:'offline',
    source:d.source==='simulated'?'simulated':'physical',
    last_updated:d.last_updated||null};
}
// TESTS ONLY (CONFIG.TEST_POSITIONS): move a real node onto the festival map, keeping its real coordinates.
function applyTestPosition(d){
  const p=(CONFIG.TEST_POSITIONS||{})[d.id];
  if(!Array.isArray(p)||!Number.isFinite(Number(p[0]))||!Number.isFinite(Number(p[1])))return d;
  return {...d,test_position:true,real_latitude:d.latitude,real_longitude:d.longitude,latitude:Number(p[0]),longitude:Number(p[1])};
}
let simCounter=0;
// Simulated nodes, with timestamps relative to the server time so they count as current.
function simulatedDevices(baseTime){
  simCounter++;
  return samples.map((d,i)=>({...d,source:'simulated',
    noise_avg:d.status==='online'?Math.round((d.noise_avg+Math.sin(simCounter*.34+i)*1.5)*2)/2:d.noise_avg,
    last_updated:d.status==='offline'?null:new Date(baseTime-(d.status==='sleeping'?35*60000:3000)).toISOString()}));
}
// Always asks the backend; adds the simulated nodes when requested. A backend failure does not
// hide the simulated nodes: it is reported in `apiError` instead.
export async function fetchDevices({simulated=false,signal}={}){
  let real=[],generated_at=null,apiError=null;
  try{
    const response=await fetch(CONFIG.API_URL,{signal,cache:'no-store',headers:{Accept:'application/json'}});
    if(!response.ok) throw new Error(`API returned HTTP ${response.status}`);
    const payload=await response.json();
    if(!payload || !Array.isArray(payload.devices)) throw new Error('Invalid API response: devices array missing');
    generated_at=payload.generated_at||null;
    real=payload.devices.map(normalizeDevice).filter(Boolean).map(applyTestPosition);
  }catch(err){apiError=err.message||String(err)}
  const now=generated_at?Date.parse(generated_at):Date.now();
  const time=Number.isFinite(now)?now:Date.now();
  return {generated_at:new Date(time).toISOString(),devices:simulated?[...real,...simulatedDevices(time)]:real,apiError};
}
