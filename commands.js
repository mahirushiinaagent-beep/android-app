/* ALISA COMMANDS — step 4: tool / action system. Independent module: window.ALISACommands.
   Deterministic voice commands (regex, no AI needed, work offline) + the same tools exposed to Gemini as function calls.
   PERMISSIONS: every tool has a level —
     safe       runs immediately (time, timers, lists, calculator, opening public sites …)
     confirm    (inside a tool) asks "say yes to confirm" first (clear a list, cancel several alarms, delete a contact)
     sensitive  calls / texts / WhatsApp: ALISA's voice-security gate must pass first (done in index.html), and the
                action is NEVER fired automatically — a button appears and YOU tap it (a tap is a real user gesture).
   Gemini can only call SAFE tools. It cannot call, text, or delete anything.
   LIMITS (browser): timers / alarms / reminders only ring while ALISA is open in Chrome (a background tab may be a few seconds late).
   Closed-app alarms, contacts lookup, and device control need the Android wrapper (step 6/7).
   Storage: localStorage only — alisa-schedule, alisa-lists, alisa-contacts, alisa-stopwatch. Nothing is sent anywhere. */
(()=>{'use strict';
const K={sched:'alisa-schedule',lists:'alisa-lists',contacts:'alisa-contacts',sw:'alisa-stopwatch'};
const ls={get(k,d){try{const v=localStorage.getItem(k);return v==null?d:JSON.parse(v)}catch(e){return d}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}};
const host={speak:null};
const emit=()=>{try{window.dispatchEvent(new CustomEvent('alisacommands:change'))}catch(e){}};
const say=t=>{try{if(host.speak)return host.speak(t);const S=window.speechSynthesis;if(S){const u=new SpeechSynthesisUtterance(t);S.speak(u)}}catch(e){}};
const rnd=n=>{try{return Math.floor(crypto.getRandomValues(new Uint32Array(1))[0]/4294967296*n)}catch(e){return Math.floor(Math.random()*n)}};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cap=s=>s?s[0].toUpperCase()+s.slice(1):s;
const plural=(n,w)=>n+' '+w+(n==1?'':'s');

/* ---------- text helpers ---------- */
const ONES={zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19};
const TENS={twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90};
function numify(s){const tk=String(s).split(/\s+/),out=[];
 for(let i=0;i<tk.length;i++){const m=/^([a-z]+)([,.]*)$/.exec(tk[i]);if(!m){out.push(tk[i]);continue}const w=m[1];
  if(w in TENS){let v=TENS[w];const n=/^([a-z]+)([,.]*)$/.exec(tk[i+1]||'');if(n&&n[1] in ONES&&ONES[n[1]]>0&&ONES[n[1]]<10){v+=ONES[n[1]];i++;out.push(v+n[2]);continue}out.push(v+m[2])}
  else if(w in ONES)out.push(ONES[w]+m[2]);else out.push(tk[i])}
 return out.join(' ')}
function norm(s){s=String(s||'').toLowerCase().trim().replace(/[’]/g,"'").replace(/\b([ap])\.\s?m\.?/g,'$1m').replace(/\bo'?clock\b/g,'')
 .replace(/\s+dot\s+(com|org|net|in|io|co|edu|gov|app|dev|ai)\b/g,'.$1').replace(/[!?;:](?!\d)/g,' ').replace(/\.(?!\w)/g,' ').replace(/\s+/g,' ').trim();
 let p;do{p=s;s=s.replace(/^(?:hey|hi|hello|ok|okay|alisa|alissa|alisha|aleesa|elisa|please|so|um|uh)\b[\s,]*/,'')}while(p!==s);
 s=s.replace(/^(?:(?:can|could|would|will) you(?: please)?|i want you to|i need you to|i would like you to|i'd like you to|go ahead and)\s+/,'');
 return s.replace(/[\s,]+(?:please|for me|thanks|thank you|now)$/,'').replace(/[\s,]+$/,'').trim()}
const flip=s=>String(s).replace(/\bmy\b/g,'your').replace(/\bi am\b/g,'you are').replace(/\bi'm\b/g,"you're").replace(/\bmyself\b/g,'yourself').replace(/\bme\b/g,'you').replace(/\bi\b/g,'you').replace(/\bmine\b/g,'yours');
const tidy=s=>{s=String(s).replace(/\s+/g,' ').trim();let p;do{p=s;s=s.replace(/^(?:and|to|that|about|at|on|in|for|by|me|then)(?:\s+|$)/,'').replace(/(?:^|\s+)(?:at|on|in|for|by|and|to|then)$/,'')}while(p!==s);return s.trim()};
const DURU='(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)';
const DUR='(?:\\b(?:\\d+(?:\\.\\d+)?|an?|half(?: an?)?)\\s*'+DURU+'(?:\\s+and\\s+a\\s+half)?(?:\\s*(?:,|and)?\\s*(?=\\d|an?\\b|half))?)+';
function parseDuration(s){s=numify(String(s).toLowerCase());let ms=0,m;const re=/\b(\d+(?:\.\d+)?|an?|half(?: an?)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)(\s+and\s+a\s+half)?/g;
 while((m=re.exec(s))){const n=/^half/.test(m[1])?.5:/^an?$/.test(m[1])?1:parseFloat(m[1]),u=m[2][0],f=u=='s'?1e3:u=='m'?6e4:u=='h'?36e5:u=='d'?864e5:6048e5;ms+=n*f+(m[3]?.5*f:0)}
 return Math.round(ms)}
const DAYS=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'],PART={morning:8,afternoon:15,evening:18,night:21,tonight:21};
/* parseWhen: "in 10 minutes", "at 7:30 pm", "tomorrow at 6", "tonight", "on friday at 5" → {at:Date, rest:text-without-the-time}. kind 'alarm' | 'reminder' only changes how an ambiguous "at 5" is read. */
function parseWhen(text,kind,now){now=now||new Date();let s=numify(norm(text));
 let m=s.match(new RegExp('\\b(?:in|after|within)\\s+('+DUR+')','i'));
 if(m){const ms=parseDuration(m[1]);if(ms>0)return{at:new Date(now.getTime()+ms),rest:tidy(s.replace(m[0],' ')),dur:ms}}
 let day=null,part=null,wd=null;
 s=s.replace(/\bday after tomorrow\b/,()=>{day=2;return' '}).replace(/\btomorrow\b/,()=>{day=1;return' '}).replace(/\btoday\b/,()=>{day=0;return' '})
  .replace(/\b(?:this |in the |at )?(morning|afternoon|evening|night|tonight)\b/,(a,p)=>{part=p;if(p=='tonight'&&day==null)day=0;return' '})
  .replace(/\b(?:on |next |this |coming )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/,(a,d)=>{wd=DAYS.indexOf(d);return' '});
 let h=null,mi=0,mer=null,hit=null,x;
 if((x=s.match(/\b(?:(?:at|by|around)\s+)?(\d{1,2})(?:[:.\s](\d{2}))?\s*(am|pm)\b/))){h=+x[1];mi=+(x[2]||0);mer=x[3];hit=x[0]}
 else if((x=s.match(/\b(\d{1,2}):(\d{2})\b/))){h=+x[1];mi=+x[2];hit=x[0]}
 else if((x=s.match(/\b(?:at|by|around)\s+(\d{1,2})(?:[:.](\d{2})|\s(\d{2})\b)?(?!\d)/))){h=+x[1];mi=+(x[2]||x[3]||0);hit=x[0]}
 else if((x=s.match(/\b(?:at\s+)?(noon|midnight)\b/))){h=x[1]=='noon'?12:24;mi=0;mer='24';hit=x[0]}
 if(h==null){if(part==null&&day==null&&wd==null)return null;if(kind=='alarm'&&part==null)return null;h=part?PART[part]:9;mer='24'}
 else s=s.replace(hit,' ');
 if(h>24||mi>59||(!mer&&h==0&&false))return null;
 let H,amb=false;
 if(mer=='24')H=h;else if(mer)H=h%12+(mer=='pm'?12:0);else if(h>=13||h==0)H=h;
 else if(part&&part!='morning')H=h==12&&part!='night'&&part!='tonight'?12:h==12?24:h+12;
 else if(part=='morning')H=h%12;else{amb=true;H=h%12}
 const mk=(off,hh)=>{const d=new Date(now);d.setDate(d.getDate()+off);d.setHours(hh,mi,0,0);return d},soon=new Date(now.getTime()+15e3);let at;
 if(wd!=null){const off=(wd-now.getDay()+7)%7;at=amb?mk(off,kind=='alarm'?H:(h<=6||h==12)?H+12:H):mk(off,H);if(at<=soon)at=new Date(at.getTime()+7*864e5)}
 else if(amb&&day==null){const c=[mk(0,H),mk(0,H+12)].find(d=>d>soon);at=c||mk(1,kind=='alarm'||!(h<=6||h==12)?H:H+12)}
 else if(amb)at=mk(day,kind=='alarm'?H:(h<=6||h==12)?H+12:H);
 else{at=mk(day||0,H);if(day==null&&at<=soon)at=mk(1,H)}
 return{at,rest:tidy(s)}}

/* ---------- formatting ---------- */
const fmtDur=ms=>{ms=Math.max(0,Math.round(ms/1000));const d=Math.floor(ms/86400),h=Math.floor(ms%86400/3600),m=Math.floor(ms%3600/60),s=ms%60,p=[];
 if(d)p.push(plural(d,'day'));if(h)p.push(plural(h,'hour'));if(m)p.push(plural(m,'minute'));if(s&&!d&&!h)p.push(plural(s,'second'));return p.slice(0,3).join(' ')||'0 seconds'};
const fmtClock=d=>new Date(d).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
const fmtWhen=ts=>{const d=new Date(ts),n=new Date(),dd=Math.round((new Date(d.getFullYear(),d.getMonth(),d.getDate())-new Date(n.getFullYear(),n.getMonth(),n.getDate()))/864e5);
 return(dd==0?'':dd==1?'tomorrow ':d.toLocaleDateString([], {weekday:'long',month:'short',day:'numeric'})+' ')+'at '+fmtClock(d)};
const fmtNum=n=>Number.isFinite(n)?(+n.toPrecision(12)).toLocaleString('en-US',{maximumFractionDigits:6}):'not a number';
let warned=false;const warn=()=>{if(warned)return'';warned=true;return' Keep ALISA open in Chrome so I can alert you.'};

/* ---------- on-screen layer (ringing alarms + tap-to-open links) ---------- */
function css(){if(document.getElementById('ac-css'))return;const s=document.createElement('style');s.id='ac-css';
 s.textContent='#ac-layer{position:fixed;z-index:60;left:10px;right:10px;top:calc(34px + env(safe-area-inset-top,0px));display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:460px;margin:0 auto}#ac-layer .ac{pointer-events:auto;display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:16px;border:1px solid hsl(var(--c3,200 90% 60%)/.55);background:rgba(4,10,24,.92);backdrop-filter:blur(14px);box-shadow:0 0 22px hsl(var(--c3,200 90% 60%)/.35);color:#eaf6ff;font:500 13px var(--ui,system-ui)}#ac-layer .ac.ring{animation:acp 1s ease-in-out infinite alternate}@keyframes acp{to{box-shadow:0 0 34px hsl(var(--c3,200 90% 60%)/.8)}}#ac-layer .ac span{flex:1;line-height:1.3}#ac-layer .ac small{display:block;opacity:.65;font-size:10px;letter-spacing:.06em}#ac-layer .ac button,#ac-layer .ac a{pointer-events:auto;border:1px solid hsl(var(--c3,200 90% 60%)/.5);background:hsl(var(--c3,200 90% 60%)/.18);color:#fff;border-radius:11px;padding:8px 11px;font:600 12px var(--ui,system-ui);text-decoration:none;cursor:pointer}';
 document.head.appendChild(s)}
function layer(){css();let L=document.getElementById('ac-layer');if(!L){L=document.createElement('div');L.id='ac-layer';document.body.appendChild(L)}return L}
function card(html,cls){const d=document.createElement('div');d.className='ac '+(cls||'');d.innerHTML=html;layer().appendChild(d);return d}
function showLink(label,url,note){try{const c=card('<span>'+esc(label)+(note?'<small>'+esc(note)+'</small>':'')+'</span><a href="'+esc(url)+'" target="_blank" rel="noopener">Open ↗</a><button aria-label="Dismiss">✕</button>');
 c.querySelector('button').onclick=()=>c.remove();c.querySelector('a').addEventListener('click',()=>setTimeout(()=>c.remove(),300));setTimeout(()=>c.remove(),30000)}catch(e){}}
function openLink(url,label,auto){let ok=false;if(auto){try{const w=window.open(url,'_blank');if(w){ok=true;try{w.opener=null}catch(e){}}}catch(e){}}if(!ok)showLink(label,url);return ok}
/* Chrome blocks pages opened without a tap, so we try once and fall back to a button */
const opened=(ok,what)=>ok?'Opening '+what+'.':'Tap the button on screen to open '+what+'.';

/* ---------- schedule: timers · alarms · reminders ---------- */
let sched=ls.get(K.sched,[]);if(!Array.isArray(sched))sched=[];
const ringing=new Map(),saveS=()=>{ls.set(K.sched,sched);emit()},uid=()=>Math.random().toString(36).slice(2,9);
function askNotify(){try{if('Notification' in window&&Notification.permission=='default')Notification.requestPermission().catch(()=>{})}catch(e){}}
async function notify(title,body,tag){try{if(!('Notification' in window)||Notification.permission!='granted')return;const o={body,tag,renotify:true,requireInteraction:true,vibrate:[300,150,300],icon:'alisa-192.png',badge:'alisa-192.png'};
 const reg=navigator.serviceWorker&&await navigator.serviceWorker.getRegistration();if(reg)reg.showNotification(title,o);else new Notification(title,o)}catch(e){}}
let actx;function beep(n){try{actx=actx||new(window.AudioContext||window.webkitAudioContext)();if(actx.state=='suspended')actx.resume();const t=actx.currentTime;
 for(let i=0;i<n;i++){const o=actx.createOscillator(),g=actx.createGain(),a=t+i*.24;o.type='sine';o.frequency.value=i%2?988:784;g.gain.setValueAtTime(0,a);g.gain.linearRampToValueAtTime(.35,a+.02);g.gain.exponentialRampToValueAtTime(.001,a+.22);o.connect(g);g.connect(actx.destination);o.start(a);o.stop(a+.24)}}catch(e){}}
const vib=()=>{try{navigator.vibrate&&navigator.vibrate([300,150,300])}catch(e){}};
const describe=it=>it.type=='timer'?'a timer for '+fmtDur(it.ms||0)+(it.label?' ('+it.label+')':''):it.type=='alarm'?'an alarm '+fmtWhen(it.at)+(it.label?' ('+it.label+')':'')+(it.repeat?', every day':''):'a reminder to '+(it.label||'do something')+' '+fmtWhen(it.at);
const ringText=it=>it.type=='timer'?'Your timer for '+fmtDur(it.ms||0)+' is done.'+(it.label?' '+it.label+'.':''):it.type=='alarm'?'Alarm.'+(it.label?' '+it.label+'.':''):'Reminder: '+flip(it.label||'something')+'.';
function addItem(type,at,label,extra){const it=Object.assign({id:uid(),type,at:+at,label:label||'',created:Date.now()},extra||{});sched.push(it);saveS();askNotify();return it}
function paintRing(){try{paint2()}catch(e){}}
function paint2(){const L=layer();L.querySelectorAll('.ac.ring').forEach(n=>n.remove());
 ringing.forEach(R=>{const it=R.it,c=card('<span>'+esc(ringText(it))+'<small>'+esc(it.type.toUpperCase())+'</small></span><button data-a="sn">Snooze 5m</button><button data-a="st">Stop</button>','ring');
  c.querySelector('[data-a=st]').onclick=()=>stopRing(it.id);c.querySelector('[data-a=sn]').onclick=()=>stopRing(it.id,300000)})}
function startRing(it){if(ringing.has(it.id))return;const R={it,n:0,iv:0},max=it.type=='reminder'?3:27;ringing.set(it.id,R);
 R.iv=setInterval(()=>{R.n++;if(R.n>max){clearInterval(R.iv);return}beep(it.type=='reminder'?2:3);vib();if(it.type!='reminder'&&R.n%6==0)say(ringText(it))},2200);
 beep(3);vib();say(ringText(it));notify('ALISA · '+cap(it.type),ringText(it),it.id);paintRing();emit()}
function stopRing(id,snoozeMs){const R=ringing.get(id);if(!R)return false;clearInterval(R.iv);ringing.delete(id);const it=R.it;
 if(snoozeMs){it.at=Date.now()+snoozeMs}
 else if(it.repeat=='daily'){it.at+=864e5;while(it.at<=Date.now())it.at+=864e5}
 else sched=sched.filter(x=>x.id!=id);
 saveS();paintRing();return true}
function tick(){const n=Date.now();let dirty=false;
 for(const it of sched.slice()){if(it.at>n||ringing.has(it.id))continue;
  if(n-it.at>10*60e3){ // overdue by >10 min (app was closed / phone asleep) → don't ring, just tell the user
   const c=card('<span>Missed '+esc(it.type)+(it.label?': '+esc(it.label):'')+'<small>'+esc(new Date(it.at).toLocaleString())+'</small></span><button aria-label="Dismiss">✕</button>');c.querySelector('button').onclick=()=>c.remove();notify('ALISA · missed '+it.type,it.label||'',it.id);
   if(it.repeat=='daily'){while(it.at<=n)it.at+=864e5}else sched=sched.filter(x=>x.id!=it.id);dirty=true}
  else startRing(it)}
 if(dirty)saveS()}
let ticker=0;function init(o){if(o&&o.speak)host.speak=o.speak;if(!ticker){ticker=setInterval(tick,1000);document.addEventListener&&document.addEventListener('visibilitychange',()=>{if(!document.hidden)tick()});setTimeout(tick,400)}}

/* ---------- stopwatch ---------- */
const swGet=()=>ls.get(K.sw,{run:false,t0:0,acc:0}),swEl=s=>s.acc+(s.run?Date.now()-s.t0:0);

/* ---------- lists ---------- */
const lists=()=>ls.get(K.lists,{}),saveL=o=>{ls.set(K.lists,o);emit()};
function lname(n){n=String(n||'').toLowerCase().replace(/\b(?:my|the|our)\b/g,'').trim();if(!n||/^(?:to ?do|to-do|todo|tasks?|things)$/.test(n))return'to-do';if(/^(?:shopping|grocery|groceries|shop|market)$/.test(n))return'shopping';return n}
const splitItems=s=>String(s).split(/\s*,\s*/).map(x=>x.trim()).filter(Boolean);

/* ---------- contacts (local only) ---------- */
const contacts=()=>ls.get(K.contacts,{}),saveC=o=>{ls.set(K.contacts,o);emit()};
const digits=s=>{const d=numify(String(s)).replace(/[^\d+]/g,'');return d.replace(/(?!^)\+/g,'')};
const okNum=d=>/^\+?\d{7,15}$/.test(d);
function resolveContact(n){n=String(n).toLowerCase().replace(/^(?:my|to|the)\s+/,'').trim();const d=digits(n);if(okNum(d))return{name:d,num:d};const c=contacts(),k=Object.keys(c);
 const f=k.find(x=>x==n)||k.find(x=>x.startsWith(n))||k.find(x=>n.startsWith(x))||k.find(x=>x.includes(n));return f?{name:f,num:c[f]}:null}

/* ---------- calculator ---------- */
function toExpr(s){return numify(String(s).toLowerCase()).replace(/(\d),(\d{3})/g,'$1$2')
 .replace(/(\d+(?:\.\d+)?)\s*(?:%|percent|per cent)\s*of\s*(\d+(?:\.\d+)?)/g,'($1/100*$2)')
 .replace(/square root of\s*(\d+(?:\.\d+)?)/g,'sqrt($1)').replace(/(\d+(?:\.\d+)?)\s*squared/g,'$1^2').replace(/(\d+(?:\.\d+)?)\s*cubed/g,'$1^3')
 .replace(/\bto the power(?: of)?\b|\braised to(?: the power of)?\b/g,'^').replace(/\bplus\b/g,'+').replace(/\bminus\b|\bsubtract\b/g,'-')
 .replace(/\b(?:times|multiplied by|multiply by|into)\b/g,'*').replace(/(\d)\s*x\s*(\d)/g,'$1*$2').replace(/\bx\b/g,'*')
 .replace(/\b(?:divided by|divide by|over)\b/g,'/').replace(/\bmod(?:ulo)?\b/g,'%').replace(/\s+/g,'')}
function evalExpr(src){if(!/^[\d.+\-*/^()%sqrt]+$/.test(src)||!/[+\-*/^%]|sqrt/.test(src))return null;const tk=src.match(/\d+(?:\.\d+)?|sqrt|[+\-*/^()%]/g)||[];if(tk.join('')!=src)return null;let i=0;
 const peek=()=>tk[i],ex=()=>{let v=te();while(peek()=='+'||peek()=='-'){const o=tk[i++],r=te();v=o=='+'?v+r:v-r}return v},
  te=()=>{let v=un();while(peek()=='*'||peek()=='/'||peek()=='%'){const o=tk[i++],r=un();if((o=='/'||o=='%')&&r==0)throw new Error('div0');v=o=='*'?v*r:o=='/'?v/r:v%r}return v},
  un=()=>{if(peek()=='-'){i++;return-un()}if(peek()=='+'){i++;return un()}return pw()},
  pw=()=>{const b=at();if(peek()=='^'){i++;return Math.pow(b,un())}return b},
  at=()=>{const t=tk[i++];if(t==undefined)throw new Error('syntax');if(t=='('){const v=ex();if(tk[i++]!=')')throw new Error('syntax');return v}if(t=='sqrt'){const v=at();if(v<0)throw new Error('sqrtneg');return Math.sqrt(v)}if(/^\d/.test(t))return parseFloat(t);throw new Error('syntax')};
 try{const v=ex();if(i!=tk.length)return null;return{v}}catch(e){return{err:e.message}}}
function calc(src){const r=evalExpr(toExpr(src));if(!r)return null;if(r.err=='div0')return'I can’t divide by zero.';if(r.err=='sqrtneg')return'I can’t take the square root of a negative number.';if(r.err)return null;return fmtNum(r.v)}

/* ---------- unit conversion ---------- */
const U={length:{m:1,meter:1,meters:1,metre:1,metres:1,km:1e3,kilometer:1e3,kilometers:1e3,kilometre:1e3,kilometres:1e3,kms:1e3,cm:.01,centimeter:.01,centimeters:.01,centimetre:.01,centimetres:.01,mm:.001,millimeter:.001,millimeters:.001,mile:1609.344,miles:1609.344,mi:1609.344,yard:.9144,yards:.9144,yd:.9144,foot:.3048,feet:.3048,ft:.3048,inch:.0254,inches:.0254},
 mass:{kg:1,kgs:1,kilo:1,kilos:1,kilogram:1,kilograms:1,g:.001,gram:.001,grams:.001,mg:1e-6,milligram:1e-6,milligrams:1e-6,pound:.45359237,pounds:.45359237,lb:.45359237,lbs:.45359237,ounce:.0283495231,ounces:.0283495231,oz:.0283495231},
 volume:{l:1,liter:1,liters:1,litre:1,litres:1,ml:.001,milliliter:.001,milliliters:.001,millilitre:.001,millilitres:.001,gallon:3.785411784,gallons:3.785411784,cup:.2365882365,cups:.2365882365},
 speed:{kmh:1/3.6,kph:1/3.6,mph:.44704,'km/h':1/3.6,'m/s':1},
 temp:{celsius:'c',centigrade:'c',c:'c',fahrenheit:'f',f:'f',kelvin:'k',k:'k'}};
const UK=Object.values(U).flatMap(o=>Object.keys(o)).sort((a,b)=>b.length-a.length).map(x=>x.replace(/[/]/g,'\\/')).join('|');
function conv(v,a,b){a=a.toLowerCase();b=b.toLowerCase();for(const g in U){const o=U[g];if(a in o&&b in o){if(g=='temp'){const x=o[a],y=o[b];let c=x=='c'?v:x=='f'?(v-32)*5/9:v-273.15;return y=='c'?c:y=='f'?c*9/5+32:c+273.15}return v*o[a]/o[b]}}return null}
const convUnit=u=>u.replace(/s$/,'')==u?u:(UK.split('|').includes(u)?u:u);
function doConvert(v,a,b){const r=conv(v,a,b);if(r==null)return'I can’t convert '+a+' to '+b+'.';return fmtNum(v)+' '+a+' is about '+fmtNum(r)+' '+b+'.'}

/* ---------- websites ---------- */
const SITES={youtube:'https://www.youtube.com',google:'https://www.google.com',gmail:'https://mail.google.com',email:'https://mail.google.com',maps:'https://www.google.com/maps','google maps':'https://www.google.com/maps',drive:'https://drive.google.com','google drive':'https://drive.google.com',calendar:'https://calendar.google.com','google calendar':'https://calendar.google.com',photos:'https://photos.google.com','google photos':'https://photos.google.com',translate:'https://translate.google.com','google translate':'https://translate.google.com',news:'https://news.google.com',whatsapp:'https://wa.me/',instagram:'https://www.instagram.com',facebook:'https://www.facebook.com',twitter:'https://x.com',x:'https://x.com',reddit:'https://www.reddit.com',wikipedia:'https://www.wikipedia.org',amazon:'https://www.amazon.com',flipkart:'https://www.flipkart.com',netflix:'https://www.netflix.com',spotify:'https://open.spotify.com',github:'https://github.com',linkedin:'https://www.linkedin.com',telegram:'https://web.telegram.org',pinterest:'https://www.pinterest.com',claude:'https://claude.ai',gemini:'https://gemini.google.com','play store':'https://play.google.com/store','google play':'https://play.google.com/store',weather:'https://www.google.com/search?q=weather'};
const DISP={youtube:'YouTube',whatsapp:'WhatsApp',github:'GitHub',linkedin:'LinkedIn',x:'X',gmail:'Gmail'};
const INTERNAL=/^(?:settings?|status|report|colou?r|home|voice|chat|memory|vision|menu|knowledge|agents?|brain|tools?|mind)$/;
function resolveSite(n){n=String(n||'').toLowerCase().trim().replace(/^(?:the|my|to)\s+/,'').replace(/\s+(?:website|site|app|page|web)$/,'').replace(/^(?:https?:\/\/)/,'');
 if(!n||INTERNAL.test(n))return null;if(SITES[n])return{url:SITES[n],name:DISP[n]||n.replace(/\b[a-z]/g,c=>c.toUpperCase())};
 const d=n.replace(/\s+/g,'');if(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/.test(d))return{url:'https://'+d,name:d};return{unknown:n}}
const q=s=>encodeURIComponent(s);

/* ---------- jokes ---------- */
const JOKES=['Why don’t scientists trust atoms? Because they make up everything.','I told my computer I needed a break, and it said: no problem, I’ll go to sleep.','Why did the scarecrow win an award? He was outstanding in his field.','What do you call a fake noodle? An impasta.','Why do programmers prefer dark mode? Because light attracts bugs.','I would tell you a UDP joke, but you might not get it.','Why did the phone go to school? To improve its smart skills.','What did the ocean say to the beach? Nothing, it just waved.','Why was the math book sad? It had too many problems.','What do you call cheese that isn’t yours? Nacho cheese.','Why did the bicycle fall over? It was two tired.','How does a battery introduce itself? With a positive charge.'];

/* ---------- help ---------- */
const CATALOG=[
 ['Time & info',['what time is it','what’s the date','battery level','am I online']],
 ['Timers',['set a timer for 10 minutes','how much time is left','cancel my timer','start a stopwatch · stop the stopwatch']],
 ['Alarms',['set an alarm for 7 am','wake me up at 6:30 tomorrow','set an alarm for 7 am every day','cancel all alarms']],
 ['Reminders',['remind me to call mom in 10 minutes','remind me at 5 pm to drink water','what reminders do I have']],
 ['While ringing',['stop','snooze · snooze for 10 minutes']],
 ['Lists',['add milk to my shopping list','what’s on my to-do list','remove milk from my shopping list','clear my shopping list']],
 ['Web & maps',['open YouTube','search for best laptops','play lo-fi on YouTube','navigate to Connaught Place','find pharmacy near me','weather in Mumbai']],
 ['Maths',['what is 15 percent of 200','what’s 12 times 8','square root of 144','convert 5 km to miles','20 celsius to fahrenheit']],
 ['Fun',['flip a coin','roll a dice','pick a number between 1 and 50','choose pizza or burger','tell me a joke']],
 ['Contacts · needs voice security',['save mom’s number as 9876543210','call mom','text mom saying I’ll be late','whatsapp mom hello','list my contacts']],
 ['Other',['copy hello world to clipboard','help']]];

/* ---------- tools ---------- */
let pending=null;const T=[];
const tool=(id,level,m,run,decl,opts)=>T.push({id,level,m,run,decl,...opts});
const R=(re,t)=>{const x=re.exec(t);return x};

tool('time','safe',t=>/^(?:what(?:'s| is)? )?(?:the )?(?:current |local )?time(?: is it)?(?: right)?$|^what time is it(?: right)?$|^tell me the time$|^time please$/.test(t)?{}:null,()=>'It’s '+fmtClock(new Date())+'.');
tool('date','safe',t=>/^(?:what(?:'s| is)(?: the)? )?(?:today'?s )?date(?: today)?$|^what day (?:is it|is today)(?: today)?$|^what(?:'s| is) today$|^today'?s date$/.test(t)?{}:null,()=>'Today is '+new Date().toLocaleDateString([], {weekday:'long',day:'numeric',month:'long',year:'numeric'})+'.');
tool('battery','safe',t=>/^(?:what(?:'s| is) )?(?:the |my )?(?:phone )?battery(?: level| status| percentage| percent)?$|^how much battery(?: do i have| is left| left| remaining)?$|^battery (?:left|remaining)$|^check (?:the |my )?battery$/.test(t)?{}:null,async()=>{
 if(!navigator.getBattery)return'This browser doesn’t let me read the battery.';try{const b=await navigator.getBattery(),p=Math.round(b.level*100);return'Battery is at '+p+' percent'+(b.charging?' and charging.':'.')}catch(e){return'I couldn’t read the battery.'}});
tool('network','safe',t=>/^(?:am i|are we|is (?:the |my )?(?:internet|network|wifi|wi-fi|connection)) (?:online|connected|working|on|up)$|^(?:network|internet|connection|wifi) status$|^check (?:my |the )?(?:network|internet|connection|wifi)$/.test(t)?{}:null,()=>{
 if(!navigator.onLine)return'You’re offline.';const c=navigator.connection;return'You’re online'+(c&&c.effectiveType?', on a '+c.effectiveType.toUpperCase()+' connection':'')+(c&&c.saveData?', with data saver on':'')+'.'});

/* timers */
const timerM=t=>{let m=t.match(new RegExp('^(?:(?:set|start|create|make|begin)\\s+)?(?:an? )?(?:timer|countdown)(?:\\s+(?:for|of))?\\s*('+DUR+')?(?:\\s+(?:called|named|labell?ed|for)\\s+(.+))?$'))||t.match(new RegExp('^(?:(?:set|start|create|make|begin)\\s+)?(?:an? )?('+DUR+')\\s*(?:timer|countdown)(?:\\s+(?:called|named|labell?ed|for)\\s+(.+))?$'));
 if(!m)m=t.match(new RegExp('^(?:set|start|create|make)\\s+(?:an? )?(?:timer|countdown)\\s+(.+?)\\s+for\\s+('+DUR+')$'))&&(x=>[x[0],x[2],x[1]])(t.match(new RegExp('^(?:set|start|create|make)\\s+(?:an? )?(?:timer|countdown)\\s+(.+?)\\s+for\\s+('+DUR+')$')));
 if(!m)return null;return{ms:m[1]?parseDuration(m[1]):0,label:(m[2]||'').trim()}};
tool('timer_set','safe',t=>timerM(numify(t)),({ms,label})=>{if(!ms||ms<1e3)return'How long should the timer be? For example: set a timer for 10 minutes.';if(ms>7*864e5)return'That’s too long for a timer. I can do up to 7 days.';addItem('timer',Date.now()+ms,label,{ms});return'Timer set for '+fmtDur(ms)+(label?' for '+label:'')+'.'+warn()},
 {name:'set_timer',description:'Start a countdown timer. Use when the user asks for a timer.',parameters:{type:'object',properties:{duration_seconds:{type:'integer',description:'Length of the timer in seconds'},label:{type:'string',description:'Optional label'}},required:['duration_seconds']},from:a=>({ms:Math.round(+a.duration_seconds*1000),label:a.label||''})});

/* alarms */
const alarmArgs=(txt,label0)=>{let rep=/\b(?:every ?day|daily|each day|everyday)\b/.test(txt);txt=txt.replace(/\b(?:every ?day|daily|each day|everyday)\b/,' ');let lab=label0||'';const lm=txt.match(/\b(?:called|named|labell?ed|saying)\s+(.+)$/);if(lm){lab=lm[1];txt=txt.replace(lm[0],' ')}
 const w=parseWhen(txt,'alarm');if(!w)return{at:null};return{at:w.at,label:lab||w.rest,repeat:rep}};
const alarmM=t=>{if(/^(?:cancel|delete|remove|clear|stop|turn off|disable)\b/.test(t))return null;let m=t.match(/^(?:(?:set|create|make|add|schedule)\s+)?(?:an? )?alarm(?:\s+(?:for|at|in))?\s+(.+)$/)||t.match(/^wake (?:me )?(?:up )?(.+)$/)||t.match(/^(?:(?:set|create|make|add)\s+)?(?:an? )?(.+?)\s+alarm$/);
 if(!m){if(/^(?:(?:set|create|make|add)\s+)?(?:an? )?alarm$/.test(t))return{at:null};return null}
 let rest=m[1];if(/^(?:in\s)?/.test(t)&&/^(?:(?:set|create|make|add|schedule)\s+)?(?:an? )?alarm\s+in\s+/.test(t))rest='in '+rest;return alarmArgs(rest)};
tool('alarm_set','safe',t=>alarmM(t),({at,label,repeat})=>{if(!at)return'What time should I set it for? For example: set an alarm for 7 am.';addItem('alarm',at,label,{repeat:repeat?'daily':undefined});return'Alarm set for '+fmtWhen(at).replace(/^at /,'')+(repeat?', every day':'')+(label?', labelled '+label:'')+'.'+warn()},
 {name:'set_alarm',description:'Set an alarm at a clock time or after a delay. time is natural language such as "7:30 am", "tomorrow at 6", "in 8 hours".',parameters:{type:'object',properties:{time:{type:'string'},label:{type:'string'},repeat_daily:{type:'boolean'}},required:['time']},from:a=>{const x=alarmArgs(String(a.time||''),a.label);if(a.repeat_daily)x.repeat=true;return x}});

/* reminders */
const remArgs=txt=>{const w=parseWhen(txt,'reminder');if(!w)return{at:null,raw:txt};const label=tidy(w.rest.replace(/^(?:to|that|about)\s+/,''));return{at:w.at,label}};
const remM=t=>{const m=t.match(/^remind me\s+(.+)$/)||t.match(/^(?:(?:set|create|add|make)\s+)?(?:a )?reminder\s+(.+)$/);return m?remArgs(m[1]):null};
tool('reminder_set','safe',t=>remM(t),({at,label,raw})=>{if(!at)return'When should I remind you? Say it with a time, like: remind me to '+(raw?tidy(String(raw).replace(/^(?:to|that|about)\s+/,'')):'call mom')+' at 5 pm.';
 addItem('reminder',at,label||'do that');return'Okay, I’ll remind you '+(label?'to '+flip(label)+' ':'')+fmtWhen(at)+'.'+warn()},
 {name:'set_reminder',description:'Set a reminder for later. task = what to be reminded about; time = natural language such as "in 10 minutes", "at 5 pm", "tomorrow at 9".',parameters:{type:'object',properties:{task:{type:'string'},time:{type:'string'}},required:['task','time']},from:a=>remArgs(String(a.time||'')+' '+String(a.task||''))});

/* list / cancel / snooze */
const KINDS={timer:'timer',timers:'timer',alarm:'alarm',alarms:'alarm',reminder:'reminder',reminders:'reminder'};
tool('schedule_list','safe',t=>{let m=t.match(/^(?:what|which|show|list|read|tell me)(?: me)?(?: are| is)?(?: all)?(?: my| the)?(?: active| pending| upcoming| current)? (timers?|alarms?|reminders?)(?: do i have| i have| are set| are running| are active| are there| left| set)?$/)||t.match(/^do i have any (timers?|alarms?|reminders?)(?: set)?$/)||t.match(/^(?:what(?:'s| is) )?(?:my )?(schedule)$/);
 if(m)return{kind:KINDS[m[1]]||'any'};if(/^(?:how (?:much|long)(?: time)? (?:is )?left(?: on (?:my |the )?timer)?|how much time is left|time left(?: on (?:my |the )?timer)?|how long is left)$/.test(t))return{kind:'timer'};
 if(/^(?:show|list|what(?:'s| is)) (?:my )?(?:timers and alarms|alarms and reminders|everything scheduled)$/.test(t))return{kind:'any'};return null},({kind})=>{
 const a=sched.filter(i=>kind=='any'||i.type==kind).sort((x,y)=>x.at-y.at);if(!a.length)return kind=='any'?'You have nothing scheduled.':'You have no '+kind+'s set.';
 return'You have '+plural(a.length,kind=='any'?'item':kind)+': '+a.map(i=>{const left=fmtDur(i.at-Date.now());return i.type=='timer'?describe(i)+', '+left+' left':describe(i)+', in '+left}).join('; ')+'.'});
tool('schedule_cancel','safe',t=>{const m=t.match(/^(?:cancel|delete|remove|clear|stop|turn off|disable)\s+(?:all |every |any )?(?:of )?(?:my |the |that |this |these )?(all )?(timers?|alarms?|reminders?)(?: all| now)?$/);if(!m)return null;return{kind:KINDS[m[2]],all:/\ball\b|\bevery\b/.test(t)||/s$/.test(m[2])}},({kind,all})=>{
 const a=sched.filter(i=>i.type==kind).sort((x,y)=>x.at-y.at);if(!a.length)return'You have no '+kind+'s set.';
 const kill=l=>{l.forEach(i=>{if(ringing.has(i.id)){clearInterval(ringing.get(i.id).iv);ringing.delete(i.id)}});const ids=l.map(i=>i.id);sched=sched.filter(i=>!ids.includes(i.id));saveS();paintRing()};
 if(all&&a.length>1)return{confirm:'Cancel all '+a.length+' '+kind+'s?',yes:()=>{kill(a);return'Cancelled all '+kind+'s.'}};
 kill([a[0]]);return'Cancelled '+describe(a[0])+'.'+(a.length>1?' You still have '+plural(a.length-1,kind)+'.':'')});
tool('snooze','safe',t=>{const m=t.match(new RegExp('^snooze(?:\\s+(?:for\\s+)?('+DUR+'))?$'));return m?{ms:m[1]?parseDuration(m[1]):300000}:null},({ms})=>{if(!ringing.size)return'Nothing is ringing right now.';const n=ringing.size;[...ringing.keys()].forEach(id=>stopRing(id,ms));return'Snoozed for '+fmtDur(ms)+'.'});

/* stopwatch */
tool('stopwatch','safe',t=>{if(/^(?:start|begin|run)(?: the| a| my)? stopwatch$|^stopwatch start$/.test(t))return{op:'start'};if(/^(?:stop|pause|end)(?: the| my)? stopwatch$|^stopwatch stop$/.test(t))return{op:'stop'};
 if(/^(?:reset|clear)(?: the| my)? stopwatch$/.test(t))return{op:'reset'};if(/^(?:check|show|read|what(?:'s| is))(?: the| my)? stopwatch(?: time)?$|^stopwatch(?: time)?$|^lap$/.test(t))return{op:'check'};return null},({op})=>{const s=swGet();
 if(op=='start'){if(s.run)return'The stopwatch is already running: '+fmtDur(swEl(s))+'.';ls.set(K.sw,{run:true,t0:Date.now(),acc:s.acc});return s.acc?'Stopwatch resumed.':'Stopwatch started.'}
 if(op=='stop'){if(!s.run)return'The stopwatch isn’t running.';const e=swEl(s);ls.set(K.sw,{run:false,t0:0,acc:e});return'Stopped at '+fmtDur(e)+'.'}
 if(op=='reset'){ls.set(K.sw,{run:false,t0:0,acc:0});return'Stopwatch reset.'}
 return s.run||s.acc?'The stopwatch '+(s.run?'is at ':'stopped at ')+fmtDur(swEl(s))+'.':'The stopwatch hasn’t been started.'});

/* lists */
const LN='(?:([a-z][a-z -]*?) )?';
tool('list_add','safe',t=>{let m=t.match(new RegExp('^add (.+?) (?:to|on|in|into) (?:my |the |our )?'+LN+'(?:list|todos?|to-do|tasks?)$'));if(m)return{items:splitItems(m[1]),list:lname(m[2])};
 m=t.match(/^(?:add|create|new) (?:a )?(?:task|todo|to-do)(?: to)?\s+(.+)$/);if(m)return{items:splitItems(m[1]),list:'to-do'};return null},a=>listAdd(a),
 {name:'add_to_list',description:'Add an item to one of the user\'s lists (default "to-do"; "shopping" for groceries).',parameters:{type:'object',properties:{item:{type:'string'},list:{type:'string'}},required:['item']},from:a=>({items:splitItems(a.item),list:lname(a.list)})});
function listAdd({items,list}){if(!items.length)return'What should I add?';const L=lists(),a=L[list]||(L[list]=[]),added=[];for(const i of items)if(!a.some(x=>x.toLowerCase()==i.toLowerCase())){a.push(i);added.push(i)}saveL(L);
 return added.length?'Added '+added.join(', ')+' to your '+list+' list. It now has '+plural(a.length,'item')+'.':'That’s already on your '+list+' list.'}
tool('list_show','safe',t=>{const m=t.match(new RegExp('^(?:what(?:\'s| is)(?: on| in)?|show|read|list|tell me|read out|read me)(?: me)?(?: (?:my|the|our))? ?'+LN+'(?:list|todos?|to-do list|tasks)$'));if(m)return{list:lname(m[1])};
 const n=t.match(/^(?:what(?:'s| is) on my|show my|read my) ([a-z -]+)$/);return n&&/(?:todo|to-do|tasks)$/.test(n[1])?{list:'to-do'}:null},a=>listShow(a),
 {name:'read_list',description:'Read out one of the user\'s lists.',parameters:{type:'object',properties:{list:{type:'string'}}},from:a=>({list:lname(a.list)})});
function listShow({list}){const a=lists()[list]||[];return a.length?'Your '+list+' list has '+plural(a.length,'item')+': '+a.join(', ')+'.':'Your '+list+' list is empty.'}
tool('list_remove','safe',t=>{const m=t.match(new RegExp('^(?:remove|delete|cross off|take off|tick off|check off|strike off) (.+?) (?:from|off|on|in) (?:my |the |our )?'+LN+'(?:list|todos?|to-do|tasks?)$'));return m?{item:m[1],list:lname(m[2])}:null},({item,list})=>{
 const L=lists(),a=L[list]||[],i=item.toLowerCase(),k=a.findIndex(x=>x.toLowerCase()==i)>=0?a.findIndex(x=>x.toLowerCase()==i):a.findIndex(x=>x.toLowerCase().includes(i));
 if(k<0)return'I couldn’t find '+item+' on your '+list+' list.';const g=a.splice(k,1)[0];saveL(L);return'Removed '+g+' from your '+list+' list.'});
tool('list_clear','safe',t=>{const m=t.match(new RegExp('^(?:clear|empty|wipe|delete) (?:out )?(?:all )?(?:my |the |our )?'+LN+'(?:list|todos?|to-do list|tasks)$'));return m?{list:lname(m[1])}:null},({list})=>{
 const a=lists()[list]||[];if(!a.length)return'Your '+list+' list is already empty.';return{confirm:'Clear your '+list+' list with '+plural(a.length,'item')+'?',yes:()=>{const L=lists();delete L[list];saveL(L);return'Cleared your '+list+' list.'}}});

/* contacts + call / text / whatsapp */
tool('contact_save','safe',t=>{let m=t.match(/^(?:save|add|store|set)\s+(?:the\s+)?(?:contact\s+)?([a-z][a-z ]*?)(?:'s)?\s+(?:phone |mobile |contact )?(?:number|no|phone)\s+(?:as|is|to)\s+(.+)$/)||t.match(/^(?:save|add|store)\s+(?:the\s+)?(?:contact|number)\s+(.+?)\s+(?:as|for|to)\s+([a-z][a-z ]*)$/)&&(x=>[x[0],x[2],x[1]])(t.match(/^(?:save|add|store)\s+(?:the\s+)?(?:contact|number)\s+(.+?)\s+(?:as|for|to)\s+([a-z][a-z ]*)$/));
 return m?{name:m[1].trim().replace(/^my /,''),num:digits(m[2])}:null},({name,num})=>{if(!okNum(num))return'That number doesn’t look right. Say it digit by digit, like: save mom’s number as 9 8 7 6 5 4 3 2 1 0.';const c=contacts();c[name]=num;saveC(c);return'Saved '+name+'’s number.'});
tool('contact_list','safe',t=>/^(?:list|show|read|who are)(?: me)?(?: all)?(?: my| the)? (?:saved )?contacts$|^who(?:'s| is) in my contacts$/.test(t)?{}:null,()=>{const k=Object.keys(contacts());return k.length?'You have '+plural(k.length,'contact')+' saved: '+k.join(', ')+'.':'You haven’t saved any contacts yet. Say: save mom’s number as, then the digits.'});
tool('contact_delete','safe',t=>{const m=t.match(/^(?:delete|remove) (?:the )?(?:contact )?([a-z][a-z ]*?)(?:'s)?(?: contact| number)$/)||t.match(/^(?:delete|remove) contact ([a-z][a-z ]*)$/);return m?{name:m[1].replace(/^my /,'')}:null},({name})=>{
 const r=resolveContact(name);if(!r||okNum(r.name))return'I don’t have a contact called '+name+'.';return{confirm:'Delete the contact '+r.name+'?',yes:()=>{const c=contacts();delete c[r.name];saveC(c);return'Deleted '+r.name+'.'}}});
const needContact=n=>'I don’t have a number saved for '+n+'. Say: save '+n+'’s number as, then the digits.';
const sentence=s=>cap(String(s||'').trim());
tool('whatsapp','sensitive',t=>{let m=t.match(/^(?:send (?:a )?)?whatsapp(?: message)?(?: to)? (.+?)(?:\s+(?:saying|that says|that|with message|message)\s+(.+))?$/)||t.match(/^(?:send (?:a )?)?(?:message|text) (?:to )?(.+?) (?:on|via|using|in) whatsapp(?:\s+(?:saying|that says|that)\s+(.+))?$/);return m?{who:m[1],body:m[2]}:null},({who,body})=>{
 if(/^me\b/.test(who))return null;const r=resolveContact(who);if(!r)return needContact(who);const n=r.num.replace(/^\+/,'');openLink('https://wa.me/'+n+(body?'?text='+q(sentence(body)):''),'WhatsApp '+r.name,false);return'Ready to WhatsApp '+r.name+(body?': '+sentence(body)+'.':'.')+' Tap the button to open it. I never send it for you.'});
tool('sms','sensitive',t=>{const m=t.match(/^(?:send (?:an? )?(?:text|sms|message)(?: message)? to|text|sms|message)\s+(.+?)(?:\s+(?:saying|that says|that|with message|message)\s+(.+))?$/);return m&&!/\bwhatsapp\b/.test(t)?{who:m[1],body:m[2]}:null},({who,body})=>{
 if(/^(?:me|us|him|her|them|back)\b/.test(who))return'Who should I text? Say a saved name or number.';const r=resolveContact(who);if(!r)return needContact(who);openLink('sms:'+r.num+(body?'?body='+q(sentence(body)):''),'Text '+r.name,false);return'Ready to text '+r.name+(body?': '+sentence(body)+'.':'.')+' Tap the button to open Messages. You press send.'});
tool('call','sensitive',t=>{const m=t.match(/^(?:call|phone|ring|dial)\s+(.+)$/);return m&&!/^(?:me|us|an?|the)\b/.test(m[1])?{who:m[1]}:null},({who})=>{const r=resolveContact(who);if(!r)return needContact(who);openLink('tel:'+r.num,'Call '+r.name,false);return'Ready to call '+r.name+'. Tap the button to start the call.'});

/* web */
tool('youtube','safe',t=>{const m=t.match(/^(?:play|search|find|watch|show me)\s+(.+?)\s+(?:on|in|at)\s+youtube$/)||t.match(/^(?:search )?youtube (?:for )?(.+)$/)||t.match(/^search (?:on )?youtube for (.+)$/);return m?{query:m[1]}:null},({query})=>opened(openLink('https://www.youtube.com/results?search_query='+q(query),'YouTube: '+query,true),'YouTube for '+query));
tool('spotify','safe',t=>{const m=t.match(/^(?:play|search|find)\s+(.+?)\s+(?:on|in)\s+spotify$/);return m?{query:m[1]}:null},({query})=>opened(openLink('https://open.spotify.com/search/'+q(query),'Spotify: '+query,true),'Spotify for '+query));
const mapsGo=({query,mode})=>{const u=mode=='directions'?'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination='+q(query):'https://www.google.com/maps/search/?api=1&query='+q(query);return opened(openLink(u,'Maps: '+query,true),mode=='directions'?'directions to '+query:'maps for '+query)};
tool('maps','safe',t=>{let m=t.match(/^(?:navigate|directions?|route|take me|drive|walk|get me|guide me)(?: me)?\s+(?:to|towards?)\s+(.+)$/)||t.match(/^(?:give me |show me |get )?directions?(?: to| for)\s+(.+)$/);if(m)return{query:m[1],mode:'directions'};
 m=t.match(/^(?:show|find|search|look for|open)\s+(.+?)\s+(?:on (?:the )?(?:google )?maps?)$/);if(m)return{query:m[1],mode:'search'};
 m=t.match(/^(?:find|show me|search for|look for|where(?:'s| is)(?: the)?(?: nearest| closest)?)\s+(.+?)\s+(?:near me|nearby|near by|around me|close to me|around here|near here)$/)||t.match(/^(?:find|show me|where(?:'s| is)) (?:the )?(?:nearest|closest) (.+)$/);
 return m?{query:m[1]+' near me',mode:'search'}:null},mapsGo,
 {name:'maps',description:'Open Google Maps. mode "directions" navigates to a destination; mode "search" finds places (add "near me" for nearby).',parameters:{type:'object',properties:{query:{type:'string'},mode:{type:'string',enum:['directions','search']}},required:['query']},from:a=>({query:String(a.query||''),mode:a.mode=='directions'?'directions':'search'})});
tool('weather','safe',t=>{const m=t.match(/^(?:what(?:'s| is) )?(?:the )?(?:weather|temperature|forecast)(?: like)?(?: today| now| right now| tomorrow)?(?: in| for| at)?(?: (.+))?$/)||t.match(/^how(?:'s| is) the weather(?: in (.+))?$/);return m?{place:m[1]||''}:null},({place})=>
 opened(openLink('https://www.google.com/search?q='+q('weather '+place),'Weather'+(place?' in '+place:''),true),'the weather'+(place?' in '+place:'')));
tool('open_site','safe',t=>{const m=t.match(/^(?:open|go to|launch|take me to|visit|browse|load)\s+(.+)$/);if(!m)return null;const s=resolveSite(m[1]);return s?s:null},s=>{if(s.unknown)return'I don’t know a site called '+s.unknown+'. Try saying the address, like example dot com.';return opened(openLink(s.url,s.name,true),s.name)},
 {name:'open_website',description:'Open a website by common name (youtube, gmail, maps, wikipedia…) or domain.',parameters:{type:'object',properties:{site:{type:'string'}},required:['site']},from:a=>resolveSite(a.site)||{unknown:String(a.site||'')}});
tool('web_search','safe',t=>{const m=t.match(/^(?:search|google|look up|lookup|search up)(?: (?:the )?(?:web|internet|google|online))?(?: for| about)?\s+(.+)$/);return m&&!/\b(?:notes?|knowledge|documents?)\b/.test(t.slice(0,40))?{query:m[1]}:null},({query})=>opened(openLink('https://www.google.com/search?q='+q(query),'Search: '+query,true),'a search for '+query),
 {name:'web_search',description:'Open a Google search in the browser for the user. Use for "search for / look up X" requests.',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']},from:a=>({query:String(a.query||'')})});

/* maths */
tool('convert','safe',t=>{const n=numify(t);let m=n.match(new RegExp('^(?:(?:what(?:\'s| is)|how much is|convert)\\s+)?(-?\\d+(?:\\.\\d+)?)\\s*('+UK+')\\s+(?:to|into|in|=)\\s+('+UK+')$'));if(m)return{v:+m[1],a:m[2],b:m[3]};
 m=n.match(new RegExp('^how many ('+UK+') (?:are |is )?(?:there )?in (?:an? |one )?(-?\\d+(?:\\.\\d+)?)?\\s*('+UK+')$'));return m?{v:m[2]?+m[2]:1,a:m[3],b:m[1]}:null},({v,a,b})=>doConvert(v,a,b),
 {name:'convert_units',description:'Convert between units of length, mass, volume, speed or temperature.',parameters:{type:'object',properties:{value:{type:'number'},from_unit:{type:'string'},to_unit:{type:'string'}},required:['value','from_unit','to_unit']},from:a=>({v:+a.value,a:String(a.from_unit||''),b:String(a.to_unit||'')})});
tool('calculate','safe',t=>{const n=numify(t);let m=n.match(/^(?:what(?:'s| is)|calculate|compute|how much is|work out|solve|whats)\s+(?:the\s+)?(.+)$/),e=m?m[1]:n;if(!/\d/.test(e)&&!/square root/.test(e))return null;if(!m&&!/\b(?:plus|minus|times|divided|multiplied|percent|squared|cubed|square root|power)\b|^[\d\s.+\-*/^()x%]+$/.test(e))return null;
 return calc(e)==null?null:{expr:e}},({expr})=>{const r=calc(expr);return r==null?'I couldn’t work that out.':/[a-z]/.test(r)&&/^I /.test(r)?r:'That’s '+r+'.'},
 {name:'calculate',description:'Evaluate an arithmetic expression, e.g. "15% of 200" or "12*8+3". Use for any calculation.',parameters:{type:'object',properties:{expression:{type:'string'}},required:['expression']},from:a=>({expr:String(a.expression||'')})});

/* fun */
tool('coin','safe',t=>/^(?:flip|toss|spin)(?: a| the)? coin$|^heads or tails$/.test(t)?{}:null,()=>'It’s '+(rnd(2)?'heads':'tails')+'.');
tool('dice','safe',t=>{let m=numify(t).match(/^(?:roll|throw)(?: (?:an?|(\d+)))?(?: (\d+)[- ]sided)? (?:dice|die|dices)(?: (\d+)[- ]sided)?$/);if(m)return{n:Math.min(+m[1]||1,10),s:Math.min(+(m[2]||m[3])||6,1000)};
 m=t.match(/^roll (?:an? )?d(\d+)$/);return m?{n:1,s:Math.min(+m[1]||6,1000)}:null},({n,s})=>{if(s<2)return'A die needs at least two sides.';const r=Array.from({length:n},()=>rnd(s)+1);return n==1?'You rolled a '+r[0]+'.':'You rolled '+r.join(', ')+', total '+r.reduce((a,b)=>a+b,0)+'.'});
tool('random','safe',t=>{const m=numify(t).match(/^(?:pick|choose|give me|generate|random)(?: me)?(?: an?)?(?: random)? number(?: (?:between|from) (\d+) (?:and|to) (\d+))?$/);return m?{a:m[1]?+m[1]:1,b:m[2]?+m[2]:100}:null},({a,b})=>{if(a>b)[a,b]=[b,a];return'I pick '+(a+rnd(b-a+1))+'.'});
tool('choose','safe',t=>{const m=t.match(/^(?:pick|choose|decide)(?: (?:one|something))?(?: (?:of|from|between))? (.+)$/);if(!m||/\bnumber\b/.test(m[1]))return null;const o=m[1].split(/\s*(?:,|\bor\b)\s*/).map(x=>x.trim()).filter(Boolean);return o.length>=2?{o}:null},({o})=>'I choose '+o[rnd(o.length)]+'.');
tool('joke','safe',t=>/^(?:tell me|say|give me)(?: a| another| one)?(?: funny)? joke$|^(?:another|one more|a) joke$|^joke$|^make me laugh$/.test(t)?{}:null,()=>JOKES[rnd(JOKES.length)]);
tool('copy','safe',t=>{const m=t.match(/^copy (.+?)(?: to (?:the |my )?clipboard)?$/);return m&&m[1]!='that'?{text:m[1]}:null},async({text})=>{try{await navigator.clipboard.writeText(text);return'Copied.'}catch(e){return'Chrome wouldn’t let me copy that. Tap the screen once and try again.'}});
/* ---------- memory tools (Gemini function calls; the spoken "remember … / forget …" grammar lives in alisa-mind.js) ----------
   All logic, secret filtering and ambiguity handling is in ALISAMind.tools. A model-initiated update/forget never applies by itself:
   it asks "Change/Forget …? Say yes to confirm." and only the user's spoken/typed "yes" (see parse → _confirm) runs the change. */
const MT=()=>window.ALISAMind&&window.ALISAMind.tools,mAsk=r=>r.status==='needs-confirmation'?{confirm:r.text,yes:async()=>(await r.commit()).text}:r.text,noMem='My memory isn’t available right now.';
const strOrU=v=>typeof v==='string'&&v.trim()?v:undefined,tagsOf=v=>Array.isArray(v)?v.filter(x=>typeof x==='string').slice(0,10):undefined;
tool('remember','safe',()=>null,async a=>{const T=MT();return T?mAsk(await T.remember(a,{source:'model'})):noMem},
 {name:'remember',description:'Save a fact, preference or goal about the user in long-term memory. Use ONLY when the user asks you to remember something. Never pass passwords, keys, tokens or card numbers.',
  parameters:{type:'object',properties:{content:{type:'string',description:'The thing to remember, as a short statement'},category:{type:'string',enum:['preferences','importantFacts','goals','approvedMemories']},tags:{type:'array',items:{type:'string'},description:'Optional short keywords'},private:{type:'boolean',description:'True if the user says this is private; private memories are never sent to the cloud'}},required:['content']},
  from:a=>({content:strOrU(a.content),category:strOrU(a.category),tags:tagsOf(a.tags),private:a.private===true})});
tool('search_memory','safe',()=>null,async a=>{const T=MT();return T?mAsk(await T.search(a,{source:'model'})):noMem},
 {name:'search_memory',description:'Look up what the user has asked ALISA to remember. Use when the user asks what you know or remember about something.',
  parameters:{type:'object',properties:{query:{type:'string',description:'What to look for'},limit:{type:'integer',description:'Max results (1-5)'}},required:['query']},
  from:a=>({query:strOrU(a.query),limit:a.limit})});
tool('update_memory','safe',()=>null,async a=>{const T=MT();return T?mAsk(await T.update(a,{source:'model'})):noMem},
 {name:'update_memory',description:'Correct or change an existing memory. query describes the OLD memory; new_content is the replacement. The user is asked to confirm before anything changes.',
  parameters:{type:'object',properties:{query:{type:'string',description:'Words describing the existing memory'},new_content:{type:'string',description:'The corrected memory text'}},required:['query','new_content']},
  from:a=>({query:strOrU(a.query),new_content:strOrU(a.new_content)})},{modelConfirm:true});
tool('forget_memory','safe',()=>null,async a=>{const T=MT();return T?mAsk(await T.forget(a,{source:'model'})):noMem},
 {name:'forget_memory',description:'Delete a memory the user asked you to forget. query describes the memory. The user is asked to confirm before anything is deleted.',
  parameters:{type:'object',properties:{query:{type:'string',description:'Words describing the memory to forget'}},required:['query']},
  from:a=>({query:strOrU(a.query)})},{modelConfirm:true});

tool('help','safe',t=>/^(?:help|what can you do|what are (?:your|the) (?:commands|abilities|skills|tools)|show (?:me )?(?:your )?commands|list (?:your )?commands|what commands do you (?:have|know))$/.test(t)?{}:null,()=>
 'I can do timers, alarms and reminders, lists, quick maths and unit conversions, open websites and maps, search the web, and call or text your saved contacts. Open Settings, Tools, to see every command.');

/* ---------- parse / execute ---------- */
const YES=/^(?:yes|yeah|yep|yup|sure|ok|okay|confirm|do it|go ahead|yes please|please do|affirmative)$/,NO=/^(?:no|nope|nah|cancel|never ?mind|don't|do not|abort|stop)$/,STOPR=/^(?:stop|dismiss|silence|quiet|enough|got it|done|turn it off|turn off|shut up|stop it|stop (?:the )?(?:alarm|timer|ringing|reminder|sound)|i'm up|i am up|okay stop)$/;

/* ---------- Hindi / Hinglish layer ----------
   toEnglish(): rewrites Hindi (देवनागरी) and Roman-script Hinglish commands into the English phrasing the tools above already understand.
   English input passes through untouched. localize(): speaks results back in the language chosen in the ALISA menu (hi / hg / en). */
const DEV={'टाइमर':'timer','अलार्म':'alarm','मिनट':'minute','घंटा':'ghanta','घंटे':'ghante','सेकंड':'second','सेकेंड':'second','दिन':'din','कल':'kal','आज':'aaj','परसों':'parso','सुबह':'subah','दोपहर':'dopahar','शाम':'shaam','रात':'raat','बजे':'baje','लगाओ':'lagao','लगा':'laga','दो':'do','दीजिए':'do','करो':'karo','करें':'karo','कर':'kar','खोलो':'kholo','खोल':'khol','चलाओ':'chalao','शुरू':'shuru','बंद':'band','रोको':'roko','समय':'samay','टाइम':'time','क्या':'kya','है':'hai','हैं':'hai','कितना':'kitna','कितने':'kitne','का':'ka','की':'ki','के':'ke','को':'ko','लिए':'liye','मुझे':'mujhe','मेरे':'mere','मेरी':'meri','मेरा':'mera','याद':'yaad','दिलाओ':'dilao','दिलाना':'dilana','जगाओ':'jagao','जगा':'jaga','लिस्ट':'list','में':'mein','जोड़ो':'jodo','जोड़':'jod','हटाओ':'hatao','दिखाओ':'dikhao','बताओ':'batao','सुनाओ':'sunao','चुटकुला':'chutkula','जोक':'joke','बैटरी':'battery','तारीख':'tareekh','तारीख़':'tareekh','नेटवर्क':'network','इंटरनेट':'internet','वाईफाई':'wifi','एक':'ek','तीन':'teen','चार':'char','पाँच':'paanch','पांच':'paanch','छह':'chhe','सात':'saat','आठ':'aath','नौ':'nau','दस':'das','पंद्रह':'pandrah','बीस':'bees','तीस':'tees','चालीस':'chalis','पचास':'pachas','आधा':'aadha','डेढ़':'dedh','ढाई':'dhai','हाँ':'haan','हां':'haan','जी':'ji','नहीं':'nahi','ठीक':'theek','कॉल':'call','फोन':'phone','मैसेज':'message','व्हाट्सएप':'whatsapp','यूट्यूब':'youtube','गूगल':'google','पर':'pe','पे':'pe','खोजो':'khojo','ढूंढो':'dhundo','जमा':'jama','घटा':'ghata','गुणा':'guna','भाग':'bhag','प्लस':'plus','माइनस':'minus','अलीसा':'alisa','एलिसा':'alisa','स्टॉपवॉच':'stopwatch','सिक्का':'sikka','उछालो':'uchhalo','पासा':'pasa','फेंको':'phenko','मौसम':'mausam','कैसा':'kaisa','रद्द':'radd','चालू':'chalu','रोज़':'roz','रोज':'roz','हर':'har','सहेजो':'save','नंबर':'number','नंबर':'number','रास्ता':'rasta','मदद':'madad','और':'aur','भेजो':'bhejo','सारे':'saare','सभी':'sabhi','खाली':'khali','साफ':'saaf','शॉपिंग':'shopping','सूची':'list','काम':'kaam'};
const DIG={'०':'0','१':'1','२':'2','३':'3','४':'4','५':'5','६':'6','७':'7','८':'8','९':'9'};
const NUMW={ek:1,teen:3,char:4,chaar:4,paanch:5,panch:5,chhe:6,chhah:6,che:6,saat:7,aath:8,nau:9,das:10,gyarah:11,barah:12,terah:13,chaudah:14,pandrah:15,solah:16,satrah:17,atharah:18,unnis:19,bees:20,pachis:25,pachees:25,tees:30,chalis:40,pachas:50,pachaas:50,saath:60};
const HI_GATE=/[\u0900-\u097f]|\b(?:kya|hai|hain|ka|ki|ke|ko|mein|lagao|karo|kholo|sunao|batao|jodo|hatao|yaad|baje|kal|aaj|subah|shaam|raat|mujhe|mere|haan|nahi|nahin|kitna|kitne|samay|chalao|dikhao|shuru|band|roko|dhundo|khojo|jagao|mausam|chutkula|sikka|pasa|madad)\b/;
const TIMERE=/(?:in \d+(?:\.\d+)? (?:seconds|minutes|hours|days)|day after tomorrow|tomorrow|today|tonight|morning|afternoon|evening|night|at \d{1,2}(?::\d{2})?(?:\s?(?:am|pm))?|every day)/g;
const DURH=/(?:(?:\d+(?:\.\d+)?|half an)\s*(?:seconds?|minutes?|hours?|days?)\s*)+/;
function toEnglish(raw){let s=String(raw||'');if(!HI_GATE.test(s.toLowerCase()))return raw;
 s=s.replace(/[०-९]/g,c=>DIG[c]).replace(/[।,?!]/g,' ').split(/\s+/).map(w=>DEV[w]||w).join(' ').toLowerCase();
 s=s.replace(/\b(?:yaar|zara|na|bhai|plz|please|thoda|bas|toh|to|zaroor|jaldi|abhi|alisa|alissa|aliza|elisa|ji)\b/g,' ')
  .replace(/\b(?:laga ?d[oe]|laga ?dijiye|lagaiye|lagayiye|lagana|lagao)\b/g,'lagao').replace(/\b(?:kar ?d[oe]|kar ?dijiye|kijiye|kariye|karna|karein|karo)\b/g,'karo')
  .replace(/\b(?:khol ?d[oe]|kholiye|kholo)\b/g,'kholo').replace(/\b(?:suna ?d[oe]|sunaiye|sunao)\b/g,'sunao').replace(/\b(?:dikha ?d[oe]|dikhaiye|bata ?d[oe]|bataiye|dikhao|batao)\b/g,'batao')
  .replace(/\byaad dila (?:do|dena|dijiye|de)\b|\byaad (?:dilana|dilaiye|dilao)\b/g,'yaad dilao').replace(/\b(?:jaga ?d[oe]|jaga ?dena|jagana|jagao)\b/g,'jagao')
  .replace(/\b(?:shuru|chalu|start)\s+karo\b|\bchalao\b/g,'shuru').replace(/\b(?:band|stop)\s+karo\b|\brok ?do\b|\broko\b/g,'band').replace(/\b(?:hata ?d[oe]|mita ?d[oe]|nikaal ?d[oe]|hatao|delete karo)\b/g,'hatao')
  .replace(/\b(?:jod ?d[oe]|daal ?d[oe]|dal ?d[oe]|daalo|add karo|jodo)\b/g,'jodo').replace(/\b(?:sabhi|saare|sare)\b/g,'all');
 s=s.replace(/\baadha (?:ghanta|ghante|ghantey)\b/g,'half an hour').replace(/\bdedh (?:ghanta|ghante)\b/g,'1.5 hours').replace(/\bdhai (?:ghanta|ghante)\b/g,'2.5 hours')
  .replace(/\bdo(?=\s+(?:minute|min|mins|minat|ghanta|ghante|second|sec|din|baje))/g,'2').replace(/\b([a-z]+)\b(?=\s*(?:minute|min|mins|minat|mint|ghanta|ghante|second|sec|din|dino|baje|hours?|minutes?|seconds?))/g,(a,w)=>NUMW[w]!=null?NUMW[w]:a);
 s=s.replace(/\b(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|minat|mint)\b/g,'$1 minutes').replace(/\b(\d+(?:\.\d+)?)\s*(?:ghanta|ghante|ghantey|hours?|hrs?)\b/g,'$1 hours').replace(/\b(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|sekand)\b/g,'$1 seconds').replace(/\b(\d+(?:\.\d+)?)\s*(?:din|dino)\b/g,'$1 days');
 s=s.replace(/\bsaade (\d{1,2}) baje\b/g,'at $1:30').replace(/\bsawa (\d{1,2}) baje\b/g,'at $1:15').replace(/\bpaune (\d{1,2}) baje\b/g,(a,h)=>'at '+((+h+10)%12+1)+':45')
  .replace(/\b(\d{1,2})(?::(\d{2}))? baje\b/g,(a,h,m)=>'at '+h+(m?':'+m:'')).replace(/\baaj raat\b/g,'tonight').replace(/\bparso\b/g,'day after tomorrow').replace(/\bkal\b(?!\s+(?:tha|thi))/g,'tomorrow').replace(/\baaj\b/g,'today')
  .replace(/\bsubah\b/g,'morning').replace(/\bdopahar\b/g,'afternoon').replace(/\bshaam\b/g,'evening').replace(/\braat\b/g,'night').replace(/\b(?:roz|rozana|har din|har roz)\b/g,'every day');
 s=s.replace(/\s+/g,' ').trim();let m;
 const when=x=>{const w=[];x=x.replace(TIMERE,a=>{w.push(a);return' '});return[w.join(' '),x.replace(/\s+/g,' ').trim()]};
 const junk=/\b(?:alarm|reminder|timer|lagao|set|rakho|banao|ke liye|liye|ka|ki|ke|ko|mere|meri|mera|mujhe|par|pe|aur|hai|karo|jagao|yaad dilao|ki|ke baad|baad)\b/g;
 /* yes / no / stop */
 if(/^(?:haan|ha|haanji|theek hai|theek|kar do|yes)(?: karo)?$/.test(s))return'yes';if(/^(?:nahi|nahin|mat karo|rehne do|na)$/.test(s))return'no';if(/^(?:band|bas|ruko|chup|roko)$/.test(s))return'stop';
 /* help */
 if(/\b(?:madad|help)\b|kya kar sakti|kya kar sakte/.test(s))return'what can you do';
 /* timer */
 if(/\btimer\b/.test(s)){if(/\b(?:band|hatao|radd|cancel)\b/.test(s))return'cancel timer';if(/\b(?:kitna|kitne|baki|bacha|left)\b/.test(s)&&!DURH.test(s))return'how much time is left';m=DURH.exec(s);if(m)return'set a timer for '+m[0].trim()}
 /* alarm */
 if(/\balarm\b|\bjagao\b/.test(s)){if(/\b(?:band|hatao|radd|cancel)\b/.test(s))return'cancel alarm';const [w,r]=when(s);if(!w&&/\b(?:batao|kitne|kaun)\b/.test(s))return'what alarms do i have';return(/\bjagao\b/.test(s)?'wake me up ':'set an alarm for ')+w}
 /* reminder */
 if(/\byaad dilao\b|\breminder\b/.test(s)){const [w,r]=when(s);let t0=r.replace(/\b(?:mujhe|mere liye|yaad dilao|reminder|lagao|set|ke liye)\b/g,' ').replace(/\s+/g,' ').trim();t0=t0.replace(/^(.+?)\s+ko\s+(.+?)\s+karo$/,'$2 $1');const task=t0.replace(junk,' ').replace(/\s+/g,' ').trim();return'remind me '+w+(task?' to '+task:'')}
 /* time / date / battery / network */
 if(/\b(?:samay|time)\b.*\b(?:kya|kitna|batao)\b|\bkya (?:samay|time)\b|\bkitne baje\b|\btime kya\b/.test(s))return'what time is it';
 if(/\bkya din\b|\bkaun ?sa din\b|\bkaunsa din\b/.test(s))return'what day is it';if(/\b(?:tareekh|date)\b/.test(s))return'what is the date';
 if(/\bbattery\b/.test(s))return'battery';if(/\b(?:internet|network|wifi)\b/.test(s)&&/\b(?:chal|hai|check|status|connected|on|batao)\b/.test(s))return'check network';
 /* stopwatch */
 if(/\bstopwatch\b/.test(s))return/\bshuru\b|\bstart\b/.test(s)?'start stopwatch':/\bband\b/.test(s)?'stop stopwatch':/\breset\b/.test(s)?'reset stopwatch':'check stopwatch';
 /* lists */
 if((m=/^(?:(.+?)\s+)?list\s+(?:mein|me|main)\s+(.+?)\s+jodo$/.exec(s)))return'add '+m[2].replace(/\bko\b/g,'').trim()+' to my '+(m[1]||'to-do').replace(/\bmeri\b|\bmere\b/g,'').trim()+' list';
 if((m=/^(.+?)\s+(?:(?:(shopping|grocery|groceries|work|to do|todo)\s+)?list)\s+(?:mein|me|main)\s+jodo$/.exec(s)))return'add '+m[1].replace(/\bko\b/g,'').trim()+' to my '+(m[2]||'to-do')+' list';
 if((m=/^(.+?)\s+(?:(.+?)\s+)?list\s+(?:se|mein se)\s+hatao$/.exec(s)))return'remove '+m[1].trim()+' from my '+(m[2]||'to-do')+' list';
 if((m=/^(?:meri\s+|mera\s+)?(?:(.+?)\s+)?list\s+(?:saaf|khali|clear)\s*(?:karo)?$/.exec(s)))return'clear my '+(m[1]||'to-do')+' list';
 if((m=/^(?:meri\s+|mera\s+)?(?:(.+?)\s+)?list\s+(?:batao|padho|sunao)$/.exec(s)))return'show my '+(m[1]||'to-do')+' list';
 if((m=/^(?:task|kaam)\s+jodo\s+(.+)$/.exec(s)))return'add task '+m[1];
 /* maths */
 if(/\d/.test(s)&&/\b(?:plus|minus|jama|ghata|guna|times|bhag|percent|kitna|kitne)\b/.test(s)){const e=s.replace(/\b(?:kitna|kitne|hota|hote|hai|hain|batao|calculate|karo|nikalo|kya|hoga)\b/g,' ').replace(/\bjama\b/g,'plus').replace(/\bghata\b/g,'minus').replace(/\bguna\b/g,'times').replace(/\bbhag\b/g,'divided by').replace(/\s+/g,' ').trim();return'what is '+e}
 /* web, maps, weather */
 if((m=/^(.+?)\s+(?:pe|par)\s+(.+?)\s+(?:chalao|shuru|dhundo|khojo|search|dekho|karo)$/.exec(s))&&/youtube/.test(m[1]))return'play '+m[2]+' on youtube';
 if((m=/^google\s+(?:pe|par)\s+(.+?)\s+(?:khojo|dhundo|search|karo)$/.exec(s)))return'search '+m[1];
 if((m=/^(.+?)\s+(?:search|khojo|dhundo)(?:\s+karo)?$/.exec(s)))return'search '+m[1];
 if((m=/^(.+?)\s+(?:ka\s+)?(?:rasta|directions?|navigate)(?:\s+(?:batao|karo|dikhao))?$/.exec(s))||(m=/^(.+?)\s+(?:le chalo|jana hai)$/.exec(s)))return'directions to '+m[1];
 if(/\b(?:mausam|weather)\b/.test(s))return'what is the weather';
 if((m=/^(.+?)\s+kholo$/.exec(s)))return'open '+m[1];
 /* fun */
 if(/\b(?:joke|chutkula)\b/.test(s))return'tell me a joke';if(/\bsikka\b|heads ya tails/.test(s))return'flip a coin';if(/\b(?:pasa|dice)\b/.test(s))return'roll a dice';
 /* calls / messages / contacts */
 if((m=/^(.+?)\s+(?:ko\s+)?whatsapp\s*(?:karo|bhejo)?(?:\s+(?:ki\s+)?(.+))?$/.exec(s)))return'whatsapp '+m[1]+(m[2]?' saying '+m[2]:'');
 if((m=/^(.+?)\s+(?:ko\s+)?(?:call|phone)\s*(?:karo|lagao)?$/.exec(s)))return'call '+m[1];
 if((m=/^(.+?)\s+(?:ko\s+)?(?:message|sms|text)\s*(?:karo|bhejo)(?:\s+(?:ki\s+)?(.+))?$/.exec(s)))return'text '+m[1]+(m[2]?' saying '+m[2]:'');
 if((m=/^(.+?)\s+ka\s+number\s+([\d ]+)\s+(?:save|jodo)(?:\s+karo)?$/.exec(s)))return'save '+m[1]+"'s number as "+m[2];
 return raw}
/* localize(): English tool reply -> Hindi (देवनागरी) or Hinglish, based on the ALISA menu language. Unknown replies stay English. */
const lang=()=>{try{return(window.UI&&UI.lang)||localStorage.getItem('alisa-lang')||'en'}catch(e){return'en'}};
const LU={minutes:['मिनट','minute'],minute:['मिनट','minute'],hours:['घंटे','ghante'],hour:['घंटा','ghanta'],seconds:['सेकंड','second'],second:['सेकंड','second'],days:['दिन','din'],day:['दिन','din'],and:['और','aur'],tomorrow:['कल','kal'],today:['आज','aaj'],tonight:['आज रात','aaj raat'],at:['','']};
const loc=(x,L)=>String(x).replace(/\b(minutes?|hours?|seconds?|days?|and|tomorrow|today|tonight|at)\b/g,w=>LU[w][L=='hi'?0:1]).replace(/\s+/g,' ').trim();
const LR=[[/^It.s (.+)\.$/,'अभी समय है $1।','Abhi samay hai $1.'],[/^Today is (.+)\.$/,'आज $1 है।','Aaj $1 hai.'],
 [/^Battery is at (\d+) percent( and charging)?\.$/,(m,L)=>L=='hi'?'बैटरी '+m[1]+' प्रतिशत है'+(m[2]?' और चार्ज हो रही है':'')+'।':'Battery '+m[1]+' percent hai'+(m[2]?' aur charge ho rahi hai':'')+'.'],
 [/^You.re offline\.$/,'आप ऑफ़लाइन हैं।','Aap offline hain.'],[/^You.re online.*$/,'आप ऑनलाइन हैं।','Aap online hain.'],
 [/^Timer set for (.+?)(?: for (.+?))?\.(?: .*)?$/,(m,L)=>(L=='hi'?loc(m[1],L)+' का टाइमर लगा दिया।':loc(m[1],L)+' ka timer laga diya.')],
 [/^Alarm set for (.+?)(, every day)?(?:, labelled (.+?))?\.(?: .*)?$/,(m,L)=>L=='hi'?'अलार्म '+loc(m[1],L)+(m[2]?' रोज़':'')+' के लिए लगा दिया।':'Alarm '+loc(m[1],L)+(m[2]?' roz':'')+' ke liye laga diya.'],
 [/^Okay, I.ll remind you (.+?)\.(?: .*)?$/,(m,L)=>{const x=loc(m[1].replace(/^to /,'').replace(/ to /,' '),L);return L=='hi'?'ठीक है, मैं आपको याद दिला दूँगी: '+x+'।':'Theek hai, main aapko yaad dila dungi: '+x+'.'}],[/^Your (.+?) list has (\d+) items?: (.+)\.$/,'आपकी $1 लिस्ट में $2 चीज़ें हैं: $3।','Aapki $1 list mein $2 cheezein hain: $3.'],
 [/^Stopped\.$/,'बंद कर दिया।','Band kar diya.'],[/^Okay, cancelled\.$/,'ठीक है, रद्द कर दिया।','Theek hai, radd kar diya.'],[/^Done\.$/,'हो गया।','Ho gaya.'],
 [/^Cancelled (.+)\.(?: .*)?$/,'रद्द कर दिया।','Radd kar diya.'],[/^Snoozed for (.+)\.$/,(m,L)=>L=='hi'?loc(m[1],L)+' के लिए स्नूज़ किया।':loc(m[1],L)+' ke liye snooze kiya.'],
 [/^Added (.+?) to your (.+?) list\..*$/,'$1 आपकी $2 लिस्ट में जोड़ दिया।','$1 aapki $2 list mein jod diya.'],[/^Removed (.+?) from your (.+?) list\.$/,'$1 आपकी $2 लिस्ट से हटा दिया।','$1 aapki $2 list se hata diya.'],
 [/^Your (.+?) list is empty\.$/,'आपकी $1 लिस्ट खाली है।','Aapki $1 list khali hai.'],[/^You have no (.+?)s set\.$/,'आपके पास कोई $1 नहीं है।','Aapke paas koi $1 nahi hai.'],
 [/^That.s (.+)\.$/,'जवाब है $1।','Jawab hai $1.'],[/^(.+?) Say yes to confirm\.$/,'$1 पुष्टि के लिए "हाँ" कहिए।','$1 Confirm karne ke liye "haan" boliye.'],
 [/^Stopwatch started\.$/,'स्टॉपवॉच शुरू हो गई।','Stopwatch shuru ho gayi.'],[/^Stopwatch reset\.$/,'स्टॉपवॉच रीसेट हो गई।','Stopwatch reset ho gayi.'],
 [/^Opening (.+?)\.?$/,'$1 खोल रही हूँ।','$1 khol rahi hoon.'],[/^It.s (heads|tails)\.$/,'यह $1 आया है।','Yeh $1 aaya hai.']];
function localize(out){const L=lang();if(L=='en'||typeof out!='string')return out;for(const [re,hi,hg] of LR){const m=re.exec(out);if(!m)continue;const r=typeof hi=='function'?hi(m,L):(L=='hi'?hi:hg);return typeof hi=='function'?r:r.replace(/\$(\d)/g,(a,i)=>m[+i]||'')}return out}

function parse(text){const raw=String(text||'');let t=norm(toEnglish(raw));
 if(pending){if(Date.now()>pending.until)pending=null;else if(YES.test(t))return{id:'_confirm',level:'safe',yes:true};else if(NO.test(t))return{id:'_confirm',level:'safe',yes:false}}
 if(ringing.size&&(t===''||STOPR.test(t)))return{id:'_stop',level:'safe'};
 if(!t)return null;
 for(const x of T){let a;try{a=x.m(t)}catch(e){a=null}if(a)return{id:x.id,level:x.level,args:a,text:t}}return null}
/* modelConfirm tools (memory edits) may ASK for confirmation when the model calls them; the change itself still only happens after the USER says yes */
async function run(x,a,model){let r=await x.run(a);if(r&&typeof r=='object'&&r.confirm){if(model&&!x.modelConfirm)return'That needs your confirmation, so please say it to me directly.';pending={yes:r.yes,until:Date.now()+20000};return r.confirm+' Say yes to confirm.'}return r==null?'Done.':String(r)}
async function execute(c){return localize(await execute0(c))}
async function execute0(c){try{
 if(c.id=='_confirm'){const p=pending;pending=null;if(!p)return'There’s nothing to confirm.';if(!c.yes)return'Okay, cancelled.';return String(await p.yes())}
 if(c.id=='_stop'){const n=ringing.size;[...ringing.keys()].forEach(id=>stopRing(id));return n?'Stopped.':'Nothing is ringing.'}
 const x=T.find(y=>y.id==c.id);if(!x)return'I don’t know that command.';return await run(x,c.args,false)}catch(e){console.warn('[ALISA COMMANDS]',e);return'That tool hit a problem: '+String(e&&e.message||e).slice(0,80)}}
/* Gemini function calling — SAFE tools only */
const declarations=()=>T.filter(x=>x.decl&&x.level=='safe').map(x=>({name:x.decl.name,description:x.decl.description,parameters:x.decl.parameters}));
async function runModelCall(fc){try{const x=T.find(y=>y.decl&&y.decl.name==fc.name&&y.level=='safe');if(!x)return'I can’t do that one.';const a=x.decl.from?x.decl.from(fc.args||{}):(fc.args||{});return await run(x,a,true)}catch(e){console.warn('[ALISA COMMANDS] model call failed',e);return'That tool hit a problem.'}}

/* ---------- Settings UI ---------- */
function mount(el){if(!el||typeof document=='undefined')return;
 if(!document.getElementById('tools-css')){const s=document.createElement('style');s.id='tools-css';s.textContent='#tools{border:1px solid hsl(var(--c3)/.22);border-radius:18px;padding:14px;margin-top:12px;background:linear-gradient(150deg,hsl(200 70% 40%/.14),hsl(var(--c1)/.12));backdrop-filter:blur(14px)}#tools h3{margin:0 0 6px!important;letter-spacing:.3em;font-size:13px!important}#tools .r{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid hsl(var(--c3)/.12);font:400 13px var(--ui)}#tools .r b{font-weight:600;color:#9ef;text-align:right;max-width:62%;overflow-wrap:anywhere}#tools summary{font:500 11px var(--ui);color:var(--dim);cursor:pointer;padding:6px 0;letter-spacing:.06em}#tools .it{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;font:400 12px var(--ui);padding:5px 0;border-top:1px solid hsl(var(--c3)/.08)}#tools .it small{display:block;color:var(--dim);font-size:10px}#tools .g{font:600 11px var(--ui);margin:8px 0 2px;color:#9ef;letter-spacing:.08em}#tools .e{font:400 12px/1.5 var(--ui);color:var(--dim)}#tools p{font:400 11px/1.5 var(--ui);color:var(--dim);margin:8px 0 0}';document.head.appendChild(s)}
 const paint=()=>{const L=lists(),C=Object.keys(contacts()),n=('Notification' in window)?Notification.permission:'unsupported';
  el.innerHTML='<h3>⚙️ ALISA TOOLS</h3><div class="r"><span>Scheduled</span><b>'+sched.length+'</b></div><div class="r"><span>Lists</span><b>'+Object.keys(L).map(k=>k+' ('+L[k].length+')').join(', ')+(Object.keys(L).length?'':'none')+'</b></div><div class="r"><span>Contacts</span><b>'+C.length+' saved</b></div><div class="r"><span>Notifications</span><b>'+n+'</b></div>'
  +'<div class="chips"><button data-a="notif">Enable notifications</button><button data-a="clr">Clear schedule</button></div>'
  +'<details><summary>Timers · alarms · reminders</summary>'+(sched.length?sched.slice().sort((a,b)=>a.at-b.at).map(i=>'<div class="it"><span>'+esc(cap(describe(i)))+'<small>'+esc(new Date(i.at).toLocaleString())+'</small></span><button data-a="x" data-id="'+i.id+'">✕</button></div>').join(''):'<small>Nothing scheduled.</small>')+'</details>'
  +'<details><summary>All commands</summary>'+CATALOG.map(g=>'<div class="g">'+esc(g[0])+'</div>'+g[1].map(e=>'<div class="e">“'+esc(e)+'”</div>').join('')).join('')+'</details>'
  +'<p>Timers, alarms and reminders ring only while ALISA is open in Chrome. Calls, texts and WhatsApp need your voice security and never send anything by themselves — you tap the button. Contacts and lists stay in this browser.</p>'};
 el.addEventListener('click',e=>{const b=e.target.closest('button[data-a]');if(!b)return;const a=b.dataset.a;if(a=='notif'){try{Notification.requestPermission().then(paint)}catch(x){}}
  else if(a=='x'){const i=sched.find(y=>y.id==b.dataset.id);if(i){if(ringing.has(i.id))stopRing(i.id);sched=sched.filter(y=>y.id!=i.id);saveS()}}
  else if(a=='clr'&&confirm('Cancel all timers, alarms and reminders?')){[...ringing.keys()].forEach(id=>{clearInterval(ringing.get(id).iv);ringing.delete(id)});sched=[];saveS();paintRing()}});
 window.addEventListener('alisacommands:change',paint);paint()}

window.ALISACommands={version:1,parse,execute,declarations,runModelCall,init,catalog:CATALOG,
 tools:T.map(x=>({id:x.id,level:x.level})),ui:{mount},_t:{norm,parseWhen,parseDuration,numify,calc,sched:()=>sched,ringing,tick,reset:()=>{sched=[];pending=null;ringing.clear()}}};
init();
})();
