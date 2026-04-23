import { createClient } from '@supabase/supabase-js';
import './style.css';
// ------------------------------------------------
//  SUPABASE CONFIG
// ------------------------------------------------
const CONFIG_KEY = 'golazo_supabase_config';
// ── VASTE SUPABASE CONFIG (ingevuld door admin) ──
const SUPABASE_URL_FIXED = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY_FIXED = import.meta.env.VITE_SUPABASE_KEY;
const GAME_ID = 'golazo_main'; // één vaste game ID voor iedereen

let supabaseUrl = '';
let supabaseKey = '';
let db = null;
let realtimeChannel = null;
let currentUserId = null; // welke speler is deze gebruiker

// ── SUPABASE SETUP ──
function loadSupabaseConfig(){
  // Gebruik vaste config als die is ingevuld
  if(SUPABASE_URL_FIXED && SUPABASE_KEY_FIXED){
    supabaseUrl = SUPABASE_URL_FIXED;
    supabaseKey = SUPABASE_KEY_FIXED;
    return;
  }
  // Anders: uit localStorage (voor admin setup)
  try{
    const cfg = JSON.parse(localStorage.getItem(CONFIG_KEY)||'{}');
    supabaseUrl = cfg.url||'';
    supabaseKey = cfg.key||'';
  }catch(e){}
}

function saveSupabaseConfig(){
  const url = document.getElementById('setupUrl').value.trim().replace(/\/$/,'');
  const key = document.getElementById('setupKey').value.trim();
  const errEl = document.getElementById('setupError');
  if(!url || !key){
    errEl.textContent = 'Vul beide velden in.';
    errEl.style.display = 'block';
    return;
  }
  localStorage.setItem(CONFIG_KEY, JSON.stringify({url, key}));
  supabaseUrl = url;
  supabaseKey = key;
  errEl.style.display = 'none';
  initSupabase();
}

async function initSupabase(){
  if(!supabaseUrl || !supabaseKey){
    document.getElementById('loadingScreen').style.display = 'none';
    document.getElementById('setupScreen').style.display = 'flex';
    return;
  }

  try{
    db = createClient(supabaseUrl, supabaseKey);
    // Test de verbinding
    const { error } = await db.from('golazo_state').select('id').limit(1);
    if(error && error.code !== 'PGRST116'){
      throw error;
    }
    document.getElementById('setupScreen').style.display = 'none';
    await loadStateFromSupabase();
    setupRealtime();
    document.getElementById('loadingScreen').style.display = 'none';
    generateShareLinks();
    if(isAdmin){
      renderAll();
      adminOpen = true;
      document.getElementById('adminScreen').classList.add('active');
      refreshAdminUI();
    } else {
      showPickScreen();
    }
  } catch(err){
    document.getElementById('loadingScreen').style.display = 'none';
    const setup = document.getElementById('setupScreen');
    setup.style.display = 'flex';
    const errEl = document.getElementById('setupError');
    errEl.textContent = 'Verbinding mislukt. Controleer URL en Key. (' + (err.message||err) + ')';
    errEl.style.display = 'block';
  }
}

// ------------------------------------------------
//  STATE
// ------------------------------------------------
const VAST_VRAGEN = [
  {id:'v1',tekst:'__TEAM1_LABEL__ scoort als eerste',type:'team',vast:true},
  {id:'v2',tekst:'Welke speler scoort het eerste doelpunt?',type:'speler',vast:true},
  {id:'v3',tekst:'Welke speler pakt de eerste gele kaart?',type:'speler',vast:true},
  {id:'v4',tekst:'Komt er een rode kaart?',type:'jn_met_sub',vast:true,subVraag:{id:'v5',tekst:'Wie pakt de rode kaart?',type:'speler'}},
  {id:'v6',tekst:'Eindstand',type:'score',vast:true},
];

let state = {
  mode:'landen', team1:'', team2:'',
  players:[], vragen:JSON.parse(JSON.stringify(VAST_VRAGEN)),
  voorspellingen:{}, geheim:{}, uitslag:{},
  activePlayer:null, countdown:{date:'',time:''},
  locked:false,
  strafMode:false,
  straffen:{},
  pincode:'',
  pushGoedBericht:'Lekker pik! Bekijk hier wat je goed hebt gedaan.',
  pushFoutBericht:'Haha sukkel.. bekijk wat je fout hebt gedaan.',
  fotos:{},
  devices:{},
};

// ── LOAD / SAVE via Supabase ──
async function loadStateFromSupabase(){
  setSyncStatus('syncing');
  try{
    const { data, error } = await db
      .from('golazo_state')
      .select('*')
      .eq('id', GAME_ID)
      .single();

    if(error && error.code === 'PGRST116'){
      // Geen rij gevonden — eerste keer, maak aan
      await saveStateToSupabase();
    } else if(!error && data){
      const saved = data.state_json;
      state = {...state, ...saved};
      // Zorg dat vaste vragen altijd aanwezig zijn
      const ids = state.vragen.map(v=>v.id);
      VAST_VRAGEN.forEach(v=>{ if(!ids.includes(v.id)) state.vragen.unshift(v); });
    }
    setSyncStatus('ok');
  } catch(e){
    setSyncStatus('error');
    console.error('Load error:', e);
  }
}

async function saveStateToSupabase(){
  if(!db) return;
  setSyncStatus('syncing');
  try{
    const { error } = await db
      .from('golazo_state')
      .upsert({ id: GAME_ID, state_json: state, updated_at: new Date().toISOString() });
    if(error) throw error;
    setSyncStatus('ok');
  } catch(e){
    setSyncStatus('error');
    console.error('Save error:', e);
  }
}

// Wrapper: saveState sloeg op naar localStorage, nu naar Supabase
function saveState(){
  saveStateToSupabase();
}

// ── REALTIME ──
function setupRealtime(){
  if(!db) return;
  realtimeChannel = db
    .channel('golazo_changes')
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'golazo_state',
      filter: `id=eq.${GAME_ID}`
    }, (payload) => {
      const newState = payload.new.state_json;
      if(!newState) return;

      // Detect reset: no teams and no players
      const isReset = !newState.team1 && !newState.team2 && (!newState.players || !newState.players.length);
      if(isReset){
        // Stop timer and clear countdown widget immediately
        if(cdInterval){ clearInterval(cdInterval); cdInterval = null; }
        const cw = document.getElementById('countdownWidget');
        if(cw) cw.innerHTML = '';
      }

      state = {...state, ...newState};
      const ids = state.vragen.map(v=>v.id);
      VAST_VRAGEN.forEach(v=>{ if(!ids.includes(v.id)) state.vragen.unshift(v); });
      // Re-render alles behalve de actieve invoervelden
      renderInvullen();
      renderMatchup();
      renderCountdown();
      if(adminOpen) refreshAdminUI();
      setSyncStatus('ok');
    })
    .subscribe();
}

// ------------------------------------------------
//  PLAYER PICK SCREEN
// ------------------------------------------------
function showPickScreen(){
  // Als dit apparaat al een speler heeft geclaimd, direct doorgaan als die speler
  if(!isAdmin){
    const savedId = localStorage.getItem(USER_KEY);
    const deviceId = getDeviceId();
    const stillClaimed = savedId && state.devices?.[savedId] === deviceId;
    if(stillClaimed && state.players.find(p => p.id === savedId)){
      pickPlayer(savedId);
      return;
    }
    // Admin heeft de koppeling gereset — wis localStorage zodat speler opnieuw kan kiezen
    if(savedId && !stillClaimed) localStorage.removeItem(USER_KEY);
  }
  // Check pincode first (skip if no pincode set, or if already verified, or if admin)
  if(state.pincode && !isAdmin){
    const stored = localStorage.getItem(PINCODE_KEY);
    if(stored !== state.pincode){
      document.getElementById('pincodeScreen').style.display = 'flex';
      requestAnimationFrame(()=>{ const el=document.getElementById('pincodeUserInput'); if(el) el.focus(); });
      return;
    }
  }
  const screen = document.getElementById('pickScreen');
  if(!state.players.length){
    // Geen spelers → ga direct naar app
    screen.classList.remove('active');
    renderAll();
    return;
  }
  screen.classList.add('active');
  renderPickGrid();
}

function renderPickGrid(){
  const grid = document.getElementById('pickGrid');
  if(!grid) return;
  if(!state.players.length){
    grid.innerHTML = '<div class="empty"><span>👤</span>Nog geen spelers. Vraag de admin om spelers toe te voegen.</div>';
    return;
  }
  grid.innerHTML = state.players.map(p => {
    const pred = state.voorspellingen[p.id] || {};
    const vis = getVisibleVragen(pred);
    const ingevuld = vis.filter(v => {
      const val = pred[v.id]||'';
      if(!val) return false;
      if(v.type==='score'||v.type==='tussenstand'){
        const parts=val.split('-');
        return parts[0].trim()!==''&&parts[1]!==undefined&&parts[1].trim()!=='';
      }
      return true;
    }).length;
    const heeftAlles = ingevuld === vis.length && vis.length > 0;
    const nietAlles = ingevuld > 0 && !heeftAlles;
    const statusText = ingevuld === 0 ? 'Nog niets ingevuld' : heeftAlles ? '✅ Klaar!' : `${ingevuld} van ${vis.length} ingevuld`;
    const deviceId = getDeviceId();
    const devices = state.devices || {};
    const isMine = devices[p.id] === deviceId;
    const isClaimed = devices[p.id] && !isMine;
    const foto = state.fotos && state.fotos[p.id];
    const avatarContent = foto
      ? `<img src="${foto}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;">`
      : p.name[0].toUpperCase();
    const avatarStyle = foto ? 'padding:0;overflow:hidden;' : '';
    return `<div class="pick-card ${heeftAlles?'done':''} ${isClaimed?'claimed':''}" onclick="pickPlayer('${p.id}')" style="${isClaimed?'opacity:.5;':''}">
      <div style="position:relative;flex-shrink:0;">
        <div class="pick-card-avatar" id="pick_avatar_${p.id}" style="${avatarStyle}">${avatarContent}</div>
        ${isMine?`<label for="foto_${p.id}" onclick="event.stopPropagation()" style="position:absolute;bottom:-2px;right:-2px;width:20px;height:20px;border-radius:50%;background:var(--surface3);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:11px;cursor:pointer;" title="Foto uploaden">📷</label><input type="file" id="foto_${p.id}" accept="image/*" style="display:none;" onchange="uploadFoto('${p.id}',this)">`:``}
      </div>
      <div style="flex:1;min-width:0;">
        <div class="pick-card-name">${p.name}${nietAlles?'<span style="color:var(--accent);margin-left:4px;">!</span>':''}${isClaimed?'<span style="color:var(--muted);font-size:11px;margin-left:6px;">🔒</span>':''}${isMine?'<span style="color:var(--oranje);font-size:11px;margin-left:6px;">● jij</span>':''}</div>
        <div class="pick-card-status">${isClaimed?'Gekoppeld aan ander apparaat':statusText}</div>
      </div>
    </div>`;
  }).join('');
}

function pickPlayer(id){
  const p = state.players.find(x => x.id === id);
  if(!p) return;
  const deviceId = getDeviceId();
  const devices = state.devices || {};
  // Check if this device already claimed a different player
  const myClaimedId = Object.keys(devices).find(pid => devices[pid] === deviceId);
  if(myClaimedId && myClaimedId !== id){
    const myName = state.players.find(x => x.id === myClaimedId)?.name || 'iemand anders';
    showToast(`⚠️ Je bent al aangemeld als ${myName}!`);
    return;
  }
  // Check if this name is already claimed by another device
  if(devices[id] && devices[id] !== deviceId){
    showToast('⚠️ Deze naam is al gekoppeld aan een ander apparaat!');
    return;
  }
  // Claim this name for this device
  if(!devices[id]){
    if(!state.devices) state.devices = {};
    state.devices[id] = deviceId;
    saveState();
  }
  currentUserId = id;
  localStorage.setItem(USER_KEY, id);
  subscribeToPush(id);
  // Toon user indicator in header
  const userInd = document.getElementById('userIndicator');
  const userAvatar = document.getElementById('userIndicatorAvatar');
  const userNameEl = document.getElementById('userIndicatorName');
  userInd.style.display = 'flex';
  const foto = state.fotos && state.fotos[id];
  if(foto){
    userAvatar.innerHTML = `<img src="${foto}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;">`;
    userAvatar.style.padding = '0';
    userAvatar.style.overflow = 'hidden';
  } else {
    userAvatar.innerHTML = '';
    userAvatar.style.padding = '';
    userAvatar.textContent = p.name[0].toUpperCase();
  }
  userNameEl.textContent = p.name;
  document.getElementById('pickScreen').classList.remove('active');
  editingPlayer = id;
  state.activePlayer = id;
  renderAll();
  updateFabLabel();
  renderInvullenForm();
}

function uploadFoto(playerId, input){
  const file = input.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = function(e){
    if(!state.fotos) state.fotos = {};
    state.fotos[playerId] = e.target.result;
    saveState();
    // Update avatar in-place without re-rendering the whole grid (avoids screen jump)
    const avatar = document.querySelector(`#pick_avatar_${playerId}`);
    if(avatar){
      avatar.innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;">`;
      avatar.style.padding = '0';
      avatar.style.overflow = 'hidden';
    }
    // Update header avatar if this is current user
    if(currentUserId === playerId){
      const userAvatar = document.getElementById('userIndicatorAvatar');
      userAvatar.innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;">`;
      userAvatar.style.padding = '0';
      userAvatar.style.overflow = 'hidden';
    }
    showToast('📸 Foto opgeslagen!');
  };
  reader.readAsDataURL(file);
}

function switchPlayer(){
  // Sla op en ga terug naar eigen overzicht (niet wisselen van speler)
  if(editingPlayer) saveCurrentVoorspelling(false);
  editingPlayer = null;
  renderAll();
}

function renderAll(){
  renderInvullen();
  renderMatchup();
  renderCountdown();
}

// ── SYNC INDICATOR ──
function setSyncStatus(status){
  ['mainSyncDot','adminSyncDot'].forEach(id => {
    const el = document.getElementById(id);
    if(!el) return;
    el.className = 'sync-dot ' + status;
  });
}

// ------------------------------------------------
//  ADMIN
// ------------------------------------------------
let adminOpen = false;
function toggleAdmin(){
  adminOpen = !adminOpen;
  document.getElementById('adminScreen').classList.toggle('active', adminOpen);
  if(adminOpen) refreshAdminUI();
}

function refreshAdminUI(){
  document.getElementById('modeToggle').checked = state.mode==='clubs';
  document.getElementById('strafToggle').checked = state.strafMode||false;
  document.getElementById('pincodeInput').value = state.pincode||'';
  document.getElementById('modeLabel').textContent = state.mode==='landen'?'🌍 Landen':'🏟️ Clubs';
  document.getElementById('team1Input').value = state.team1;
  document.getElementById('team2Input').value = state.team2;
  syncModeLabels();
  document.getElementById('cdDate').value = state.countdown?.date||'';
  document.getElementById('cdTime').value = state.countdown?.time||'';
  renderPlayers();
  renderAdminVragen();
  renderAdminUitslag();
  syncLockdownBtn();
}

// ── TABS ──
function showTab(name){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('screen-'+name).classList.add('active');
  ['invullen','resultaat'].forEach((t,i)=>{
    if(t===name) document.querySelectorAll('.tab')[i].classList.add('active');
  });
  if(name==='invullen'){ renderInvullen(); }
  if(name==='resultaat') renderResultaat();
}

// ── FLAG LOOKUP ──
const FLAG_MAP = {
  'nederland':'🇳🇱','netherlands':'🇳🇱','holland':'🇳🇱',
  'duitsland':'🇩🇪','germany':'🇩🇪','deutschland':'🇩🇪',
  'frankrijk':'🇫🇷','france':'🇫🇷',
  'spanje':'🇪🇸','spain':'🇪🇸','españa':'🇪🇸',
  'engeland':'🏴󠁧󠁢󠁥󠁮󠁧󠁿','england':'🏴󠁧󠁢󠁥󠁮󠁧󠁿',
  'groot-brittannië':'🇬🇧','great britain':'🇬🇧','uk':'🇬🇧',
  'italië':'🇮🇹','italy':'🇮🇹','italia':'🇮🇹',
  'portugal':'🇵🇹',
  'belgie':'🇧🇪','belgië':'🇧🇪','belgium':'🇧🇪',
  'brazilië':'🇧🇷','brazil':'🇧🇷','brasil':'🇧🇷',
  'argentinië':'🇦🇷','argentina':'🇦🇷',
  'usa':'🇺🇸','verenigde staten':'🇺🇸','united states':'🇺🇸','america':'🇺🇸',
  'mexico':'🇲🇽','marokko':'🇲🇦','morocco':'🇲🇦',
  'tunesië':'🇹🇳','tunisia':'🇹🇳','senegal':'🇸🇳','nigeria':'🇳🇬',
  'ghana':'🇬🇭','egypte':'🇪🇬','egypt':'🇪🇬',
  'kroatië':'🇭🇷','croatia':'🇭🇷','servië':'🇷🇸','serbia':'🇷🇸',
  'zwitserland':'🇨🇭','switzerland':'🇨🇭','oostenrijk':'🇦🇹','austria':'🇦🇹',
  'denemarken':'🇩🇰','denmark':'🇩🇰','zweden':'🇸🇪','sweden':'🇸🇪',
  'noorwegen':'🇳🇴','norway':'🇳🇴','finland':'🇫🇮',
  'schotland':'🏴󠁧󠁢󠁳󠁣󠁴󠁿','scotland':'🏴󠁧󠁢󠁳󠁣󠁴󠁿','wales':'🏴󠁧󠁢󠁷󠁬󠁳󠁿',
  'ierland':'🇮🇪','ireland':'🇮🇪','turkije':'🇹🇷','turkey':'🇹🇷','türkiye':'🇹🇷',
  'griekenland':'🇬🇷','greece':'🇬🇷','oekraine':'🇺🇦','oekraïne':'🇺🇦','ukraine':'🇺🇦',
  'polen':'🇵🇱','poland':'🇵🇱','tsjechie':'🇨🇿','tsjechië':'🇨🇿','czech republic':'🇨🇿','czechia':'🇨🇿',
  'slowakije':'🇸🇰','slovakia':'🇸🇰','hongarije':'🇭🇺','hungary':'🇭🇺',
  'roemenie':'🇷🇴','roemenië':'🇷🇴','romania':'🇷🇴','rusland':'🇷🇺','russia':'🇷🇺',
  'japan':'🇯🇵','china':'🇨🇳','zuid-korea':'🇰🇷','south korea':'🇰🇷','korea':'🇰🇷',
  'australie':'🇦🇺','australië':'🇦🇺','australia':'🇦🇺','iran':'🇮🇷',
  'saoedi-arabie':'🇸🇦','saudi arabia':'🇸🇦','qatar':'🇶🇦','canada':'🇨🇦',
  'colombia':'🇨🇴','chili':'🇨🇱','chile':'🇨🇱','uruguay':'🇺🇾',
  'ecuador':'🇪🇨','peru':'🇵🇪','venezuela':'🇻🇪','costa rica':'🇨🇷','panama':'🇵🇦',
};

const CLUB_LOGO_MAP = {
  'ajax': 'data:image/png;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAD4APcDASIAAhEBAxEB/8QAHQAAAgMBAQEBAQAAAAAAAAAABwgABQYEAwIJAf/EAEYQAAEDAwQABAQEBAQEAwcFAQECAwQFBhEABxIhEyIxQQgUMlEVI0JhM1JxgRYkYpFDU3KhF3PwCSU0Y4Kx4VSSo7LB8f/EABYBAQEBAAAAAAAAAAAAAAAAAAACBP/EAB0RAQABBAMBAAAAAAAAAAAAAAABAgMEMQURErH/2gAMAwEAAhEDEQA/ACuNgYLZy3TbJ9+o9MnRfZI/RNOOh/8AbVjD2cjxV5RTUIwejDuurRT749HFffVJYFLuHdNUep/4kuqjbf05KmaUpmoORp9ecz55r7icLS0pWeCBj7gJGBrfR9rYcYgxr2v5GCDhVxPuj39nCr7/APYaDKX5SrQ27tR24Luu67qPEZISy2xd86Qt9zjgNoS4oclHvr0HqcAdBe1rGvD4l6tArtyIlW9t1TVFFPbcIXMngdFRcIytRxguEcRkhIJ5aOF1fDpZd21yDVrsrV1152EUhpqdUgtspBBKCkIGArHeCCfvovxWGIsZqNGZbYYaQENttpCUoSBgAAdAAe2gq7Nteg2db8egW1TGKdTo4whppPqfdSj6qUfcnJOrjU1NBNTU1NBNTWcvu+LYsiA3KuKqNxlPEpjRkAuSJS/5Gmk5UtXp6D37xrFpb3K3HJ+aMrbu1ln+E2pJrUxGPdQymKD+3Jzr1ToOTfn4g7L2sYdgKeTWbj4/l0uM4Mtk+heX2Gx+3ajkYGOwmxuC7d8a9W7mux5bzFFZRIaKJC2olNbU4E8UtJGVE9dlxv6Mqc9NH74mNkLPZXZ4oTcOml2azTPkg1lcrxHe3luklSlArwSoEkrTlXXff8Dtn0aiwrrQwtFQZnR6O+vx0JUUlcQPKQoenlcdWMf6RoM58NdrQ65HqVIqu4NIp1M4ttwKZa9Yjw5SuyF/MeByW4ThIBLznqez0Qy9H29tGjwvlKPTF05lSub3ykp1lchXsp5xKgt0/wDWVep0OI23BtbdC7bjmWM1fMC6HmnELaREDtPShJBaU0+pCCjOMLSok4HIZGT4ptPbaK65mw9xbVcUrlzpqqgEoP1eUQnXEJH7YxoDnGYZjMJYjtIabSMJSkYA0IZtxU6fufWL5qctlq0bCgOw2pK1ANu1B3HjqQo4BKEBLI7+pxQ++q+PSLAacMGbuduK82el06dVZiFLGMFJBQl3BB9M65t4IF1XDZdO232dt2XR6XI/Kl1RaF09mEwD2gNuISp0LBOSnv8ArkkAVNrbodvWx6fdK6a7TmaklT8Vl5QLngFR8NSgMgEpwcAnog++Bp9Jrt7vNO2rqNEiVqgCZQbqotMeguRpLbJbksxm4rxUXVBvtbQySpIACT7nTbQZlWn2+ZX4Suk1FaFcIs5xC/DV7cyypSSPfyq/20H1c9QXS7eqE9kIVIYiuusNrP8AEWhtSgn9/p/2zpTfgo30ua4bxmWdfVUfqSqqp2TS5kgjKXkjk4wD6cSk8gkfTjAGFDBdu92r0xNWqlwVFV01xunS26fGpFP4RKQFMu/mupLil5X4Sm/EUT9KkADkrKBbf1GZbiYt3UlsOVCi1BioJX4ik+G224lC0Y9CFqeZB9eh+5Gg/RPaZAt/c/cWzlHg07UGrhgpJ+puWjDvEZ9A80v+6v3123ht2/W9wo10tT2mUNO0tamSFZWIj0pw9g47EhOB9064K5SJ1/tWruftrc0Sk1MQiEuyYvzDEyG8ErLDqQQoFK0pOQQUnkPfrudm72xooAt2w6g8E9rbq8pgKPH14KYVjv25n+vvoMRclh1mg02NDpbT8pyHbLqIq0FRCX6fOalREnvorBI/+nGuxqkqeuyc/QWUyHozjd0UNB+iZDnApnxMk8SFqSpwD0C3WietaqLWd5VIbRLs2yY6yoAuKuR/ir+iRFJ/76+rdvWVH3Bi2ReFtQ6HWJEFbtJlQ5XjxJraMeK02pSELQtPlJbKfQZz0NBQXZYdu02z2rXdSzOe5vNUpsqcElmEpQc8AIbKS80hXFPBxSWuISVqGO83OVCbRt9KpbrLqaRekeIp2O54yAh5hxhSCtttLKVAqALbI4I9M5718X229PrUmlSoTsKJJWsrjuNqBnhPuY7ajLmgH1U6phkAgkEDXhFrMCoUOl0+GtDrLN4UVmO6lYcTyRISpTYcbSIwKUpP5McqSjByolR0BRe2ktmRuQ5fMqXWJEozW6g3BXLxCalIZSyH0tADK+CQMqJ/bGunc7a+2txZVIfuNyqEUl4vxWo0xTKA51hZA9VDAwfbv7nWzfU8kt+E0lYK8OFS+PFOD2OuznAx16+ulK3N+JncWhyalRaZZ9JalNylRos1b/iuLzy4YiJWVhSuJwSSB1ke2gzu6VnRY2+a7YmzZ8qpqq6q3SXZKy6++yqBzKuWBy4PQA32c4UPU5OsfadDqL98zrbo1Xdp0aiXPAbW5KaTKW0t2U9EZLWSU+EGXWQpteQSMAgaLt/Vtm5bG2a36cShx6m1CPFrawnA8J1XgvkgDAAcSoAY/wCJrCVyki1N87tg0ppv5Ci063US3AyEJcfamUzC0pxjJGcgYHZ0HzZGxEa7p9Ityq12rMPpoVRi5EpSmmZMGqpacS2lSemilfLh6BSs6mjBtfxgboUFtCkkSLgvCOkjHafmm149Pu3/AP8AdTQMRHZZjx248dpDLLSQhttCQlKEgYAAHQAHtr71NTQTU1NTQTU1NU94XRb1oUR2tXNV4lLgNfU8+vGT/KkeqlfsASdBcaCfxGbrzbZrFuWBZlUpbN23HUGoZXIT4v4e04oJDykA4zlQ4hXrgnBxrAXtv/dF8OSKLttGXbVLLXNyvVJsCQ614kdLio7R6Txbkod5KOSnJHE4OlsqlAuaFXY66fGfTeVFrSnH5i3S49IkBQQCVKJ5KEiOvGfUyWx7jQPxt/t/aNo1hypTKoq4LwePhy6xVHw7LKihS+CR6Mo4pUQhIA4p98a9bt3FiU2tCnxVhxll2EZEhrCxwemriOj0wPDcSnkfbOgNspSaxuq1Kv6l1OE29Pc4VqGXFoWxLBeacwME8VR5shSO+ihpJ9CQTtobElQa/LZvOnk1H5b5kE8HGJSZKGxMZV0QtIlMeMPQjxk/dQ0FRbdh3HfcaO5c8qbHMR2NIalO58Rt9tEdDoQFZyRJpwUQQMokEg96+rQpf+BN291bZoqHs1KkR7ipEbmVHKfFQ4hHfSfF4gADoED2GmB0CdxavIo3xD2tXJLbbLUWWijPLbBy7CqDWGFLPp5Zcd0ddYUj3Og1EC85EKtOtOuByNIlJYZyrISpVVXHV9++L7Hrj21cXXuEzSrh/wAN0W267c1aSlKnmKcwkMxQrtPjvuFLbeR2Bkqx3jBGrupWrQ6i+49LhhxbiisnkRhXJleR9jyjtK69051mdt6xAXTL1u12ShUdVdnKfUhXMttxEpjYwO/pj88f68++g8Ztx7tU2E7V5e39DnQ2wVrp9Nrbjk9KAMniFsJbcWBnyhQyegT720fcG36ttXPv2iylSadGgSJKxx4utqaQpS21pP0rSUkEH3/bQe2n+KFq9LqIqVusUO2H5zVLjTXJnN4THUuLaS4nAASsNLGRnirjk4ORtrvoUK070mT1IKLRvgGm19hJ4tx5rqS21J/0h0HwlkfqLZPvoK/ZzbC1K3tbtxWq9TI1Skw6DHUlElht5C+YDySeaCUlKlkgpKc5IVyGNGzSv7J7h3JZm5MPZa9JEaOxR2EwIzq2iPmWwrhGdQvHosLaRgk9gYx2NM+pSUpKlEJSBkknoaDMu0SiUa4X6y3TXnHa06mPLUhPNDZWkJ5EeoSsobSrHWeJwMrVpMLUs0bZbx3Ba9RSkxIlQjSIReSQl6IZDUpCs9hXUQJIxgFJGdOwm5oVTRPj2rLptbqMPiHGkTMNNLVnCXHEJXwPROMFXp1g50Dvip2+uy4NuoF7MQ4j18ULxUuNUlt1YfiOlSVNIz51lAUFA4HYXgDONB07QbQ27SrWpdKpm5F8QJUuCiTKh0+sBuOh5BQl/gAjCPzVEFOc949tbiNsfZylBVZqV23CsEHNUuKW6M9d8UrSn2+2gt8PFYbuu85tKgGVFqcMMz1tSGVtK8JVUbkvjvjnpXEDB9P92SbqU+1rCmVe75Md9dLjyZMp9g4C2mytSDggYUWwnI9ArIGR3oBtf+3m0MOIujt2ZTkOKTiRNgNrTMp/ly26l1KFBtYOCC6tCfckjo4rd9y+6QLElVy5rDcp1vTk1GPX59SVGkTkpb4oStpKVElSVKKvCK+eARwx3kr0qO++6dQZrVB2tqEWhHD0MTJ7YeWD224kPq8Ns9pPJtsLx+v9Q6Nttt6RSZL1y7vbXbhXJcrjq3FhyN+JQ2wckJSEvLW711lzPftnQZStbmU2vS3qXZ1rVu+pMgpVM8GE63T3HeP1KjoJkSh2f/iXvb0xrd7IWJu1X907cue+bdkUeg0Za5DaZcpIc5hlSGm2o6MIZbSVZ4pbR6HkVHGjBD3ct2jwEsR9uNwKZAZ8oDdpPttNj/pSOh/bXc3vvtSGEuTbsZpa1EjwKlHeiugg4PkcQD6+460BFmM/MQ3o/Mo8VtSOQAOMjGcEEH+4I1+Yl3xp1k71vqfZQmVb09LrYQylhtlbS/GbBKWm0rLiGyR5BkKGM41+nzLjbzSHmlpW2tIUlSTkEHsEaTf48bci0a8LeuKhRUCdXUvCqxkYAlpieG6lzH84TySSOyMD30HdttSo1V223s2Xaw61BddqVDQU9qYeR40bA9cBSGldD1c/ca57EbdvWwZF3OSGlSK5IoTD7CQfE5mqMMKcOMeU/KnB9ej+2an4Z614HxE2ylLqXUVm1XaTKIAwtyEpbaSfufDiNn36Xr+7FzItKoFyhtbb0Kg1qJAjrSUrDojTKhN5JwQSnC0nPXoftoDNtZQpdSrVhXEhs/Jsi46m66o+q5cxJbACjy7QtR9MdfuMzXCKsrby16hILKlybStSh05KUkH8151Xj4zns8Wif+nU0DA6mpqaCamvl5xtlpbzziW20JKlrUcBIHZJPsNJpurvjeu5delW1tpMct+1m1LZcrKUkSJpGR+WR2lJVxSOPm8wJIzxAMDuxvFQbMLtGpaDcV2rZcXGosJQU4ClBWVPKHTSQlKlHPZAOAdBehUWTdlUi3FfalXVebdaiFMVs84NNjtVCO2+2y16dNPtLUpQOQT9iTZ7L7LlxtMqMt6lwEvn5h51HKVUBl/ClKPRCmJikhfrlI660x1uUKl0CnIhUyM20lKUBa+I5uqS2hsLWR9SiltAJ9+I0Cw2rtfd1QrUekyLeXT4EVswJTq1cEqi8XoD6ELxlRVH+UfQfQlr1yBorNbIUmpFybdM52bUpMZAkOMZbT8x8t4DzySe/wAzgy5j9LjKFA50W9TQKttDDqm13xaS7MqcmO63eFDRPcEZJS0uW2FFTqU+3ItyFYwMc8DodtQpaE/UpI9PU/c4Gg5uJZbk74m9t7zamgKix5kd2KG+/CSy8S5yz6BbracY/X7e+93HhSH6A5MiJdW7FSouIaRzcU0ccige7iCEuI9yptI65HQafQW+KS3HKnSIUyMoNLlpXSFO5A8N5xSXYThJ/llsso/YPK/fV9stuxTtwZlboi20Ra3RHEIksg+R9tSAQ+12eTRVyAOTlPBRxzA1sb5t+PdVoVS3ZLq2UToymkvIOFMr9UOJ/wBSVBKh+4Gg5NrrmbvLb2h3KkBLk6Ihb7f/ACngOLqD+6VhSf7aHdq0L8C3e3BsF8rRRbwhKr0Ej0Q4v8iakf6uSm149goarPhhuOSxcFwWdVkfLy5LjlXbZwQlqT4nhVBlOfQJkDxUgfpkJPodbvc6TEhVe27pHkXQ68zAlLUMDwZqEsKGf5eb8defu3oE22Uii1KRcFNqkWNNepjtTenQnkko8WPTpyOCh/fOcDpXXedMLYW4NKru1l02buIX5a6EHYUqQ79dQpyZCo6ZqTjtSShQUoei0ZJGeuWPtlTqn8R1/wBMkSFR41RhNVLghsZU3LiS4b/EkYzzPLP++daLfOxU0K1YN12fS3H5FvPy3psBtSiqfTpa1rnR/wB881LT/KU9d40AO30rMeJb8RyvVyM1uft9PaVTZrgwmvQUSB4awfpWpKkZUnOUracHudF3ZGv21v3Tl1a8WmqjMgJaQihyO4rY8NsrfLX0PFThV2oHgAlOEnJUEdw7gtODFcitVuHU0Sac74Eta0OuLjvSKoUKUU4wsGWwVY7BScgEHB4+C6xKlau271arkQQZ1ekmazBCOIhsKSkISE/pUoJSpXucIz2nQG6mU+BS4TcKmwo0KK2MNsx2ktoT/RKQANdOsZuXuXam334cbjqLMYTZSGSC4OTSFBf5qk+vAFOCR7ka10OQ1LiMy2Fcmnm0uIVjGUkZB/2Og/shhiQy4zIZbdbcQUOIWkKStJ9UkH1B+2h7cWzFmVekzaSyuuUeDObLcmLTas+zHWknJHglRaAPp0n00RtTQDOPtdXIMVqJS9376jx2UJbQh0wnylIBAHJUfP29/b+mInbC4XFAyt5L+cHuGlw2s+n2j/t/69yZr+ck8uPIcvXGe9APX9uKszAUin7rXxGlgflyJD8aQOWMDkhbOFDPeBgn7jWes6tUnevaCv0KsopNWq8BcqkzuLSVNmQ3yS3JbSclIXhK0kehyAfLrY7y3HOtqx5EijpjOVWS/HhxESF8UJU/IaY8RWCFcUl1OeOT2NJJ8L9TO3N9TbuRU3k2/El0+kV9LyClLQlNOlTi/sGZDQTk+oJ++gdD4f6l+JbE2dLaT4jrdFYYUjOMuNIDakk+x5II0j/xSbo3LcO5jhmwYrDVJWY0Rsx3CmOQcrSla+JWVgp5K4pyAAny4Upmfgsu1VTo1y228w9Hai1N6p0kOoKfFgSnXFIUjPqnmlzvGPMNCL47IFRpqn6TBpaolAM5qrFxEdKGVvuIW2rioBKQrOSQkOLUVlS1ABA0A2+Fi16nuHulRaWJsqJBpPjz6hKjPLbc+XUlCFMhaSCnxCOJ7HS1nTp7jbHWxXkNVG1o0C1a9HaWy3KiQkhmQytCkOMPtJ4haFIUpOchQz0dLx8GkkwolWqqi1GiS0NMSS0zxDzLKFLWpQBzyCIzwJ91SkHTP2NW6kzKFPq7avmluJExIcCgxMeQ7KdbKv5GmiygHODyA+2gEMaXdUPdGNau6lAhxBclXMn8SpxBpj0aLTnEIZT4hKkr5pSvCsft1qa6vjfvdmBtfaUygvIfk1OpJmQHUpJJZEZzktPoew8gf0VqaBlNTU0Nbxv+rT63IszbGDHrFwMnhPqD5P4fR/8Azlj63fsynKvdXEDsKn4uruh27stXKW3NaFbrcb5CnQkqy/ILqktr4IBycJUo5H/41n7G2ouWzLeoVNo9OolTqUOOhtp6plSYtPCgy+44pCU5ed+aQ6UlJBCVJBIGCN/t1tVRrXqblyVaW/c93yR/mq7UQC7/ANDKPpYb7OEo9uiTga1lxVdmm052SJsNjwlgLck8vBR74cWn+GD/ADK6GR0fTQcdvW47Tpy6nVK1Lq07gW2lOJS0zGbOMobaRhIHlGVHko+nLHWsjd2w+1l2VOTWZ9AcbqEtRcXKhT32CVkY5hKFhGegc8ez65712T7jqqUNyUpSmO6rk2px/MVY/mZmNApSOxhL6ByPXQ1023SGJ9URMlRZMZbbgkll5gN8nAchS0p5MOL7B8ZopV0BnQYCxrIuza/dalUWmX1WbhtiqRn1im1iUkqj+GpsKLayFFRSHArgEtggK8xIwTHOnOU+uQ2SxPlM1FXhAtoQWoqkpJ5LJIUAoYHQV2PbJJFd7zQr4vdvIDUkFTdDqS3mUr7SlSRgkewJR19+P7aI11Lpz9w27TZSQqSqYqRHPgNuFBbbWc+dCuIIyOSSlQyMHBOg9qfRH/8AGM+4qhKafc8BMOntIRj5VjpbmSeytawkn2w22AOiTfaobvptVfirnW9JDFVabKUoWvi3JR6+Gs4PE+vFeCUE5wpJUlWVsrdSnzn5FEuVl6kV6H5XY7zRSXcDJISCcKAyopBIKfMgrT5tABt/bbreyG9NM3stVuQ/bsp0R6vEbOQwFnzt/s2sdpzkJWkDocBpndu7ih3HbrL8aqIqbjSEByQloN+MFIStDoSCRhaFJV0cZJHRBAs6rT6Nc9vP06oMRapSagwUONqIW282ofceo9wR+xGlvaizvh13DgMeJLmWFU3DHhPLJWqKlSisxHD7lCipxo+p5Oo7K8gK74i58nbTc2LuPBYWRGqLTsxttBwVrR4ZV9giRGSUE/8ANhp+51v/AIhXheO2XyNszeEe44rE2JKYHbq0uMraVn75S0PYgHH9NHvra1MvGx3KiECfAchqRLEf8wvwl4X4rePqcaUEPIxnPFSR9Z0vGwFwVOkOObK19bUiqUSsQqjb0lA5pkRPmmXnktK90Kay8j7gq+wGgLlDuFV71yx77sRLb111GgEVVDznCC1DCiFJkYSpXMSAtLYRgkpWT5UnRW21u6LetsCrMxzFkMyHoU6KVhfy8llZQ63yHSgFDIUPUEHAzjSrbHOX5Z64u3FpQuEW740OY3WnkgmkuqYJmHH6yA2soSSAFEZzk5bm0bepdq27DoNGY8GFERxQCeSlknKlrV6qWpRKlKPZJJ0Ajj7D2lWd5H72n2xRINNpr3+RiQh1OkdFciQkeUcV5CWwOyCpWc41rd7N4bS2mpbMq4vnX5Mj/wCGiRWSVvDOFEKVhHl9SCrPp12NWm1jst+k1x6QFEm4amlkLJHkRKcQP7eU6/Nv4jLiqlx7tVh+r0ximy4rghuMtlxSlFvyhS1OBKlrIwORSOgOsDQXe9e8N07x1CHUZdBgQo9GbcKTDaJc8NbrY8y15OQS2Ov5j1g6vtoviMuqwrf/AAWMmnyIjaFtRoSwpC0PLaCEurcXyBShTQWUZTkukAhIwn+bW0WlyLLis05wuSKgypIU4oZQ9IDkVSMgDATKbpyhk/S8O+9Fx2ibdXjeCXK5bdImsXVUmpjK3FKjyUuTYAcZSXkKCwkSYklsp7GXPTOg29vfFrYUqWlmtxJ1IZW41xkKSHEIbXFDoUvhnBLgW2EjJ+knHYBCp2+W1U+lzalHvGCpiEEl/pRUOTKngEpAyo8EL6Tk5QpPqMaAG9Hw07eU2n0yl2jErTV511wNUynpqAcjtlOFPOuqWgqDLaSckHJJSB2dU11fDjatnx2KXcNauqryXoDbzj8CSgRmnUKUnDjCWnX0NAEhLoSsDzZCfcD3TPiQ2iuCW/SKZd3y8lbYS0/IiusI5rWltOCtIyeS0n9hk+gOFm2c3guKNWk064JdRnV2FIZircccU6+tKJD7jgyclSlFbbOM+hwM5xoS3fNpVqRa9aFDg0+fEqTrDzdQlGLLkxkt8wW23mioAKJBJHBXQykdg5KmSatQqjTqzEkKhyVKTKiyMgkFDpAXjv0W2fUeqdB+nu/cdMu0qU624yULr1IayUAkpXUop6X6geUenr19hpbtg0RqFYm9NVkRmJCZ8CnOMMOpCkLdlMuLZBB+632/br+2iz8PW7v/AIjvi1r3jQxXUsonRcJSuNOQ2ocZEdQ65BSQVJ9ULSSMYKUYW9IFN2grlz2nWVKdpVzW1BXQZbhCEGpU1gNNtqJICVFSWnOzjPEZ70F9Zt7Qv/EbbqXCYZhQj8xa6PN55UVbKJMXAwem0CLk5+qQR1g59Pj9tyqy9tF3JAdQIkJtDNQb4p5KQp9ooweBVgL7I5JT0CeRxgLpuCNM3E21eaQI0Nu5IMj1y3ES44l8gnJ4+WU0z9v8pj20yPxvw5U74eatHiuBKlTYSVJIPnCpCEgeox5lJPofT09wA4+HWgLpe39sRAtHiVeWwlxxtXkUhxXzL2QfYxIEf1H/ABj7nWyrNRqqbeqioy3Y9RrMRDTKuKUuIl1iVxbTnrC2I7bX74xrSUi34FEuOlUB1JMSh0VLCkgJ8zkpbUGOrOOj4cZwZ/1nWfuZx+XWIk2EytbhmVe5UtNtDJEJgQIaUg9HkpTa0jrJ0AP3quicd4qVc9UhUhi0rfhuRaHT5hW4mRH8SRF8bgkepW1y66CfC9dTRJ3w2ZlXdt5RTagSu4bHYapBYejoeaqAU0wXD3kZSpxSskHsL98HU0BTXXK3um6uFZ0yTRrOSstyrgQOL9Rx0puFn0R6gvkffhn6hv7Vt6i2tQ2KLQKezAgMA8Gmx6k9lSie1KJ7Kjkk+uhLNvN9FSgyJcmm0+JFU34MONV222mwARgJfaiqxxB6LhT2OtFW2rjgV6Kh+Gh0BQB9UOpwfT8xpS2z/ZR0HRVIUyYSwmY2iI4kpdT4IUvsH0KspI+4Uk+/es+xZ00PJeerSXHEqCUqSytKktjHlSsOeKk5Hu4Uf6BrYqOASATj2Hvoa3NUd7ZDEx62Lcs6npZQox2qnPdkPyCASBxbShtsnoDK1D7kaDSTKTQregSq5JkfhyYoXKlTWUpZUtIGVF1LYCXegfqST3133rA0H4j9kHqj+DRrpapi0uFsJlQHorSVcsEEqQEo79eWP399e1gVDd64/EoW7O3FIh06SPNNptSQUoKfMOTRcUo+ZI7SrokdYydb+67WtqtU+SavalKrag2tQZkRGnFOHH0grHRPQzkaAF3Swad8dVlXCtxDtMuCgvR4chKgpCnENOkpSf6FByPXmP30f4DVUFxVN6UtJgqQymIkN4IwFc8nmc9n+RPt2r2yFwWBbV0WBSIFsrbpCqO8ibb8thvPyEhtRKRwV3xzlK2zjrKeiBjN07d6sUq4pVGvG3pDE+NH8aXCipC3EJSO5MbOPmYqsEnj+Y2chSSDlIGfWT3DsCgXtHbNRaXHnsY+XnRzwebweQHIeqcgHHsQFJKVAKHTt3fFsbgW4m4LTqiKjALimlKCFIU2tPqlSVAKScEHBHoQfQjWj0Ajt6k3tt1MCS5+P0iU6pTyG/LxWT2rvAbWr1z/AA1EnnwVl1zYzplu3PTlUa46dFmU6a4GktzGMtOOA5DTiFjLboOPKr16KSewNXqtq1EhVJxLrySlZAQ7xAKX2wcltxJBCk+vqMjJKSCdB2QosaFFbiQ47UeO0ni200gJQgfYAdAaVH4odralAqVPuG0fHj1GC/8AMUGQycFpwKLioP8AQq5OM+2S417tjTNU1mr02oogEKqFKWk+FJcdy/GI9EOZ7cT7BfavQKCu1667gpFPr9GlUeqxxIhykFDiMkH9ikjtKgcEKGCCARgjQLHtZd0O8qBSb5t1fytdp0sQqxSuXUZ51qalLqcnJbceks4B6Tw4/p0Vrdv6rVS+lNR/Bco7z8JGFJJKGXKY9L5oIPqVhCcn2BH2Olp3LoF27O7sG7bcCXavHSqTMZUkeDXISVBSpAQOvETgeMhPaVAPJHEnhvtjrytau3PRHoVXShqdGZKYyiA7GeYXIipjqBznDE6MAr0UGlKGOwAKdQvKRQ3aPeNMiNvW1U4bUmu0yKwFS4rshHNqUhKRydyAUrSAVYSFAdK1hL0sD4bd5Zz1Tg3JS6bXpKyXHoM1MaQ44c9uR3cZUTkk8Ao+516WWHlPWa2sglqPa5UMDykMTWlewP1II/t/bWgXGpF30ehQLotyiVqQ3Cofzr9QhIdeUZKXEuEKPmSrKU4PqMnQLbfPw87wbctuuW0td12+gPKQIBPio8RKQVljPLnlDagUcu20E+mtGjZ+pzrHpW8N7qqFLeTPQ+5T4mUfhcB1S1LkoH1JWl90yePolORg+gZ2Ftc1brPCwbordsoTjhCU+Z0Hr28F/kUj/wAtSP66p6haO7Fy0+VSL0v+hUqivBTTxt6nLalSmSCCFOvLUGcg98Uk/YjQZWJKrW4VoUjcShpZkbgWDUZMCYyyoBqpBGESGU46w63xcQfQKIx99F+jS7Yv63KXc0aBDqTY/PhmXHSXIzwyCPMCW3EqBScdggjXLtfZdlbd0A0Gz2GYkVbniu5kl1brmAkrUVE9kJA6wOuhrH3rU4O097M3azJjtWrcUtDFejBwARJSsJbnIT7BXlQ7j18i+yDkPzsvVy4K9uDWHa8hZuOZVFtyY/DH56llKkj2GFYSB9v6at49HTW6zFiOMrTTGFH/ADaFBXKI0lQUoDPXkjSnPYZJ/bTCfG7t4q0bzhbuUGnIXGlyEqnqQD+RMSk+E4cHHBZCSevqR6+fWZsC1XKOxBi3C05DkS3GYbyXAWy3GW6GeRHpxMeHUl/Yh4H37DusGDE2X3ItitVVpL1vlbbFTbce8RVMqT7BeUpjHYQ0y4whwknkCc58vFkd8LWpW9WytWiQ47qZ8Nbr1OLzYS4iSznAHr5XE9ZB7SsH1HQnuCTCrSjTatJDD9RjMuVILKfFit1Jxc6cSPUeHBiNtBXsDga0vwl7nRpFr1ixag3Ji1ChR3KhS2ZKVF12lLSlxhSjggqSlxseuSFJ9e9AtO1dGauOw6h+OTZXGQZE10sOhDyhGR4UNtJ9/EmTQAMf8H9umwuOr1e//hDrcmVHcRcsCC41UY4b8RxufCcBcHFKhhRW1yGD1yBwr0K57Bpk06wU1iQpT4Q/IqwSlPiAR6a0X2kAH+adMaH7lsj20Xvgzrr9NvK+Nuqw49IdVLXKbkO8iiVKbShqfgnonxChWB/Mf20F3t3fDt8WtN3SkU9yLDdqbKn2CkFSGafAW+vvvKfmefH09Rns41t6PAbVdzDNZjsPufIU2h4baS22iQ229NfwlPokhLPl6HQ6xoebVwZdJ2VrViCG1hq7H6PLUynLaA5UIyCnHWQWpCiPfCdES82Z0e6PmYyQqR8hWaqgJ4qIebajxWAP3KVH/uD3oKBrdSmbe7bybrrrDz8KQ5+J8GEJ8Z5U+W+tlCckDysoBOfYA/1muJbNqQ5jjVzpbNr0h9/t1tfBIiNQ6e0MAnrxHJGP3J+2poFQpPxBXfSnCzNpjhCCUKDdaqkdQIHHHESSjI+xQe9aim/ENbkmSZNWotZhyu8PhEKeUnGAQstMPjA+z2f30f4FF2UvyQ9RGKvJpNUdaYiy6NVk+BMDSJSpTrfhvjmVOuLy4tJUTgYOq6/vhipMuZVq/EgQqvKcTU5bFPbQIYW+6htENnIOA00ErJ7TyUQSMEgBV2T8QtBddQiJesMozksVB5+KrAJxn5oPJOfsJSNH2y73i12Ah9aSUnovsIDrBOAf4jK3WgO/dzSgX38KzkCprg0VitKbbTTqfGmFAcbly3ipUmUsDJajtNggj15YGe+xG5Y142ld64duV5+JUm6WasktPOQ5CI5WQgLA+hxTfFwoJ8qVdnII0H6kIcbX9C0q6B6OfX01S3A/WGWw7FYkAI7CooQ8D/5ja+KiP2QrlpAqXvtvXZ7jS7nhisspQSl2pRCl4NocUwopkslLn8RCk5Kj5ho27afGJZUtxEe7oNaohUnHiZE1hBz68kpDv9ilf9euwLsavMR7ikVOnxXXJeSJ8WAtYD49A6/EWjxm3QE9KSg5GApZAGO9F3bd3XJgOS24sudBfL8ZD8dLj0Z1HqpvGSop9FFoqA9FEa7qTWdudz6eh+l1OjXChjzIXHeBfiqP6gQQ4yr9xxOsfuHszDrxTJdSKythILD0hYaqTBTjiW5QGHePeEyEryT2saCwtaqUOibq3TIUmPTaTXEQFQJyQBDnSEpcS7h1PkDv8NPFRClcegdFBTraXEtKcQFqyUpJ7OPXA0vlLtu6aW+/HE+RPCkj5tUhHGXwzjD6CHPFT6pClCShXfFTIGRt6dTZMelMsVKD4dOWtKkJDZfhoIHRDYUpcQjHlU0tTSfXokDQE7U0uO6F7Vh27Rt5taKvcl4QfMZqJfFmi5wFIkOnyvp6GUOpJ9cqKsAaqVQN2/8ADK5167zUe2EoRykrpdIZQ0yBnOX5Cv6d8U+mgMmpperJqu5dRXKasTeGh33wQVp/GrZejsDBGQiUxhCicgfq69B1rWt7rV62fy90rCqNBYScGsUxRqNPx/OsoHiND/qR/fQbDcux6TfdvfhlRLsaSysPwJ7Bw/CfH0utq9iPcehGQdITudYt6ba3fU1UxgU2ryIriXmYaMR6jGJBVIiD24qSla2R5mlAKTlH0fobbtdotx0pqq0CqwqpBd+iRFeS4g/tkH1HuPUa4b8s6gXvQlUe4IfjNcg4w82ooejOj6XWljtCwewR/fI60CmbAbpU+4aVGZqciO3Woiobr6SeADUeqF0rHoAAzOc676aV6Y0QK9fMiVds+i2XQJFbuHwaawadEILcJ2nVN/mmS4o4ZStAGCrOcgjOdCLdPYSqWldS6nJW8/EfWptuqQ1JjJlBxJSUO/oYkdkZVhl7lgltR77dzr2jMTqfc9PtqdQ7yly24Uq66NMVEbQrKPLLiOdBwgK5Mu4B4ApcWnsAxD1o7s3c2XLsv9u0YKxk021mgHkjH6pjoKuQ7+hIGsBSLO+F2qXi3QJtxJuy4nXvAT+I1yTJW675uuQUG1K9f749z2J7p3m3Vu22k2fArNFriZssNOhmN8tUZLPzCm0MqQlwNr8UIKleASEpBBWAe6C8rzNzUePT7P4wXVyEvCBTyluXHkNSEtxfDCE8VH+IsMxkggJSpbrhGga64Nr/AId7TjB+4Lds+kNHtKp7qW+Xv1zVk+h6H20PZtT+DSmzmpimaAp2O8koXGhS3m+aewPIkoV6ehyDpdKYWVKl1pFUp92NzFLmzmq0v/PCO2pSGmnZHakrecIywySpSRgrA71cUaTVTdraKbKm0mdAdWKpQ3FNR0w+Y8SY8yTlEBCEhthK/M7/AH8oBit29/8AZW6ttbitqJWhW50+E5Gi09VPktl6QoYaHJbYCSF8TnIxjPqNC+BbNUptJolp1KS1KqKXX6Y4uLjw0KU6xSW0DkM+VLk9zPXfI9e2KoVScTV4ky3gzbs4FVZj0edTy4y5OkJDMFENg+d5YA/jungFLK8DPm0Fo3FJj29OhioTJM6i1uoV+cxKdS+qGY8ZxpBL2Ehan5rvJKEZx6j3JAgVCGxd1RnJjstNfi6FICksAeWqTBFYORjPh06Is/0cP31nbUkFr4rpE1EhsMXna85MGOhBSGYiA4iKk5x9TMNtY/6h/XViJr1NtxDsAeFKcdmJgZC0cDFjs0OIMYP/AB5Di8fcE+2sbaqmEfErIvaJJdfpFn0qVPdbQoKKafFC4bLSB12ppKV/b8zvHZ0HvYsuBb+1cB11DTrTEGC04goBC0t/MVmQkqH8/wDlGiP3SNdFoVaZZG09mXtKfTJqTNRFYRHYbSXgl12R8+t1R7CFxVRgB/MUnH2wj1KqFL2MqbT0V2I2qmCpxUlWVLTUZ0ZtkkpJGSxCWMHvCj99E6rWrIfq6dqabHVFqFRpCm5tQkNhDdJhNKixnX3En+dFOTwOQFeNnOFZ0BftWeaH8RdwWY3ATMgXQ/GuaO6e0NNpjqS66DjHL5hmOB2enM+2iXRplIlzG0UqI9OTHLUV+Q6ceChTPzKVnl5iTlrOe8rST6HS/XzufZMO6oyLbrTj66ZZ1SobdXDREedJIj+Aw09jC3AtBUSDgZ9TnW3k3TGsS07wuebNTGp7NWmsKUSnk64zFZisNpAHaipkY667z1kgAZvveFLg7bPRlS2BUqxBiVOLFW2FfMJl1CdKdJ4q+kANHP3KfvqaBUy4oN1zDcF5FtyPTYsOlRabDcDL3goaUlCmyQQQnwvPn3dGP2mg/T287MtW8oAhXTQIFWZT9HzDQKmz90L+pB/dJB0PF7V3naQLu1m4s+KwgeSiXFyqEL9koWT4rSf6FWjDqaBfrn3z3A26guO7k7RTQy10arQ5gfhL9ACcjLQJOPOc/toX7K0ms7tXFX5tdZhocrYXWDLYCHSliQ0/CMZbg7aU20tCkNkd8CrPejn8ZTT7vw1XemOSFBqOpWM54iS0Vf8AYHVd8IMaGmxXZbTcZD6ksoKGXs8EFsKSC0n8tjIUFcE5XghTiipR0Geura26obkxLUdqofiZllAaBU2mQpLE9sr9OKPnYz6c4xiSnPqcDXdPb+2K9RUS4FBbZDsWoyILjTIbd4vspqcblx9VDwpsYBWfTH207RIGMn19NUty2xSLgiIjzo/Hg/HeDjWEryw54iEk+6clQKT0QtQ99B+fFf2fYptUrdRse73okimTyYDbyi2tUVS4gbdD6cEHhNZUTxxjPfWtDZ++3xBbfMMivU6RcdJTDRMP4hHLqm4xWpAWX2+0+ZJTlwqwRjGi9Xdmbjoc+nOR2kzKW/CcolReYUS61HIXEjO8R5lENORVqx9PyhPuNYmkXGusW5UozLZaq7bVXo8qMkBJbeeSKk21jsjD0eayke/WgJW3fxbbYXSphi5mJNrzwcpVKT40cK/0uoGR17qSke2dbvcy7rkr9Hi0DaNtNRm1pvH+ImlBdPprJJCnfFGUrdwDxQnJBwSPQFTt9bdsyqbhyKbSqcjxqhInVpibFBbL8Z6mokxUABJBy+l4DrPRHvoY2y1ddqtouHby8JaFlVPaWiKXI7rsiQ06rww2enUNqadQVHyk4wO9A8FYq1g/DBtKmOFCZVpAK0tlX+bq0sjzOLPZCc+qj0kdDJIBqdmdurjvyQzuLve85Upsg/M0e25HUSntn6XFMehXgjAUCQCCrKvpULbTc9mj7oN3zuTQZN7SF4cacmyVc2VBRw4gKyhWCCAkjiMdYxplaZuHb9/Av0GqCtv+ZxEIgs1KMteeSkR1OJUVYIyuE+g5P8M6Br20IbQlDaUoQkYSlIwAPtr+6Xig7n16j/MqjVViuU6GoNyY9VdKHIxJ+lUrglbJ79JjKMnrxT66Klp7lW1XpjVMddeo1XdSFN06ppDLroIByyrJQ+nv6mlKGgqbl2foUiqu3BZ86ZZFxODK51Hwht8+v58c/lvDPfYBP31Vxr/vSw1CLu1REP0tI8t00RlbsYAe8lgArY+5UMo/pou6hAIIIyD6jQcEOTR7ioaZEV+FVqVOaPFaFJeZfbPR+4UD6aDG6exUKoxOdBadLCGvBDDa0/MsNf8ALaU55HmR/wDp3vKP0Lbxg7Os7cuUyoO17baot2vVVkrfh+Fypk9Xr+cwMcVH/mt8V9nPL010WnuGiRVmLYvKluWvc7gPhRX3AuNOx6qiv/S6PQ8ThYz2n30CB3lbW4dhpkzIb6Z9JjFcQz2WVByDzZcZ8J0LHjRTwdXhCsIyrKSro64aQ9CRbTn4hUmqVPRNTFpDypCkTW23UBtDzrwScw2mkuDiz9SnO+sa/RTcqx4lzwHJsJJhXEwyUwagw+Y7g9/DWsJUFNH3QtC09/SdJ3OthmXOFvXFbSaXUpK1PIahR0ORZ3XbrUQLCHCcAFcF1K8Zy0PTQDCp1fnTy9JbiVtlmSVIq1OWliYxCjFLMYNo4lMNkvKSc4C1k/3PSqBT4sdmJd7YqFKmPLjRLkhpJAYZX4st1hoAKfcUs+H47mUj+3l9rlsm+qfTnWLbgwrgt6GpbjzNNbD7rHmJIkNFCJSEBQCgl5JSCB2cZ1VQ6xbbcGU3RqxU6LIdRFpRps8qW1IjjC5K3nx202pxP8JsD1Hr3oNNWbkqDtkPQX3mqjFkLFVqNTjTVLlRZLpLcBEySE4PhJAX4LIzls+mFBPNDlw25cESahMnCngGgVuAgIkOMx1FmOyhj6YyXJC1qLzwKjjOOWeVfR7kYmzk1ukOQaHc6g48iOGEKivPu4jxWYrH0NFtsqV4zhykk+4HLnpsyLBcmwqTTvBTIdSXqE7I8WHUgxhlgocBKpTipKlrKEANkJOMD6Q2NwXpUqBToSas2hydRaginwp1OClU6QiAFvqUl1Z5POuS1oWtWMDiPuNZTZu7ahRqJdxhW3RptUmUd1v8Yqriv8rGDfgqaZSB5nF80oAB7JTkYB1zyZ7dtUyTTnZshyVBfNMkW/OUla2GmwVScSAAGkOSFEeG1lSkhQKvdXxIcdVApMeHVVSHYykG2aklsofUto9xmo6D5OUh5SvFcwT4eR3lOgID0yFVXbHtumBsUyv16kw4iVqT8yqFBJY8V5OTw8V999QSf5PToaYuTtfYl1bj1etQHqtVzLnpfqVLkSSmA441LDDynE9KdCfDdKUFRQCk4HmxpYbAlLt+9bYmNNC3qK9d1Ph1dpaPGipdhcR4y56vKpS1rfWUtnikDJ646KN7fEzbdFanU/aml1SXcciS8y2+82hyMOUx19S0AEqcKy4vAwOlDskaCx3lo1ColhUm4JiKY3SqdTa29TWV4SBUXqg06020nOQrAc+n0CD7aWi97lund3cB+nUOPVZkafVZMul0dKvELKn3C4vpIAz2cqPoB64GiZt98NW6+5lRRWL3fft2muureK54JkHxHCtYbj5Hh5UpRwrgMnODpytoNpLJ2tpaotsUwCU6nEmoSCFyX/2UvHSfTypAT74z3oEV3X2Sq2ytDtW5q+qNVVVBbrNQjJb5sxneGW2+R6UccjnrtBx0MmaevfjbyLuftxLtV91Mdxx5p+O+U58JaFgkj+qeaf8A6tTUzRE7bsbkb+NR4tzHW9RP1u9TU1NUwhr8UEhprYe6Y6mw69PipgRms4K331pabA/fkoH+2sQHIm120NxilzodOdhzmo8Oa654DCmkqSlKUcsBJQoOpWkJWpS0rUpC+eDe7yVFFV3DoNAUhTsC3witTW0uFsPzXFFinRi4PoK3lKVk9DgknWU31i0qv28qzZ0dTr1JZAmTZTKS8C4w2h19fHIUUJkNSCoEZMR72GgWHcbdJL1ZTVod73TdNeZe5sy5WI0KICcqSwgAOA4wnxEhg/6R6acP4StzFX/YfCpVB+TVoy1cvHwSpscQeK8Ar4k4PLzJ5I5FWUrWBaJtzX9rpabtq8S17megUGO7KoFajuJWyHV+FlopDjRdJY8PxDgHkkkZVrxsyqtQazIvzZ2nzWo7swyZVrOMD5qHJbTh5EdvKRIjqQ5haGyFoy0op8iRoHq0qO9ViTbJ3GrN623DU21UHWqw88on5dLqHGwS4B9PF4NlR92pcj+Q6Lnw/wC8UHdenTk/hL9FrNKUG6lTpCiVtKVnipOUjKThXrggpwR6E6O/oUt5BmuRFzIMdIakRWytQlRHvJJbW0OlFKQlxJA5eXiPVXIPzcnV+W3djiKbGrFDS0tblNjHk64VNvrcjIWh1ZRhslTYKEgdHykqUDS209UqlcMaJQXHXpkdDhgB8jnxZKpCAM8gFHiQEI4gkgZPI6IG5uz8Omby1CzKTcKm0pqLERJqLRUttL3y5Dq1IBSEf5jPI4yEL9/XV2/txWtq6xVKXOdhPymxAfXUEAqZp0s4XHcUsDyJRIHguZPbclC8AaDh26mW87tjZ9wXLb0Ws0yz6s/S6/HeYC1Jp0/8xiQesgIcU5xIOcnH6ta2s/DtZN53DWadtzW121cNPIkx6ZMkGRFmRF4VHlR3gOfhqSU5PnKVZSfQE5ORId2y3geqrNLEux7mpjzkqjTFeHyiZV8zC82B40dYcSBnPkTj6gNXlaohtijUe6bbuGoVKxIzinLfuqmjxJ9uKWcmNKa/4jHI4Ug4xlRGCooWGbuedvDtXUozW5luy6vEiuBESrl9aZDY6wGKg1505A/huFQ+6PXWgtW9qHdEL8Lp0lie2894jlJnRmWpCl4Pm+XJTGkq/wBbCoz5PeCdGWz/AIgYqaGxT936VDcpU0eAzc1Na+bpE/r0cSAVNL9MoUMg5ylA61UbgfDHtjuXTl3JtXXoNKkOnmPk3RIgOKIzgpSctH/pOB/LoOa0dyLqttRXS62JNOjvFuTTK2865HYOcBHzTiRJhK9AEy0lv7OH10drC3St66ZLVKkJfoNfWjmKVUcIdcT/ADsrBKH0H1CmyoY+2kbuL/xc2bqcSLf9Ek1KnRiWYNRS+oLbT9o81HnQMD+E5lOPVvWtsu47du2EzT6Q8ic2kl92kOxAHkL7ytMVCkhS84PjQVtu+6mVaB8tVdz29RbnpDlKr1OYnw1kK4Op7Soei0kdpUD2FAgg+h0Adv8Acy6LfjRELecumjOPFlLUiUlcttWRlDEshKH1DP8AAkBmR7DljRntbcG17ii/MQaglAS8I7qH0lpyO8evBeQsBTTmeuKwM/p5aDL1CrXHtZBkfjT0u47TQhXy9TWrMymnHlRJOD4jOevHwSn9YIyrQirlRj12iVMu0z5+RHiuTpcVMRkqWkJKkuyactYQ4CFZ+bhLyrORgdaaKoVOmRYMx+bKZRHitKclc+/DbGclQ9eOAe8emkQ3On0WPCqjdMkLZtxHzEWZQ3Ynza7aqhLiODDgU2pMda0rAU2riOgpBBCSG0seRIuujw6gyyqWpuK2pDYdNb+TCv0IejrRU4ZHL6SHEp77OibI2Xj3vS/nLkp1Imqc8yBUEOPvlPmACZaW48lBzjPjB3H76VzYC73Q8/TqlQ6PdMubLQuKiVGb+cbcbZTlSJAdQ80AlCR5ULGUnHec/oNbT70izYEgxXory4SFBhLynXGzw6SFvAFSh91gd+ugRC+fh3iBzx7WnRlJW8phDMauRpnJxGOaR43yywUhQykBwjI7OdYeobNbmwHIr8lipMqiJSIrq4c0JZAJWAh0NFCcHKulYByRpxr+XdsdlbUyXdxiuf8ACq0i3CysBJ/Q4kZ7/wBQ99YKNbFYdDkmj2pT08eQK2KR4AJ4gA86TPV6/s19+tArN3UK56XRoLlXqdLLdKTiNHbUC5lbnNRICPMrksZKznAA7AAGp+H3Zq9N3olb/CKrEpVIQ80mdIlIUfHc8yglASnzFPqRlI8yT31rYb4G53Lbl0Wp19ikIbmxkyqcms1h5bsZaiC6ticsYbQvwT9GSVdEYILwbZWbRLBsinWvb7QTCiNAeIccn1ntTqiPVSj3/wBh0BoAJaXwb2pFjxGruu6u3A3Fz4MVpQjRkcjlQCcqUAT2eKhk96Odh7bWJYrIRalrU2mLxxL6GuT6h9lOqys/3OtZqaCampqaCampqaCa+JLzUaO5IfcS200grWtRwEpAySf7a+9Yne6W21t3NpRcWh+vOtURgIVhZXKcDJ4n7hK1q/oknQVm0VFNVoD16VHxGp1z1A1h1vAwqKUFuKwsKHaUseGcYGF5OqHcWnSHd54TjLqWiqNGkOKCQohCHFth0pzlSUKcU056Zamr7/LGjIw02wy2wyhLbTaQhCEjASAMAAaHG5DTrG5loVOE08X0OKZkeCjmpxhRwfL6qCORyn+VbixktdAPd8rhqatzHKTZ1tU+tIotDXAuSDLqDUJL0SYEltLZcwCG/C5FYyE+Jx9zhftpdi7t3Tu2fUJ1ZhJp0Vwh6uwiShUor5ueCQEh9wZVlYPEEjClAAFxbv202w3OuWRPuW2mKlUqG+mCt4uuNk5abeCVcFDmAHk4Cs4ydb+lU+BSacxTaXCjwoUdAQzHjthDbaR7JSOgNBldsNv4dk0qOy7VqhX6my0tj8VqTniSVNKXz8Mq90hXoDnGtnqamgDe9tjUifcLNwQaHGYup9oNQaitX5M5aEr5U+Un04PNFaAo5/qClAUFL0j1SuIl0dLkiWzVqdGRDdmIBXKaKlO04vgnzSGZLS4ThPakvIzk6Mm4dddlXQ/Fky200OXHQlMlhXJsM+KlsSRk+V+JLLZURgcHgSMt9Ci4au5WKXXpkaoQqE7TTCnuuqbDpixag7FeeeQlPajHnMOO4PqFEe4yC71a7K1ctzU2WxVPFap8xhmlwapLSsNoVlSGynB5pSUqbWtZJIW2FaKNEcp21m4zl4RZFWTYUyLEkopUN1IDseal0obkoWnDjTbiH2lE5UMIHvrJuVdaaOippuKmsCDQw98m9H7kyWamh5UYqwn85S1F9aU9oQpCfQFWtLZU9V10qvUuTOplZlwmFQoDkZghlxxysNvxefL9DjvNAAHSHU5GCToPfZvb5cisVq07Xvl23NwILr3zVNntIfpNbi8strSjBSpPBQOClfRCkjGSLuPsjulCutp6g26/YdwOKVir2/UwukSCMqAcZKvFYSSMfqTnA8MA9Byh1dqVApom1yRQ6hTZS2rZufC8tJQEKMWQUDmEJDqClYCuHJScFB8rEWh8T94WhAjxt2rOkT4fSGrhoxQ4zJ/fKT4Kz7koWP8ApGg0uy+8Fbq91yNmd87fjR7iWjw2HHo6SxUQBnitHaCSASlSfIrsYBAzlviF+Fu04zbVw2RUDbLrslLamX1KVCQ4o4bPPtTIK8Jz5khSk9JHY+PiD3T2l3Is6mXDaVwtNXzQajFk0gSGVxngS+2FIUpSeJSM8+ldcM5wDlppsFVWnRZKZUeZRXorjUqIrC2niooU26k99p4qH7hef0jQIGq8b724uFFH3aolS5uMlhurshBkvMgAAKWoKZnsjryPBfr0pJ0Q4lcjT4DNywZzE6noSWzWadkGIkqH5L6XOSmUEHHgSQ7HOfI40MYZdNoxJVuIt+4qWxW7aXHQERJ7aXHIaR4y8HolXBPgNpIPLyk6Xi+fh3etGsrvDYu90U6WykrVTJMoFKklPMtpdOUqSUEHw3QQRklRGg6axdlLn21KanVI4mRXqC3UwpBg01mUPzHHitXjMjgglDRU42pXHwllPoOLkp1Ij3XclZkTPBpF1tPPPodVjwm54qD8VZBxhWIkJ7B7z/XVPXYlKqE2ZCrjLuz24BYW2+24hxmkVZpf1AgA+By7PXJo+2Cev5I2/vKBYdTrSydwFGKpIXT1OTYkILYDQeW9geM6hvyoQ3yDWeSinGFABGVJQ6hS0BaQoEj7j7aer4Od6I8ylx7QrkR2nRipQp811oMxQvI/y4cKuKlEnygBPrjB9dJtQnaXVEKptQp4+ceZZh096OlDKW3TJSVOOkqAUS2XE5V905ICc6L8mvVCJdbG2229ntyVW1KlMpehxFTHKs6pv5Z5clIWGw26kHzDPhhQwc96Bht+qztm1cr3zb1Clym1KblpBHJt0Y5NrLEVxZV9w46jBV++hbRDR6xKVHtqkU1ucSA1MYieJhROOz8o+5gq7PHievUall/CpV5UZ+696rybosVazIlNCUlb5KlZUXZCzwQST3jnkns51dtxfhSiRHKZSLAuO6obHllVenw5chtsjoqU9zTj2+gY760FB8Q+1m4FQp1tuVa5qYpbsXhVm36u+7FiOoU4tt9KX8vISporKglOE8FkgJGU7D4ZN4XrduCj7VXNd9IuqJJSI1LqkBxxRjOhKSmM4VpSVoIUEoWM4I4+3lx7lu2TQNxrIXt1dAq9h3xUG2psWQ4HHIi4riVYBWOaAEOqSQoZCVrBOFDQivK36RttvxEfpzz0q3KbVIcxla1AvFkeG6QoY+r60+nqhXXWg/ULU1x0SqU6t0mLVqTMZmwJbYdYfZVyQ4k+hB12aCampqaCampqaCaGaR/jXe5SyoLo1jJCQnjlL1UfbyTn0PgsKH9FP/tomaTPbTfNja3cLdOibiPTEhFTfmQIrbJUp98vuFQScdc0KZwVEDigaBzNYa7FRGt17QUIrhkvJktOSGs4SkNKWhLoKCniSlzieSVhQwkFKnNBmz/jHtadOabu20qvbUKST8tO5/MtKAPqrCEkdEfSFeuqX4h71tem09VzbYXxFrFUrMWZClR01xUpyOhbXiF5tC1kshIbKSjyp86CE8kp0DQ0Wjfhldrs9DnJurSWpSk57S4lhtk/24st/wDf+9xoTbYbvxbmVDTOESNFeoiKj8yXeyoMtOOgj0GObg9c5Yd6wnRFj16mmOlUmdDadSlwvBL3JDZaUlDvmIHSVKAJIHqNBaaprui06oU1FMqMqbFTKcCWXYkhbLqXUgrTxUgg58pIByCRjB9Dx1G76fSyhie4FyeLrjiWUn6GlpS6Ug9koC0rKfXjkp5Y1mN8a4U2TEMB9lCKjJcYjyXXUttoeTGekRXkuEhP8Zlnirlg8sevoAc3Dpl7XIZ1OoLtOQ34ria9VZZbaiwkKirbfkKQTnw5UZyM8EpHTjajnIJ0u7VWoVKh1OgxpjcinwqXUaexJa8SD+IFa0yI0iQpBUXCr9DX/wAlsKIBUQRfiNueBKvaS4p5VJo9VoTC4UqMtzhObLZkQnEx23E81odS+wVqJQkKbJTlIyPv8K0X5CNPh3XT5k16nOpepT8QKWFvSEpTEjuqAD8gB5wqdH8MgfYYC3veXd9uLiMtQ5c2nS/no4gTUtPS4yJfhvSCp5JV+e62hRUTktoWM45jWr2CpzN93LLual0R9TduQV1p6LSmAw1NrLj6nY8fH/LbSEJA6wWyScHujiThCvatWrMgLgQX3ZsWfGQ8H121EclJTNUHe/GcU0hKS5nypP260b9pKfC2N2UqV1/KIerN3uiVTqWFgIbbKFLYbWvJCUNtFTjjhOEjl30CQDkyzKLIepdBbfbUtuVJjuSXMBvDiY8ALJz0CiFNk5P6EA+41bXttnULTsCztwdvqxPtlyvyHES47chSW3A+p16GVIJxjhwbUkgjtJwSDkjbXbJXBVno9UrUlESgykqS+w4gtSZLSkISsobAAYbcQkMpQTybYBTgKcUU7fduizN2q/K2xgRjT6FQfDlTaqnIR834KyxFQkYzx8Rp1WD0kAdFQOgDth0q3LjpIhX3Ytt3FLdajuR5keKKbKcTIpbk1kLUwEgnLDzZPRzxPeNa+2NvJNtIn1jZO+KpbfyzpUaHcLqX6fPQOPnSM80IJV4fiEZ5JIB99Fuj7c2jaK3qxNC5uPkmmg8gFLIYiGE2lKR65Q67nOf4h+w1h67W1Xuyq+aZSwG6PMkxYj0cLUuZEZfIWysYxlb8ZgpABwlz2wo6DOTPiEptZo9Sp9TMi0Nx6GpxhEH5jnEmuehb8QEJLaiAORKSjkFJXgKVoeULcd+ZLmvzm5EGcwkpqMZwJbcY8/Il1BAQkFRzzwGVKPImM4fEVy13a62KNuFT6duRVFURdaiSY9Lqzbi0vMyIy46GZDgI65Hxhk9FHFWUnseV6W3Ecuv8AviUnb/c+A0huk3Ex+TS642hIQ0XOIw0opASVJwn1ChkcdBZ7g3PVam09T7vimvW28lSEzXGEvinqUAE+MhxSXY6iMFKw4nPryk/USN8Pbm5dtW98pbk+mXvbUM8G6VJlqj1CK3+jwXHW0ckEfpcSgdYSQO9DezV1SJVUUG7V0W27kZSW2mJLxhtuJWQStg8kIQhf3jvhCs+ZhXuzGx1rzbbgSg85TxGewW0Qn0ONk+pXlptpskknvwgo+6j7hm7gZ2pqEpU+5dkat+JrJU4FWaqS4tRGTydYQttR/fmf66+Kjfb9r2w89a9hUnbygtdGpXKlFPaB/8Alw2Muuqx6JPAnV1f9rbe0Jhcyq7gV2zGHOyhi63orSusYQ2tZSP6IA0Bb4uX4b0UOrQqHXpFxXXU2vw1mr1tcyV8ul5XhuOh14cEBCFqVySM9e+gyDkufuhulMqt31O47mte3ae3UVQ5TQhtz3nVJTGaZYScNIeU42EkkqUkEk9gAs/Ehdd77U7HRoSq+xFrtdeRHjxaRCbjRqTGQgl1DBSOfXJCOZV7gpCdW/wlQ6TXoF97jTITaKZU66j8O8dPTUSCkfLqBP8AJ0P2Lf7azFd+IOA7v9VbFue3KZXLTk1KLBjSJzSUmmhbbaXuQUg8gXBk5IxxPZGMAtG39jRa20647XA3/nkwnX46uQZS4plRdHpkeD80SCR/CI++qrdes1qZckunXAlCKxSpUiDJUz0hzDrhV1/5i3j9sLAGAkaLm7eyt57Q3HVKhQ6RLr1lSl+K2uMkulkDkA2+gdjyLcaK/Ti6SDk8dZe1rnsK5Lgh0ncCO7LZNxqeNSBLD7rEhrw1l1QPlUh1DLp9R5ncfuHFtNubd9kuQU2FdHyTfyrr8+k1NznEdeaClKCARgeIgJxgpUV8k5+nLm/Dj8RNvbrIFHnMoot0No5KhKXluSAO1sqPrj1KD2P9QBOlAtzZpi+lSHLLNTbKh4LceUEuiLLShaiy64gY8Nzg4EO9YUjitIyFHYVDYmuWRZM676jVodtS6cgS7fkyZgZluvoAeSzxKsBS0KcBR6hxjoFKzkH+1NA3bb4lNuqltrRq3d11Uyk1h5rw5sMqKnEvIPFSuCASEq+oZGMH9jouWpc1vXZSUVa2qzCq0JfQeiuhYB+xx2k/scHQW2pqamgmsfeO1+3t4Vlis3NaNLqlQYSEoffayopGcJVj6wMnAVka2GpoAJ8aFDp7O1lLuj/DsCqsWrUWZBp7yCGXIyx4S28IwQnKmz1gDgPtjQl2j3J+GeTT6vS5Fn/4DnVmI7BekrU5JT4S0dlDxyWzn7ADKUnP2by+Ldg3bZ9WtmpA/K1OI5GcUBko5JICh+4OCP3A0I6PS95rapFJo1Usax75iUhtpmNLbnGNKWlvHhuEPNlKXBxSej69g/YFvg27de28euUSYuMl23AKtT5z/JcWp09ZUOISj8wJIW8nkAUj5l1CynmlQ2W2N3T5dvsw5kmnzETnPm4k2M784mMoMhp1p9shKnUlgJD7JAWQFPI59ls8V2j2zv3t/PpNUps6g1qmvORHEPBIl0mUWwSAUHC0KSpJ6PFaSP7KVSaJUbOvT8D3DuR+nzI7jq1zmhNlLbcYbU1Ff8NvynweLLqSodtv4P20DDQbhgQJyIlbpshAaS0n5dqUHsOlJERbT5KStp3+GzKCkrQoht0ny8V93wvSt3K9HXEYqLMenteAtmbISpxbSJDoZfkRWj4TL7K0rQsvKwrkhXHs6tbnrcKsWBHobVLkVauTXJbzq2qQ7DYgpkNLdXHbR4zZc4S4bpSVEoAQTxJSE6ylTq05VnVO20V2PBgLmKUaJBf4qkfMNMueVqKkoUELcIBefKR0gpBSdB9V/wCacp1Bh12VRpyKbFBkymPPFejqqjail+R5Q62hTi0gRQriCRyxyAoqqufaFHU29TqzARWaQ423MlQR4aFfNqcbMILUFR46sJPMgqPmIHeR6sUW6bpulVBup2e0zTFO05kTlF10hMlhr5dAUpTbJSXWk/lBAwSBnOt2qALzttlmPEbm0tNIg0ylwmwpK1SocdmctpR788lD03jj1UjHZ0AuvW2FUe1YdYdqVUnIlQ4cl5RkhSUPzWXXcY+xLWDnsls9/Y+zq7U6/blOiS6vFQHoEqj09c5aExWHFPQ5cVlxfEBCJENkIClZyeffrqks+jUyZGNtV5D9ZtxVLTCkPR0KMn8MLi3qfVmkYJV4KnHWXQAfDxhQPY0d9kfhztOy21VKbW5l2mbTvk1tTAhUB1gq5JIZwcjGMBSlAZVj1GAzzG/t0TdzahTotsuRIdPpTbblLfSl2RIqr6whiOh1txSOBJKuWE+RLhI6BG1teSiM23trQ6y9MuZ+U7JumrMJUPl1kIckKQsjHiEuNtIAJ4Ag+rZGq29Y1uWXfC1UC3aTTY9q2lUbkZiQ4iWkPSumkLUlAAUUoDqc5z+adVW0MFNIks1GE74p5UpEyTyIXKVKZQvxDnpXN6oSlnHoUJ+w0FN8TlM3Bi3OiDZFMVLoTNsKUtKn1ARFMJkBS0gnK1lDyQD5vNwJ9NDLae995dv6fUFWjT6BetMqry6kunxXFLkwnXBzV/lwUvp6xkcFJ8vR9ywu6u4yIO3bTjzTcCuVKG4G0vtY5spjNyJCUcs+iVhOD7pJ9s6H1tPQqvZ8KkogPzBCjBKoaWWq81FUEhJJjP8Ahz2T0cIR5U/pOgWLeav3HuBfBn3RcsV6tJZLQhpiux2IuApQjthYznPWVDtSx5lDKgyW3120qpbWUK3t9KVDrlqyo7SabciwHExlKbBSxLUglUd4JIAcyOScEn1Og78R8eJMgxUsViMVsOkfJuzKhGU2A0tXliz0ktD0GEOkZIAT3kaT4NqVPj7hyKfEbRPoc5S/xKKZ0d9ksIRKRh1tKvOCsM4IRj0PQIyB7oGy/wCFUpcK267SbzsuWlLkajXO384zGIPSo0hGeAwT+g+g7z3qxe+GLZuUUvqtJcB9YBdRCqklLfLHYHnAx2fYf0GpUNiGqZLdqO1t6Vzb+Q6tS1xIqvmaesn3MZw8Qf6EAZ6Gs3d9z757ZUxFRu++NqnqYpfhpk1JiWy+4rGcJbYT5iMeiQdB73Ftv8M+2CkSa3QKc7PVgsQ5Lz0+TIPsER1KUVZP+nHfsNDO4ttdwviBuim5tZO3G3VL5CBHkR0svKSrHJYYTg81AJ9cJSB0VEHJVtDfzYhlhyYLnt+HXJQK50mPRpEZLzxPaiVN8lAn7knQNh/GDeKbfXTJzFPkVNpbzTlQYhKW2+2rpC0pS62W1J7+4UCOkkdgaN8qzbmzm00OzaTxZgMU9xhqKF8nXEuBSFrcPtkKcwf1OLSQAlCyFr+GCBSb63AuGgbgtOtt3xTpHyc1SfD5S0vpd5NKPRUClR6z2niRgkaom7O3Z3goVw3i0qRUaTR1uvPKlOlLjrqUpK0IQSpa3Agj6icABIPonTfVLa2xd1dhbUYseoJpopUZD1vVSNkLjOjHMLx3krT5/wBXMZ9RoKiDuRuLspGRQd1raqNy27EAah3VSUeKpTY6T8wgnpQGAVEg9frPmN0xcnwz7wFLUtdqTp8jrhOYESYSe+KVqCVk+v0qOsaxvHvZtefwjdTbaTckJjDaa5SQcOpGPMohJQSRk4Phn7jVa/uX8M24S1M1zbCpR5r/AE4tFC4vZzknnGUVns5z696Aq23tvB2Xky6vZ1wN0205ToXVabV3VOMRs+UPsu/UkjKQQskKT6qTgELX8XNRYrcaXIqcRui35THWWqszElrch1anuJwzKZycFIVwGCOQ5jJPHqgqN/vWnVzGses1Wr2228tNJp8ua48ksrWAtopUlJUhWPDcYcRlHNK0FWeWsduZWYV7y6DbVuNv1CTDmuwqQT24uC+pDkaMSRkqaW4632esgDoaBk9oYWymzGzdq17cOLTXK5dEYTPFkwfnHuCgFJCEhKihCUqQDjGSe8+gqt3HaPtPXrX342cfY/wtW3xGq0CESmJJByoYb9EEhLg4kDgtA6BJGhVdlrXDuDulcdBZgyqixbny9uxpKEOPt04Mgstnw2vMErW0rKyClPNRIyRohbs2fM28+DW3LArxZ/xRVa4l5uE26HFJWpSiUpxnPFJQklPXJfqc9g6dHqEarUiHVYS+cWYwiQyr+ZC0hST/ALEamg9aDO+m31v06kTqNbt902HFajNCnSvkZjIQgJAPijw3EjAGcpUezj21NAa9TU1NBV3fXqfa1rVO46qtSINNiuSXygZUUoSSQke5OMAfcjS107du5L1rcNq4LrlWVSp7DEhqHQYaHZLTUlQTFS9IdCj4z2QUtstk8fMSkA6YjciLQp1gV+Fc8tEOiyKe81OkLWEhppSCFKyfQgHI/fGkMpll77T6hGqlKsypVOImRT1QJTqDES+zBaWzHUpC1pKQppXZIB7yCMnIPbt5bFDtymSXaLPl1M1OR83KqEqaZTspzilAUVk4wEoSkAYAA9NKJ8c1Pdru7tKoFu0/8QqsyCiW0GkIIUQl9DwUpR9eDDJA9uB98aMeytmbt7fWRWVXHVaU6mJQxGp0CnpXIcDjCF+G4CshCVEKCSgJIUUpJweXIPV64m6dLTV0SRMhOShFi1NZ5eEtImx8rUB0HI01iT6jISs94OgFuzNrUrcK+YlLc+Xh09MKQ7LlNUjLmVPLbGGypSMoTKaWVDptCAf0ciwNF+G2ompSocuZInQIz8vw1P8ACPGfUUQCyoNN+qSlDyTnkOTacge5DtrbyhzrHs+6bFtun0SvU1ppLrU1ksuSmktGO/DkuBJWesgKIVhSEnBGt7bk9mgV2JYb1WcqstUZcmKjwvzYkNGEjx3OXm8xCEqwFKx2CUqVoFT3g2wvGm7qXHXaTbVQKHJ8moGqxmvEbXHfDSmVdAnlHko5qR9RT2AQCdbXZK37Drkio0CVU5dHr89CXBSEqWzLgPsr8ZKuKkY5R3fEDTwOFNrShQPHtnqlPh02Oh+a+llpb7TCVK93HXEtoT/dSkj++hNb9flb57W3OmlyJlrShOManvtLKJDaEoZfYW4R2A4FJKgkjyqwDkZ0FluLA2vgU9Ue4I8aNLokZdSZeiLVDkMKdLqyptxkpUlTq23lFKT5uKiRga7NkKzUnqIxbNYdmTKrSaRAfqU2S7zWZUlK3FMnPeUJ4evstOlIuu8Lovig1hFwx47N002rrpk6EyCS8pulzUI8vYJU4l7odZX166NLm4Qo9/1N+JI+Ug1WZT7nTKPaHaZIpwhlZGO0svhpav8ATk9YOgI+8dpVmbVKZedrwmKlVKbHfgzaS+4EN1aA+B4rBUekrBSFJJ6zkH10HdlKRWbd3ii/Nyq/QbKMduHBp11RIzD78pHiGPFYXyUp3ww4spcBBwAjJAA0XNut1xd12C3IsGO5IZhtSpikv+aOkpUh1K0gEJcRIQUFBKcpUlaSoZ0GvijsRyDcVarEC4pcR6otu1dwIcW4ptqNHT4bauZI80xMZLQGCkuuBP20FV8S1XrVz3/Gs7giZGTVW47C46xJfZLrDYcUuKAlaW1R5XfFRClskjhlQ0abY2bt162o1LqEmWZ9MAiuusl1cdSkAHk2xMDraM9E8ARnOD7DttLaOksbg0/cqe2fxxcBCpUd1pC0Ny1NJQt1tX1oOBx45KcHoA96KYUoKVzCUpyAk8vX+v27/roAPuJsRc1coUmk0bc6qxo0hpTTrMtLrqFoUCFJKUvIaAI66b++h1s9sHd9q3Ci4p08ymqbPiGNHMRtC1/5lsPHyleEBrxPRQ9BnrI03ySVJOUlPZGDj/frVZRrdoVHkPSaXRaXBffH5zsWGhpbp9SVFIyf76Dq5IZnNxEJ4+KhTuQDjycE4+3oR/tpZvirs69Ln3PpCY9mquK35jEOEiWnktNOSZJXKJSnKkKcSGQXQOm0qA9Tph638wK1SuL3gh2QphJQe1DiHSDn7+Cof0P+3NbNWRGo0CBOBRKbZZYCSe3FfL+If/6L/wD26BdmNmNmrPsGp11+z5t6VSgvAV1l196O80nP5rjbA4pLYSS4gEYUgdKJGtHbQc22uKs0aw6RCdoN2Uv8etAR2sB2S0ylTsNSyCT4iEhac+gKsftpN6HZW31/0bdyI245Q3Gk0i62UJziKpWWZOPfw1qIJ9eKgPTOiXQKHbTVGoqaTEiOQKf+fSVIPiJYC0KSC0ok4TwcUkY6CTgdaALWnekOjXXL3Ppin5G3N3ttuVYtslS6FU2kpbUp5CclKFJAC1Y6UEk4GCf5clpVzbYztwdob1tun2vUcT5tHrbv/uxalDJdYdSfJyGMJGAfuRhIMNIsuk0W66ncFFSYK6wQqqRUjLElwA4e4/pc7wVD6h6gnBAeve3bcty53ZVr7ISL3fjPKWx4dZQ7DiPLPNSRHcWpMc8lE4S2B7j9g/lp7tb2Vuy03W5tvbNPpBaLon1CtKiNKbH/ABeK0lQQeiCfUf1GslC+KTcANv1p3ao1S1obmJVXpZkFjgDhSkOONgHHfrgfuPXVftwq+PiL3XnN7heBGsq13gZFHgPcoj8oHyNKWkkPYwSo5I6AGArRE+I28ItHv7bCw7cn/J1WRXI4fhtPBuKICj4S2nm/pUlYOEpP8px3jQJ/upuTEkbtVe77KeI+em/OsvORQ2phSm3G1oCfTzIWnmT6qTnJ9SavgQ2UmqqzW6V0QVMxmEkURh5BCnVkYMjB/SASE/cnkMcQSx8bYnaGNcBrrNg0YTSvmMtlTQVnOQ0T4Y7+ydVPxF7v0bbu05NLpkpEu757JjUmmxfO8lxY4pcKRnCU5yAR5iAB69AsdoWzd24HxL7kVzaS6k249BlvuJlOKXwkc3SkpOAfKpSVrAKSBgddZBw2q+HKdEvOLfu7F2v3jcUVQXFaUta48dYOUnK+1cT2BhKQe8HXN8KFGpG0lNVaNecWm9KyuJMqTZTlLCXw8GGeX6lJ8JfL2CnfUjTJaCamsLft8pplbptsW/MpL9elvr+YakO8kwmENFanXUpIKQVKZQM4yXU+upoN1qampoBfvb8jV7qsCy6stX4ZV6u5IlMpCiJQitFxDKgB2guFClZ6wg560Qq5S2qvS3Kc9JmRmHCA4Yj6mXFJByUhacKSD6EpIOPcaXH467iqNPXYdGtMzm7wk1VTtOfirKFIQU+CW85APiKdQMHrynPr3qY957mW3s5WE3dZFQp9YptvyZCKs3OYksOyG2VrK18VlTZKuJA4kdkZwNBob33s28sKFJjreqFRRSloiSEUuIuQiM50lLS3emwvv6Svl0etAPency4KxHFOoW2LFr0p9qNInqqjKUyp7HiqUxFW00QpAcWlZ4FWSkLUSlHJWmGs6yLYg0mxzJW25Hp8FtulQ3QChcxTRWuSf+Y8UJUQojy+cj16zvxIWAqt0Z6oU+C4+taHy+lkq5lxTGOazyzxUGWo5wMhDzmMZJAL7s3vLvNfe6VOiNSIDrQddW86VKjwc48MKdIOXEILzQS0kgKVw/UtSi41iWbDtcTZi5T9UrlTWHanVJIHiyVgYAAHSG0jpLaekj7kklWvhqs2oW3dtZpVNgOVFTNOTJWuS6lKvFiVt9AaZQrGOaI+T6ALA5Echoy7jz946Hb9EqlCpBqkppLUSdDgvJcWpR8HL/FYAxkSE4zkAtKJAKwkOzeC5lPLq1kokx4tUmQlO2+peEqNTj8H2UZVkK5qLRQMdlp0d9aWnZzdd/ZurSVXLUXqjCrRZ8VLjRDrCG1Dg4lPRP5ZfYUnvg7HSkkJxrQ/FNRd15VFp951W2HUTmI8JP8A7ofVIVBfjpfUuSsoQPDBW+CnBIHh9kdaxe8dYsW+KaXBWGp1WdZYW5JjtpT4khiMRIfQjo8pL62GQnAz4Kl4wAdAYN3bCt1y5UbvWdUIa6XVA2/KqEUB9mBPaWl2PPVwyfDJBbd+yXFKPuR82lb9Nr5fYv610UW0YgH4NOFWDTsZyW6lp2LFdjrPzEJS3E4UriEhzjgj0pP/AGcbNejR7uhTFL/CFNxJLbKjlKXXPEHIDPRUhCSeuxwP2117uXDFuW5WmGpSEtNzJEGC4oo8FptVQhNNnrGEBUCa6D9mie9ARnKjblibNR5G1NHptFk1NRbabKea0P8AifL5dJyp3hIW00oknAUceg1R/DxfdM37Zjzbndn/AIzb6mpUilNtpapqng654L6cZW4UgJPFailKgCB76ptwV0q0PhnauetuSkyKpVXKhAbGeSRJnpnttcCeshhvl7jKv713/s5aI8i3K9cjyA2274cGOD6r4LcW45/QlaEj921aBtT0M65PnmFyFMJWMpS2vPNHYWSE9ZyOx7gZ9snOOpQCkkHOCMdHGvItNFIaU0HAjgRz8xyDkE57yCM5/wD90H8iKcwpLrinFFayk+EUYSFYA/8Az7+uvfX8SlKRhKQBknoe57Ov7oMrf06RTxDneCEsw3Fvod5ZKl/KyspKfYDCO+88vTrQPu3eWLSviOpVoR3TLp8R9iHPcbhurcRKUiahCeQOAB4zQPlOeyCAkglret1RtOqRzMjkfKgpjgHxUlQcQVqOTlJyABx9Uq7Psme8NdLG510zJdfrqGIdQbeai0QJjpa8R5YWZC1jipwodXwUOeAvieIBAB47erVNuG0nhVmmFxfkWjNQ+kKbcacjIcUVA9FJCyCD9joVVbZrcm1XeOzG57lFpKXFLaodWbEiNH5dlLa1JWQjPYSU9ZJznXzZUxxcKy4yHUiNcNDpcaUM9KD1Lmeoz/NFb/f99F+zKp8/Q4VRkKwqptsPNjOQSuMhZx/sr/bQLqvY/wCIa63XWL33kZiU9+SJLjdMW6tSVYI4oHFsITxUocQePpkH2zVHea2TsDfWzqTMfXV6X8o7GlvEeM8zKQ20HRgD6FOE5GcFQ9fdz21hxCVpzhQBGQQf9j6aA/xOfD8nc9w3DbdVFGuURflXitSgxOZByG3ePYIOMKwfQAjoYCkp9bovw3fCjSZ0VtmVWamwh9hCvSTNfQFlSsHPBCcD+iAOidAP4QPxTcT4ombkuVYrEthp+pSnpSAvCwAlCgMgJ4qWjjgYTgYAx1st5bSvCe1tXQd3KVIo1p0Zv8In1inzW3Wg4sJbbfUcHwxhDWS4MZ5+nufttNtdtfh8tqrV9NWdZZdZT89Uqk+klSEFSkpSEgDJ5Y4pBKiE+p0G83HsqjX9ba6BXV1BENTiXD8nMcjqJT6ZKCOQ/ZWR6HGQCBza9kbdbV7nWzbtDsWEhdbjyjFrLrnjym5DKQtSCXMkBTeSCgjBSRjByMd8J9RvLcO9ri3AqM2a3aDVUnrosZ9aypxchTeR2rHhtIbSAMYCnF47zo2XtSJE+9bEqTDC3EU2qSHH1pST4aFwZKMk+wKigd+5GgXnfCf+HfFxCmMrCG4tNpsmUSUgZbkuKyc4/Rn3/wDwy0GfKp+3kepPMPzZcelIeU0gEuPOJaBKR+5PX99L5uLQmq/vtfkmR/DjQqfSgr+X5iI+Co+vSVuskj9xo139UIk/ahU4mQxTJ8RpTzLAIkOsugYjtAf8RwqS0MYI55HYGgTKHU4aqPUbq3Gblt/4k4z6wYawl75NTqvlmEK7wp1/k9g/8GIjHWpozbOWTC3BvaXWq3TosygUV91LyT+ZGn1RaA2tLYPSo8RkJYb6wTyUPU6mgZ7U1NTQAD4xLIuCo0aDuJaK2/xe12XXXWlkJKmEqQ94iSf1traSsDPYyO/Q1O0d61hjYRiBubZF1tUGRT/lXqoptlxlqGppLfJaS54wRxyoqLZwFH1AyTPvNbky7tqbmtunr4zJ9Odaj5OApzGUpJyMAkAH+ul4vf4qo9JpDZj0tLs5XhMVGg1OPxMdSCUSY5weSVHKVJWoLQQFJIChjQaS27Y3foNIl0ypRpVffo0+lotmSxJYTHLDPipU8rkoKRlnDToAzhfJIVknRtt0Q7ZtNPjVmNKpcZxxQnPPpSEMlajlayeJKSeJOR6egPWqPb7cmFctGplcWqIii1ogUyY2sgB0kj5V5JzwdBHEEEpWQccTgEdbpbCbc3gmfOojqaUhoPvzYtGS2lb77ajzT5yUNq5ADpAwQcnvQFi7qzVqdTZ1SgW83KditLchq+YSXZA4LJS0gZK1+TlwynkkpwrkCE+UWqViLTDdV2S1UGnx46n36f8AluqR5clC1pCvEwQSkt8SQQCknS3/ABA73IVV7VtumNS26uhtmpOeJJTwYeVGkNIZVlKVBaw62olWABx8oyrPpvbHvi5PhtsyvW7TKi5KoUnwZEVMcureYSSht8J75pw0yvkMgh3OcZ0DO2reVAuWJV5dLl8o9HnOwZjrgCUodaQlTgzn0TywT6ZSfUdlfZmzW2XxCUtN/W08q3JCqnJZekwI/wCXNbbdUlK1NKxxWpIQrlgHtWQeiFatO6b9qNpVaz7VbqcSPV3yutusuhMVYJPJTylIJaGOlK8RKSkeYHslp/hpvyzZ8VrYm3lTn4samPpeqSQWPHURyefaV9Q5uPHhkApS3nPmAAE2uwbW2b2hqDTMqoMNuAl2U14YlSXSkJzyIDbfkSlAUQlDaQnAGANLTtXtlX9zdwIr9ZpLtFsymqbmywSW0OgJ4tRkpV5uPhgAc8K4LW4rBfGT3IvM0+Ddabgo0O4m7WXIqeXiHVR1BTyhxKx0AULSkjsDrrGNJ7cl93Dujf0YuVSpzaEgNTp1PdUWY+Uth6WhLTZCeI4vkE5WpKCSonQH/eil1D4jt2Y1hWtOMazbV5Kq1XbQHGTLUMcGxkBakgcR2McnD6AZZHb+zaDY9twqFQIgYjxIyI4UTlbgSVHKj9ypa1H91HQc+Dikzbfo02husBTLLrzrz0Z1IbZlqLaX47rQx2C2lxpYBBad6P3YTQTXwgK8Vwq+kkceh9vv76/j7Db4R4nPyKC0lKyk5/sf39Neh9NB8MDDKOyeh2cj/wC/f++vvXlGQW2kN4QlKEJSEpRxAIHsMnr069sep166AZ711iE5RRTWZyVuqeR4rQHSU5eTy5ffm2U4z7H+6U71ttxtyrll1tCfl0LjORzK8VTwH+VcWIg7QFlLmVF1PHicep05O8s9S4q4X4iXlR5cZwsfJqb8ILVJAV4novIRxwM44Z/UNJFetTqFVuKvPgOUB6rtNsVJLr5d8NgmBxEhQAShgHBBbyv9KhjGgMHw+3yquUC2YL/MSaHUbehtqVJS6XGi/MZBITnhgPBPE4OOPsQSeLerPg0q0oXoqBKhRjkYxyXMi/bH/D/9dZVrZOHDh/JPsr/MjPULg4iG2yiUkV5aFPJIHNY8qQFrAX6pIwkaP1KILqXEkfk3DGb6OOk3JMbHQI9lfbQFui1N9LkWZJPCAIDjch0nKUPMvBvv7Zyv/Y59NarQlfnKRRZTXirSC3cRCc4yUVNCU9Z9RywPfv8AfGtZEutLDqkS8rbSmqvKUBkhMWUhsJH9nMf20GnqEOJUYL8CfFZlxJDZbeYeQFocQRgpUk9EEex0Ebp+Frbm4a3Hmy6hc7dPj9NUlFTKojQ90oCwpSEn7JUB9saMzFXgOvTGg+lKobikO5P8qELUR+wDic/vrpgyWZsJiZHJUy+2l1skYJSoZHXt0dBzW7RqXb1EiUSiQWYNOhthqPHaGEoSP/v9yT2T2dd+poab31esy10rbe13lRazdSX0OTwCfw6E2E/MPjGMrwtKEDI8ygc9aAOtb07NxIV8ruatOyZly1eYC1BirceRFQERmjy+lJKY6VjJyOQONVG6fxBWduLEoduWpW5dtrkvqaky6kymOiltcSFv5CiFueHyS2lJ6KyelceO52KtS2psSpN7TxqdQqLSZiqeq4JEFEyo1OQ2ElxaVueVtoZAHRBJOAgDv23TsVF0ykWBuJHpFTm1mK8q27niwkxZLctlvkWXgCfUZUOJCVJSocQQDoAvf+6r9Xo0Pb7ZqqIs+wKIhMd2vynFxvmXR5gAoJ55UrvCRzUSpSgEg6mg9bVL3F3dfo9hUWEZLdFZcDTKGG2I8YfqWsoQMKVxAKlkqUrHepoP00se6aJelrQbkt6YiXT5rYW2seqT7oUP0qB6I9iNXWkbsu56vsNcX+JqbAnubdVeYY1bormVP0GePraOf1D1Qr0dRjPYB06lt1ulXHQodcoc5mdTprQdjvtHKVpP/cH2IPYIIOCNBYazNe2+sSvVcVet2bQKnUAAn5mVT2nXCB6AlSSTj99abU0C3X1tXfFlwrjgbYUyFcNo3CVOv27Ik/Lu06SrsPxHSQEgKCVBJ9CkY+4y7Vnb03HRZsudZFWo9Xq0RMeqhq5YaYVScS2Gw+9EdZdCVEAA8SM8fbo6bnU0CU034RLkoFnwbjjTKbV72gzkSzS31ZgPspwfAKjxJVkZ5ZA9uvq0dbH3dqrTNYTujacew/wsU8JQZwk8xLdcaQs8E4QgKbx2TjsnGNGHQv352bpe6tOQ05VpNFnBsR3ZLDSXA/HDgc8JaCRnChyScgpJOOiQQEnxQ0yTZ9NXc1BtaA/S3qg5+I8FrkLZluLCmnUMLcMdJcynKyypQUfQ5B0CdkF3bbO6Mu8plDuSZUXXXI5hwY6pU5ZWUKkHjkHLbS8EnHFbjeR6gNpdOxM2uVKi05W49ep1j0eE1GaokNam3HS2MFTj/LzFXuSnodDHrqt+Fqlwnb0viv2/Abi2fGcZodt8CShbLCnFPrQpRKlhbq+RWSeRJ760FJA+HyVfFIvO5rtkVG36td61SmaJFmFEaGoBRYMkJ6ecCjyIPQKle50oNgVmft1uG9T620IT0SR8u+XmefychtZ4uFP6khXJKh3ybW4B2Rr9OrkrblPU2iKGlqLyWFc1cQl1WC0hR/SlztAV7LUjo9jQB+KbYWNupBTfVkJQxc4axIiueQTko8pQrP0PIxx79ccTjAIAi/DtUbaq9KkzKS3HYqLLTUeTHK8yI7QHJppZHTzSUq/Je75NkDOQclfSP/BbuJSbLuGo2TuU81RqnGIjUp2pRQ25G5KJejqeV2hJVwUEK8ueRyCe3ebWhxtLja0rQoBSVJOQQfQg6D615Sw8qK8mMtCHyhQbUtHNKVY6JTkZGfbIz9xr11NB5sIUjkVFBUogninHsB9z9v8A1669NTU0At+IqQlu14yFLKuM1tfhlAwMMyFZyejnh6Z6x+/aDX3N+QqtPckTK7KmxZhU5JmlLSeaURP/AIdrvwyAjHiLyFp4HHWnb+KKpKTaXLw6i222+/jxWgGlFunVFZKMeYnyDJORjgQO86RSqU5iTXJ0+NFQiIuWtuM98qtpOUORk4jtrXzeeAc7aUTgKz+4Ai7DQJUiVPrj/wAy6uRKpZdkKbIQ4tdej9hYV+ZkoPmASMhQ9RnTOWiyuWaoElSg3coVkEn0uaSr9/YH7aCXw8sMuwau18q43JlVWgPqkSZBVJlgXA4lTjrfmDC+gktg/p5d8s6Ne2b4VOqLSeK1S7hKQMJOONcqjp+3s1/69g66g4pDsOOFdSXa63g5GfGr8VA6I/1nUrUd6a7Gcir55lVOItOEkASLgjIB9v0tr9/bXZHgrkrt15LakKdRTn0ZSRgyJ5mujon2jDP9R6DWt2ztyo0+lMPVthCZbgdElt0hxfITHnmlJIJAGHVK9z9PoQdBn7atqq1ubUZrrqo0Ge5cUdxeBkF2SyywrGex4bC1D+330VWGm2GUMtICG20hKEj0AAwBr7AAGAMDU0E0Hb4eFF+KKzKnUMIp9boM2isPKHlRJDiHgnPsVJTgffB0YtCbcir25e9+UTaOXQ263GqNPXWpsoOqbNPYSClh5pSew4pzABBBAz6hWgWDbDcq4/hzuG4LJvCnS1Q4pWac3wWluSoyEFbifY82grivvBCQeicXtu7lXfWaczuxfE2oJodqJfcpolBppis1JbSmY4jsoaQpOEqUpZ5rGSccRkA7LsfdmK07S6JunR63To6g22LgoqZMqNhIISp1Ch4igCk8lJyc9/uH79tzcek7jqFzvwNwbjVDEy2G5rPgwXmkcvnYzDCFAIlBJQtKsklKCR5sYAjfBBWbHO0MCh0KtwpFfJcl1eNnhIDy1dkoIBUkDinkMjod6ml2fsKBu1TE3NslCYolywFpbqduh8RpEbIUkrac5IQpr0HaeZyrkrIAM0Dr1/be2qxUTLksLS1IhmDUooILNRj4PhoeSoHJbJyhYwtPYzgkaH9ubHUKxob8K2d17zt6muul4xUVGKWkKOO082Tjr/frOpqaD3k0C2IOTUviHulvAOfGuSE19/s0P3/21kIN6XjtxU59dh3g3u/t4lafn3okpl+o0Y9+dXhnC0YGT6Dr9OCTNTQH+yrrt286CzXbYq0ap0970dZV2k+6VJPaVD7EA6utTU0E1NTU0Aev+t1DcuvytsrJmusUxg8LqrrCsJjNn1hsK/U+sdKI6QnOck4GyhzLYtiz26TbxYhU6mpTDSiOkf5NPiqY8RSVeoS4lXJR/lUTnU1NBiqvKkMVF+LLgOTG30vNSaeg5Mlv65MZH6i63yMlj0K23FpSBjI01sSEqjOpXPkTHX4qX2ZcQjFRjjHCUkAdvpBSlYH1eXKSChImpoMvuRY9kbk05uJfFvsTKpxxTqvTlhlU0fZp3OA5gH8lwkZBwSAVDB0Pbbc3aG35FT2tuBd1UqMpUg0ad4rUhSeuTJaUVIKgAT5Ay5n+bpOpqaBhbCuujXra0S4aHJS9GkJ8yfRbDg+tpafVK0nog6vdTU0E1NTU0CxfGFU3m7RhTUVBFUjVJ19MRmGpLiWkrpktkLBJHSvHSonvodZ60o9bkTVbgvRZUmo1F1NacCGXZyFTHFmSjILo5Nsunh/FRkH9xqamgN3whwXaheL5ShPhfhlOknwGFICSKsl0B9akgvukJJ8RJKcZT+nAZfZW2VU+LNkVJookOTnJkZK8c+Di33Qvj2QMynU/1B1NTQEmBDiwYrUWIwhllpCW0JSPRKUhKR/YADXvqamgmpqamgztdkPu3PEpEd/wTIpM53n35FJXHSk//wAhP9tDf4cosWvXNeO5Mdv/ACM2UiiURRPL/IQk+FzSfs44FKx/p1NTQdvww1l6v0y/Kq4srbdvaoiOev4SQ0lHp+w1UUK3Z98fDjRpdOWGbjpkh6p0KQf0SGZLpaSc48q0jgrPWFHU1NAsu8UGdbFz0He3bqqu29EuxL6n/VAp04AiRHWQD0VBeAR6pV9hqampoP/Z',
  'psv':  'data:image/png;base64,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',
};

const CLUB_PARTIAL_MAP = { 'pec': 'data:image/png;base64,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' };

function getClubLogo(name){
  if(!name) return '';
  const lower = name.trim().toLowerCase();
  if(CLUB_LOGO_MAP[lower]) return CLUB_LOGO_MAP[lower];
  for(const [key, val] of Object.entries(CLUB_PARTIAL_MAP)){
    if(lower.includes(key)) return val;
  }
  return '';
}

function avatarHtml(p, size='36px', fontSize='15px'){
  const foto = state.fotos && state.fotos[p.id];
  if(foto) return `<div style="width:${size};height:${size};border-radius:50%;overflow:hidden;flex-shrink:0;border:2px solid var(--border-orange);box-shadow:0 0 10px var(--oranje-glow);"><img src="${foto}" style="width:100%;height:100%;object-fit:cover;display:block;"></div>`;
  return `<div style="width:${size};height:${size};border-radius:50%;background:linear-gradient(135deg,var(--oranje),var(--oranje-light));color:#000;font-weight:800;font-size:${fontSize};display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 0 12px var(--oranje-glow);">${p.name[0].toUpperCase()}</div>`;
}

function getFlag(name){
  if(!name) return '';
  return FLAG_MAP[name.trim().toLowerCase()] || '';
}

function flagBadge(name){
  const f = getFlag(name);
  if(!f) return '';
  return `<span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:var(--surface3);font-size:16px;border:1px solid var(--border);margin-right:6px;flex-shrink:0;">${f}</span>`;
}

// ── LOCKDOWN ──
function toggleLockdown(){
  state.locked = !state.locked;
  saveState();
  syncLockdownBtn();
  showToast(state.locked ? '🔒 Voorspellingen vergrendeld!' : '🔓 Voorspellingen ontgrendeld');
  renderInvullen();
}
function syncLockdownBtn(){
  const btn = document.getElementById('lockdownBtn');
  if(!btn) return;
  if(state.locked){
    btn.textContent = '🔓 Ontgrendel voorspellingen';
    btn.style.background = 'linear-gradient(135deg,#ff1744,#ff4569)';
    btn.style.color = '#fff';
  } else {
    btn.textContent = '🔒 Vergrendel voorspellingen';
    btn.style.background = '';
    btn.style.color = '';
  }
}

function capitalizeInput(el){
  const v = el.value;
  if(v.length > 0) el.value = v.charAt(0).toUpperCase() + v.slice(1);
}

// ── COLLAPSIBLES ──
function toggleVragenAdmin(){
  const body = document.getElementById('vragenBody');
  const arrow = document.getElementById('vragenArrow');
  const open = body.style.display === 'none';
  body.style.display = open ? 'block' : 'none';
  arrow.style.transform = open ? 'rotate(180deg)' : '';
}
function toggleEigenVraag(){
  const body = document.getElementById('eigenVraagBody');
  const arrow = document.getElementById('eigenVraagArrow');
  const open = body.style.display === 'none';
  body.style.display = open ? 'block' : 'none';
  arrow.style.transform = open ? 'rotate(180deg)' : '';
}
function toggleUitslag(){
  const body = document.getElementById('uitslagBody');
  const arrow = document.getElementById('uitslagArrow');
  const open = body.style.display === 'none';
  body.style.display = open ? 'block' : 'none';
  arrow.style.transform = open ? 'rotate(180deg)' : '';
}

// ── RESET SHEET ──
function showResetSheet(){ document.getElementById('resetSheet').style.display = 'block'; }
function hideResetSheet(){ document.getElementById('resetSheet').style.display = 'none'; }

function resetSpelers(){
  state.players = [];
  state.voorspellingen = {};
  state.geheim = {};
  state.activePlayer = null;
  tourMode = false; tourIndex = 0; editingPlayer = null;
  saveState();
  renderPlayers();
  renderInvullen();
  showToast('👤 Spelers gewist');
}

// ── MODE ──
function savePincode(){
  state.pincode = document.getElementById('pincodeInput').value.trim();
  saveState();
}
function clearPincode(){
  state.pincode = '';
  document.getElementById('pincodeInput').value = '';
  saveState();
  showToast('🔑 Pincode verwijderd');
}

const PINCODE_KEY = 'golazo_pincode_ok';
function checkPincode(){
  const input = document.getElementById('pincodeUserInput').value.trim();
  const errEl = document.getElementById('pincodeError');
  if(input === state.pincode){
    // Onthoud in localStorage zodat ze het maar 1x hoeven in te vullen
    localStorage.setItem(PINCODE_KEY, state.pincode);
    document.getElementById('pincodeScreen').style.display = 'none';
    showPickScreen();
  } else {
    errEl.style.display = 'block';
    document.getElementById('pincodeUserInput').value = '';
    document.getElementById('pincodeUserInput').focus();
  }
}

function toggleStraffen(){
  state.strafMode = document.getElementById('strafToggle').checked;
  saveState();
  renderAdminVragen();
  showToast(state.strafMode ? '🍺 Straffen aan!' : 'Straffen uit');
}

function toggleMode(){
  state.mode = document.getElementById('modeToggle').checked ? 'clubs' : 'landen';
  syncModeLabels();
  saveState();
}
function syncModeLabels(){
  const landen = state.mode === 'landen';
  const modeLbl = document.getElementById('modeLabel');
  const cardTitle = document.getElementById('teamsCardTitle');
  const t1 = document.getElementById('team1Input');
  const t2 = document.getElementById('team2Input');
  if(modeLbl) modeLbl.textContent = landen ? '🌍 Landen' : '🏟️ Clubs';
  if(cardTitle) cardTitle.textContent = landen ? 'Landen' : 'Teams';
  if(t1) t1.placeholder = landen ? 'Land 1' : 'Team 1';
  if(t2) t2.placeholder = landen ? 'Land 2' : 'Team 2';
}
function saveTeams(){
  state.team1 = document.getElementById('team1Input').value;
  state.team2 = document.getElementById('team2Input').value;
  const f1 = document.getElementById('flag1Preview');
  const f2 = document.getElementById('flag2Preview');
  function setPreview(el, name){
    if(!el) return;
    const logo = getClubLogo(name);
    if(logo){
      el.innerHTML = `<img src="${logo}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;">`;
      el.style.padding = '0';
      el.style.overflow = 'hidden';
    } else {
      el.innerHTML = '';
      el.style.padding = '';
      el.style.overflow = '';
      el.textContent = getFlag(name) || '🏴';
    }
  }
  setPreview(f1, state.team1);
  setPreview(f2, state.team2);
  saveState();
  renderMatchup();
}

let cdInterval = null;
function formatDateInput(el){
  let v = el.value.replace(/\D/g,'');
  if(v.length > 8) v = v.slice(0,8);
  if(v.length >= 5) v = v.slice(0,2)+'/'+v.slice(2,4)+'/'+v.slice(4);
  else if(v.length >= 3) v = v.slice(0,2)+'/'+v.slice(2);
  el.value = v;
}
function formatTimeInput(el){
  // Strip everything except digits
  let v = el.value.replace(/\D/g, '');
  if(v.length > 4) v = v.slice(0, 4);
  // Validate hours (max 23) and minutes (max 59) as we go
  if(v.length >= 3){
    let h = v.slice(0, 2);
    let m = v.slice(2);
    if(parseInt(h) > 23) h = '23';
    v = h + ':' + m;
  } else if(v.length === 2){
    v = v + ':';
  }
  el.value = v;
}

function saveCountdown(){
  if(!state.countdown) state.countdown={};
  state.countdown.date = document.getElementById('cdDate').value;
  state.countdown.time = document.getElementById('cdTime').value;
  saveState();
  renderCountdown();
}
function renderCountdown(){
  const w = document.getElementById('countdownWidget');
  if(!w) return;
  const cd = state.countdown||{};
  if(!cd.date||!cd.time){w.innerHTML='';return;}
  const parts = cd.date.split(/[\/\-]/);
  if(parts.length!==3){w.innerHTML='';return;}
  const [dd,mm,yyyy]=parts;
  if(!dd||!mm||!yyyy||yyyy.length<4){w.innerHTML='';return;}
  const target = new Date(`${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}T${cd.time}:00`);
  if(isNaN(target)){w.innerHTML='';return;}
  let prevS = -1;
  function update(){
    const diff = target - new Date();
    if(diff<=0){
      w.innerHTML=`<div class="countdown-card"><div class="countdown-label">⚽ Wedstrijd is bezig!</div><div class="countdown-done">Aftrap!</div></div>`;
      if(cdInterval){clearInterval(cdInterval);cdInterval=null;}
      return;
    }
    const d=Math.floor(diff/86400000);
    const h=Math.floor((diff%86400000)/3600000);
    const m=Math.floor((diff%3600000)/60000);
    const s=Math.floor((diff%60000)/1000);
    const tick = s!==prevS; prevS=s;
    w.innerHTML=`
      <div class="countdown-card">
        <div class="countdown-label">⏱️ Aftrap over</div>
        <div class="countdown-digits">
          ${d>0?`<div class="cd-block"><span class="cd-num">${String(d).padStart(2,'0')}</span><div class="cd-label">dagen</div></div><div class="cd-sep">:</div>`:''}
          <div class="cd-block"><span class="cd-num">${String(h).padStart(2,'0')}</span><div class="cd-label">uur</div></div>
          <div class="cd-sep">:</div>
          <div class="cd-block"><span class="cd-num">${String(m).padStart(2,'0')}</span><div class="cd-label">min</div></div>
          <div class="cd-sep">:</div>
          <div class="cd-block"><span class="cd-num ${tick?'tick':''}">${String(s).padStart(2,'0')}</span><div class="cd-label">sec</div></div>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:10px;">${state.team1||'Team 1'} vs ${state.team2||'Team 2'} — ${cd.date} ${cd.time}</div>
      </div>`;
  }
  update();
  if(cdInterval) clearInterval(cdInterval);
  cdInterval = setInterval(update, 1000);
}

function renderMatchup(){
  const w = document.getElementById('matchupWidget');
  if(!w) return;
  const t1 = state.team1;
  const t2 = state.team2;
  if(!t1 && !t2){ w.innerHTML=''; return; }
  function flagHtml(name) {
    const logo = getClubLogo(name);
    if(logo) return `<div class="matchup-flag" style="background:white;overflow:hidden;padding:0;"><img src="${logo}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;"></div>`;
    const emoji = getFlag(name);
    if(emoji) return `<div class="matchup-flag">${emoji}</div>`;
    return `<div class="matchup-flag" style="font-size:22px;font-weight:800;color:var(--oranje);font-family:'Oswald','Arial Black',system-ui,sans-serif;">${(name||'?')[0].toUpperCase()}</div>`;
  }
  w.innerHTML=`
    <div class="matchup">
      <div class="matchup-team">
        ${flagHtml(t1)}
        <div class="matchup-team-name">${t1||'Team 1'}</div>
      </div>
      <div class="matchup-vs">VS</div>
      <div class="matchup-team">
        ${flagHtml(t2)}
        <div class="matchup-team-name">${t2||'Team 2'}</div>
      </div>
    </div>`;
}

function addPlayer(){
  const inp=document.getElementById('playerInput');
  const name=inp.value.trim();
  if(!name) return;
  const id='p'+Date.now();
  state.players.push({id,name});
  state.voorspellingen[id]={};
  state.geheim[id]=false;
  inp.value='';
  saveState();
  renderPlayers();
  renderAdminUitslag();
  showToast('👤 '+name+' toegevoegd!');
}
function resetDevice(id){
  if(!state.devices) return;
  delete state.devices[id];
  saveState();
  renderPlayers();
  showToast('📱 Apparaatkoppeling gereset');
}

function removePlayer(id){
  state.players=state.players.filter(p=>p.id!==id);
  delete state.voorspellingen[id];
  delete state.geheim[id];
  if(state.activePlayer===id) state.activePlayer=null;
  saveState();
  renderPlayers();
}
function renderPlayers(){
  const list=document.getElementById('playerList');
  if(!list) return;
  document.getElementById('playerCount').textContent=state.players.length;
  list.innerHTML=state.players.map(p=>{
    const foto = state.fotos && state.fotos[p.id];
    const devices = state.devices || {};
    const isClaimed = !!devices[p.id];
    const avatarContent = foto
      ? `<img src="${foto}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;">`
      : p.name[0].toUpperCase();
    const avatarStyle = foto ? 'padding:0;overflow:hidden;' : '';
    return `<div class="player-chip">
      <div style="display:flex;align-items:center;gap:0;flex:1;min-width:0;">
        <div class="player-avatar" style="${avatarStyle}">${avatarContent}</div>
        <div class="player-name" style="flex:1;">${p.name}</div>
        ${isClaimed?`<button onclick="resetDevice('${p.id}')" style="background:none;border:1px solid rgba(255,107,0,.3);color:var(--accent);font-size:10px;font-weight:700;padding:3px 8px;border-radius:999px;cursor:pointer;margin-right:6px;white-space:nowrap;" title="Apparaatkoppeling resetten">📱 Reset</button>`:''}
      </div>
      <button class="del-btn" onclick="removePlayer('${p.id}')">✕</button>
    </div>`;
  }).join('');
}

// ── DRAG TO REORDER VRAGEN ──
let dragSrcId = null;
function dragStart(e, id){
  dragSrcId = id;
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(()=> e.currentTarget.classList.add('dragging'), 0);
}
function dragEnd(e){
  document.querySelectorAll('.vraag-item').forEach(el=>{
    el.classList.remove('dragging','drop-above','drop-below');
  });
  dragSrcId = null;
}
function dragOver(e){
  e.preventDefault();
  if(!dragSrcId) return;
  const el = e.currentTarget;
  if(el.dataset.id === dragSrcId) return;
  const rect = el.getBoundingClientRect();
  const mid  = rect.top + rect.height / 2;
  document.querySelectorAll('.vraag-item').forEach(x=>x.classList.remove('drop-above','drop-below'));
  if(e.clientY < mid) el.classList.add('drop-above');
  else                 el.classList.add('drop-below');
}
function dragLeave(e){ e.currentTarget.classList.remove('drop-above','drop-below'); }
function dragDrop(e, targetId){
  e.preventDefault();
  const el = e.currentTarget;
  const above = el.classList.contains('drop-above');
  el.classList.remove('drop-above','drop-below');
  if(!dragSrcId || dragSrcId === targetId) return;
  reorderVraag(dragSrcId, targetId, above);
}
function reorderVraag(fromId, toId, insertBefore){
  const fromIdx = state.vragen.findIndex(v=>v.id===fromId);
  const toIdx   = state.vragen.findIndex(v=>v.id===toId);
  if(fromIdx<0||toIdx<0) return;
  const moved = state.vragen.splice(fromIdx,1)[0];
  const newToIdx = state.vragen.findIndex(v=>v.id===toId);
  state.vragen.splice(insertBefore ? newToIdx : newToIdx+1, 0, moved);
  saveState();
  renderAdminVragen();
  renderAdminUitslag();
}

// Touch drag (mobile)
let touchDragId = null;
function touchDragStart(e, id){
  touchDragId = id;
  e.currentTarget.closest('.vraag-item').classList.add('dragging');
}
function touchDragMove(e){
  e.preventDefault();
  if(!touchDragId) return;
  const touch = e.touches[0];
  document.querySelectorAll('.vraag-item').forEach(el=>el.classList.remove('drop-above','drop-below'));
  const els = document.elementsFromPoint(touch.clientX, touch.clientY);
  const target = els.find(el=>el.classList.contains('vraag-item') && el.dataset.id && el.dataset.id !== touchDragId);
  if(target){
    const rect = target.getBoundingClientRect();
    const mid  = rect.top + rect.height / 2;
    if(touch.clientY < mid) target.classList.add('drop-above');
    else                    target.classList.add('drop-below');
  }
}
function touchDragEnd(e){
  if(!touchDragId) return;
  const touch = e.changedTouches[0];
  const els = document.elementsFromPoint(touch.clientX, touch.clientY);
  const target = els.find(el=>el.classList.contains('vraag-item') && el.dataset.id && el.dataset.id !== touchDragId);
  document.querySelectorAll('.vraag-item').forEach(el=>{
    el.classList.remove('dragging','drop-above','drop-below');
  });
  if(target && target.dataset.id){
    const above = touch.clientY < target.getBoundingClientRect().top + target.getBoundingClientRect().height/2;
    reorderVraag(touchDragId, target.dataset.id, above);
  }
  touchDragId = null;
}

// ── VRAGEN ADMIN ──
function renderAdminVragen(){
  const list=document.getElementById('adminVragenList');
  if(!list) return;
  document.getElementById('vraagCount').textContent=state.vragen.length;
  list.innerHTML=state.vragen.map((v,i)=>`
    <div class="vraag-item" data-id="${v.id}"
      draggable="true"
      ondragstart="dragStart(event,'${v.id}')"
      ondragover="dragOver(event)"
      ondragleave="dragLeave(event)"
      ondrop="dragDrop(event,'${v.id}')"
      ondragend="dragEnd(event)">
      <div style="display:flex;align-items:center;gap:8px;">
        <div class="drag-handle"
          ontouchstart="touchDragStart(event,'${v.id}')"
          ontouchmove="touchDragMove(event)"
          ontouchend="touchDragEnd(event)">⠿</div>
        <div class="vraag-num">${i+1}</div>
        <div style="flex:1;min-width:0;">
          <div id="vraag_display_${v.id}" style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
            <div class="vraag-text" style="flex:1;overflow:hidden;text-overflow:ellipsis;">${getVraagTekst(v)}</div>
            <button onclick="startEditVraag('${v.id}')" style="background:none;border:none;color:var(--muted);font-size:13px;cursor:pointer;padding:2px 4px;flex-shrink:0;opacity:0.6;transition:opacity .15s;" title="Bewerken">✏️</button>
          </div>
          <div id="vraag_edit_${v.id}" style="display:none;margin-top:6px;">
            <input type="text" id="vraag_input_${v.id}" value="${v.tekst}"
              style="border-radius:10px;font-size:13px;padding:8px 12px;margin-bottom:6px;"
              onkeydown="if(event.key==='Enter')saveEditVraag('${v.id}');if(event.key==='Escape')cancelEditVraag('${v.id}')">
            <div style="display:flex;gap:6px;">
              <button onclick="saveEditVraag('${v.id}')" class="btn sm" style="font-size:12px;padding:6px 14px;">✓ Opslaan</button>
              <button onclick="cancelEditVraag('${v.id}')" class="btn secondary sm" style="font-size:12px;padding:6px 14px;">Annuleren</button>
            </div>
          </div>
          <div class="vraag-meta">
            <span class="tag">${typeLabel(v.type)}</span>
            <span>${v.vast?'Vast':'Eigen'}</span>
          </div>
        </div>
        ${!v.vast?`<button class="del-btn" onclick="removeVraag('${v.id}')" style="flex-shrink:0;">✕</button>`:''}
      </div>
      ${state.strafMode ? renderStrafInput(v) : ''}
    </div>`).join('');
}

function strafTypeOpties(selectedVal, prefix){
  return ['slokken','adtje'].map(t=>`<option value="${t}" ${selectedVal===t?'selected':''}>${t}</option>`).join('');
}

function renderStrafInput(v){
  const straf = state.straffen[v.id] || {fouGetal:'', fouType:'slokken', goedGetal:'', goedType:'slokken'};
  return `<div style="padding:10px 12px 12px;border-top:1px solid var(--border);">
    <div style="font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">🍺 Straffen instellen</div>
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap;">
      <span style="font-size:12px;color:#ff8080;font-weight:700;min-width:38px;">❌ Fout:</span>
      <input type="text" inputmode="numeric" value="${straf.fouGetal||''}" placeholder="0"
        id="straf_fout_getal_${v.id}"
        oninput="saveStraf('${v.id}')"
        style="width:48px;padding:5px 8px;border-radius:999px;font-size:13px;font-weight:800;text-align:center;">
      <select id="straf_fout_type_${v.id}" onchange="saveStraf('${v.id}')"
        style="padding:5px 10px;border-radius:999px;font-size:12px;flex:1;">
        ${strafTypeOpties(straf.fouType||'slokken','fout_'+v.id)}
      </select>
    </div>
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
      <span style="font-size:12px;color:var(--oranje);font-weight:700;min-width:38px;">✅ Goed:</span>
      <input type="text" inputmode="numeric" value="${straf.goedGetal||''}" placeholder="0"
        id="straf_goed_getal_${v.id}"
        oninput="saveStraf('${v.id}')"
        style="width:48px;padding:5px 8px;border-radius:999px;font-size:13px;font-weight:800;text-align:center;">
      <select id="straf_goed_type_${v.id}" onchange="saveStraf('${v.id}')"
        style="padding:5px 10px;border-radius:999px;font-size:12px;flex:1;">
        ${strafTypeOpties(straf.goedType||'slokken','goed_'+v.id)}
      </select>
    </div>
  </div>`;
}

function saveStraf(vraagId){
  if(!state.straffen) state.straffen = {};
  const fouGetal = (document.getElementById('straf_fout_getal_'+vraagId)||{}).value||'';
  const fouType  = (document.getElementById('straf_fout_type_'+vraagId)||{}).value||'slokken';
  const goedGetal = (document.getElementById('straf_goed_getal_'+vraagId)||{}).value||'';
  const goedType  = (document.getElementById('straf_goed_type_'+vraagId)||{}).value||'slokken';
  state.straffen[vraagId] = { fouGetal:fouGetal.trim(), fouType, goedGetal:goedGetal.trim(), goedType };
  saveState();
}

function startEditVraag(id){
  document.getElementById('vraag_display_'+id).style.display = 'none';
  document.getElementById('vraag_edit_'+id).style.display = 'block';
  const inp = document.getElementById('vraag_input_'+id);
  if(inp){ inp.focus(); inp.select(); }
}

function cancelEditVraag(id){
  document.getElementById('vraag_display_'+id).style.display = 'flex';
  document.getElementById('vraag_edit_'+id).style.display = 'none';
}

function saveEditVraag(id){
  const inp = document.getElementById('vraag_input_'+id);
  if(!inp) return;
  const nieuweTekst = inp.value.trim();
  if(!nieuweTekst) return;
  const v = state.vragen.find(v=>v.id===id);
  if(v) v.tekst = nieuweTekst;
  saveState();
  renderAdminVragen();
  showToast('✏️ Vraag aangepast');
}

function typeLabel(t){
  return {team:'Team',team3:'Team/Gelijkspel',speler:'Speler',jn:'Ja/Nee',getal:'Getal',vrij:'Vrij',tussenstand:'Tussenstand',score:'Eindstand'}[t]||t;
}
function addEigenVraag(){
  const tekst=document.getElementById('eigenVraagInput').value.trim();
  const type=document.getElementById('eigenVraagType').value;
  if(!tekst) return;
  state.vragen.push({id:'e'+Date.now(),tekst,type,vast:false});
  document.getElementById('eigenVraagInput').value='';
  saveState();
  renderAdminVragen();
  renderAdminUitslag();
  showToast('✅ Vraag toegevoegd');
}
function removeVraag(id){
  state.vragen=state.vragen.filter(v=>v.id!==id);
  saveState();
  renderAdminVragen();
  renderAdminUitslag();
}

// ── UITSLAG ADMIN ──
function renderAdminUitslag(){
  const content=document.getElementById('adminUitslagContent');
  if(!content) return;
  const goedEl = document.getElementById('pushGoedInput');
  const foutEl = document.getElementById('pushFoutInput');
  if(goedEl && !goedEl.value) goedEl.value = state.pushGoedBericht || '';
  if(foutEl && !foutEl.value) foutEl.value = state.pushFoutBericht || '';
  if(!state.vragen.length){content.innerHTML='<div class="empty" style="padding:16px 0;"><span>❓</span>Geen vragen.</div>';return;}
  content.innerHTML=getVisibleVragen(state.uitslag).map((v,i)=>{
    const filled = state.uitslag[v.id] && state.uitslag[v.id]!=='';
    return `<div style="background:var(--surface2);border:1px solid ${filled?'rgba(103,242,143,.25)':'var(--border)'};border-radius:14px;margin-bottom:8px;overflow:hidden;">
      <div onclick="toggleUitslagVraag('uv_${v.id}')" style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;cursor:pointer;gap:10px;">
        <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">
          <div style="width:20px;height:20px;border-radius:50%;background:var(--surface3);color:var(--muted2);font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${i+1}</div>
          <div style="font-size:13px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${getVraagTekst(v)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
          ${filled ? `<span style="font-size:11px;font-weight:700;color:var(--oranje);background:var(--oranje-dim);border-radius:999px;padding:2px 8px;">${state.uitslag[v.id]}</span>` : ''}
          <span style="color:var(--muted);font-size:13px;transition:transform .2s;" id="arrow_uv_${v.id}">▼</span>
        </div>
      </div>
      <div id="uv_${v.id}" style="display:none;padding:0 14px 14px;">
        ${renderAntwoordInput(v,state.uitslag[v.id]||'','uit',state.uitslag)}
      </div>
    </div>`;
  }).join('');
}
function toggleUitslagVraag(id){
  const el = document.getElementById(id);
  const arrow = document.getElementById('arrow_'+id);
  const open = el.style.display === 'none';
  el.style.display = open ? 'block' : 'none';
  if(arrow) arrow.style.transform = open ? 'rotate(180deg)' : '';
}
function saveUitslag(){
  state.vragen.forEach(v=>{
    if(v.type==='score' || v.type==='tussenstand'){
      const e1=document.getElementById('uit_'+v.id+'_1');
      const e2=document.getElementById('uit_'+v.id+'_2');
      if(e1||e2) state.uitslag[v.id]=`${e1?e1.value:''}${e2?'-'+e2.value:''}`;
    } else if(v.type==='jn_met_sub'){
      const el=document.getElementById('uit_'+v.id);
      if(el) state.uitslag[v.id]=el.value;
      if(v.subVraag){
        const sub=document.getElementById('uit_'+v.subVraag.id);
        if(sub) state.uitslag[v.subVraag.id]=sub.value;
      }
    } else {
      const el=document.getElementById('uit_'+v.id);
      if(el) state.uitslag[v.id]=el.value;
    }
  });
  saveState();
  showToast('🏁 Uitslag opgeslagen!');
  sendPersonalizedPushNotifications();
}

// ── POPUP FLOW ──
let tourMode = false;
let tourIndex = 0;

function checkStartTour(){
  if(!state.players.length || !state.vragen.length) return;
  const anyEmpty = state.players.some(p => {
    const pred = state.voorspellingen[p.id] || {};
    return Object.values(pred).filter(v=>v&&v!=='').length === 0;
  });
  if(anyEmpty && !tourMode){
    tourMode = true; tourIndex = 0;
    state.players.forEach((p,i) => {
      const pred = state.voorspellingen[p.id]||{};
      if(Object.values(pred).some(v=>v&&v!=='')) tourIndex = i+1;
    });
    if(tourIndex < 0) tourIndex = 0;
    showPlayerPopup(tourIndex);
  }
}

function showPlayerPopup(idx){
  if(!state.players.length) return;
  const p = state.players[idx];
  if(!p) return;
  const overlay = document.getElementById('playerPopupOverlay');
  document.getElementById('popupAvatar').textContent = p.name[0].toUpperCase();
  document.getElementById('popupName').textContent = p.name;
  const remaining = state.players.length - idx - 1;
  document.getElementById('popupSub').textContent =
    idx === 0 && state.players.length === 1 ? 'Jij bent de enige speler!' :
    idx === 0 ? `Nog ${remaining} speler${remaining===1?'':'s'} na jou` :
    idx === state.players.length - 1 ? 'Jij bent de laatste! 🎉' :
    `Nog ${remaining} speler${remaining===1?'':'s'} na jou`;
  const dots = document.getElementById('popupDots');
  dots.innerHTML = state.players.map((_,i) =>
    `<div class="popup-dot ${i<idx?'done':i===idx?'active':''}"></div>`
  ).join('');
  overlay.style.display = 'flex';
}

function startPlayerTurn(){
  const overlay = document.getElementById('playerPopupOverlay');
  overlay.style.display = 'none';
  if(state.players[tourIndex]){
    editingPlayer = state.players[tourIndex].id;
    state.activePlayer = editingPlayer;
  }
  updateFabLabel();
  renderInvullen();
}
function popupOverlayClick(e){}

function handleSaveBtn(){
  if(editingPlayer){
    saveCurrentVoorspelling(false);
    const name = state.players.find(x=>x.id===state.activePlayer)?.name;
    showToast('💾 Voorspelling van '+name+' opgeslagen!');
    editingPlayer = null;
    renderInvullen();
  } else {
    saveAndNextPlayer();
  }
}

function updateFabLabel(){
  const btn = document.getElementById('invullenFabBtn');
  if(!btn) return;
  btn.textContent = editingPlayer ? '💾 Opslaan' : '💾 Opslaan & volgende';
}

function backToOverview(){
  saveCurrentVoorspelling(false);
  editingPlayer = null;
  // Als de gebruiker ingelogd is als een speler, stay op die context
  if(currentUserId){
    renderInvullen();
    // Toon pick screen opnieuw
    showPickScreen();
  } else {
    renderInvullen();
  }
}

function saveAndNextPlayer(){
  saveCurrentVoorspelling(false);
  const name = state.players.find(x=>x.id===state.activePlayer)?.name;
  showToast('💾 Voorspelling van '+name+' opgeslagen!');
  if(tourMode){
    tourIndex++;
    if(tourIndex < state.players.length){
      editingPlayer = null;
      setTimeout(()=> showPlayerPopup(tourIndex), 600);
    } else {
      tourMode = false;
      editingPlayer = null;
      renderInvullen();
      showToast('✅ Iedereen heeft voorspeld!');
    }
  } else {
    editingPlayer = null;
    renderInvullen();
  }
}

// ── INVULLEN ──
let editingPlayer = null;

function renderInvullen(){
  renderCountdown();
  renderMatchup();
  const sel=document.getElementById('playerSelector');
  const content=document.getElementById('invullenContent');
  const fab=document.getElementById('invullenFab');
  sel.innerHTML='';

  if(!state.players.length){
    content.innerHTML='<div class="empty"><span>👤</span>Voeg spelers toe via Admin.</div>';
    fab.style.display='none';
    return;
  }

  if(editingPlayer){
    state.activePlayer = editingPlayer;
    renderInvullenForm();
    return;
  }

  renderLockedOverview();
}

function renderLockedOverview(){
  const content=document.getElementById('invullenContent');
  const bannerHtml = state.locked
    ? `<div class="lockdown-banner"><span class="lockdown-icon">🔒</span>Voorspellingen zijn vergrendeld — wedstrijd is begonnen!</div>`
    : `<div class="info-bar" style="margin-bottom:14px;">Klik op je naam bovenin om voorspellingen in te vullen ✏️</div>`;
  content.innerHTML=`
    ${bannerHtml}
    <div class="player-locked-grid">
      ${state.players.map(p=>{
        const pred=state.voorspellingen[p.id]||{};
        const visV=getVisibleVragen(pred);
        const ingevuld=visV.filter(v=>{
          const val = pred[v.id]||'';
          if(!val || val==='') return false;
          // Score/tussenstand: beide kanten moeten gevuld zijn
          if(v.type==='score'||v.type==='tussenstand'){
            const parts=val.split('-');
            return parts[0].trim()!==''&&parts[1]!==undefined&&parts[1].trim()!=='';
          }
          return true;
        }).length;
        const heeftAlles = ingevuld===visV.length && visV.length>0;
        const nietAlles = ingevuld>0 && !heeftAlles;
        const statusText = ingevuld===0 ? 'Nog niets ingevuld' : heeftAlles ? '✅ Klaar!' : `${ingevuld} van ${visV.length} ingevuld`;
        const cls = ingevuld===0?'empty':heeftAlles?'done':'';
        const kanBewerken = !state.locked && (isAdmin || p.id === currentUserId);
        const editBtnHtml = kanBewerken ? `<div class="edit-btn" onclick="editPlayer('${p.id}')">✏️</div>` : '';
        return `<div class="player-locked-card ${cls}">
          <div class="player-locked-left">
            ${avatarHtml(p)}
            <div>
              <div style="font-weight:700;font-size:15px;">${p.name}${nietAlles?'<span style="color:var(--accent);margin-left:4px;">!</span>':''}</div>
              <div class="player-locked-status ${heeftAlles?'done':''}">${statusText}</div>
            </div>
          </div>
          ${editBtnHtml}
        </div>`;
      }).join('')}
    </div>`;
}

function editPlayer(id){
  if(state.locked){ showToast('🔒 Voorspellingen zijn vergrendeld!'); return; }
  if(!isAdmin && id !== currentUserId){ showToast('❌ Je kan alleen je eigen voorspellingen bewerken.'); return; }
  editingPlayer = id;
  state.activePlayer = id;
  document.getElementById('invullenFab').style.display='flex';
  updateFabLabel();
  renderInvullenForm();
}

function selectPlayer(id){
  saveCurrentVoorspelling(false);
  state.activePlayer=id;
  renderInvullen();
}

function renderInvullenForm(){
  const content=document.getElementById('invullenContent');
  const p=state.players.find(x=>x.id===state.activePlayer);
  if(!p){content.innerHTML='';return;}
  const opgeslagen=state.voorspellingen[p.id]||{};
  const isGeheim=state.geheim[p.id]||false;
  const visibleVragen = getVisibleVragen(opgeslagen);
  const ingevuld=visibleVragen.filter(v=>opgeslagen[v.id]&&opgeslagen[v.id]!=='').length;
  const pct=visibleVragen.length?Math.round(ingevuld/visibleVragen.length*100):0;

  const vragenHtml = visibleVragen.map((v,i)=>{
    const waarde = opgeslagen[v.id]||'';
    const filled = waarde !== '';
    const strafData = (state.strafMode && state.straffen) ? state.straffen[v.id] : null;
    const strafBadge = strafData ? (() => {
      const parts = [];
      if(strafData.fouGetal) parts.push(`<span style="display:inline-flex;align-items:center;gap:2px;background:rgba(255,80,80,.25);border:1px solid rgba(255,80,80,.4);color:#ff8080;font-size:10px;font-weight:800;padding:2px 7px;border-radius:999px;white-space:nowrap;">❌ ${strafData.fouGetal} ${strafData.fouType}</span>`);
      if(strafData.goedGetal) parts.push(`<span style="display:inline-flex;align-items:center;gap:2px;background:var(--oranje-dim);border:1px solid var(--border-orange);color:var(--oranje);font-size:10px;font-weight:800;padding:2px 7px;border-radius:999px;white-space:nowrap;">✅ ${strafData.goedGetal} ${strafData.goedType}</span>`);
      return parts.length ? `<span style="display:inline-flex;gap:4px;margin-left:6px;flex-shrink:0;flex-wrap:wrap;">${parts.join('')}</span>` : '';
    })() : '';
    return `<div style="background:var(--surface);border:1px solid ${filled?'rgba(103,242,143,.25)':'var(--border)'};border-radius:14px;margin-bottom:8px;overflow:hidden;">
      <div onclick="togglePredVraag('pv_${v.id}','${v.id}')" style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;cursor:pointer;gap:10px;">
        <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">
          <div style="width:20px;height:20px;border-radius:50%;background:var(--surface2);color:var(--muted2);font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${i+1}</div>
          <div style="display:flex;align-items:center;flex:1;min-width:0;">
            <span style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${getVraagTekst(v)}</span>
            ${strafBadge}
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
          ${filled ? `<span style="font-size:11px;font-weight:700;color:var(--oranje);background:var(--oranje-dim);border-radius:999px;padding:2px 8px;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${isGeheim?'🔒':waarde}</span>` : ''}
          <span style="color:var(--muted);font-size:13px;transition:transform .2s;" id="arrow_pv_${v.id}">▼</span>
        </div>
      </div>
      <div id="pv_${v.id}" style="display:none;padding:0 14px 14px;">
        ${renderAntwoordInput(v,waarde,'pred',opgeslagen)}
      </div>
    </div>`;
  }).join('');

  content.innerHTML=`
    <button class="btn secondary sm" style="margin-bottom:14px;width:auto;" onclick="backToOverview()">← Terug</button>
    <div class="info-bar">Voorspellingen van <strong>${p.name}</strong></div>
    <div style="margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:5px;">
        <span>Voortgang</span><span>${ingevuld} / ${visibleVragen.length} ingevuld</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>
    ${vragenHtml}
    <div class="secret-row">
      <div>
        <div class="secret-label">🔒 Antwoorden geheimhouden</div>
        <div class="secret-desc">In het overzicht verborgen voor anderen</div>
      </div>
      <label class="switch">
        <input type="checkbox" id="secretToggle_${p.id}" ${isGeheim?'checked':''} onchange="toggleSecret('${p.id}')">
        <span class="slider"></span>
      </label>
    </div>
    <button class="btn" id="invullenFabBtn" onclick="handleSaveBtn()" style="margin-top:16px;margin-bottom:32px;">💾 Opslaan</button>`;
}

function togglePredVraag(id, vraagId){
  const el = document.getElementById(id);
  const arrow = document.getElementById('arrow_'+id);
  const open = el.style.display === 'none';
  el.style.display = open ? 'block' : 'none';
  if(arrow) arrow.style.transform = open ? 'rotate(180deg)' : '';
  if(!open){
    saveCurrentVoorspelling(false);
    const hasDependents = state.vragen.some(v=>v.dependsOn && v.dependsOn.id === vraagId);
    if(hasDependents) renderInvullenForm();
  }
}
function toggleSecret(pid){
  const el=document.getElementById('secretToggle_'+pid);
  if(!el) return;
  state.geheim[pid]=el.checked;
  saveState();
  showToast(el.checked?'🔒 Antwoorden verborgen':'👁️ Antwoorden zichtbaar');
}

function getVisibleVragen(antwoorden){
  return state.vragen.filter(v=>{
    if(!v.dependsOn) return true;
    const dep = antwoorden[v.dependsOn.id] || '';
    return dep.trim().toLowerCase() === v.dependsOn.waarde.toLowerCase();
  });
}

function getVraagTekst(v){
  const label = state.mode==='landen' ? 'Welk land' : 'Welk team';
  return v.tekst.replace('__TEAM1_LABEL__', label);
}

function renderAntwoordInput(v, waarde, prefix, antwoorden){
  const t1=state.team1||(state.mode==='landen'?'Land 1':'Team 1');
  const t2=state.team2||(state.mode==='landen'?'Land 2':'Team 2');
  const id=prefix+'_'+v.id;
  const onchangeRender = prefix==='pred' ? `onchange="saveCurrentVoorspelling(false);renderInvullenForm();"` : '';

  if(v.type==='team') return `<select id="${id}" ${onchangeRender}><option value="">Kies...</option><option value="${t1}" ${waarde===t1?'selected':''}>${t1}</option><option value="${t2}" ${waarde===t2?'selected':''}>${t2}</option></select>`;
  if(v.type==='team3') return `<select id="${id}"><option value="">Kies...</option><option value="${t1}" ${waarde===t1?'selected':''}>${t1}</option><option value="${t2}" ${waarde===t2?'selected':''}>${t2}</option><option value="Gelijkspel" ${waarde==='Gelijkspel'?'selected':''}>Gelijkspel</option></select>`;
  if(v.type==='jn') return `<select id="${id}" ${onchangeRender}><option value="">Kies...</option><option value="Ja" ${waarde==='Ja'?'selected':''}>Ja</option><option value="Nee" ${waarde==='Nee'?'selected':''}>Nee</option></select>`;

  if(v.type==='jn_met_sub'){
    const sub = v.subVraag;
    const subWaarde = antwoorden ? (antwoorden[sub.id]||'') : '';
    const showSub = waarde.toLowerCase()==='ja';
    const subDivId = `${prefix}_sub_${v.id}`;
    const onchangeSub = `document.getElementById('${subDivId}').style.display=this.value==='Ja'?'block':'none';`;
    return `<select id="${id}" onchange="${onchangeSub}"><option value="">Kies...</option><option value="Ja" ${waarde==='Ja'?'selected':''}>Ja</option><option value="Nee" ${waarde==='Nee'?'selected':''}>Nee</option></select>
    <div id="${subDivId}" style="display:${showSub?'block':'none'};margin-top:10px;padding:10px 12px;background:var(--surface3);border-radius:10px;border:1px solid var(--border);">
      <div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px;">↳ ${sub.tekst}</div>
      <input type="text" id="${prefix}_${sub.id}" value="${subWaarde}" placeholder="Naam speler..." autocapitalize="words" oninput="capitalizeInput(this)" style="border-radius:10px;">
    </div>`;
  }

  if(v.type==='score'){
    const parts = waarde ? waarde.split('-') : ['',''];
    const s1 = parts[0]||''; const s2 = parts[1]||'';
    return `<div style="display:flex;align-items:center;gap:10px;">
      <div style="flex:1;text-align:center;">
        <div style="font-size:11px;color:var(--muted);margin-bottom:4px;font-weight:600;">${t1||'Team 1'}</div>
        <input type="text" inputmode="numeric" id="${id}_1" value="${s1}" placeholder="0"
          style="text-align:center;font-size:22px;font-weight:800;padding:14px 8px;border-radius:12px;"
          oninput="syncScore('${id}')">
      </div>
      <div style="font-size:28px;font-weight:800;color:var(--muted);font-family:'Oswald',sans-serif;">—</div>
      <div style="flex:1;text-align:center;">
        <div style="font-size:11px;color:var(--muted);margin-bottom:4px;font-weight:600;">${t2||'Team 2'}</div>
        <input type="text" inputmode="numeric" id="${id}_2" value="${s2}" placeholder="0"
          style="text-align:center;font-size:22px;font-weight:800;padding:14px 8px;border-radius:12px;"
          oninput="syncScore('${id}')">
      </div>
    </div>`;
  }

  if(v.type==='getal') return `<input type="text" inputmode="numeric" id="${id}" value="${waarde}" placeholder="bijv. 3">`;
  return `<input type="text" id="${id}" value="${waarde}" placeholder="Jouw antwoord..." autocapitalize="words" oninput="capitalizeWordsInput(this)">`;
}

function syncScore(baseId){}

function capitalizeWordsInput(el){
  const pos = el.selectionStart;
  el.value = el.value.replace(/\b\w/g, c => c.toUpperCase());
  el.setSelectionRange(pos, pos);
}

function saveCurrentVoorspelling(alert){
  if(!state.activePlayer) return;
  const pred=state.voorspellingen[state.activePlayer];
  if(!pred) return;
  state.vragen.forEach(v=>{
    if(v.type==='score'||v.type==='tussenstand'){
      const e1=document.getElementById('pred_'+v.id+'_1');
      const e2=document.getElementById('pred_'+v.id+'_2');
      if(e1||e2){
        const v1 = e1?e1.value.trim():'';
        const v2 = e2?e2.value.trim():'';
        // Only save if at least one side has a value, avoid saving bare "-"
        pred[v.id] = (v1||v2) ? `${v1}-${v2}` : '';
      }
    } else if(v.type==='jn_met_sub'){
      const el=document.getElementById('pred_'+v.id);
      if(el) pred[v.id]=el.value;
      if(v.subVraag){
        const sub=document.getElementById('pred_'+v.subVraag.id);
        if(sub) pred[v.subVraag.id]=sub.value;
      }
    } else {
      const el=document.getElementById('pred_'+v.id);
      if(el) pred[v.id]=el.value;
    }
  });
  saveState();
  if(alert){
    const name=state.players.find(x=>x.id===state.activePlayer)?.name;
    showToast('💾 Voorspelling van '+name+' opgeslagen!');
    renderInvullenForm();
  }
}

// ── RESULTAAT ──
function renderResultaat(){
  const content=document.getElementById('resultaatContent');
  if(!state.players.length){content.innerHTML='<div class="empty"><span>😬</span>Geen spelers gevonden.</div>';return;}
  const uitslagSet=Object.values(state.uitslag).some(v=>v&&v!=='');

  const uitslagKeys = Object.keys(state.uitslag).filter(k=>state.uitslag[k]&&state.uitslag[k]!=='');
  const vragenSorted = [...state.vragen].sort((a,b)=>{
    const ai = uitslagKeys.indexOf(a.id);
    const bi = uitslagKeys.indexOf(b.id);
    const aHas = ai !== -1;
    const bHas = bi !== -1;
    if(aHas && bHas) return bi - ai;
    if(aHas) return -1;
    if(bHas) return 1;
    return 0;
  });

  const scores=state.players.map(p=>{
    const pred=state.voorspellingen[p.id]||{};
    let goed=0,totaal=0;
    const visVragen=getVisibleVragen(pred);
    const details=vragenSorted.filter(v=>visVragen.find(vv=>vv.id===v.id)).map(v=>{
      const antwoord=pred[v.id]||'';
      const correct=state.uitslag[v.id]||'';
      const correctValid = (v.type==='score'||v.type==='tussenstand')
        ? (()=>{ const p=correct.split('-'); return p[0].trim()!==''&&p[1]&&p[1].trim()!==''; })()
        : correct!=='';
      // Only evaluate if uitslag for THIS question is known
      const isGoed = correctValid && antwoord.trim().toLowerCase()===correct.trim().toLowerCase();
      if(correctValid) totaal++;
      if(isGoed) goed++;
      return {v,antwoord,correct,isGoed,correctValid};
    });
    return {p,goed,totaal,details};
  }).sort((a,b)=>b.goed-a.goed);

  const perVraagHtml = vragenSorted.map(v=>{
    let correct = state.uitslag[v.id]||'';
    if(v.type==='score'||v.type==='tussenstand'){
      const parts = correct.split('-');
      if(!parts[0].trim() && (!parts[1] || !parts[1].trim())) return '';
    }
    if(!correct) return '';

    const winnaars = state.players.filter(p=>{
      const pred = state.voorspellingen[p.id]||{};
      const ant = pred[v.id]||'';
      return ant.trim().toLowerCase()===correct.trim().toLowerCase();
    });
    const verliezers = state.players.filter(p=>{
      const pred = state.voorspellingen[p.id]||{};
      const ant = pred[v.id]||'';
      return ant.trim().toLowerCase()!==correct.trim().toLowerCase();
    });

    // Straf info
    const strafInfo = state.strafMode && state.straffen && state.straffen[v.id] ? state.straffen[v.id] : null;

    // Helper: actie-label per type en context
    function strafActie(type, context){
      if(context === 'fout') return type === 'adtje' ? 'doen' : 'nemen';
      return 'uitdelen'; // goed
    }

    // Twee kolommen: fout links, goed rechts
    const fouChips = verliezers.map(p=>{
      const pred = state.voorspellingen[p.id]||{};
      const ant = pred[v.id]||'';
      return `<div class="winner-chip fout">
        <div class="winner-chip-avatar">${p.name[0].toUpperCase()}</div>
        ${p.name}${ant ? ` <span style="color:var(--muted);font-weight:400">(${ant})</span>` : ''}
      </div>`;
    }).join('');

    const goedChips = winnaars.map(p=>`
      <div class="winner-chip goed">
        <div class="winner-chip-avatar">${p.name[0].toUpperCase()}</div>
        ${p.name}
      </div>`).join('');

    // Straf labels per kolom
    const fouStrafLabel = strafInfo && strafInfo.fouGetal
      ? `<div style="font-size:10px;font-weight:800;color:#ff8080;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">🍺 ${strafInfo.fouGetal} ${strafInfo.fouType} ${strafActie(strafInfo.fouType,'fout')}</div>`
      : '';
    const goedStrafLabel = strafInfo && strafInfo.goedGetal
      ? `<div style="font-size:10px;font-weight:800;color:var(--oranje);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">🍺 ${strafInfo.goedGetal} ${strafInfo.goedType} ${strafActie(strafInfo.goedType,'goed')}</div>`
      : '';

    // Two-column layout when straffen active, else original single row
    const winnersSection = strafInfo
      ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:0;border-top:1px solid var(--border);">
          <div style="padding:10px 12px;border-right:1px solid var(--border);">
            ${fouStrafLabel}
            <div style="display:flex;flex-direction:column;gap:5px;">
              ${fouChips || '<div style="font-size:11px;color:var(--muted);">Niemand fout 🎉</div>'}
            </div>
          </div>
          <div style="padding:10px 12px;">
            ${goedStrafLabel}
            <div style="display:flex;flex-direction:column;gap:5px;">
              ${goedChips || '<div style="font-size:11px;color:var(--muted);">Niemand goed 😬</div>'}
            </div>
          </div>
        </div>`
      : `<div class="vraag-summary-winners">
          ${goedChips || ''}${fouChips || ''}
          ${!goedChips && !fouChips ? '<div class="vraag-summary-none">Niemand had dit goed 😬</div>' : ''}
        </div>`;

    return `
      <div class="vraag-summary">
        <div class="vraag-summary-header">
          <div class="vraag-summary-tekst">${getVraagTekst(v)}</div>
          <div class="vraag-summary-antwoord">✓ ${(v.type==='score'||v.type==='tussenstand') ? correct.replace('-',' — ') : correct}</div>
        </div>
        ${winnersSection}
      </div>`;
  }).filter(Boolean).join('');

  const medals=['🥇','🥈','🥉'];
  const standenHtml = scores.map((s,i)=>{
    const isGeheim = state.geheim[s.p.id]||false;
    const heeftIngevuld = Object.values(state.voorspellingen[s.p.id]||{}).some(v=>v&&v!=='');
    // Score badge: toon alleen als uitslag is ingevuld
    const scoreBadge = uitslagSet
      ? `<div class="result-score">${s.goed}/${s.totaal}</div>`
      : `<div class="result-score" style="font-size:13px;color:var(--muted);">${heeftIngevuld?'✅':'⏳'}</div>`;
    // Subtitel onder naam
    const subTekst = uitslagSet
      ? `${s.goed} van ${s.totaal} goed`
      : heeftIngevuld ? (isGeheim ? '🔒 Ingevuld (geheim)' : 'Ingevuld') : 'Nog niet ingevuld';
    // Progress bar: alleen als uitslag bekend
    const progressBar = uitslagSet
      ? `<div class="progress-bar" style="max-width:140px;margin-top:5px;"><div class="progress-fill" style="width:${s.totaal?Math.round(s.goed/s.totaal*100):0}%"></div></div>`
      : '';
    // Details rijen: toon antwoord tenzij geheim en geen uitslag
    const detailRows = s.details.map(d=>{
      const antwoord = d.antwoord;
      const vraagHeeftUitslag = d.correctValid;
      const verbergAntwoord = isGeheim && !vraagHeeftUitslag;
      const antwoordTekst = verbergAntwoord ? '<span style="color:var(--muted)">🔒 Geheim</span>' : (antwoord||'<span style="color:var(--muted)">—</span>');
      const icon = !uitslagSet ? '' : (!d.correctValid?'⬜':d.isGoed?'✅':'❌');
      const correctTekst = vraagHeeftUitslag && !d.isGoed
        ? `<div style="font-size:11px;color:var(--oranje);margin-top:2px;">✓ ${d.correct}</div>`
        : '';
      return `<div class="result-row">
        <div class="result-vraag">${getVraagTekst(d.v)}</div>
        <div class="result-antwoord">${antwoordTekst}${correctTekst}</div>
        <div class="result-icon">${icon}</div>
      </div>`;
    }).join('');
    return `
    <div class="result-player-card ${uitslagSet&&i===0?'rank-1':''}" id="rcard_${s.p.id}" style="animation-delay:${i*0.06}s">
      <div class="result-player-header" onclick="toggleResultCard('${s.p.id}')">
        ${avatarHtml(s.p,'36px','15px')}
        <div style="margin-left:10px;flex:1;">
          <div style="font-weight:800;font-size:16px;">${uitslagSet?(medals[i]||'  '):''}<span style="${!uitslagSet?'':''}"> ${s.p.name}</span> <span class="expand-arrow">▼</span></div>
          <div style="font-size:12px;color:var(--muted);font-weight:500;">${subTekst}</div>
          ${progressBar}
        </div>
        ${scoreBadge}
      </div>
      <div class="result-rows">
        ${detailRows||'<div style="padding:10px 16px;font-size:12px;color:var(--muted);">Nog niets ingevuld</div>'}
      </div>
    </div>`;
  }).join('');

  let schaamtepaalHtml = '';
  if(scores.length > 1){
    const verliezers = scores.filter(s=>s.totaal>0);
    if(verliezers.length){
      const laatste = verliezers[verliezers.length-1];
      const shames = ['🤡','😭','🙈','💩','🫠','😬'];
      const emoji = shames[Math.floor(Math.random()*shames.length)];
      const pct = laatste.totaal ? Math.round(laatste.goed/laatste.totaal*100) : 0;
      schaamtepaalHtml = `
        <div class="schaamtepaal-card">
          <span class="schaamtepaal-emoji">${emoji}</span>
          <div class="schaamtepaal-title">Wall of Shame</div>
          <div class="schaamtepaal-name">${laatste.p.name}</div>
          <div class="schaamtepaal-sub">${laatste.goed} van ${laatste.totaal} goed · ${pct}% raak</div>
        </div>`;
    }
  }

  content.innerHTML = `
    ${uitslagSet ? `<div class="result-section-label">Per vraag</div>${perVraagHtml || '<div class="empty" style="padding:20px 0;"><span>⏳</span>Nog geen uitslag ingevuld</div>'}` : '<div class="info-bar" style="margin-bottom:4px;">⏳ Wacht op de uitslag van de Admin — bekijk alvast wie wat heeft ingevuld!</div>'}
    <div class="result-section-label" style="margin-top:${uitslagSet?'24':'8'}px;">${uitslagSet ? 'Eindstand' : 'Voorspellingen'}</div>
    ${standenHtml}
    ${schaamtepaalHtml}
  `;
}

function toggleResultCard(pid){
  const card = document.getElementById('rcard_'+pid);
  if(card) card.classList.toggle('expanded');
}

function clearVoorspellingen(){
  state.players.forEach(p => { state.voorspellingen[p.id] = {}; state.geheim[p.id] = false; });
  tourMode = false; tourIndex = 0; editingPlayer = null;
  saveState();
  showToast('🗑️ Voorspellingen gewist');
}

function startNieuwRondje(){
  state.players.forEach(p => { state.voorspellingen[p.id] = {}; state.geheim[p.id] = false; });
  state.uitslag = {};
  tourMode = true; tourIndex = 0; editingPlayer = null; state.locked = false;
  saveState();
  if(adminOpen) toggleAdmin();
  renderInvullen();
  setTimeout(()=> checkStartTour(), 300);
  showToast('🔄 Nieuw rondje gestart!');
}

function resetAll(){
  // Stop countdown timer first
  if(cdInterval){ clearInterval(cdInterval); cdInterval = null; }
  state={
    mode:'landen',team1:'',team2:'',
    players:[],vragen:JSON.parse(JSON.stringify(VAST_VRAGEN)),
    voorspellingen:{},geheim:{},uitslag:{},
    activePlayer:null,countdown:{date:'',time:''},
    locked:false,
    strafMode:false,
    straffen:{},
    pincode:'',
    fotos:{},
    devices:{},
  };
  tourMode = false;
  tourIndex = 0;
  currentUserId = null;
  document.getElementById('userIndicator').style.display = 'none';
  document.getElementById('countdownWidget').innerHTML = '';
  if(adminOpen) toggleAdmin();
  saveState();
  renderInvullen();
  renderMatchup();
  showToast('🗑️ Alles gereset');
}

function showToast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg;t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2500);
}

// ── ENTER KEY NAVIGATION ──
document.addEventListener('keydown', function(e){
  if(e.key !== 'Enter') return;
  const active = document.activeElement;
  if(!active) return;
  const id = active.id || '';
  if(!id.startsWith('pred_') || active.tagName === 'SELECT') return;
  e.preventDefault();
  const tegels = Array.from(document.querySelectorAll('[id^="pv_"]'));
  const openTegel = tegels.find(t => t.style.display !== 'none');
  if(!openTegel) return;
  saveCurrentVoorspelling(false);
  const curId = openTegel.id;
  const curArrow = document.getElementById('arrow_' + curId);
  openTegel.style.display = 'none';
  if(curArrow) curArrow.style.transform = '';
  const curIdx = tegels.indexOf(openTegel);
  const next = tegels[curIdx + 1];
  if(next){
    next.style.display = 'block';
    const nextArrow = document.getElementById('arrow_' + next.id);
    if(nextArrow) nextArrow.style.transform = 'rotate(180deg)';
    const inp = next.querySelector('input, select');
    if(inp) setTimeout(()=>inp.focus(), 50);
  }
});

// ── ADMIN WACHTWOORD & CONFIG VIA URL ──
const ADMIN_PASSWORD = '0801';
const DEVICE_KEY = 'golazo_device_id';
const USER_KEY = 'golazo_user_id';
const ADMIN_SESSION_KEY = 'golazo_admin_session';
const ADMIN_SESSION_DURATION = 60 * 60 * 1000; // 60 minuten in ms
function getDeviceId(){
  let id = localStorage.getItem(DEVICE_KEY);
  if(!id){ id = 'dev_' + Math.random().toString(36).slice(2) + Date.now(); localStorage.setItem(DEVICE_KEY, id); }
  return id;
}
let isAdmin = false;

// Encode/decode config voor in de URL (simpele base64)
function encodeConfig(url, key){
  return btoa(unescape(encodeURIComponent(JSON.stringify({url, key}))));
}
function decodeConfig(str){
  try{ return JSON.parse(decodeURIComponent(escape(atob(str)))); }catch(e){ return null; }
}

// Genereer deelbare links (roep aan na verbinden)
function generateShareLinks(){
  if(!supabaseUrl || !supabaseKey) return;
  const cfg = encodeConfig(supabaseUrl, supabaseKey);
  const base = window.location.origin + window.location.pathname;
  const friendLink = base + '?cfg=' + cfg;
  const adminLink  = base + '?cfg=' + cfg + '&admin=ja';
  // Sla op zodat we ze kunnen tonen
  window._friendLink = friendLink;
  window._adminLink  = adminLink;
  // Toon in admin scherm als die al open is
  renderShareLinks();
}

function renderShareLinks(){
  const el = document.getElementById('shareLinksBox');
  if(!el || !window._friendLink) return;
  el.innerHTML = `
    <div style="margin-top:16px;background:var(--surface2);border:1px solid var(--border-orange);border-radius:16px;padding:14px;">
      <div style="font-size:10px;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">🔗 Deelbare links</div>
      <div style="font-size:12px;color:var(--muted2);margin-bottom:4px;font-weight:600;">👥 Link voor vrienden:</div>
      <div style="display:flex;gap:6px;margin-bottom:10px;">
        <input type="text" value="${window._friendLink}" readonly style="font-size:11px;padding:8px 12px;border-radius:10px;flex:1;">
        <button class="btn sm" onclick="copyLink('friend')" style="flex-shrink:0;width:auto;">📋</button>
      </div>
      <div style="font-size:12px;color:var(--muted2);margin-bottom:4px;font-weight:600;">🔐 Jouw admin-link:</div>
      <div style="display:flex;gap:6px;">
        <input type="text" value="${window._adminLink}" readonly style="font-size:11px;padding:8px 12px;border-radius:10px;flex:1;">
        <button class="btn sm" onclick="copyLink('admin')" style="flex-shrink:0;width:auto;">📋</button>
      </div>
    </div>
  `;
}

function copyLink(type){
  const link = type === 'admin' ? window._adminLink : window._friendLink;
  navigator.clipboard.writeText(link).then(()=> showToast('🔗 Link gekopieerd!'));
}

// BETA knop klik — alleen reageren als admin
let betaClickCount = 0;
function betaClick(){
  if(!isAdmin) return;
  toggleAdmin();
}

function checkAdminUrl(){
  const params = new URLSearchParams(window.location.search);

  // Config via URL laden (?cfg=...)
  const cfgParam = params.get('cfg');
  if(cfgParam){
    const decoded = decodeConfig(cfgParam);
    if(decoded && decoded.url && decoded.key){
      supabaseUrl = decoded.url;
      supabaseKey = decoded.key;
      // Sla ook lokaal op zodat het de volgende keer snel laadt
      localStorage.setItem(CONFIG_KEY, JSON.stringify({url: supabaseUrl, key: supabaseKey}));
    }
  }

  // Admin check (?admin=ja)
  if(params.get('admin') === 'ja'){
    // Controleer of er een geldige admin-sessie is (binnen 60 min)
    const savedSession = localStorage.getItem(ADMIN_SESSION_KEY);
    if(savedSession && (Date.now() - parseInt(savedSession, 10)) < ADMIN_SESSION_DURATION){
      isAdmin = true;
      return false; // Direct doorgaan zonder wachtwoordscherm
    }
    document.getElementById('loadingScreen').style.display = 'none';
    document.getElementById('adminPwScreen').style.display = 'flex';
    // Focus op wachtwoordveld
    requestAnimationFrame(()=>{ const el=document.getElementById('adminPwInput'); if(el) el.focus(); });
    return true;
  }
  return false;
}

function checkAdminPassword(){
  const pw = document.getElementById('adminPwInput').value;
  const errEl = document.getElementById('adminPwError');
  if(pw === ADMIN_PASSWORD){
    isAdmin = true;
    localStorage.setItem(ADMIN_SESSION_KEY, Date.now().toString());
    document.getElementById('adminPwScreen').style.display = 'none';
    // BETA knop krijgt subtiele admin-stijl
    const betaBtn = document.getElementById('betaAdminBtn');
    if(betaBtn){
      betaBtn.style.cursor = 'pointer';
      betaBtn.title = 'Admin';
    }
    initSupabase();
  } else {
    errEl.style.display = 'block';
    document.getElementById('adminPwInput').value = '';
  }
}

// Maak functies globaal beschikbaar voor inline HTML handlers
Object.assign(window, {
  saveSupabaseConfig, checkAdminPassword, checkPincode,
  toggleAdmin, toggleMode, toggleStraffen,
  savePincode, clearPincode, capitalizeInput, saveTeams,
  formatDateInput, saveCountdown, formatTimeInput,
  addPlayer, removePlayer, resetDevice,
  toggleVragenAdmin, toggleEigenVraag, addEigenVraag,
  startEditVraag, saveEditVraag, cancelEditVraag, removeVraag,
  toggleUitslag, toggleUitslagVraag, saveUitslag, savePushBerichten,
  toggleLockdown, startNieuwRondje,
  showResetSheet, hideResetSheet,
  clearVoorspellingen, resetSpelers, resetAll,
  popupOverlayClick, startPlayerTurn,
  betaClick, switchPlayer, showTab,
  pickPlayer, uploadFoto, editPlayer,
  togglePredVraag, toggleResultCard,
  backToOverview, handleSaveBtn, copyLink,
  toggleSecret, saveStraf,
  saveCurrentVoorspelling, renderInvullenForm,
  syncScore, capitalizeWordsInput,
});

// ── PUSH NOTIFICATIONS ──
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch(e) {
    console.error('Service worker registratie mislukt:', e);
    return null;
  }
}

async function subscribeToPush(playerId) {
  if (!('PushManager' in window)) return;
  const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
  if (!vapidKey) return;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey)
      });
    }
    if (db) {
      await db.from('push_subscriptions').upsert(
        { player_id: playerId, subscription: sub.toJSON(), updated_at: new Date().toISOString() },
        { onConflict: 'player_id' }
      );
    }
  } catch(e) {
    console.error('Push subscribe mislukt:', e);
  }
}

function savePushBerichten() {
  const goedEl = document.getElementById('pushGoedInput');
  const foutEl = document.getElementById('pushFoutInput');
  if(goedEl) state.pushGoedBericht = goedEl.value.trim() || 'Lekker pik! Bekijk hier wat je goed hebt gedaan.';
  if(foutEl) state.pushFoutBericht = foutEl.value.trim() || 'Haha sukkel.. bekijk wat je fout hebt gedaan.';
  saveState();
  showToast('🔔 Pushmeldingen opgeslagen!');
}

async function sendPersonalizedPushNotifications() {
  const goedBericht = state.pushGoedBericht || 'Lekker pik! Bekijk hier wat je goed hebt gedaan.';
  const foutBericht = state.pushFoutBericht || 'Haha sukkel.. bekijk wat je fout hebt gedaan.';
  const messages = [];
  state.vragen.forEach(v => {
    const correct = state.uitslag[v.id] || '';
    const correctValid = (v.type === 'score' || v.type === 'tussenstand')
      ? (()=>{ const parts = correct.split('-'); return parts[0].trim() !== '' && parts[1] && parts[1].trim() !== ''; })()
      : correct !== '';
    if (!correctValid) return;

    state.players.forEach(p => {
      const antwoord = (state.voorspellingen[p.id] || {})[v.id] || '';
      const isGoed = antwoord.trim().toLowerCase() === correct.trim().toLowerCase();
      messages.push({
        player_id: p.id,
        title: 'Golazo 🏆',
        body: isGoed ? goedBericht : foutBericht
      });
    });
  });

  if (!messages.length) return;

  try {
    await fetch('/api/send-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages })
    });
  } catch(e) {
    console.error('Push versturen mislukt:', e);
  }
}

async function sendPushNotification(title, body) {
  try {
    await fetch('/api/send-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body })
    });
  } catch(e) {
    console.error('Push versturen mislukt:', e);
  }
}

// ── INIT ──
registerServiceWorker().then(() => {
  // Luister naar berichten van de service worker (bijv. notificatie klik)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'SHOW_TAB') showTab(event.data.tab);
    });
  }
  // Eenmalige URL-check bij opstarten (app geopend via notificatie link)
  const tabParam = new URLSearchParams(window.location.search).get('tab');
  if (tabParam) setTimeout(() => showTab(tabParam), 500);
});
loadSupabaseConfig();
if(!checkAdminUrl()) initSupabase();
