/* Petit Bac — application principale */
(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const R = window.Rules;
  const D = window.PB_DATA;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    role: null,           // 'host' | 'guest'
    code: null,
    name: '',
    net: null,
    players: [],          // [{id, name, avatar, isHost}]
    categories: [],
    timer: 60,
    withTimer: true,
    hardLetters: false,
    numRounds: 5,
    stopMode: false,      // mode « premier arrivé stoppe la manche »
    usedLetters: new Set(),
    round: 0,             // index de manche courante (0-based)
    phase: 'home',        // home|setup|lobby|playing|reveal|vote|scores|final
    letter: '',
    dict: new Set(),
    answers: {},          // playerId -> [answers per category]
    entries: [],          // entrées de la manche courante
    myVotes: {},
    roundScores: [],
    totals: {},
    timerId: null,
    timeLeft: 0,
    finishedFlags: {}
  };

  // ---------- utilitaires UI ----------
  function show(id) {
    $$('.screen').forEach(el => el.classList.add('hidden'));
    const el = $(id);
    if (el) el.classList.remove('hidden');
    window.scrollTo({ top: 0 });
  }

  function toast(msg, ms) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms || 2200);
  }

  function myId() { return state.net ? state.net.peer.id : null; }

  function me() { return state.players.find(p => p.id === myId()); }

  function shareUrl() {
    const u = new URL(location.href);
    u.hash = '#room=' + state.code;
    return u.toString();
  }

  // ---------- chargement dictionnaire ----------
  function loadDict() {
    return fetch('assets/dict.txt').then(r => {
      if (!r.ok) throw new Error('dict-http');
      return r.text();
    }).then(txt => {
      txt.split('\n').forEach(w => { if (w) state.dict.add(w); });
    }).catch(() => {
      state.dict = new Set();
      toast('⚠️ Dictionnaire indisponible : la vérification auto est désactivée.');
    });
  }

  // listes par catégorie chargées à la demande (une seule fois)
  state.catSets = state.catSets || {};
  const CAT_FILES = { ville: 'assets/villes.txt', pays: 'assets/pays.txt', animal: 'assets/animaux.txt', prenom: 'assets/prenoms.txt', celebre: 'assets/celebrites.txt', film: 'assets/films.txt' };
  function loadCatSets(categories) {
    const keys = categories.map(c => window.PB_CATS.catKey(c));
    state.catKeys = keys;
    const jobs = [];
    keys.forEach(k => {
      if (!k) return;
      if (state.catSets[k]) return;
      if (window.PB_CATS.CATS[k] && window.PB_CATS.CATS[k].length) {
        state.catSets[k] = new Set(window.PB_CATS.CATS[k]);
        return;
      }
      const f = CAT_FILES[k];
      if (!f) return;
      jobs.push(fetch(f).then(r => r.text()).then(txt => {
        const s = new Set();
        txt.split('\n').forEach(w => { if (w) s.add(w); });
        state.catSets[k] = s;
      }).catch(() => {}));
    });
    return Promise.all(jobs);
  }

  // ---------- réseau ----------
  function send(msg) { if (state.net && !state.net.isHost) state.net.send(msg); }
  function bcast(msg) { if (state.net && state.net.isHost) state.net.broadcast(msg); }
  function sendOrBcast(msg) { if (state.net && state.net.isHost) state.net.broadcast(msg); else if (state.net) state.net.send(msg); }

  function hostData(from, msg) {
    switch (msg.type) {
      case 'hello': {
        const name = String(msg.name || 'Joueur').slice(0, 16);
        const existing = state.players.find(p => p.id === from);
        if (existing) {
          existing.name = name;
          state.net.sendTo(from, {
            type: 'welcome', you: existing, players: state.players, settings: currentSettings(),
            resume: state.phase !== 'lobby' && state.phase !== 'setup'
              ? { phase: state.phase, letter: state.letter, round: state.round + 1, entries: state.entries, answers: state.answers[from], myVotes: (state.myVotesHost || {})[from] }
              : null
          });
          bcast({ type: 'players', players: state.players });
          renderLobby();
          if (state.phase === 'playing') bcast({ type: 'finished', id: from, players: state.players });
          break;
        }
        if (state.players.length >= D.maxPlayers) { state.net.sendTo(from, { type: 'full' }); return; }
        if (state.phase !== 'lobby' && state.phase !== 'setup') { state.net.sendTo(from, { type: 'full', reason: 'partie-en-cours' }); return; }
        const avatar = D.avatars[state.players.length % D.avatars.length];
        const player = { id: from, name, avatar, isHost: false };
        state.players.push(player);
        state.net.sendTo(from, { type: 'welcome', you: player, players: state.players, settings: currentSettings() });
        bcast({ type: 'players', players: state.players });
        renderLobby();
        break;
      }
      case 'answers': {
        state.answers[from] = msg.answers;
        state.finishedFlags[from] = true;
        bcast({ type: 'finished', id: from, players: state.players });
        maybeEndRound();
        break;
      }
      case 'stop': {
        if (state.stopMode) endRoundByHost();
        break;
      }
      case 'chat': {
        bcast({ type: 'chat', from, text: String(msg.text || '').slice(0, 60) });
        break;
      }
      case 'vote': {
        state.myVotesHost = state.myVotesHost || {};
        state.myVotesHost[from] = msg.votes;
        bcast({ type: 'vote-progress', id: from });
        maybeFinishVotes();
        break;
      }
      case 'leave': {
        removePlayer(from);
        break;
      }
    }
  }

  function removePlayer(id) {
    state.players = state.players.filter(p => p.id !== id);
    delete state.answers[id];
    bcast({ type: 'players', players: state.players });
    renderLobby();
  }

  function currentSettings() {
    return {
      categories: state.categories,
      timer: state.timer,
      withTimer: state.withTimer,
      hardLetters: state.hardLetters,
      numRounds: state.numRounds,
      stopMode: state.stopMode
    };
  }

  function guestData(from, msg) {
    switch (msg.type) {
      case 'welcome': {
        state.players = msg.players;
        applySettings(msg.settings);
        toast('✅ Bienvenue ' + msg.you.name + ' !');
        if (msg.resume && msg.resume.phase === 'playing') {
          state.phase = 'playing';
          state.letter = msg.resume.letter;
          state.round = msg.resume.round - 1;
          state.answers = msg.resume.answers || {};
          renderAnswerForm();
          if (msg.resume.answers && state.answers[myId()]) fillMyAnswers(msg.resume.answers);
          show('#screen-play');
          $('#play-round').textContent = 'Manche ' + msg.resume.round + ' / ' + state.numRounds;
          $('#play-letter').textContent = state.letter;
          toast('🔁 Reconnexion réussie, manche en cours !');
          break;
        }
        if (msg.resume && msg.resume.phase === 'vote') {
          state.phase = 'vote';
          state.letter = msg.resume.letter;
          state.round = msg.resume.round - 1;
          state.entries = msg.resume.entries || [];
          state.myVotes = msg.resume.myVotes || {};
          showReveal(state.entries);
          toast('🔁 Reconnexion réussie, vote en cours !');
          break;
        }
        show('#screen-lobby');
        state.phase = 'lobby';
        renderLobby();
        break;
      }
      case 'full': {
        toast(msg.reason === 'partie-en-cours' ? '😢 Partie déjà commencée' : '😢 Partie pleine (' + D.maxPlayers + ' max)');
        show('#screen-home');
        break;
      }
      case 'players': {
        state.players = msg.players;
        if (state.phase === 'lobby') renderLobby();
        break;
      }
      case 'start': {
        applySettings(msg.settings);
        state.round = msg.round - 1;
        startRound(msg.letter, msg.round);
        break;
      }
      case 'reveal': {
        state.entries = msg.entries;
        state.round = msg.round - 1;
        showReveal(msg.entries);
        break;
      }
      case 'vote-result': {
        state.entries = msg.entries;
        showScores(msg.entries, msg.roundScore, msg.totals, false);
        break;
      }
      case 'final': {
        showFinal(msg.totals);
        break;
      }
      case 'finished': {
        state.finishedFlags[msg.id] = true;
        updatePlayStatus();
        break;
      }
      case 'chat': {
        addChatBubble(msg.from, msg.text);
        break;
      }
      case 'vote-progress': updateVoteProgress(); break;
      case 'kicked': toast('👋 L\'hôte a fermé la partie'); location.hash = ''; location.reload(); break;
    }
  }

  function applySettings(s) {
    if (!s) return;
    state.categories = s.categories;
    state.timer = s.timer;
    state.withTimer = s.withTimer;
    state.hardLetters = s.hardLetters;
    state.numRounds = s.numRounds;
    state.stopMode = !!s.stopMode;
  }

  // ---------- écrans ----------
  function initHome() {
    $('#btn-create').addEventListener('click', () => {
      const name = $('#host-name').value.trim() || 'Hôte';
      state.name = name.slice(0, 16);
      state.code = R.genRoomCode();
      state.role = 'host';
      openHost();
    });
    $('#btn-join').addEventListener('click', () => {
      const name = $('#guest-name').value.trim() || 'Joueur';
      const code = $('#room-code').value.trim().toUpperCase();
      if (!/^[A-Z2-9]{5}$/.test(code)) { toast('⚠️ Code à 5 caractères (ex: K7XQM)'); return; }
      state.name = name.slice(0, 16);
      state.code = code;
      state.role = 'guest';
      openGuest();
    });
    const m = location.hash.match(/room=([A-Z2-9]{5})/i);
    if (m) { $('#room-code').value = m[1].toUpperCase(); toast('🔗 Code de partie détecté : ' + m[1].toUpperCase()); }
  }

  function openHost() {
    show('#screen-loading');
    $('#loading-text').textContent = '🚀 Création de la partie…';
    state.net = window.PBNet.createHost(state.code, {
      onOpen: () => {
        const avatar = D.avatars[0];
        state.players = [{ id: myId(), name: state.name, avatar, isHost: true }];
        state.phase = 'setup';
        show('#screen-setup');
        renderCategoryPicker();
        $('#setup-code').textContent = state.code;
        $('#setup-link').textContent = shareUrl();
      },
      onGuestJoined: (id, conn) => { conn.send({ type: 'ping' }); },
      onData: (from, msg) => { if (msg.type !== 'ping') hostData(from, msg); },
      onGuestLeft: id => removePlayer(id),
      onError: err => {
        if (err && err.type === 'unavailable-id') { toast('⚠️ Code déjà pris, réessaie'); show('#screen-home'); }
        else toast('Erreur réseau: ' + (err && err.type ? err.type : err));
      }
    });
  }

  function openGuest() {
    show('#screen-loading');
    $('#loading-text').textContent = '🛰️ Connexion à la partie ' + state.code + '…';
    state.net = window.PBNet.joinAsGuest(state.code, state.name, {
      onOpen: () => { state.net.send({ type: 'hello', name: state.name }); },
      onData: guestData,
      onHostMissing: () => { toast('😢 Aucune partie avec ce code'); show('#screen-home'); },
      onClose: () => { toast('👋 Partie fermée par l\'hôte'); location.hash = ''; location.reload(); },
      onError: () => { toast('😢 Connexion impossible'); show('#screen-home'); }
    });
  }

  // ---------- configuration ----------
  function renderCategoryPicker() {
    const box = $('#cat-list');
    box.innerHTML = '';
    const chosen = new Set(state.categories);
    D.presetCategories.forEach(cat => {
      const lbl = document.createElement('label');
      lbl.className = 'cat-chip' + (chosen.has(cat) ? ' on' : '');
      lbl.innerHTML = '<input type="checkbox" ' + (chosen.has(cat) ? 'checked' : '') + '> <span>' + esc(cat) + '</span>';
      const cb = lbl.querySelector('input');
      cb.addEventListener('change', () => {
        lbl.classList.toggle('on', cb.checked);
        updateCatCount();
      });
      box.appendChild(lbl);
    });
    updateCatCount();
  }

  function selectedCats() {
    const custom = $$('#custom-cats .custom-cat').map(el => el.dataset.cat);
    const presets = $$('#cat-list .cat-chip input:checked').map(cb => cb.parentElement.querySelector('span').textContent);
    return presets.concat(custom);
  }

  function updateCatCount() {
    const n = selectedCats().length;
    const el = $('#cat-count');
    el.textContent = n + ' / ' + D.maxCategories + ' catégorie' + (n > 1 ? 's' : '');
    el.style.color = (n >= D.minCategories && n <= D.maxCategories) ? 'var(--good)' : 'var(--bad)';
  }

  function initSetup() {
    $('#btn-add-cat').addEventListener('click', () => {
      const inp = $('#custom-cat-input');
      const v = inp.value.trim();
      if (!v) return;
      if (selectedCats().length >= D.maxCategories) { toast('⚠️ Max ' + D.maxCategories + ' catégories'); return; }
      if (selectedCats().some(c => c.toLowerCase() === v.toLowerCase())) { toast('⚠️ Déjà dans la liste'); return; }
      const chip = document.createElement('span');
      chip.className = 'cat-chip on custom-cat';
      chip.dataset.cat = v.slice(0, 24);
      chip.innerHTML = '<span>' + esc(v.slice(0, 24)) + '</span> <button type="button" class="btn small ghost" style="padding:2px 8px">✕</button>';
      chip.querySelector('button').addEventListener('click', () => { chip.remove(); updateCatCount(); });
      $('#custom-cats').appendChild(chip);
      inp.value = '';
      updateCatCount();
    });
    $('#btn-start-game').addEventListener('click', () => {
      const cats = selectedCats();
      if (cats.length < D.minCategories) { toast('⚠️ Choisis au moins ' + D.minCategories + ' catégories'); return; }
      if (state.players.length < 2) { toast('⚠️ Attends au moins 1 autre joueur (code ' + state.code + ')'); return; }
      applyLocalSettings();
      state.phase = 'lobby';
      show('#screen-lobby');
      renderLobby();
      bcast({ type: 'players', players: state.players });
    });
    $('#btn-copy-link').addEventListener('click', () => {
      const url = shareUrl();
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('🔗 Lien copié !'));
      else toast(url);
    });
    $('#btn-print').addEventListener('click', () => { window.print(); });
  }

  function applyLocalSettings() {
    state.categories = selectedCats();
    state.timer = Math.max(15, Math.min(300, parseInt($('#opt-timer').value, 10) || D.defaultTimer));
    state.withTimer = $('#opt-with-timer').checked;
    state.hardLetters = $('#opt-hard').checked;
    state.numRounds = Math.max(1, Math.min(10, parseInt($('#opt-rounds').value, 10) || 5));
    state.stopMode = $('#opt-stop').checked;
  }

  // ---------- lobby ----------
  function renderLobby() {
    const list = $('#lobby-players');
    list.innerHTML = '';
    state.players.forEach(p => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="avatar">' + p.avatar + '</span> <span>' + esc(p.name) + '</span>' + (p.isHost ? '<span class="host-tag">HÔTE</span>' : '');
      list.appendChild(li);
    });
    $('#lobby-code').textContent = state.code;
    $('#lobby-count').textContent = state.players.length + ' / ' + D.maxPlayers + ' joueurs';
    const canStart = state.role === 'host' && state.players.length >= 2;
    const btn = $('#btn-launch');
    if (btn) { btn.disabled = !canStart; btn.textContent = canStart ? '🚀 Lancer la partie (' + state.numRounds + ' manches)' : '⏳ En attente de joueurs…'; }
    const lbl = $('#waiting-note');
    if (lbl) lbl.textContent = state.role === 'host'
      ? 'Partage le code ou le lien pour inviter des amis !'
      : 'En attente du lancement par l\'hôte…';
  }

  function initLobby() {
    $('#btn-launch').addEventListener('click', () => {
      if (state.role !== 'host') return;
      applyLocalSettings();
      state.round = 0;
      state.roundScores = [];
      state.totals = {};
      state.usedLetters = new Set();
      const letter = R.pickLetter(Math.random, state.hardLetters, state.usedLetters);
      state.usedLetters.add(letter);
      bcast({ type: 'start', letter, round: 1, settings: currentSettings() });
      startRound(letter, 1);
    });
    $('#btn-copy-lobby').addEventListener('click', () => {
      if (navigator.clipboard) navigator.clipboard.writeText(shareUrl()).then(() => toast('🔗 Lien copié !'));
    });
    $('#btn-print-lobby').addEventListener('click', () => window.print());
  }

  // ---------- manche ----------
  function startRound(letter, roundNo) {
    state.phase = 'playing';
    state.letter = letter;
    state.usedLetters.add(letter);
    state.entries = [];
    state.answers = {};
    state.myVotes = {};
    state.finishedFlags = {};
    if (state.role === 'host') { state.myVotesHost = {}; }
    stopTimer();
    loadCatSets(state.categories);
    $('#play-round').textContent = 'Manche ' + roundNo + ' / ' + state.numRounds;
    $('#play-letter').textContent = letter;
    const timerEl = $('#play-timer');
    if (state.withTimer) {
      state.timeLeft = state.timer;
      timerEl.textContent = '⏱️ ' + state.timeLeft + ' s';
      timerEl.classList.remove('hidden');
      state.timerId = setInterval(() => {
        state.timeLeft--;
        timerEl.textContent = '⏱️ ' + Math.max(0, state.timeLeft) + ' s';
        if (state.timeLeft <= 0) endRoundByHost();
      }, 1000);
    } else {
      timerEl.classList.add('hidden');
    }
    renderAnswerForm();
    show('#screen-play');
    updatePlayStatus();
  }

  function renderAnswerForm() {
    const box = $('#answers-form');
    box.innerHTML = '';
    state.categories.forEach((cat, i) => {
      const row = document.createElement('div');
      row.className = 'answer-row';
      row.innerHTML = '<div class="cat-label"><span>🪐 ' + esc(cat) + '</span><span class="chk" data-i="' + i + '"></span></div>' +
        '<input type="text" maxlength="40" autocomplete="off" autocapitalize="off" placeholder="Un mot en « ' + state.letter.toUpperCase() + ' »…" data-i="' + i + '">';
      box.appendChild(row);
    });
    const inputs = $$('#answers-form input');
    inputs.forEach(inp => {
      inp.addEventListener('input', () => liveCheck(inp));
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const n = inputs[inputs.indexOf(inp) + 1]; if (n) n.focus(); } });
    });
  }

  function liveCheck(inp) {
    const i = parseInt(inp.dataset.i, 10);
    const chk = document.querySelector('.chk[data-i="' + i + '"]');
    const v = inp.value.trim();
    if (!v) { chk.textContent = ''; chk.className = 'chk'; return; }
    if (!R.startsWithLetter(v, state.letter)) { chk.textContent = '❌ pas de « ' + state.letter.toUpperCase() + ' »'; chk.className = 'chk status-ko'; return; }
    const key = state.catKeys ? state.catKeys[i] : null;
    const catRes = R.categoryCheck(v, key, state.catSets);
    if (catRes === false) { chk.textContent = '❌ hors catégorie « ' + state.categories[i] + ' »'; chk.className = 'chk status-ko'; return; }
    if (state.dict.size === 0) { chk.textContent = '❓'; chk.className = 'chk'; return; }
    if (R.isInDictionary(v, state.dict)) {
      chk.textContent = catRes === true ? '✅ mot connu, bonne catégorie' : '✅ mot connu';
      chk.className = 'chk status-ok';
    } else {
      chk.textContent = '⚠️ inconnu du dictionnaire (sera voté)';
      chk.className = 'chk status-ko';
    }
  }

  function updatePlayStatus() {
    const el = $('#play-status');
    if (!el) return;
    const done = state.players.filter(p => state.finishedFlags[p.id]);
    const n = done.length;
    const names = done.map(p => p.avatar + ' ' + p.name).join(' ');
    el.textContent = n + ' / ' + state.players.length + ' ont terminé' + (names ? ' : ' + names : '');
  }

  function fillMyAnswers(answers) {
    const inputs = $$('#answers-form input');
    inputs.forEach((inp, i) => { inp.value = answers[i] || ''; liveCheck(inp); });
  }

  function updateLobbyWaiting() { /* conservé pour compatibilité */ }

  function collectMyAnswers() {
    const inputs = $$('#answers-form input');
    return inputs.map(inp => inp.value.trim());
  }

  function submitAnswers() {
    if (state.phase !== 'playing') return;
    stopTimer();
    const answers = collectMyAnswers();
    if (state.role === 'host') {
      state.answers[myId()] = answers;
      state.finishedFlags[myId()] = true;
      bcast({ type: 'finished', id: myId(), players: state.players });
      maybeEndRound();
    } else {
      send({ type: 'answers', answers });
      show('#screen-waiting');
      $('#waiting-text').textContent = '✨ Tes réponses sont envoyées ! En attente des autres…';
    }
    updatePlayStatus();
  }

  function stopRound() {
    if (state.phase !== 'playing') return;
    if (state.role === 'host') endRoundByHost();
    else send({ type: 'stop' });
    toast('🛑 Stop ! La manche s\'arrête.');
  }

  function maybeEndRound() {
    if (state.role !== 'host' || state.phase !== 'playing') return;
    const allDone = state.players.every(p => state.finishedFlags[p.id]);
    if (allDone || (!state.withTimer && Object.keys(state.finishedFlags).length >= state.players.length)) endRoundByHost();
  }

  function endRoundByHost() {
    if (state.role !== 'host' || state.phase !== 'playing') return;
    stopTimer();
    state.phase = 'reveal';
    const entries = R.buildRoundEntries(
      state.players.map(p => ({ playerId: p.id, answers: state.answers[p.id] || [] })),
      state.categories, state.letter, state.dict, state.catSets, state.catKeys
    );
    state.entries = entries;
    bcast({ type: 'reveal', entries, round: state.round + 1 });
    sfx('start');
    showReveal(entries);
  }

  // ---------- révélation + vote ----------
  function showReveal(entries) {
    state.phase = 'vote';
    const box = $('#vote-list');
    box.innerHTML = '';
    if (!entries.length) { box.innerHTML = '<p>Aucune réponse 😅</p>'; }
    entries.forEach(e => {
      const row = document.createElement('div');
      row.className = 'card';
      row.style.padding = '12px';
      row.style.marginBottom = '10px';
      const who = e.players.map(pid => { const p = state.players.find(x => x.id === pid); return p ? p.name : '?'; }).join(', ');
      const dupBadge = e.players.length >= 2 ? '<span class="badge dup">doublon ×' + e.players.length + ' → 1 pt</span>' : '';
      let autoBadge;
      if (e.catCheck === false) autoBadge = '<span class="badge rejected">❌ hors catégorie « ' + esc(e.category) + ' » → vote</span>';
      else if (!e.letterOk) autoBadge = '<span class="badge rejected">❌ mauvaise lettre → vote</span>';
      else if (e.auto) autoBadge = '<span class="badge auto">auto ✅' + (e.catCheck === true ? ' (catégorie ok)' : '') + '</span>';
      else autoBadge = '<span class="badge rejected">hors dictionnaire → vote</span>';
      row.innerHTML =
        '<div style="font-weight:800">' + esc(e.category) + ' : « ' + esc(e.word) + ' »</div>' +
        '<div style="font-size:.85rem;color:#7a739e">' + esc(who) + dupBadge + autoBadge + '</div>' +
        '<div class="vote-btns" style="margin-top:8px">' +
        '<button class="btn small up" data-id="' + e.id + '" data-v="1">👍 Valide</button>' +
        '<button class="btn small down" data-id="' + e.id + '" data-v="0">👎 Refuse</button>' +
        '<span style="margin-left:auto;font-size:.85rem" class="vcount" data-id="' + e.id + '"></span></div>';
      box.appendChild(row);
    });
    $$('#vote-list .vote-btns .btn').forEach(b => {
      b.addEventListener('click', () => {
        const id = b.dataset.id;
        const v = b.dataset.v === '1';
        if (state.myVotes[id] === v) delete state.myVotes[id];
        else state.myVotes[id] = v;
        refreshVoteButtons();
        if (state.role === 'host') {
          state.myVotesHost[myId()] = state.myVotes;
          bcast({ type: 'vote-progress', id: myId() });
          maybeFinishVotes();
        } else {
          send({ type: 'vote', votes: state.myVotes });
        }
      });
    });
    const submit = $('#btn-submit-votes');
    submit.classList.remove('hidden');
    updateVoteProgress();
    show('#screen-vote');
    $('#vote-round').textContent = 'Manche ' + (state.round + 1) + ' — lettre « ' + state.letter.toUpperCase() + ' »';
  }

  function refreshVoteButtons() {
    $$('#vote-list .vote-btns .btn').forEach(b => {
      const id = b.dataset.id;
      const v = b.dataset.v === '1';
      b.classList.toggle('on', state.myVotes[id] === v);
    });
  }

  function initVote() {
    $('#btn-submit-votes').addEventListener('click', () => {
      if (state.role === 'host') {
        state.myVotesHost[myId()] = state.myVotes;
        bcast({ type: 'vote-progress', id: myId() });
        maybeFinishVotes();
      } else {
        send({ type: 'vote', votes: state.myVotes });
        $('#btn-submit-votes').classList.add('hidden');
        toast('🗳️ Votes envoyés !');
      }
    });
  }

  function allVotesCollected() {
    const votes = state.myVotesHost || {};
    return state.players.every(p => votes[p.id]);
  }

  function updateVoteProgress() {
    const votes = state.myVotesHost || {};
    const done = state.players.filter(p => votes[p.id]).length;
    const el = $('#vote-progress');
    if (el) el.textContent = '🗳️ ' + done + ' / ' + state.players.length + ' joueurs ont voté — on attend tout le monde…';
  }

  function maybeFinishVotes() {
    if (state.role !== 'host' || state.phase !== 'vote') return;
    if (!allVotesCollected()) {
      updateVoteProgress();
      return;
    }
    updateVoteProgress();
    state.phase = 'scores';
    const votesMap = state.myVotesHost;
    const entries = R.applyVotes(state.entries, state.players.map(p => votesMap[p.id] || {}));
    const roundScore = R.scoreRound(entries, state.players.map(p => p.id));
    state.roundScores.push(roundScore);
    state.totals = R.totalScores(state.roundScores, state.players.map(p => p.id));
    bcast({ type: 'vote-result', entries, roundScore, totals: state.totals, round: state.round + 1 });
    const anyRejected = entries.some(e => !e.accepted);
    sfx(anyRejected ? 'bad' : 'good');
    showScores(entries, roundScore, state.totals, true);
  }

  // ---------- scores ----------
  function showScores(entries, roundScore, totals, isHostView) {
    state.phase = 'scores';
    $('#scores-round').textContent = 'Résultats — manche ' + (state.round + 1) + ' (lettre « ' + state.letter.toUpperCase() + ' »)';
    const det = $('#score-detail');
    det.innerHTML = '';
    const byCat = {};
    entries.forEach(e => {
      if (!byCat[e.category]) byCat[e.category] = [];
      byCat[e.category].push(e);
    });
    Object.keys(byCat).forEach(cat => {
      const h = document.createElement('div');
      h.style.fontWeight = '800';
      h.style.margin = '10px 0 4px';
      h.textContent = '🪐 ' + cat;
      det.appendChild(h);
      byCat[cat].forEach(e => {
        const line = document.createElement('div');
        line.className = 'score-line';
        const who = e.players.map(pid => { const p = state.players.find(x => x.id === pid); return p ? p.name : '?'; }).join(', ');
        line.innerHTML = '<span>« ' + esc(e.word) + ' » — ' + esc(who) + '</span>' +
          (e.accepted ? '<span class="pts">+' + (e.points || 0) + '</span>' : '<span class="pts" style="color:var(--bad)">0</span>') +
          (e.players.length >= 2 ? ' <span class="badge dup">doublon</span>' : '') +
          (!e.accepted ? ' <span class="badge rejected">refusé</span>' : '');
        det.appendChild(line);
      });
    });
    renderTotals(totals);
    const next = $('#btn-next-round');
    if (state.role === 'host') {
      next.classList.remove('hidden');
      const last = state.round + 1 >= state.numRounds;
      next.textContent = last ? '🏁 Voir le classement final' : '➡️ Manche suivante';
      next.onclick = () => {
        if (last) {
          bcast({ type: 'final', totals: state.totals });
          showFinal(state.totals);
        } else {
          const letter = R.pickLetter(Math.random, state.hardLetters, state.usedLetters);
          bcast({ type: 'start', letter, round: state.round + 2, settings: currentSettings() });
          startRound(letter, state.round + 2);
        }
      };
    } else {
      next.classList.add('hidden');
    }
    show('#screen-scores');
  }

  function renderTotals(totals, targetSel) {
    const box = $(targetSel || '#score-totals');
    box.innerHTML = '';
    const ranking = state.players.map(p => ({ p, pts: totals[p.id] || 0 }))
      .sort((a, b) => b.pts - a.pts);
    const best = ranking.length ? ranking[0].pts : 0;
    ranking.forEach(r => {
      const line = document.createElement('div');
      line.className = 'score-line' + (r.pts === best && best > 0 ? ' winner' : '');
      line.innerHTML = '<span class="avatar">' + r.p.avatar + '</span><span>' + esc(r.p.name) + '</span><span class="pts">' + r.pts + ' pts</span>';
      box.appendChild(line);
    });
  }

  function showFinal(totals) {
    state.phase = 'final';
    renderTotals(totals, '#score-totals-final-list');
    const box = $('#final-winners');
    box.innerHTML = '';
    const ranking = state.players.map(p => ({ p, pts: totals[p.id] || 0 })).sort((a, b) => b.pts - a.pts);
    const best = ranking.length ? ranking[0].pts : 0;
    const winners = ranking.filter(r => r.pts === best);
    box.innerHTML = winners.map(r => '<div style="font-size:1.4rem;font-weight:800">🏆 ' + esc(r.p.name) + ' — ' + r.pts + ' pts</div>').join('');
    sfx('win');
    confetti();
    const again = $('#btn-again');
    if (state.role === 'host') {
      again.classList.remove('hidden');
      again.onclick = () => {
        state.round = 0; state.roundScores = []; state.totals = {}; state.usedLetters = new Set();
        const letter = R.pickLetter(Math.random, state.hardLetters, state.usedLetters);
        bcast({ type: 'start', letter, round: 1, settings: currentSettings() });
        startRound(letter, 1);
      };
    } else again.classList.add('hidden');
    show('#screen-final');
  }

  function stopTimer() { if (state.timerId) { clearInterval(state.timerId); state.timerId = null; } }

  // ---------- impression ----------
  function buildPrintSheet() {
    const sheet = $('#print-sheet');
    const cats = state.categories.length ? state.categories : ['Prénom', 'Animal', 'Fruit ou légume', 'Ville ou pays', 'Objet', 'Métier', 'Star ou personnage', 'Film ou série'];
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const head = '<tr><th class="pc">Catégorie</th>' + letters.map(l => '<th class="pl">' + l + '</th>').join('') + '<th class="pp">POINTS</th></tr>';
    const rows = cats.map(c => '<tr><td class="pc">' + esc(c) + '</td>' + letters.map(() => '<td class="pw"></td>').join('') + '<td class="pp"></td></tr>').join('');
    sheet.innerHTML =
      '<div class="print-sheet">' +
      '<h1>🚀 Petit Bac</h1>' +
      '<p class="pin">Nom du joueur : <span class="pline">____________________</span> &nbsp;•&nbsp; Nombre de catégories : ' + cats.length + '</p>' +
      '<table class="ptable"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>' +
      '<p class="pin small">Barème : mot unique = 2 pts • mot partagé (doublon) = 1 pt • case vide / hors sujet / refusé = 0 pt &nbsp;•&nbsp; POINTAGE FINAL : ________</p>' +
      '</div>';
  }

  // ---------- chat rapide ----------
  const CHAT_PHRASES = ['🛑 Stop !', '👏 Bravo !', '⏳ Attends-moi…', '😂 Trop fort', '🤔 Hmm…', '🚀 Allez !'];
  function addChatBubble(fromId, text) {
    const p = state.players.find(x => x.id === fromId);
    const name = p ? p.name : 'quelqu\'un';
    $$('.chat-box').forEach(box => {
      const line = document.createElement('div');
      line.className = 'chat-line';
      line.textContent = name + ' : ' + text;
      box.appendChild(line);
      box.scrollTop = box.scrollHeight;
    });
    sfx('chat');
  }
  function initChat() {
    $$('.chat-send').forEach(zone => {
      CHAT_PHRASES.forEach(ph => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn small ghost chat-phrase';
        b.textContent = ph;
        b.addEventListener('click', () => {
          sendOrBcast({ type: 'chat', text: ph });
          addChatBubble(myId(), ph);
        });
        zone.appendChild(b);
      });
    });
  }

  // ---------- sons (WebAudio, zéro fichier) ----------
  let audioCtx = null;
  let muted = false;
  function sfx(kind) {
    if (muted) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime;
      const notes = {
        chat: [660, 0.07],
        good: [523, 0.09, 784, 0.12],
        bad: [220, 0.15],
        win: [523, 0.1, 659, 0.1, 784, 0.1, 1046, 0.25],
        start: [392, 0.08, 523, 0.12]
      }[kind] || [440, 0.1];
      let cursor = t;
      for (let i = 0; i < notes.length; i += 2) {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.frequency.value = notes[i];
        o.type = 'triangle';
        g.gain.setValueAtTime(0.12, cursor);
        g.gain.exponentialRampToValueAtTime(0.001, cursor + notes[i + 1]);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(cursor); o.stop(cursor + notes[i + 1]);
        cursor += notes[i + 1];
      }
    } catch (e) {}
  }

  // ---------- confettis ----------
  function confetti() {
    const box = $('#confetti');
    if (!box) return;
    const colors = ['#ffb347', '#7c5cff', '#2ecc71', '#ff5c7a', '#4fc3f7', '#ffe066'];
    for (let i = 0; i < 80; i++) {
      const c = document.createElement('div');
      c.className = 'confetti';
      c.style.left = Math.random() * 100 + 'vw';
      c.style.background = colors[i % colors.length];
      c.style.animationDelay = (Math.random() * 0.6) + 's';
      c.style.transform = 'rotate(' + Math.random() * 360 + 'deg)';
      box.appendChild(c);
      setTimeout(() => c.remove(), 3200);
    }
  }

  // ---------- thèmes ----------
  const THEMES = ['espace', 'jungle', 'mer', 'bonbon', 'xp'];
  function applyTheme(name) {
    document.body.dataset.theme = THEMES.indexOf(name) >= 0 ? name : 'espace';
    $$('.theme-chip').forEach(c => c.classList.toggle('on', c.dataset.theme === document.body.dataset.theme));
    try { localStorage.setItem('pb-theme', document.body.dataset.theme); } catch (e) {}
  }
  function initTheme() {
    $$('.theme-chip').forEach(c => c.addEventListener('click', () => applyTheme(c.dataset.theme)));
    let saved = 'espace';
    try { saved = localStorage.getItem('pb-theme') || 'espace'; } catch (e) {}
    applyTheme(saved);
  }

  // ---------- partage natif ----------
  function shareInvite() {
    const url = shareUrl();
    const text = '🚀 Rejoins ma partie de Petit Bac ! Code ' + state.code + ' : ' + url;
    if (navigator.share) {
      navigator.share({ title: 'Petit Bac', text, url }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => toast('🔗 Invitation copiée !'));
    } else toast(text);
  }

  // ---------- boot ----------
  function init() {
    buildPrintSheet();
    initTheme();
    initHome();
    initSetup();
    initLobby();
    initVote();
    initChat();
    $('#btn-submit-answers').addEventListener('click', submitAnswers);
    const stopBtn = $('#btn-stop-round');
    if (stopBtn) stopBtn.addEventListener('click', stopRound);
    $('#btn-print-play').addEventListener('click', () => { buildPrintSheet(); window.print(); });
    $('#btn-quit').addEventListener('click', () => { if (confirm('Quitter la partie ?')) { location.hash = ''; location.reload(); } });
    $('#btn-mute').addEventListener('click', () => {
      muted = !muted;
      $('#btn-mute').textContent = muted ? '🔇 Son off' : '🔊 Son on';
    });
    $$('.btn-share').forEach(b => b.addEventListener('click', shareInvite));
    loadDict();
    show('#screen-home');
    sfx && setTimeout(() => sfx('start'), 300);
    window.addEventListener('beforeunload', () => { if (state.net) { sendOrBcast({ type: 'leave' }); } });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
