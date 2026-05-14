const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { execFile } = require('child_process');
const os = require('os');

// ffmpeg
let ffmpegPath;
try {
  ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
} catch (e) {
  ffmpegPath = 'ffmpeg'; // fallback si installé globalement
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── AUDIO EFFECTS ────────────────────────────────────────────────────────────
// Applique un effet FFmpeg sur un buffer audio base64, retourne base64
function applyAudioEffect(base64data, effectName, volume = 1.0) {
  return new Promise((resolve, reject) => {
    const tmpIn  = path.join(os.tmpdir(), `vc_in_${Date.now()}.webm`);
    const tmpOut = path.join(os.tmpdir(), `vc_out_${Date.now()}.webm`);

    const buf = Buffer.from(base64data, 'base64');
    fs.writeFileSync(tmpIn, buf);

    const vol = Math.max(0.1, Math.min(3.0, volume));

    const effects = {
      robot:    `asetrate=44100*0.8,aresample=44100,atempo=1.25,volume=${vol},aphaser=in_gain=0.4:out_gain=0.74:delay=3:decay=0.4:speed=0.5:type=t`,
      fast:     `atempo=2.0,volume=${vol}`,
      slow:     `atempo=0.5,volume=${vol}`,
      echo:     `aecho=0.8:0.88:60:0.4,volume=${vol}`,
      noise:    `volume=${vol},aeval='val(0)+random(0)*0.15'`,
      chipmunk: `asetrate=44100*1.5,aresample=44100,volume=${vol}`,
      deep:     `asetrate=44100*0.6,aresample=44100,volume=${vol}`,
      reverse:  `areverse,volume=${vol}`,
      telephone:`highpass=f=300,lowpass=f=3400,volume=${vol}`,
      normal:   `volume=${vol}`,
    };

    const filter = effects[effectName] || effects.normal;

    const args = [
      '-y', '-i', tmpIn,
      '-af', filter,
      '-c:a', 'libopus',
      tmpOut
    ];

    execFile(ffmpegPath, args, (err) => {
      if (err) {
        fs.unlinkSync(tmpIn);
        return reject(err);
      }
      const outBuf = fs.readFileSync(tmpOut);
      fs.unlinkSync(tmpIn);
      fs.unlinkSync(tmpOut);
      resolve(outBuf.toString('base64'));
    });
  });
}

// ─── MEDIA FILES ──────────────────────────────────────────────────────────────
app.get('/api/media', (req, res) => {
  const base = path.join(__dirname, 'public', 'media');
  const result = { images: [], videos: [], sounds: [] };
  for (const cat of ['images', 'videos', 'sounds']) {
    const dir = path.join(base, cat);
    if (fs.existsSync(dir)) {
      result[cat] = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
    }
  }
  res.json(result);
});

// ─── GAME STATE ───────────────────────────────────────────────────────────────
let state = {
  phase: 'lobby',        // lobby | recording | waiting | reveal
  players: {},
  round: 0,
  totalRounds: 4,        // nb d'étapes dans la chaîne
  chains: {},            // chainId -> [{type, content, author, effect}]
  assignments: {},       // playerId -> chainOwnerId
  pending: new Set(),
  timer: null,
  timeLeft: 0,
  timerDuration: 30,
  // Paramètres audio admin
  audioEffect: 'robot',
  audioVolume: 1.0,
  // Troll overlay actif
  trollActive: false,
};

let nextId = 1;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const p of Object.values(state.players)) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  }
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function playerList() {
  return Object.values(state.players).map(p => ({
    id: p.id, name: p.name, ready: p.ready, score: p.score
  }));
}

function broadcastLobby() {
  broadcast({ type: 'lobby', players: playerList(), phase: state.phase });
}

function findPlayer(nameOrId) {
  return Object.values(state.players).find(
    p => p.name.toLowerCase() === (nameOrId || '').toLowerCase() || p.id === nameOrId
  );
}

function startTimer(seconds, onEnd) {
  state.timeLeft = seconds;
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    state.timeLeft--;
    broadcast({ type: 'timer', timeLeft: state.timeLeft });
    if (state.timeLeft <= 0) {
      clearInterval(state.timer);
      onEnd();
    }
  }, 1000);
}

function stopTimer() {
  clearInterval(state.timer);
  broadcast({ type: 'timer', timeLeft: 0 });
}

function log(msg) { console.log(msg); }

// ─── GAME LOGIC ───────────────────────────────────────────────────────────────
function startGame() {
  const ids = Object.keys(state.players);
  if (ids.length < 2) return log('❌ Minimum 2 joueurs');

  state.phase = 'playing';
  state.round = 1;
  state.chains = {};
  state.assignments = {};

  for (const id of ids) {
    state.chains[id] = [];
    state.assignments[id] = id;
  }

  const maxRounds = state.totalRounds * ids.length;
  broadcast({ type: 'phase', phase: 'playing', round: 1, totalRounds: maxRounds });
  sendRoundPrompts();
  log(`🎙️ Partie démarrée — ${ids.length} joueurs, ${maxRounds} rounds`);
}

// Détermine le type de tâche pour ce round
function getTaskType(round) {
  // round 1 = voix originale, rounds pairs = réécoute+réenregistrement, dernier round = dessin
  const ids = Object.keys(state.players);
  const maxRounds = state.totalRounds * ids.length;
  if (round === maxRounds) return 'draw';
  return 'voice';
}

function sendRoundPrompts() {
  const ids = Object.keys(state.players);
  state.pending = new Set(ids);
  const taskType = getTaskType(state.round);

  for (const id of ids) {
    const p = state.players[id];
    const chainOwner = state.assignments[id];
    const chain = state.chains[chainOwner];
    const lastEntry = chain[chain.length - 1] || null;

    send(p.ws, {
      type: 'your_turn',
      round: state.round,
      totalRounds: state.totalRounds * ids.length,
      taskType,
      // Ce que le joueur doit imiter (audio dégradé ou image)
      prompt: lastEntry ? lastEntry.content : null,
      promptType: lastEntry ? lastEntry.type : null,
      promptEffect: lastEntry ? lastEntry.effect : null,
      chainOwner: state.players[chainOwner]?.name || '?',
      timerDuration: state.timerDuration,
      audioEffect: state.audioEffect,
    });
  }

  startTimer(state.timerDuration, () => {
    // Forcer soumission vide pour les retardataires
    for (const id of [...state.pending]) {
      receiveSubmission(id, null, 'void', true);
    }
  });
}

async function receiveSubmission(playerId, content, contentType, forced = false) {
  if (!state.pending.has(playerId)) return;
  state.pending.delete(playerId);

  const chainOwner = state.assignments[playerId];
  let processedContent = content;
  let effectUsed = 'none';

  // Si c'est une voix et pas forcé → appliquer l'effet audio
  if (contentType === 'audio' && content && !forced) {
    try {
      processedContent = await applyAudioEffect(content, state.audioEffect, state.audioVolume);
      effectUsed = state.audioEffect;
      log(`🎵 Effet "${state.audioEffect}" appliqué pour ${state.players[playerId]?.name}`);
    } catch (e) {
      log(`⚠️ Erreur FFmpeg: ${e.message} — audio non transformé`);
      processedContent = content;
    }
  }

  state.chains[chainOwner].push({
    type: contentType,
    content: processedContent,
    rawContent: content, // original non dégradé pour la révélation
    author: state.players[playerId]?.name || '?',
    effect: effectUsed,
    forced,
  });

  send(state.players[playerId]?.ws, { type: 'submitted', waiting: state.pending.size });
  for (const [id, p] of Object.entries(state.players)) {
    if (id !== playerId) {
      send(p.ws, { type: 'waiting_update', waiting: state.pending.size, name: state.players[playerId]?.name });
    }
  }

  if (state.pending.size === 0) {
    stopTimer();
    advanceRound();
  }
}

function advanceRound() {
  const ids = Object.keys(state.players);
  const maxRounds = state.totalRounds * ids.length;

  if (state.round >= maxRounds) {
    showResults();
    return;
  }

  state.round++;

  // Rotation des chaînes
  const newAssignments = {};
  for (let i = 0; i < ids.length; i++) {
    const workerId = ids[i];
    const chainIdx = (ids.indexOf(state.assignments[workerId]) + 1) % ids.length;
    newAssignments[workerId] = ids[chainIdx];
  }
  state.assignments = newAssignments;

  broadcast({ type: 'round_start', round: state.round });
  setTimeout(sendRoundPrompts, 2000);
}

function showResults() {
  stopTimer();
  state.phase = 'results';
  const results = Object.entries(state.chains).map(([ownerId, chain]) => ({
    owner: state.players[ownerId]?.name || '?',
    chain,
  }));
  broadcast({ type: 'results', results });
  log('🏆 Résultats envoyés');
}

function resetGame() {
  stopTimer();
  state.phase = 'lobby';
  state.round = 0;
  state.chains = {};
  state.assignments = {};
  state.pending = new Set();
  for (const p of Object.values(state.players)) p.ready = false;
  broadcastLobby();
  log('🔄 Reset');
}

// ─── TROLL / OVERLAY ─────────────────────────────────────────────────────────
function sendOverlay(payload, target) {
  if (!target || target.toLowerCase() === 'all') {
    broadcast(payload);
  } else {
    const p = findPlayer(target);
    if (!p) return { error: `Joueur "${target}" introuvable` };
    send(p.ws, payload);
  }
  return { ok: true };
}

// ─── ADMIN HTTP API ───────────────────────────────────────────────────────────
app.get('/api/admin/state', (req, res) => {
  res.json({
    phase: state.phase,
    round: state.round,
    totalRounds: state.totalRounds,
    timerDuration: state.timerDuration,
    timeLeft: state.timeLeft,
    audioEffect: state.audioEffect,
    audioVolume: state.audioVolume,
    players: playerList(),
  });
});

app.post('/api/admin/start',   (req, res) => { startGame();  res.json({ ok: true }); });
app.post('/api/admin/reset',   (req, res) => { resetGame();  res.json({ ok: true }); });
app.post('/api/admin/skip',    (req, res) => { stopTimer();  advanceRound(); res.json({ ok: true }); });
app.post('/api/admin/results', (req, res) => { showResults(); res.json({ ok: true }); });

app.post('/api/admin/rounds', (req, res) => {
  const n = parseInt(req.body.value);
  if (n > 0) { state.totalRounds = n; res.json({ ok: true }); }
  else res.json({ error: 'Valeur invalide' });
});

app.post('/api/admin/timer', (req, res) => {
  const t = parseInt(req.body.value);
  if (t > 0) { state.timerDuration = t; res.json({ ok: true }); }
  else res.json({ error: 'Valeur invalide' });
});

// ── AUDIO ADMIN ──
app.post('/api/admin/effect', (req, res) => {
  const validEffects = ['robot','fast','slow','echo','noise','chipmunk','deep','reverse','telephone','normal'];
  const e = req.body.effect;
  if (!validEffects.includes(e)) return res.json({ error: 'Effet invalide' });
  state.audioEffect = e;
  broadcast({ type: 'effect_changed', effect: e });
  res.json({ ok: true, effect: e });
  log(`🎚️ Effet changé: ${e}`);
});

app.post('/api/admin/volume', (req, res) => {
  const v = parseFloat(req.body.value);
  if (isNaN(v) || v < 0 || v > 3) return res.json({ error: 'Volume entre 0 et 3' });
  state.audioVolume = v;
  broadcast({ type: 'volume_changed', volume: v });
  res.json({ ok: true, volume: v });
  log(`🔊 Volume: ${v}`);
});

// ── CHAT / KICK ──
app.post('/api/admin/chat', (req, res) => {
  broadcast({ type: 'chat', from: '🎮 ADMIN', text: req.body.text });
  res.json({ ok: true });
});

app.post('/api/admin/kick', (req, res) => {
  const p = findPlayer(req.body.target);
  if (!p) return res.json({ error: 'Joueur introuvable' });
  send(p.ws, { type: 'kicked' });
  p.ws.close();
  res.json({ ok: true });
});

// ── OVERLAY TROLL ──
app.post('/api/admin/overlay', (req, res) => {
  const { mediaType, url, text, target } = req.body;
  res.json(sendOverlay({ type: 'overlay', mediaType, url, text }, target));
});

app.post('/api/admin/overlayurl', (req, res) => {
  const { mediaType, url, target } = req.body;
  if (!url || !mediaType) return res.json({ error: 'url et mediaType requis' });
  res.json(sendOverlay({ type: 'overlay', mediaType, url }, target));
});

app.post('/api/admin/overlaytext', (req, res) => {
  const { text, target } = req.body;
  res.json(sendOverlay({ type: 'overlay', mediaType: 'text', text }, target));
});

app.post('/api/admin/overlayclear', (req, res) => {
  res.json(sendOverlay({ type: 'overlay', mediaType: 'clear' }, req.body.target));
});

// Effets visuels
app.post('/api/admin/trollshake', (req, res) => res.json(sendOverlay({ type: 'overlay', mediaType: 'shake' }, req.body.target)));
app.post('/api/admin/trollblind', (req, res) => res.json(sendOverlay({ type: 'overlay', mediaType: 'blind' }, req.body.target)));
app.post('/api/admin/trollzoom',  (req, res) => res.json(sendOverlay({ type: 'overlay', mediaType: 'zoom'  }, req.body.target)));
app.post('/api/admin/trollflip',  (req, res) => res.json(sendOverlay({ type: 'overlay', mediaType: 'flip'  }, req.body.target)));

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  const id = String(nextId++);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const name = (msg.name || 'Joueur').trim().slice(0, 20);
      state.players[id] = { id, ws, name, score: 0, ready: false };
      send(ws, { type: 'welcome', id, name, phase: state.phase });
      broadcastLobby();
      log(`✅ ${name} connecté`);
    }

    else if (msg.type === 'ready') {
      if (state.players[id]) {
        state.players[id].ready = true;
        broadcastLobby();
        const all = Object.values(state.players).every(p => p.ready);
        if (all && Object.keys(state.players).length >= 2) setTimeout(startGame, 1000);
      }
    }

    else if (msg.type === 'submit_audio') {
      if (state.phase === 'playing') {
        await receiveSubmission(id, msg.data, 'audio');
      }
    }

    else if (msg.type === 'submit_drawing') {
      if (state.phase === 'playing') {
        await receiveSubmission(id, msg.data, 'drawing');
      }
    }

    else if (msg.type === 'submit_void') {
      if (state.phase === 'playing') {
        await receiveSubmission(id, null, 'void', true);
      }
    }
  });

  ws.on('close', () => {
    const p = state.players[id];
    if (p) {
      log(`👋 ${p.name} déconnecté`);
      delete state.players[id];
      state.pending.delete(id);
      broadcastLobby();
      if (state.phase === 'playing' && state.pending.size === 0 && Object.keys(state.players).length > 0) {
        advanceRound();
      }
    }
  });
});

// ─── ADMIN CLI ────────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (line) => {
  const [cmd, ...args] = line.trim().split(' ');
  switch(cmd) {
    case 'start':   startGame(); break;
    case 'reset':   resetGame(); break;
    case 'skip':    stopTimer(); advanceRound(); break;
    case 'results': showResults(); break;
    case 'effect':  state.audioEffect = args[0] || 'robot'; log(`🎚️ Effet: ${state.audioEffect}`); break;
    case 'volume':  state.audioVolume = parseFloat(args[0]) || 1.0; log(`🔊 Volume: ${state.audioVolume}`); break;
    case 'rounds':  state.totalRounds = parseInt(args[0]) || 4; log(`🔢 Rounds: ${state.totalRounds}`); break;
    case 'timer':   state.timerDuration = parseInt(args[0]) || 30; log(`⏱ Timer: ${state.timerDuration}s`); break;
    case 'kick':    { const p = findPlayer(args.join(' ')); if(p){ send(p.ws,{type:'kicked'}); p.ws.close(); } break; }
    case 'players': log(playerList().map(p=>`${p.name}${p.ready?' ✓':''}`).join(', ')); break;
    default: log(`Commandes: start reset skip results effect volume rounds timer kick players`);
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log(`\n🎙️ VOICECHAIN SERVER on port ${PORT}`);
  log(`🔧 Admin: http://localhost:${PORT}/admin.html`);
  // Créer dossiers media si besoin
  for (const cat of ['images','videos','sounds']) {
    const dir = path.join(__dirname, 'public', 'media', cat);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
});
