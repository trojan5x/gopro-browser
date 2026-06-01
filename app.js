// GoPro Browser Application Logic (Evercloud Theme)

// ── CONFIG ───────────────────────────────────────────────────────────
// Determine proxy origin dynamically so remote clients (e.g. mobile phones on the same Wi-Fi) can access it.
// When hosted on GitHub Pages or local files, default to localhost.
const PROXY_ORIGIN = (
  window.location.protocol.startsWith('http') && 
  !window.location.hostname.includes('github.io')
) ? window.location.origin : 'http://localhost:8765';
const BASE_URL = PROXY_ORIGIN + '/proxy';

// ── LOOKUP TABLES ────────────────────────────────────────────────────
const RES_NAMES = {1:'4K',4:'2.7K 4:3',5:'2.7K',6:'1440p',9:'1080p',12:'720p',18:'4K 4:3',27:'5K'};
const FPS_NAMES = {0:'240fps',1:'120fps',2:'100fps',5:'60fps',6:'50fps',8:'30fps',9:'25fps',10:'24fps',13:'200fps'};
const HS_NAMES  = {0:'Off',1:'Low',2:'High',3:'Boost',4:'AutoBoost',5:'Standard'};
const MODE_NAMES = {0:'Video',1:'Photo',2:'Multi-Shot',5:'Setup'};

// ── STATE MANAGEMENT ─────────────────────────────────────────────────
const state = {
  connected: false,
  allFiles: [], 
  filtered: [], 
  sessions: {},
  selected: new Set(),
  currentFile: null, 
  currentDetailIdx: -1,
  activeSessionId: null, 
  prevView: 'grid',
  filter: 'all', 
  sort: 'date', 
  sortDir: -1,
  view: 'grid', 
  searchQ: '',
  recording: false, 
  battery: null, 
  remainingMinutes: null,
  cameraMode: null, 
  cameraSettings: {},
  dlQueue: [], 
  dlActive: false,
  viewed: new Set(), 
  downloaded: new Set(),
  keepAliveTimer: null, 
  pollTimer: null,
  serverInfo: null, 
  useLRV: false, 
  showClip: false,
  isLegacy: false,
  isModern: false,
  hilighted: new Set(),
};

// ── INIT ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  fetchServerInfo();
  setupKeyboardShortcuts();
  
  // Hook up automatic sidebar dismissal on link selection for mobile viewports
  document.querySelectorAll('.sidebar a').forEach(link => {
    link.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        toggleSidebar(false);
      }
    });
  });
});

// ── SERVER INFO ──────────────────────────────────────────────────────
async function fetchServerInfo() {
  try { 
    state.serverInfo = await fetch(`${PROXY_ORIGIN}/info`).then(r => r.json()); 
  } catch(_) {}
}

// ── SESSION NAMING (localStorage) ───────────────────────────────────
const LS_KEY = 'gopro_session_names';
function loadGroupName(sessionId, dateKey) {
  try { 
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}')[`${sessionId}_${dateKey}`] || null; 
  } catch { 
    return null; 
  }
}
function saveGroupName(sessionId, dateKey, name) {
  try {
    const store = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if (name) store[`${sessionId}_${dateKey}`] = name;
    else delete store[`${sessionId}_${dateKey}`];
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  } catch {}
}

// ── CONNECT & POLLING ────────────────────────────────────────────────
async function connectCamera() {
  setConnStatus('connecting', 'Connecting…');
  document.getElementById('btn-connect').disabled = true;

  try {
    let info = null;
    state.isLegacy = false;
    try { info = await gopro('/gopro/camera/info'); } catch(_) {}
    if (!info) {
      info = await gopro('/gp/gpControl/info');
      state.isLegacy = true;
    }

    state.connected = true;
    setConnStatus('connected', 'Connected');
    document.getElementById('btn-refresh').disabled = false;
    document.getElementById('btn-last').disabled = false;
    document.getElementById('btn-shutter').disabled = false;
    document.getElementById('btn-shutter').style.display = 'flex';

    // Update camera models in UI
    const modelName = info?.info?.model_name || 'HERO10 Black';
    document.getElementById('breadcrumb').textContent = modelName;

    // Determine if it is a modern camera (Hero 9+)
    const modelUpper = modelName.toUpperCase();
    state.isModern = modelUpper.includes('HERO9') || modelUpper.includes('HERO10') || modelUpper.includes('HERO11') || modelUpper.includes('HERO12') || modelUpper.includes('HERO13') || !state.isLegacy;

    // Initialize Wired USB Control & Claim UI Control (for modern GoPros over USB)
    if (state.isModern) {
      try {
        console.log('Activating Wired USB Control (p=1) and UI Controller (p=2)...');
        await fetch(`${BASE_URL}/gopro/camera/control/wired_usb?p=1`).catch(() => {});
        await fetch(`${BASE_URL}/gopro/camera/control/set_ui_controller?p=2`).catch(() => {});
      } catch (e) {
        console.warn('Wired control setup error:', e);
      }
    }

    // Show live status pills
    document.getElementById('live-rec-pill').style.display = 'flex';
    document.getElementById('live-batt-pill').style.display = 'flex';
    document.getElementById('empty-state').style.display = 'none';

    // Keep-alive triggers (every 2.5s)
    if (state.keepAliveTimer) clearInterval(state.keepAliveTimer);
    state.keepAliveTimer = setInterval(() => {
      fetch(`${BASE_URL}/gopro/camera/keep_alive`).catch(() => {});
    }, 2500);

    // Live poll camera status (every 4s)
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(pollCameraState, 4000);
    pollCameraState();

    showToast('Camera connected', 'green');
    await loadMedia();

  } catch(err) {
    setConnStatus('error', 'Connection failed');
    document.getElementById('btn-connect').disabled = false;
    showCORSHelp();
  }
}

async function pollCameraState() {
  if (!state.connected) return;
  try {
    const st = await gopro('/gopro/camera/state');
    if (!st) return;
    const s = st.status || {};
    const settings = st.settings || {};

    // For debugging, print GoPro state status flags to console
    console.log('GoPro State Status:', s);

    // Modern GoPros (Hero 9+) use key 10 for encoding/recording. Legacy uses key 8.
    state.recording = state.isModern ? !!s['10'] : !!s['8'];
    state.battery = s['70'] ?? s['2'] ?? null;
    // Key 35 is remaining video time in seconds. Key 54 is SD card remaining space in KB.
    let remainingMins = null;
    if (s['35'] !== undefined && s['35'] < 4000000000) {
      remainingMins = Math.floor(s['35'] / 60);
    }
    state.remainingMinutes = remainingMins;
    state.cameraMode = s['43'] ?? null;
    state.cameraSettings = settings;

    // Shutter button & recording state
    const recDot = document.querySelector('#live-rec-pill .status-dot');
    const recLabel = document.getElementById('live-rec-label');
    const recPill = document.getElementById('live-rec-pill');
    const shutterLabel = document.getElementById('shutter-label');
    
    const vf = document.getElementById('live-viewfinder');
    const vfImg = document.getElementById('viewfinder-img');
    const grid = document.getElementById('media-grid');
    const empty = document.getElementById('empty-state');
    
    if (state.recording) {
      recPill.className = 'status-pill recording';
      recLabel.textContent = 'REC';
      if (shutterLabel) shutterLabel.textContent = 'Stop';
      document.getElementById('btn-shutter').className = 'btn-secondary recording';
      
      // Toggle viewfinder preview
      if (vf) {
        vf.classList.remove('hidden');
        if (vfImg && !vfImg.getAttribute('src')) {
          vfImg.setAttribute('src', `${PROXY_ORIGIN}/live-preview?t=${Date.now()}`);
        }
      }
      grid.classList.add('hidden');
      empty.style.display = 'none';
    } else {
      recPill.className = 'status-pill';
      recLabel.textContent = 'Idle';
      if (shutterLabel) shutterLabel.textContent = 'Record';
      document.getElementById('btn-shutter').className = 'btn-secondary';
      
      // Stop viewfinder preview
      if (vf) {
        vf.classList.add('hidden');
        if (vfImg) vfImg.removeAttribute('src');
      }
      if (state.connected) {
        grid.classList.remove('hidden');
        empty.style.display = 'none';
      } else {
        grid.classList.add('hidden');
        empty.style.display = 'flex';
      }
    }

    if (state.battery !== null) {
      document.getElementById('live-batt').textContent = state.battery + '%';
    }
    
    let sdLabel = '0% Used';
    let freeSpace = '';
    if (s['54'] !== undefined && s['54'] > 0) {
      const freeGB = (s['54'] / 1024 / 1024).toFixed(1);
      freeSpace = `${freeGB} free`;
    }
    
    let remainingLabel = '';
    if (state.remainingMinutes !== null && state.remainingMinutes > 0) {
      const h = Math.floor(state.remainingMinutes / 60);
      const m = state.remainingMinutes % 60;
      remainingLabel = h > 0 ? `${h}h ${m}m` : `${m}min`;
    }
    
    if (freeSpace && remainingLabel) {
      sdLabel = `${freeSpace} · ${remainingLabel}`;
    } else if (freeSpace) {
      sdLabel = freeSpace;
    } else if (remainingLabel) {
      sdLabel = `${remainingLabel} remaining`;
    }
    
    // Handle SD card status warnings (33 is Primary Storage State)
    const sdStatus = s['33'];
    if (sdStatus === 2) {
      sdLabel = 'No SD Card';
    } else if (sdStatus === 1) {
      sdLabel = 'SD Card Full';
    } else if (sdStatus === 3) {
      sdLabel = 'SD Card Error';
    }
    
    document.getElementById('s-sd').textContent = sdLabel;
  } catch(_) {}
}

// ── SHUTTER CONTROL ──────────────────────────────────────────────────
async function toggleShutter() {
  const endpoint = state.recording ? '/gopro/camera/shutter/stop' : '/gopro/camera/shutter/start';
  try {
    const res = await fetch(`${BASE_URL}${endpoint}`);
    if (!res.ok) {
      showToast(`Shutter failed: HTTP ${res.status}`, 'red');
    }
    setTimeout(pollCameraState, 500);
  } catch(_) { 
    showToast('Shutter command failed', 'red'); 
  }
}

// ── LOAD MEDIA ───────────────────────────────────────────────────────
async function loadMedia() {
  document.getElementById('btn-refresh').disabled = true;
  showSkeletons();
  try {
    const data = await gopro('/gopro/media/list');
    const allFiles = [];
    if (data?.media) {
      for (const folder of data.media) {
        for (const file of folder.fs || []) {
          allFiles.push({
            name: file.n, 
            dir: folder.d,
            created: parseInt(file.cre) * 1000,
            modified: parseInt(file.mod) * 1000,
            size: parseInt(file.s) || 0,
            lrv: file.glrv ? parseInt(file.glrv) : 0,
            raw: file,
          });
        }
      }
    }
    state.allFiles = allFiles;
    state.sessions = buildSessions(allFiles);
    updateCounts();
    applyFilters();
    updateStorageViz();
    fetchMediaHighlights();
  } catch(_) { 
    showToast('Failed to load media', 'red'); 
  }
  document.getElementById('btn-refresh').disabled = false;
}

// ── LAST CAPTURED ────────────────────────────────────────────────────
async function openLastCaptured() {
  try {
    const data = await gopro('/gopro/media/last_captured');
    if (data?.file) {
      const name = data.file;
      const f = state.allFiles.find(f => f.name === name);
      if (f) { openDetail(f); return; }
    }
    const latest = [...state.allFiles].sort((a,b) => b.created - a.created)[0];
    if (latest) openDetail(latest);
  } catch(_) {
    const latest = [...state.allFiles].sort((a,b) => b.created - a.created)[0];
    if (latest) openDetail(latest);
    else showToast('No files found', 'red');
  }
}

// ── SESSION GROUPING ─────────────────────────────────────────────────
function parseFilename(name) {
  let m = name.match(/^GX(\d{2})(\d{4})\.(MP4|LRV)$/i);
  if (m) return { chapter: parseInt(m[1]), session: m[2], ext: m[3].toLowerCase() };
  m = name.match(/^GOPR(\d{4})\.(JPG|JPEG|MP4)$/i);
  if (m) return { chapter: 0, session: m[1], ext: m[2].toLowerCase() };
  m = name.match(/^GP(\d{2})(\d{4})\.(JPG|JPEG)$/i);
  if (m) return { chapter: parseInt(m[1]), session: m[2], ext: m[3].toLowerCase() };
  return null;
}

function buildSessions(files) {
  const sessions = {};
  for (const file of files) {
    const parsed = parseFilename(file.name);
    const key = parsed ? parsed.session : ('misc_' + file.name);
    const dateKey = new Date(file.created).toISOString().slice(0,10);
    if (!sessions[key]) {
      sessions[key] = {
        id: key, 
        files: [], 
        totalSize: 0,
        created: file.created, 
        dateKey,
        name: loadGroupName(key, dateKey),
        isGroup: !!parsed,
      };
    }
    sessions[key].files.push(file);
    sessions[key].totalSize += file.size;
    if (file.created < sessions[key].created) {
      sessions[key].created = file.created;
      sessions[key].dateKey = new Date(file.created).toISOString().slice(0,10);
    }
  }
  
  // Sort chapters
  for (const s of Object.values(sessions)) {
    s.files.sort((a, b) => {
      const pa = parseFilename(a.name), pb = parseFilename(b.name);
      return (pa?.chapter || 0) - (pb?.chapter || 0);
    });
  }
  return sessions;
}

// ── SESSION RENAME ───────────────────────────────────────────────────
function startEditName(sessionId, el, e) {
  e.stopPropagation();
  const session = state.sessions[sessionId];
  if (!session) return;
  const current = session.name || '';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.className = 'session-name-input';
  input.placeholder = `Session ${sessionId}`;
  input.onclick = ev => ev.stopPropagation();

  const save = () => {
    const newName = input.value.trim() || null;
    session.name = newName;
    saveGroupName(sessionId, session.dateKey, newName);
    el.textContent = newName || `Session ${sessionId}`;
    el.style.display = '';
    input.remove();
  };

  input.onblur = save;
  input.onkeydown = ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
    if (ev.key === 'Escape') { input.value = current; input.blur(); }
    ev.stopPropagation();
  };

  el.style.display = 'none';
  el.parentNode.insertBefore(input, el.nextSibling);
  input.focus();
  input.select();
}

// ── FILTERS & VIEWS ──────────────────────────────────────────────────
function setFilter(f, btn) {
  state.filter = f;
  document.querySelectorAll('.sb-label-item').forEach(b => b.classList.remove('active'));
  btn?.classList.add('active');
  
  // Highlight File Manager menu item since labels belong to it
  document.querySelectorAll('.sb-menu-item').forEach(b => b.classList.remove('active'));
  document.getElementById('menu-media').classList.add('active');
  
  applyFilters();
}

function filterSearch(q) {
  state.searchQ = q.toLowerCase();
  applyFilters();
}

function setSort(s, btn) {
  if (state.sort === s) state.sortDir *= -1; 
  else { state.sort = s; state.sortDir = -1; }
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  btn.textContent = s.charAt(0).toUpperCase() + s.slice(1) + (state.sortDir === -1 ? ' ↓' : ' ↑');
  applyFilters();
}

function applyFilters() {
  if (state.view === 'grouped' || state.view === 'session') { 
    renderGrid(); 
    updateStatusBar(); 
    return; 
  }
  let files = [...state.allFiles];
  if (state.filter !== 'all') {
    if (state.filter === 'hilights') {
      files = files.filter(f => state.hilighted.has(`${f.dir}/${f.name}`));
    } else {
      files = files.filter(f => f.name.toLowerCase().endsWith('.' + state.filter));
    }
  }
  if (state.searchQ) {
    files = files.filter(f => f.name.toLowerCase().includes(state.searchQ));
  }
  files.sort((a, b) => {
    if (state.sort === 'date') return (a.created - b.created) * state.sortDir;
    if (state.sort === 'name') return a.name.localeCompare(b.name) * state.sortDir;
    if (state.sort === 'size') return (a.size - b.size) * state.sortDir;
    return 0;
  });
  state.filtered = files;
  renderGrid();
  updateStatusBar();
}

function setView(v, btn) {
  if (state.view === 'session') closeSession(false);
  state.view = v;
  document.querySelectorAll('.view-toggle-btn').forEach(b => b.classList.remove('active'));
  btn?.classList.add('active');
  document.getElementById('back-btn').disabled = true;
  document.getElementById('breadcrumb').textContent = 'All Media';
  applyFilters();
}

// ── DOM RENDER ───────────────────────────────────────────────────────
function renderGrid() {
  const grid = document.getElementById('media-grid');
  grid.classList.remove('hidden');
  document.getElementById('empty-state').style.display = 'none';

  if (state.view === 'grouped') {
    renderGrouped(grid);
  } else if (state.view === 'session') {
    renderSession(grid);
  } else {
    const isList = state.view === 'list';
    grid.className = 'media-grid' + (isList ? ' list-view' : '');
    grid.innerHTML = '';
    if (state.filtered.length === 0 && state.connected) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:60px;font-size:13px;color:var(--text-secondary)">No files match your search.</div>`;
      return;
    }
    state.filtered.forEach((f, i) => grid.appendChild(buildFileCard(f, i)));
  }
}

function renderGrouped(grid) {
  grid.className = 'media-grid grouped-view';
  grid.innerHTML = '';

  const byDate = {};
  for (const s of Object.values(state.sessions)) {
    if (!byDate[s.dateKey]) byDate[s.dateKey] = [];
    byDate[s.dateKey].push(s);
  }
  const sortedDates = Object.keys(byDate).sort((a,b) => b.localeCompare(a));

  if (sortedDates.length === 0) {
    grid.innerHTML = `<div style="text-align:center;padding:60px;font-size:13px;color:var(--text-secondary)">No recorded sessions found.</div>`;
    return;
  }

  sortedDates.forEach((dateKey, di) => {
    const sessions = byDate[dateKey].sort((a,b) => b.created - a.created);
    const totalFiles = sessions.reduce((n, s) => n + s.files.length, 0);
    const totalSize  = sessions.reduce((n, s) => n + s.totalSize, 0);

    const group = document.createElement('div');
    group.className = 'date-group';
    group.style.animationDelay = (di * 0.04) + 's';

    const dateLabel = new Date(dateKey + 'T12:00:00').toLocaleDateString('en-IN', {day:'2-digit',month:'long',year:'numeric'});
    group.innerHTML = `
      <div class="date-group-header">
        <span class="date-group-title">${dateLabel}</span>
        <div class="date-group-line"></div>
        <span class="date-group-meta">${sessions.length} Session${sessions.length>1?'s':''} · ${totalFiles} Files (${formatSize(totalSize)})</span>
      </div>
      <div class="session-grid" id="sg-${dateKey.replace(/-/g,'_')}"></div>
    `;
    grid.appendChild(group);

    const sg = group.querySelector('.session-grid');
    sessions.forEach((sess, si) => {
      sg.appendChild(buildSessionCard(sess, di * 10 + si));
    });
  });
}

function renderSession(grid) {
  const sess = state.sessions[state.activeSessionId];
  if (!sess) { closeSession(); return; }

  grid.className = 'media-grid';
  grid.innerHTML = '';

  document.getElementById('breadcrumb').textContent = sess.name || `Session ${state.activeSessionId}`;
  sess.files.forEach((f, i) => grid.appendChild(buildFileCard(f, i)));
}

function openSession(sessionId) {
  state.activeSessionId = sessionId;
  state.prevView = state.view;
  state.view = 'session';
  document.getElementById('back-btn').disabled = false;
  renderGrid();
}

function closeSession(rerender = true) {
  state.view = state.prevView || 'grouped';
  state.activeSessionId = null;
  document.getElementById('back-btn').disabled = true;
  document.getElementById('breadcrumb').textContent = 'All Media';
  if (rerender) {
    const btnId = {grid:'vbtn-grid',list:'vbtn-list',grouped:'vbtn-grouped'}[state.view];
    document.querySelectorAll('.view-toggle-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(btnId)?.classList.add('active');
    applyFilters();
  }
}

// ── CARD BUILDERS ────────────────────────────────────────────────────
function buildFileCard(file, idx) {
  const card = document.createElement('div');
  const isSelected = state.selected.has(file.name);
  card.className = 'media-card' + (isSelected ? ' selected' : '');
  card.style.animationDelay = Math.min(idx * 0.015, 0.25) + 's';

  const ext = file.name.split('.').pop().toLowerCase();
  const isVideo = ext === 'mp4', isPhoto = ext === 'jpg' || ext === 'jpeg';
  const thumbUrl = `${BASE_URL}/gopro/media/thumbnail?path=${file.dir}/${file.name}`;

  if (state.view === 'list') {
    card.innerHTML = `
      <div class="card-inner">
        <div class="card-checkbox" onclick="event.stopPropagation(); toggleSelectCard('${file.name}', this.parentNode.parentNode)"></div>
        <div class="card-thumb">${isPhoto||isVideo ? `<img src="${thumbUrl}" onerror="thumbError(this)" loading="lazy">` : `<div class="no-thumb">${svgFile()}</div>`}</div>
        <div class="card-info">
          <div class="card-name">${file.name}</div>
          <div class="card-meta"><span>${formatSize(file.size)}</span><span>${formatDate(file.created)}</span></div>
        </div>
        <span class="card-badge ${ext}">${ext.toUpperCase()}</span>
        <div class="inline-actions">
          <button class="inline-action-btn dl" onclick="event.stopPropagation(); queueDownload(${JSON.stringify(file).replace(/"/g,'&quot;')})" title="Download">↓</button>
          <button class="inline-action-btn del" onclick="event.stopPropagation(); deleteFile('${file.dir}','${file.name}')" title="Delete">🗑</button>
        </div>
      </div>`;
  } else {
    card.innerHTML = `
      <div class="card-checkbox" onclick="event.stopPropagation(); toggleSelectCard('${file.name}', this.parentNode)"></div>
      <div class="card-thumb">${isPhoto||isVideo ? `<img src="${thumbUrl}" onerror="thumbError(this)" loading="lazy">` : `<div class="no-thumb">${svgFile()}</div>`}<span class="card-badge ${ext}">${ext.toUpperCase()}</span></div>
      <div class="card-info">
        <div class="card-name">${file.name}</div>
        <div class="card-meta"><span>${formatSize(file.size)}</span><span>${formatDate(file.created)}</span></div>
      </div>`;
  }

  card.addEventListener('click', e => {
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.target.classList.contains('card-checkbox')) {
      toggleSelectCard(file.name, card);
    } else {
      openDetail(file);
    }
  });
  return card;
}

function buildSessionCard(sess, idx) {
  const card = document.createElement('div');
  card.className = 'session-card';
  card.style.animationDelay = Math.min(idx * 0.015, 0.28) + 's';

  const first = sess.files[0];
  const displayName = sess.name || `Session ${sess.id}`;
  const chapters = sess.files.length;
  const isOrange = idx % 2 === 0;

  card.innerHTML = `
    <div class="folder-icon-wrap">
      <svg class="folder-svg" viewBox="0 0 64 64" fill="none">
        <path d="M6 14C6 11.7909 7.79086 10 10 10H22.5858C23.6467 10 24.6641 10.4214 25.4142 11.1716L29.4142 15.1716C30.1643 15.9218 31.1818 16.3431 32.2426 16.3431H54C56.2091 16.3431 58 18.134 58 20.3431V48C58 50.2091 56.2091 52 54 52H10C7.79086 52 6 50.2091 6 48V14Z" fill="#e2e8f0" stroke="#cbd5e1" stroke-width="2"/>
        <path class="folder-accent-color" d="M6 22H58V48C58 50.2091 56.2091 52 54 52H10C7.79086 52 6 50.2091 6 48V22Z" fill="${isOrange ? 'var(--accent-orange)' : 'var(--accent)'}"/>
      </svg>
    </div>
    <div class="session-card-info">
      <div class="session-name-text" title="Click to rename">${displayName}</div>
      <div class="session-meta-text">${chapters} File${chapters>1?'s':''} · ${formatSize(sess.totalSize)}</div>
      <div class="session-date-label">${formatDate(sess.created)}</div>
    </div>`;

  const nameEl = card.querySelector('.session-name-text');
  nameEl.addEventListener('click', e => { 
    e.stopPropagation(); 
    startEditName(sess.id, nameEl, e); 
  });

  card.addEventListener('click', () => openSession(sess.id));
  return card;
}

// ── DETAIL LIGHTBOX MODAL ────────────────────────────────────────────
function openDetail(file) {
  state.currentFile = file;
  state.currentDetailIdx = state.filtered.indexOf(file);
  state.viewed.add(file.name);
  updateStatusBar();

  const ext = file.name.split('.').pop().toLowerCase();
  const isPhoto = ext === 'jpg' || ext === 'jpeg';
  const isVideo = ext === 'mp4';

  document.getElementById('detail-filename').textContent = file.name;
  setText('dm-name', file.name); 
  setText('dm-type', ext.toUpperCase());
  setText('dm-size', formatSize(file.size));
  setText('dm-created', formatDateFull(file.created));
  setText('dm-modified', formatDateFull(file.modified));
  setText('dm-dir', file.dir);

  // Toggle navigation keys
  const hasPrev = state.currentDetailIdx > 0;
  const hasNext = state.currentDetailIdx < state.filtered.length - 1;
  document.getElementById('detail-prev').style.display = hasPrev && isPhoto ? 'flex' : 'none';
  document.getElementById('detail-next').style.display = hasNext && isPhoto ? 'flex' : 'none';

  // Toggle video control overlay buttons
  document.getElementById('btn-lrv-toggle').style.display = isVideo && file.lrv > 0 ? 'flex' : 'none';
  document.getElementById('btn-clip-toggle').style.display = isVideo ? 'flex' : 'none';
  document.getElementById('btn-hilight').style.display = isVideo ? 'flex' : 'none';
  document.getElementById('video-overlay').style.display = isVideo ? 'flex' : 'none';
  document.getElementById('btn-dl-lrv').style.display = isVideo && file.lrv > 0 ? 'flex' : 'none';

  // Reset trimmer state
  state.showClip = false;
  document.getElementById('clip-controls').classList.remove('show');
  document.getElementById('btn-clip-toggle').classList.remove('active');

  // Reset LRV state
  state.useLRV = false;
  document.getElementById('btn-lrv-toggle').classList.remove('active');

  renderDetailPreview(file, isPhoto, isVideo);
  document.getElementById('detail-overlay').classList.add('open');
}

function renderDetailPreview(file, isPhoto, isVideo) {
  const prev = document.getElementById('detail-preview');
  
  // Clean old media
  prev.querySelectorAll('img[data-media],video').forEach(el => {
    if (el.tagName === 'VIDEO') { el.pause(); el.src = ''; }
    el.remove();
  });

  if (isPhoto) {
    const imgUrl = `${BASE_URL}/videos/DCIM/${file.dir}/${file.name}`;
    const img = document.createElement('img');
    img.dataset.media = '1';
    img.src = imgUrl; 
    img.alt = file.name;
    img.onerror = () => { 
      prev.querySelector('.no-preview')?.remove(); 
      prev.innerHTML += `<div class="no-preview">${svgFile()}<span>Preview unavailable</span></div>`; 
    };
    prev.insertBefore(img, prev.querySelector('.detail-nav-btn.next'));
  } else if (isVideo) {
    const ext = file.name.split('.').pop();
    const fname = state.useLRV && file.lrv > 0 ? file.name.replace(new RegExp(`\\.${ext}$`,'i'), '.LRV') : file.name;
    const videoUrl = `${BASE_URL}/videos/DCIM/${file.dir}/${fname}`;
    const vid = document.createElement('video');
    vid.src = videoUrl; 
    vid.controls = true;
    vid.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;';
    prev.insertBefore(vid, prev.querySelector('#video-overlay'));
  } else {
    if (!prev.querySelector('.no-preview')) {
      const div = document.createElement('div');
      div.className = 'no-preview';
      div.innerHTML = svgFile() + '<span>No preview</span>';
      prev.insertBefore(div, prev.querySelector('.detail-nav-btn.next'));
    }
  }
}

function navigateDetail(dir) {
  const idx = state.currentDetailIdx + dir;
  if (idx < 0 || idx >= state.filtered.length) return;
  openDetail(state.filtered[idx]);
}

function toggleLRV() {
  state.useLRV = !state.useLRV;
  document.getElementById('btn-lrv-toggle').classList.toggle('active', state.useLRV);
  if (state.currentFile) {
    const ext = state.currentFile.name.split('.').pop().toLowerCase();
    renderDetailPreview(state.currentFile, false, ext === 'mp4');
  }
}

function toggleClip() {
  state.showClip = !state.showClip;
  document.getElementById('clip-controls').classList.toggle('show', state.showClip);
  document.getElementById('btn-clip-toggle').classList.toggle('active', state.showClip);
}

function setClipPoint(type) {
  const vid = document.querySelector('#detail-preview video');
  if (!vid) return;
  document.getElementById(`clip-${type}`).value = vid.currentTime.toFixed(1);
}

async function exportClip() {
  if (!state.serverInfo?.ffmpeg) { 
    showToast('ffmpeg not found on server', 'red'); 
    return; 
  }
  const f = state.currentFile;
  if (!f) return;
  const start    = parseFloat(document.getElementById('clip-start').value) || 0;
  const endVal   = parseFloat(document.getElementById('clip-end').value) || 0;
  const duration = endVal > start ? endVal - start : 30;
  const path = encodeURIComponent(`${f.dir}/${f.name}`);
  showToast('Exporting clip…');
  try {
    const res = await fetch(`${PROXY_ORIGIN}/clip?path=${path}&start=${start}&duration=${duration}`, { signal: AbortSignal.timeout(300000) });
    if (!res.ok) throw new Error('Failed');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `clip_${f.name}`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('Clip saved', 'green');
  } catch(_) { 
    showToast('Clip export failed', 'red'); 
  }
}

function addHilight() {
  const vid = document.querySelector('#detail-preview video');
  if (!vid || !state.currentFile) return;
  const ms = Math.max(1, Math.round(vid.currentTime * 1000));
  const { dir, name } = state.currentFile;
  fetch(`${BASE_URL}/gopro/media/hilight/file?path=${dir}/${name}&ms=${ms}`)
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast('HiLight added ⚑', 'green');
      
      const id = `${dir}/${name}`;
      state.hilighted.add(id);
      
      // Update local file highlight offsets
      const f = state.allFiles.find(file => file.dir === dir && file.name === name);
      if (f) {
        if (!f.hilights) f.hilights = [];
        if (!f.hilights.includes(ms)) {
          f.hilights.push(ms);
          f.hilights.sort((a, b) => a - b);
        }
      }
      
      updateCounts();
      if (state.filter === 'hilights') {
        applyFilters();
      }
    })
    .catch(() => showToast('HiLight failed', 'red'));
}

function closeDetail(e) { 
  if (e.target === document.getElementById('detail-overlay')) closeDetailBtn(); 
}
function closeDetailBtn() {
  const vid = document.querySelector('#detail-preview video');
  if (vid) { vid.pause(); vid.src = ''; }
  document.getElementById('detail-overlay').classList.remove('open');
}

// ── DOWNLOAD QUEUE ────────────────────────────────────────────────────
function queueDownload(file, downloadAs) {
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    file, 
    downloadAs: downloadAs || file.name,
    status: 'queued', 
    progress: 0,
    controller: new AbortController(),
  };
  state.dlQueue.push(item);
  document.getElementById('dl-tray').classList.add('open');
  renderDLTray();
  if (!state.dlActive) processQueue();
}

async function processQueue() {
  if (state.dlActive) return;
  const next = state.dlQueue.find(i => i.status === 'queued');
  if (!next) return;
  state.dlActive = true;
  next.status = 'active';
  renderDLTray();
  try {
    const url = `${BASE_URL}/videos/DCIM/${next.file.dir}/${next.file.name}`;
    const res = await fetch(url, { signal: next.controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = parseInt(res.headers.get('content-length') || '0');
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total > 0) { 
        next.progress = Math.round(received / total * 100); 
        renderDLItem(next); 
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(chunks));
    a.download = next.downloadAs;
    a.click();
    URL.revokeObjectURL(a.href);
    next.status = 'done'; 
    next.progress = 100;
    state.downloaded.add(next.file.name);
    showToast(`${next.downloadAs} saved`, 'green');
  } catch(e) {
    next.status = (e.name === 'AbortError' || next.status === 'cancelled') ? 'cancelled' : 'error';
  }
  state.dlActive = false;
  renderDLTray();
  if (state.dlQueue.some(i => i.status === 'queued')) processQueue();
}

function cancelDownload(id) {
  const item = state.dlQueue.find(i => i.id === id);
  if (!item) return;
  item.controller.abort();
  item.status = 'cancelled';
  if (state.dlActive) { state.dlActive = false; processQueue(); }
  renderDLTray();
}

function clearDoneDL() {
  state.dlQueue = state.dlQueue.filter(i => i.status === 'queued' || i.status === 'active');
  renderDLTray();
}

function toggleTray() {
  const t = document.getElementById('dl-tray');
  t.classList.toggle('open');
}

function renderDLTray() {
  const list = document.getElementById('dl-tray-list');
  const active = state.dlQueue.filter(i => i.status === 'active' || i.status === 'queued').length;
  const done   = state.dlQueue.filter(i => i.status === 'done').length;
  document.getElementById('dl-tray-sub').textContent = `${active} active · ${done} done`;
  list.innerHTML = '';
  [...state.dlQueue].reverse().forEach(item => {
    const el = document.createElement('div');
    el.className = 'dl-item';
    el.id = 'dl-' + item.id;
    el.innerHTML = `
      <div class="dl-item-dot ${item.status}"></div>
      <div class="dl-item-name" title="${item.downloadAs}">${item.downloadAs}</div>
      ${item.status === 'active' ? `<div class="dl-item-progress-wrap"><div class="dl-item-progress-bar" style="width:${item.progress}%"></div></div><div class="dl-item-pct">${item.progress}%</div>` : `<div class="dl-item-pct" style="text-transform: capitalize;">${item.status}</div>`}
      ${item.status !== 'done' ? `<button class="dl-item-cancel" onclick="cancelDownload('${item.id}')">✕</button>` : ''}
    `;
    list.appendChild(el);
  });
}

function renderDLItem(item) {
  const el = document.getElementById('dl-' + item.id);
  if (!el) return;
  const bar = el.querySelector('.dl-item-progress-bar');
  const pct = el.querySelector('.dl-item-pct');
  if (bar) bar.style.width = item.progress + '%';
  if (pct) pct.textContent = item.progress + '%';
}

// ── DELETE OPERATIONS ────────────────────────────────────────────────
async function deleteFile(dir, name) {
  if (!confirm(`Delete ${name}?\nThis action cannot be undone.`)) return;
  try {
    await fetch(`${BASE_URL}/gopro/media/delete/file?path=${dir}/${name}`);
    state.allFiles = state.allFiles.filter(f => !(f.dir === dir && f.name === name));
    state.sessions = buildSessions(state.allFiles);
    state.selected.delete(name);
    updateCounts(); 
    applyFilters(); 
    updateStorageViz();
    showToast(`${name} deleted`, 'green');
  } catch(_) { 
    showToast('Delete failed', 'red'); 
  }
}

function deleteCurrent() {
  if (!state.currentFile) return;
  const f = state.currentFile;
  closeDetailBtn();
  deleteFile(f.dir, f.name);
}

async function deleteSelected() {
  const files = state.allFiles.filter(f => state.selected.has(f.name));
  if (!files.length) return;
  if (!confirm(`Delete ${files.length} file${files.length>1?'s':''}?\nThis cannot be undone.`)) return;
  for (const f of files) {
    try {
      await fetch(`${BASE_URL}/gopro/media/delete/file?path=${f.dir}/${f.name}`);
      state.allFiles = state.allFiles.filter(x => x.name !== f.name);
    } catch(_) {}
  }
  state.sessions = buildSessions(state.allFiles);
  state.selected.clear();
  updateSelBar(); 
  updateCounts(); 
  applyFilters(); 
  updateStorageViz();
  showToast('Files deleted', 'green');
}

// ── SINGLE ACTIONS ───────────────────────────────────────────────────
function downloadCurrent() {
  if (!state.currentFile) return;
  const prefix = document.getElementById('dl-prefix').value.trim();
  const name = prefix + state.currentFile.name;
  queueDownload(state.currentFile, name);
  showToast(`Queued: ${name}`);
}

function downloadLRVCurrent() {
  if (!state.currentFile) return;
  const lrvFile = { ...state.currentFile, name: state.currentFile.name.replace(/\.MP4$/i, '.LRV') };
  queueDownload(lrvFile, lrvFile.name);
}

function downloadSelected() {
  const prefix = document.getElementById('dl-prefix').value.trim();
  const files = state.allFiles.filter(f => state.selected.has(f.name));
  files.forEach(f => queueDownload(f, prefix + f.name));
  clearSelection();
  showToast(`${files.length} files queued`);
}

// ── MULTI-SELECTION ──────────────────────────────────────────────────
function toggleSelectCard(filename, cardEl) {
  if (state.selected.has(filename)) { 
    state.selected.delete(filename); 
    cardEl.classList.remove('selected'); 
  } else { 
    state.selected.add(filename); 
    cardEl.classList.add('selected'); 
  }
  updateSelBar();
}

function clearSelection() {
  state.selected.clear();
  document.querySelectorAll('.media-card.selected').forEach(c => c.classList.remove('selected'));
  updateSelBar();
}

function updateSelBar() {
  const bar = document.getElementById('sel-bar');
  if (state.selected.size > 0) {
    bar.classList.add('show');
    document.getElementById('sel-count-label').textContent = `${state.selected.size} file${state.selected.size>1?'s':''} selected`;
  } else { 
    bar.classList.remove('show'); 
  }
}

// ── EXPORT MANIFEST ──────────────────────────────────────────────────
function exportManifest() {
  if (!state.allFiles.length) { showToast('No files loaded', 'red'); return; }
  const rows = ['Name,Type,Size (bytes),Size,Created,Modified,Directory,Session,Chapter'];
  for (const f of state.allFiles) {
    const parsed = parseFilename(f.name);
    rows.push([f.name, f.name.split('.').pop().toUpperCase(), f.size, formatSize(f.size),
      new Date(f.created).toISOString(), new Date(f.modified).toISOString(),
      f.dir, parsed?.session||'', parsed?.chapter||''].join(','));
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type:'text/csv' }));
  a.download = `gopro_manifest_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('Manifest exported', 'green');
}

// ── SETTINGS MODAL ────────────────────────────────────────────────────
function openSettings() {
  const s = state.cameraSettings;
  const rows = [
    ['Mode', MODE_NAMES[state.cameraMode] || '—'],
    ['Resolution', RES_NAMES[s[2]] || (s[2] !== undefined ? `#${s[2]}` : '—')],
    ['Frame Rate', FPS_NAMES[s[3]] || (s[3] !== undefined ? `#${s[3]}` : '—')],
    ['HyperSmooth', HS_NAMES[s[78]] || (s[78] !== undefined ? `#${s[78]}` : '—')],
    ['Battery', state.battery != null ? state.battery + '%' : '—'],
    ['SD Remaining', state.remainingMinutes != null ? state.remainingMinutes + ' min' : '—'],
    ['Recording', state.recording ? '● REC' : 'Idle'],
  ];
  document.getElementById('settings-rows').innerHTML = rows.map(([k,v]) =>
    `<div class="settings-row"><span class="settings-k">${k}</span><span class="settings-v ${v==='● REC'?'recording':''}">${v}</span></div>`
  ).join('');
  document.getElementById('settings-overlay').classList.add('open');
}

// ── CHECKLIST MODAL ──────────────────────────────────────────────────
function openChecklist() {
  const checks = [];
  checks.push({ label:'Camera connected', pass:state.connected, detail:state.connected?'HERO10 Black':'Not connected' });
  if (state.battery !== null) {
    const ok = state.battery >= 50;
    checks.push({ label:'Battery ≥ 50%', pass:ok, warn:state.battery>=30&&!ok, detail:state.battery+'%' });
  }
  if (state.remainingMinutes !== null) {
    const ok = state.remainingMinutes >= 30;
    checks.push({ label:'SD space ≥ 30 min', pass:ok, warn:state.remainingMinutes>=10&&!ok, detail:state.remainingMinutes+' min remaining' });
  }
  const s = state.cameraSettings;
  if (s[78] !== undefined) {
    checks.push({ label:'HyperSmooth enabled', pass:s[78]>0, detail:HS_NAMES[s[78]]||`#${s[78]}` });
  }
  if (s[2] !== undefined) {
    const ok = s[2] <= 9;
    checks.push({ label:'Resolution ≥ 1080p', pass:ok, detail:RES_NAMES[s[2]]||`#${s[2]}` });
  }
  
  if (!state.connected) {
    document.getElementById('checklist-items').innerHTML = '<div style="text-align:center;padding:20px;font-size:12px;color:var(--text-secondary)">Connect camera to run checklist</div>';
  } else {
    document.getElementById('checklist-items').innerHTML = checks.map(c => `
      <div class="check-item ${c.pass?'pass':c.warn?'warn':'fail'}">
        <span class="check-icon">${c.pass?'✓':c.warn?'⚠':'✗'}</span>
        <span class="check-label">${c.label}</span>
        <span class="check-detail">${c.detail||''}</span>
      </div>`).join('');
  }
  document.getElementById('checklist-overlay').classList.add('open');
}

// ── SHARE MODAL ───────────────────────────────────────────────────────
async function openShare() {
  if (!state.serverInfo) {
    try { state.serverInfo = await fetch(`${PROXY_ORIGIN}/info`).then(r => r.json()); } catch(_) {}
  }
  const url = state.serverInfo?.local_url || window.location.origin || `http://localhost:8765`;
  document.getElementById('share-url').textContent = url;

  const qrImg = document.getElementById('share-qr');
  if (qrImg) {
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(url)}`;
  }

  document.getElementById('share-overlay').classList.add('open');
}

function copyShareUrl() {
  const url = document.getElementById('share-url').textContent;
  navigator.clipboard.writeText(url)
    .then(() => showToast('Copied to clipboard', 'green'))
    .catch(() => showToast('Could not copy — select and copy manually', 'red'));
}

function closeModal(id, e) {
  if (!e || e.target === document.getElementById(id)) {
    document.getElementById(id).classList.remove('open');
  }
}

// ── SIDEBAR SECTION ROUTER ───────────────────────────────────────────
function showSection(section) {
  if (section === 'media') {
    closeSession(true);
    state.filter = 'all';
    document.querySelectorAll('.sb-menu-item').forEach(b => b.classList.remove('active'));
    document.getElementById('menu-media').classList.add('active');
    document.querySelectorAll('.sb-label-item').forEach(b => b.classList.remove('active'));
    const allLabel = document.querySelector('.sb-label-item');
    if (allLabel) allLabel.classList.add('active');
    applyFilters();
  }
}

function focusSearch() {
  const input = document.getElementById('search');
  input.focus();
  input.select();
}

function filterHighlights() {
  state.filter = 'hilights';
  
  // Force grid view if grouped to apply highlight filters
  if (state.view === 'grouped' || state.view === 'session') {
    state.view = 'grid';
    document.querySelectorAll('.view-toggle-btn').forEach(b => b.classList.remove('active'));
    const gridBtn = document.querySelector('.view-toggle-btn[onclick*="setView(\'grid\'"]');
    if (gridBtn) gridBtn.classList.add('active');
  }

  document.querySelectorAll('.sb-menu-item').forEach(b => b.classList.remove('active'));
  document.getElementById('menu-favorites').classList.add('active');
  document.querySelectorAll('.sb-label-item').forEach(b => b.classList.remove('active'));
  
  applyFilters();
}

// ── STATS & STORAGE VIZ ──────────────────────────────────────────────
function updateCounts() {
  const vids  = state.allFiles.filter(f => /\.mp4$/i.test(f.name)).length;
  const pics  = state.allFiles.filter(f => /\.(jpg|jpeg)$/i.test(f.name)).length;
  const lrvs  = state.allFiles.filter(f => /\.lrv$/i.test(f.name)).length;
  const hilights = state.hilighted.size;
  const total = state.allFiles.length;
  
  setText('fc-all', total); 
  setText('fc-mp4', vids); 
  setText('fc-jpg', pics); 
  setText('fc-lrv', lrvs);
  setText('fc-hilight', hilights);
}

async function fetchMediaHighlights() {
  if (!state.connected || !state.allFiles.length) return;
  
  // Reset highlighted Set to ensure accurate tracking on reload
  state.hilighted.clear();
  
  // Only query metadata for MP4 video files
  const mp4Files = state.allFiles.filter(f => /\.mp4$/i.test(f.name));
  
  for (const f of mp4Files) {
    if (!state.connected) break;
    
    const id = `${f.dir}/${f.name}`;
    try {
      const data = await gopro(`/gopro/media/info?path=${f.dir}/${f.name}`);
      if (data && (parseInt(data.hc) > 0 || (Array.isArray(data.hi) && data.hi.length > 0))) {
        state.hilighted.add(id);
        f.hilights = data.hi || [];
        
        updateCounts();
        if (state.filter === 'hilights') {
          applyFilters();
        }
      }
    } catch (e) {
      console.warn(`Failed to fetch media info for ${f.name}`, e);
    }
    
    // Slow down requests to avoid camera CPU starvation
    await new Promise(r => setTimeout(r, 120));
  }
}

function updateStorageViz() {
  const vidSize = state.allFiles.filter(f => /\.mp4$/i.test(f.name)).reduce((s,f)=>s+f.size,0);
  const picSize = state.allFiles.filter(f => /\.(jpg|jpeg)$/i.test(f.name)).reduce((s,f)=>s+f.size,0);
  const lrvSize = state.allFiles.filter(f => /\.lrv$/i.test(f.name)).reduce((s,f)=>s+f.size,0);
  const total   = vidSize + picSize + lrvSize;
  if (total === 0) return;

  document.getElementById('sb-vid-bar').style.width = (vidSize/total*100)+'%';
  document.getElementById('sb-pic-bar').style.width = (picSize/total*100)+'%';
  document.getElementById('sb-lrv-bar').style.width = (lrvSize/total*100)+'%';
  
  setText('stor-vid', formatSize(vidSize));
  setText('stor-pic', formatSize(picSize));
}

function updateStatusBar() {
  const c = state.view === 'session'
    ? (state.sessions[state.activeSessionId]?.files.length || 0)
    : state.filtered.length;
  setText('sb-count', c + ' File' + (c!==1?'s':''));
  setText('sb-filter', state.filter==='all'?'All':'.' + state.filter.toUpperCase());
  setText('sb-sort', 'by ' + state.sort);
  setText('sb-viewed', state.viewed.size + ' Viewed');
}

// ── CONNECT STATUS ────────────────────────────────────────────────────
function setConnStatus(status, label) {
  const el = document.getElementById('conn-status');
  el.className = 'status-pill ' + status;
  document.getElementById('conn-label').textContent = label;
}

function showCORSHelp() {
  document.getElementById('empty-title').textContent = 'Connection failed';
  document.getElementById('empty-sub').textContent = 'Could not reach the GoPro. Make sure the proxy is running and the camera is powered on.';
  document.getElementById('empty-state').style.display = 'flex';
}

function toggleHelp() { 
  const empty = document.getElementById('empty-state');
  if (empty.style.display === 'none') {
    document.getElementById('empty-title').textContent = 'Setup Instructions';
    document.getElementById('empty-sub').textContent = 'To link the interface, run the local proxy command from step 1, plug in your GoPro Hero 10/11 via USB-C, power it on, then click Connect.';
    empty.style.display = 'flex';
  } else {
    empty.style.display = 'none';
  }
}

// ── SKELETON LOADERS ─────────────────────────────────────────────────
function showSkeletons() {
  const grid = document.getElementById('media-grid');
  grid.classList.remove('hidden');
  document.getElementById('empty-state').style.display = 'none';
  grid.className = 'media-grid';
  grid.innerHTML = '';
  for (let i = 0; i < 12; i++) {
    const el = document.createElement('div');
    el.className = 'media-card';
    el.innerHTML = `<div class="card-thumb skeleton" style="aspect-ratio:16/10"></div><div class="card-info"><div class="skeleton" style="height:10px;margin-bottom:6px;border-radius:4px"></div><div class="skeleton" style="height:9px;width:55%;border-radius:4px"></div></div>`;
    grid.appendChild(el);
  }
}

// ── GOPRO HTTP CALL ──────────────────────────────────────────────────
async function gopro(path) {
  const res = await fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── UTILS ─────────────────────────────────────────────────────────────
function setText(id, val) { 
  const el = document.getElementById(id); 
  if (el) el.textContent = val; 
}

function svgFile() { 
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`; 
}

function thumbError(img) { 
  img.parentNode.innerHTML = `<div class="no-thumb">${svgFile()}</div>`; 
}

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1048576) return (bytes/1024).toFixed(1)+' KB';
  if (bytes < 1073741824) return (bytes/1048576).toFixed(1)+' MB';
  return (bytes/1073741824).toFixed(2)+' GB';
}

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'2-digit'});
}

function formatDateFull(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
}

let toastTimer;
function showToast(msg, type='') {
  const el = document.getElementById('toast');
  clearTimeout(toastTimer);
  el.textContent = msg; 
  el.className = 'show ' + type;
  toastTimer = setTimeout(() => { el.className = ''; }, 2800);
}

// ── SPLASH ONBOARDING LOGIC ──────────────────────────────────────────
let splashPhase = 'proxy'; 

function splashSetChecking(phase) {
  const spin = document.getElementById('splash-spin');
  const btn  = document.getElementById('splash-btn');
  const err  = document.getElementById('splash-error');
  
  spin.style.display = 'inline-block'; 
  btn.disabled = true; 
  err.style.display = 'none';
  
  if (phase === 'proxy') {
    document.getElementById('ss1').classList.add('active');
    document.getElementById('ss1-status').innerHTML = '<span style="color:var(--text-secondary)">Checking proxy…</span>';
  } else {
    document.getElementById('ss2').classList.add('active');
    document.getElementById('ss2-status').innerHTML = '<span style="color:var(--text-secondary)">Checking camera…</span>';
  }
}

function splashSetDone(step) {
  const num = document.getElementById(`ss${step}-num`);
  num.classList.add('done');
  num.textContent = '✓';
  document.getElementById(`ss${step}`).classList.remove('active');
  document.getElementById(`ss${step}`).classList.add('done');
  document.getElementById(`ss${step}-status`).innerHTML = '<span style="color:var(--accent-green-text)">✓ Ready</span>';
}

function splashSetError(step, msg) {
  const spin = document.getElementById('splash-spin');
  const btn  = document.getElementById('splash-btn');
  const err  = document.getElementById('splash-error');
  
  spin.style.display = 'none'; 
  btn.disabled = false;
  
  document.getElementById(`ss${step}-status`).innerHTML = `<span style="color:var(--accent-red-text)">${msg}</span>`;
  err.style.display = 'none';
}

async function splashCheck() {
  if (splashPhase === 'proxy') {
    splashSetChecking('proxy');
    try {
      const r = await fetch(`${PROXY_ORIGIN}/info`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        splashSetDone(1);
        splashPhase = 'camera';
        document.getElementById('splash-btn-label').textContent = 'Check camera →';
        document.getElementById('splash-spin').style.display = 'none';
        document.getElementById('splash-btn').disabled = false;
        await splashCheckCamera();
        return;
      }
    } catch(_) {}
    splashSetError(1, 'Not detected — make sure the terminal shows "Serving on → http://localhost:8765"');
  } else {
    await splashCheckCamera();
  }
}

async function splashCheckCamera() {
  splashSetChecking('camera');
  try {
    let ok = false;
    for (const ep of ['/gopro/camera/info', '/gp/gpControl/info']) {
      try {
        const r = await fetch(`${BASE_URL}${ep}`, { signal: AbortSignal.timeout(4000) });
        if (r.ok) { ok = true; break; }
      } catch(_) {}
    }
    if (ok) {
      splashSetDone(2);
      await new Promise(res => setTimeout(res, 600));
      hideSplash();
      connectCamera();
      return;
    }
  } catch(_) {}
  splashSetError(2, 'Camera not found — plug in via USB-C and press the power button');
  document.getElementById('splash-btn-label').textContent = 'Try again →';
  document.getElementById('splash-spin').style.display = 'none';
  document.getElementById('splash-btn').disabled = false;
}

function hideSplash() {
  document.getElementById('splash').classList.add('hidden');
}

function copyCmd(el) {
  const cmd = el.querySelector('span').textContent;
  navigator.clipboard.writeText(cmd).catch(() => {});
  const copy = el.querySelector('.splash-code-copy');
  copy.textContent = 'copied!'; 
  setTimeout(() => copy.textContent = 'copy', 1500);
}

// ── KEYBOARD SHORTCUTS ────────────────────────────────────────────────
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.getElementById('detail-overlay').classList.contains('open')) { 
        closeDetailBtn(); 
        return; 
      }
      document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    }
    if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      focusSearch();
    }
    if (e.key === 'ArrowLeft'  && document.getElementById('detail-overlay').classList.contains('open')) {
      navigateDetail(-1);
    }
    if (e.key === 'ArrowRight' && document.getElementById('detail-overlay').classList.contains('open')) {
      navigateDetail(1);
    }
    if (e.key === 'r' && (e.metaKey||e.ctrlKey) && state.connected) { 
      e.preventDefault(); 
      loadMedia(); 
    }
  });
}

// Auto-detect on load
(async () => {
  try {
    const r = await fetch(`${PROXY_ORIGIN}/info`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return;
    splashSetDone(1); 
    splashPhase = 'camera';
    const r2 = await fetch(`${BASE_URL}/gopro/camera/info`, { signal: AbortSignal.timeout(3000) });
    if (r2.ok) { 
      splashSetDone(2); 
      await new Promise(res => setTimeout(res, 400)); 
      hideSplash(); 
      connectCamera();
    } else {
      document.getElementById('splash-btn-label').textContent = 'Check camera →';
    }
  } catch(_) {}
})();

// ── MOBILE SIDEBAR DRAWER CONTROLLER ─────────────────────────────────
function toggleSidebar(forceState) {
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!sidebar) return;
  
  const isOpen = sidebar.classList.contains('open');
  const nextState = (forceState !== undefined) ? forceState : !isOpen;
  
  if (nextState) {
    sidebar.classList.add('open');
    backdrop?.classList.add('active');
  } else {
    sidebar.classList.remove('open');
    backdrop?.classList.remove('active');
  }
}
