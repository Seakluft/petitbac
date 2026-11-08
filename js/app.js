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
    try { window.scrollTo({ top: 0 }); } catch (e) {}
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
  const CAT_FILES = { ville: 'assets/villes.txt', pays: 'assets/pays.txt', animal: 'assets/animaux.txt', prenom: 'assets/prenoms.txt', celebre: 'assets/celebrites.txt', film: 'assets/films.txt', geographie: 'assets/geographie.txt', patronyme: 'assets/patronymes.txt' };
  function flattenKeys(k) { return Array.isArray(k) ? k : (k ? [k] : []); }
  function loadCatSets(categories) {
    const keys = state.catKeys && state.catKeys.length === categories.length && state.catKeys.every(k => k)
      ? state.catKeys
      : categories.map(c => window.PB_CATS.catKey(c));
    state.catKeys = keys;
    const jobs = [];
    keys.forEach(k => {
      flattenKeys(k).forEach(single => {
        if (!single) return;
        // inline d'abord (synchrone), puis le gros fichier .txt vient EN PLUS (union)
        if (!state.catSets[single]) state.catSets[single] = new Set();
        if (window.PB_CATS.CATS[single] && window.PB_CATS.CATS[single].length) {
          window.PB_CATS.CATS[single].forEach(w => state.catSets[single].add(w));
        }
        const f = CAT_FILES[single];
        if (!f) return;
        if (state.catSets[single].fromFile) return; // déjà chargé
        jobs.push(fetch(f).then(r => r.text()).then(txt => {
          const s = state.catSets[single];
          txt.split('\n').forEach(w => { if (w) s.add(w); });
          s.fromFile = true;
        }).catch(() => {}));
      });
    });
    return Promise.all(jobs);
  }

  // ---------- réseau ----------
  const NETLOG = [];
  function netlog(dir, msg) {
    try {
      NETLOG.push({ t: Date.now(), dir, type: msg.type, from: (msg.from || '').slice(-10) });
      if (NETLOG.length > 30) NETLOG.shift();
      if (window.__debugOn) renderDebug();
    } catch (e) {}
  }
  function send(msg) { netlog('↗', msg); if (state.net && !state.net.isHost) state.net.send(msg); }
  function bcast(msg) { netlog('↗', msg); if (state.net && state.net.isHost) state.net.broadcast(msg); }
  function sendOrBcast(msg) { netlog('↗', msg); if (state.net && state.net.isHost) state.net.broadcast(msg); else if (state.net) state.net.send(msg); }

  function hostData(from, msg) {
    netlog('↙', msg);
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
        if (state.phase === 'playing') {
          maybeEndRound();
        } else if (state.phase === 'reveal' || state.phase === 'vote') {
          // réponse tardive (STOP arrivé avant) : on recalcule et on renvoie le reveal
          const entries = R.buildRoundEntries(
            state.players.map(p => ({ playerId: p.id, answers: state.answers[p.id] || [] })),
            state.categories, state.letter, state.dict, state.catSets, state.catKeys
          );
          if ((state.entries || []).length === 0 && entries.length > 0) {
            toast('📥 ' + (state.players.find(p => p.id === from) || {}).name + ' a rattrapé sa manche !');
          }
          state.entries = entries;
          bcast({ type: 'reveal', entries, round: state.round + 1 });
        }
        break;
      }
      case 'vote-sent': {
        state.finishedFlags['vote:' + from] = true;
        maybeFinishVotes();
        break;
      }
      case 'stopping': break;
      case 'stop': {
        if (state.phase !== 'playing') break;
        if (state.stopMode) {
          const p = state.players.find(x => x.id === from);
          toast('🛑 ' + (p ? p.name : 'Un joueur') + ' a stoppé la manche !');
          bcast({ type: 'stopping', by: from });
          endRoundByHost();
        }
        break;
      }
      case 'chat': {
        bcast({ type: 'chat', from, text: String(msg.text || '').slice(0, 60) });
        break;
      }
      case 'avatar': {
        const p = state.players.find(x => x.id === from);
        if (p) { p.avatar = String(msg.avatar || '🚀').slice(0, 4); bcast({ type: 'players', players: state.players }); renderLobby(); }
        break;
      }
      case 'vote': {
        state.myVotesHost = state.myVotesHost || {};
        state.myVotesHost[from] = msg.votes;
        bcast({ type: 'vote-progress', id: from });
        break;
      }
      case 'votes-done': {
        state.myVotesHost = state.myVotesHost || {};
        state.myVotesHost[from] = msg.votes;
        state.finishedFlags['vote:' + from] = true;
        state.net.sendTo(from, { type: 'vote-ack' });
        bcast({ type: 'vote-progress', id: from });
        maybeFinishVotes();
        break;
      }
      case 'vote-ack': break; // émis par l'hôte, consommé par l'invité : ignorer côté hôte
      case 'leave': {
        removePlayer(from);
        break;
      }
    }
  }

  function removePlayer(id) {
    // en pleine partie on garde le joueur (reconnexion possible), on le marque juste offline
    if (state.phase === 'playing' || state.phase === 'vote' || state.phase === 'scores' || state.phase === 'reveal' || state.phase === 'final') {
      const p = state.players.find(x => x.id === id);
      if (p) { p.offline = true; bcast({ type: 'players', players: state.players }); renderLobby(); }
      return;
    }
    state.players = state.players.filter(p => p.id !== id);
    delete state.answers[id];
    bcast({ type: 'players', players: state.players });
    renderLobby();
  }

  function currentSettings() {
    return {
      categories: state.categories,
      catKeys: state.catKeys || state.categories.map(c => window.PB_CATS.catKey(c)),
      timer: state.timer,
      withTimer: state.withTimer,
      hardLetters: state.hardLetters,
      numRounds: state.numRounds,
      stopMode: state.stopMode
    };
  }

  function guestData(from, msg) {
    netlog('↙', msg);
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
        // reconnexion en pleine manche : on restaure ce que le joueur avait tapé avant
        const saved = loadMyAnswers();
        if (saved && saved.some(v => v)) {
          fillMyAnswers(saved);
          toast('✍️ Tes réponses de la manche ont été restaurées');
        }
        break;
      }
      case 'reveal': {
        stopTimer();
        // réponse tardive : si je n'ai pas encore soumis, j'envoie mes champs actuels maintenant
        if (!state.finishedFlags[myId()]) {
          const answers = collectMyAnswers();
          netlog('↗', { type: 'answers(late)', answers });
          send({ type: 'answers', answers });
          state.finishedFlags[myId()] = true;
        }
        const keepVotes = state.phase === 'vote' ? (state.myVotes || {}) : null;
        state.entries = msg.entries || [];
        state.round = msg.round - 1;
        state.phase = 'vote';
        showReveal(state.entries, keepVotes);
        break;
      }
      case 'rejoin-play': {
        // l'hôte prévient qu'une manche est en cours : on reste sur l'écran de jeu
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
        if (state.phase === 'playing') {
          updatePlayStatus();
          const ws = $('#waiting-status');
          if (ws) {
            const n = state.players.filter(p => state.finishedFlags[p.id]).length;
            ws.textContent = '🚀 ' + n + ' / ' + state.players.length + ' ont terminé';
          }
        }
        break;
      }
      case 'chat': {
        addChatBubble(msg.from, msg.text);
        break;
      }
      case 'vote-progress': updateVoteProgress(); break;
      case 'vote-ack': toast('🗳️ L\'hôte a bien reçu tes votes'); break;
      case 'stopping': {
        toast('🛑 Stop ! Tes réponses partent maintenant');
        if (!state.finishedFlags[myId()]) {
          const answers = collectMyAnswers();
          netlog('↗', { type: 'answers(on-stop)', answers });
          send({ type: 'answers', answers });
          state.finishedFlags[myId()] = true;
        }
        break;
      }
      case 'kicked': toast('👋 L\'hôte a fermé la partie'); location.hash = ''; location.reload(); break;
    }
  }

  function applySettings(s) {
    if (!s) return;
    state.categories = s.categories;
    if (s.catKeys) state.catKeys = s.catKeys;
    state.timer = s.timer;
    state.withTimer = s.withTimer;
    state.hardLetters = s.hardLetters;
    state.numRounds = s.numRounds;
    state.stopMode = !!s.stopMode;
  }

  // ---------- écrans ----------
  function initHome() {
    $('#btn-create').addEventListener('click', () => {
      const name = $('#home-name').value.trim() || 'Hôte';
      try { localStorage.setItem('pb-name', name); } catch (e) {}
      state.name = name.slice(0, 16);
      state.code = R.genRoomCode();
      state.role = 'host';
      openHost();
    });
    $('#btn-join').addEventListener('click', () => {
      const name = $('#home-name').value.trim() || 'Joueur';
      try { localStorage.setItem('pb-name', name); } catch (e) {}
      const code = $('#room-code').value.trim().toUpperCase();
      if (!/^[A-Z2-9]{5}$/.test(code)) { toast('⚠️ Code à 5 caractères (ex: K7XQM)'); return; }
      state.name = name.slice(0, 16);
      state.code = code;
      state.role = 'guest';
      openGuest();
    });
    const m = location.hash.match(/room=([A-Z2-9]{5})/i);
    if (m) {
      $('#room-code').value = m[1].toUpperCase();
      toast('🔗 Code de partie détecté : ' + m[1].toUpperCase());
      const lastName = (() => { try { return localStorage.getItem('pb-name') || ''; } catch (e) { return ''; } })();
      if (lastName) {
        $('#home-name').value = lastName;
        setTimeout(() => { try { $('#btn-join').click(); } catch (e) {} }, 600);
        toast('🔁 Reconnexion à la partie ' + m[1].toUpperCase() + '…');
      }
    }
    $('#btn-howto').addEventListener('click', () => $('#modal-howto').classList.remove('hidden'));
    $('#btn-close-howto').addEventListener('click', () => $('#modal-howto').classList.add('hidden'));
    $('#modal-howto').addEventListener('click', e => { if (e.target.id === 'modal-howto') e.target.classList.add('hidden'); });
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
    let hostGoneCount = 0;
    state.net = window.PBNet.joinAsGuest(state.code, state.name, {
      onOpen: () => { state.net.send({ type: 'hello', name: state.name }); updateConnBadge(); },
      onData: guestData,
      onSent: (msg, tries) => { if (tries > 1) toast('📨 Renvoi de tes données (' + tries + 'ᵉ essai)…'); },
      onQueued: () => { toast('📡 Connexion instable — ton envoi partira dès que ça revient'); },
      onGiveUp: () => { toast('⚠️ Envoi impossible pour l\'instant — appuie à nouveau sur le bouton'); },
      onConnLost: () => { updateConnBadge(); toast('📱 Connexion perdue — reconnexion automatique…'); },
      onHostGone: () => {
        hostGoneCount++;
        if (hostGoneCount > 15) { toast('👋 L\'hôte s\'est déconnecté'); location.hash = ''; location.reload(); }
        else { updateConnBadge(); toast('⚠️ L\'hôte est injoignable — nouvelle tentative…'); }
      },
      onHostMissing: () => { toast('😢 Aucune partie avec ce code'); show('#screen-home'); },
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

  // groupes personnalisés : pour chaque catégorie perso, choix des listes de vérification
  function selectedCatKeys() {
    const presetKeys = $$('#cat-list .cat-chip input:checked').map(cb => window.PB_CATS.catKey(cb.parentElement.querySelector('span').textContent));
    const customKeys = $$('#custom-cats .custom-cat').map(el => (el.dataset.keys || '').split(',').filter(Boolean));
    return presetKeys.concat(customKeys);
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
      const key = window.PB_CATS.catKey(v);
      const keys = Array.isArray(key) ? key : (key ? [key] : []);
      chip.dataset.keys = keys.join(',');
      const known = keys.length ? window.PB_CATS.KNOWN_LISTS.filter(([k]) => keys.includes(k)).map(([, lbl]) => lbl) : [];
      chip.innerHTML = '<span>' + esc(v.slice(0, 24)) + '</span>' +
        (known.length ? ' <span class="badge auto" title="Vérification : ' + esc(known.join(' + ')) + '">✅ ' + esc(known.join('+')) + '</span>' : ' <span class="badge" style="background:#eee;color:#666" title="Pas de liste connue : les mots passeront au vote">🗳️ vote</span>') +
        ' <button type="button" class="btn small ghost" style="padding:2px 8px">✕</button>';
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
    state.catKeys = selectedCatKeys();
    state.timer = Math.max(15, Math.min(300, parseInt($('#opt-timer').value, 10) || D.defaultTimer));
    state.withTimer = $('#opt-with-timer').checked;
    state.hardLetters = $('#opt-hard').checked;
    state.numRounds = Math.max(1, Math.min(10, parseInt($('#opt-rounds').value, 10) || 5));
    state.stopMode = $('#opt-stop').checked;
  }

  // ---------- lobby ----------
  function renderLobby() {
    const grid = $('#avatar-grid');
    if (grid && !grid.children.length) {
      D.avatars.forEach(av => {
        const b = document.createElement('span');
        b.className = 'avatar-pick' + (me() && me().avatar === av ? ' on' : '');
        b.textContent = av;
        b.addEventListener('click', () => {
          const meNow = me();
          if (meNow) { meNow.avatar = av; }
          $$('.avatar-pick').forEach(x => x.classList.toggle('on', x.textContent === av));
          sendOrBcast({ type: 'avatar', avatar: av });
          if (state.role === 'host') bcast({ type: 'players', players: state.players });
          else renderLobbyPlayersOnly();
        });
        grid.appendChild(b);
      });
    }
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

  function renderLobbyPlayersOnly() {
    const list = $('#lobby-players');
    if (!list) return;
    list.innerHTML = '';
    state.players.forEach(p => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="avatar">' + p.avatar + '</span> <span>' + esc(p.name) + '</span>' + (p.isHost ? '<span class="host-tag">HÔTE</span>' : '');
      list.appendChild(li);
    });
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
    state.round = roundNo - 1;   // compteur de manche tenu ici (hôte ET invités)
    state.letter = letter;
    state.usedLetters.add(letter);
    state.entries = [];
    state.answers = {};
    state.myVotes = {};
    state.finishedFlags = {};
    if (state.role === 'host') { state.myVotesHost = {}; }
    stopTimer();
    loadCatSets(state.categories);
    renderProgressDots(roundNo);
    $('#play-round').textContent = 'Manche ' + roundNo + ' / ' + state.numRounds;
    const letterEl = $('#play-letter');
    letterEl.textContent = letter;
    letterEl.classList.remove('letter-pop');
    void letterEl.offsetWidth;
    letterEl.classList.add('letter-pop');
    const ringWrap = document.querySelector('.timer-ring-wrap');
    const ringFg = $('#ring-fg');
    const timerEl = $('#play-timer');
    if (state.withTimer) {
      ringWrap.classList.add('show');
      state.timeLeft = state.timer;
      updateRing();
      state.timerId = setInterval(() => {
        state.timeLeft--;
        updateRing();
        if (state.timeLeft <= 0) endRoundByHost();
      }, 1000);
    } else {
      ringWrap.classList.remove('show');
    }
    renderAnswerForm();
    show('#screen-play');
    const forceBtn = $('#btn-force-end');
    if (forceBtn) forceBtn.classList.toggle('hidden', state.role !== 'host');
    updateConnBadge();
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
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === 'Go' || e.keyCode === 13) {
          e.preventDefault();
          const n = inputs[inputs.indexOf(inp) + 1];
          if (n) n.focus(); else submitAnswers();   // Entrée sur le dernier champ = envoyer
        }
      });
    });
  }

  function liveCheck(inp) {
    if (state.phase === 'playing') updatePlayStatus();
    const i = parseInt(inp.dataset.i, 10);
    const chk = document.querySelector('.chk[data-i="' + i + '"]');
    const v = inp.value.trim();
    inp.classList.remove('ok', 'warn', 'err');
    if (!v) { chk.textContent = ''; chk.className = 'chk'; return; }
    if (!R.startsWithLetter(v, state.letter)) {
      chk.textContent = '✖️ pas de « ' + state.letter.toUpperCase() + ' »'; chk.className = 'chk status-ko';
      inp.classList.add('err'); return;
    }
    const key = state.catKeys ? state.catKeys[i] : null;
    const catRes = R.categoryCheck(v, key, state.catSets);
    if (catRes === false) {
      chk.textContent = '✖️ hors catégorie'; chk.className = 'chk status-ko';
      inp.classList.add('err'); return;
    }
    if (state.dict.size === 0) { chk.textContent = '❓'; return; }
    if (R.isInDictionary(v, state.dict)) {
      chk.textContent = catRes === true ? '✔' : '✔ mot connu';
      chk.className = 'chk status-ok';
      inp.classList.add('ok');
    } else {
      chk.textContent = '❓ sera voté';
      chk.className = 'chk status-ko';
      inp.classList.add('warn');
    }
  }

  function updateConnBadge() {
    const b = $('#conn-badge');
    if (!b || !state.net || !state.net.peer) return;
    const ok = state.net.peer.open !== false && !!state.net.peer.id;
    b.textContent = ok ? '🟢' : '🔴';
    b.className = 'conn-badge ' + (ok ? 'ok' : 'bad');
    b.title = ok ? 'Connecté (' + state.net.peer.id.slice(-12) + ')' : 'Déconnecté — reconnexion…';
  }

  function updatePlayStatus() {
    const el = $('#play-status');
    if (!el) return;
    const inputs = $$('#answers-form input');
    const filled = inputs.filter(i => i.value.trim()).length;
    if (inputs.length) {
      el.textContent = '✏️ ' + filled + '/' + inputs.length + ' remplies' + (filled === inputs.length ? ' — Entrée ou ✅ pour envoyer !' : '');
      const btn = $('#btn-submit-answers');
      if (btn) btn.classList.toggle('pulse', filled === inputs.length && filled > 0);
      return;
    }
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

  function saveMyAnswers(answers) {
    try { localStorage.setItem('pb-answers', JSON.stringify({ code: state.code, round: state.round, letter: state.letter, answers })); } catch (e) {}
  }
  function loadMyAnswers() {
    try {
      const d = JSON.parse(localStorage.getItem('pb-answers') || 'null');
      return (d && d.code === state.code && d.round === state.round) ? d.answers : null;
    } catch (e) { return null; }
  }

  function submitAnswers() {
    if (state.phase !== 'playing') { toast('⏳ La manche est déjà terminée'); return; }
    stopTimer();
    const answers = collectMyAnswers();
    saveMyAnswers(answers);
    netlog('↗', { type: 'answers', answers });
    if (state.role === 'host') {
      state.answers[myId()] = answers;
      state.finishedFlags[myId()] = true;
      bcast({ type: 'finished', id: myId(), players: state.players });
      maybeEndRound();
    } else {
      send({ type: 'answers', answers });
      state.finishedFlags[myId()] = true;
      if (state.phase === 'playing') {
        show('#screen-waiting');
        $('#waiting-text').textContent = '✨ Tes réponses sont envoyées !';
        $('#waiting-status').textContent = '📡 Envoi en cours… elles partiront dès que la connexion revient';
        $('#waiting-status').textContent = '🚀 1 / ' + state.players.length + ' ont terminé';
      }
    }
    updatePlayStatus();
  }

  function buzz(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {} }

  function stopRound() {
    if (state.phase !== 'playing') return;
    if (state.role === 'host') {
      // l'hôte soumet d'abord SES propres réponses courantes avant de reveal
      if (!state.finishedFlags[myId()]) {
        state.answers[myId()] = collectMyAnswers();
        state.finishedFlags[myId()] = true;
        bcast({ type: 'finished', id: myId(), players: state.players });
      }
      bcast({ type: 'stopping', by: myId() });
      endRoundByHost();
    }
    else { send({ type: 'stop' }); }
    buzz(80);
    toast('🛑 Stop ! La manche s\'arrête — dernières réponses !');
  }

  function maybeEndRound() {
    if (state.role !== 'host' || state.phase !== 'playing') return;
    const allDone = state.players.every(p => state.finishedFlags[p.id]);
    if (allDone || (!state.withTimer && Object.keys(state.finishedFlags).length >= state.players.length)) endRoundByHost();
  }

  function endRoundByHost() {
    if (state.role !== 'host' || state.phase !== 'playing') return;
    stopTimer();
    // filet de sécurité mobile : avant de clore, on demande aux retardataires d'envoyer
    // leurs champs TOUT DE SUITE (message 'stopping' → envoi auto côté invité). Les
    // réponses qui arrivent ensuite recalculent automatiquement le reveal (case 'answers').
    const missing = state.players.filter(p => !state.finishedFlags[p.id] && p.id !== myId());
    if (missing.length) {
      bcast({ type: 'stopping', by: myId() });
      toast('⏳ Dernières réponses en cours de réception…');
    }
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
  function showReveal(entries, keepVotes) {
    state.phase = 'vote';
    if (keepVotes) {
      state.myVotes = {};
      const ids = new Set(entries.map(e => e.id));
      Object.keys(keepVotes).forEach(k => { if (ids.has(k)) state.myVotes[k] = keepVotes[k]; });
    } else {
      state.myVotes = state.myVotes || {};
    }
    const box = $('#vote-list');
    box.innerHTML = '';
    if (!entries.length) {
      box.innerHTML = '<div class="card" style="text-align:center"><p style="font-size:1.1rem;font-weight:800">😴 Personne n\'a répondu à cette manche…</p>' +
        (state.role === 'host' ? '<button id="btn-skip-empty" class="btn">⏭ Manche suivante</button>' : '<p class="hint">En attente de l\'hôte…</p>') + '</div>';
      const skip = document.getElementById('btn-skip-empty');
      if (skip) skip.addEventListener('click', () => {
        const last = state.round + 1 >= state.numRounds;
        if (last) { bcast({ type: 'final', totals: state.totals }); showFinal(state.totals); }
        else {
          const letter = R.pickLetter(Math.random, state.hardLetters, state.usedLetters);
          bcast({ type: 'start', letter, round: state.round + 2, settings: currentSettings() });
          startRound(letter, state.round + 2);
        }
      });
    }
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
        updateVoteCount(entries);
        sfx('chat');
        if (state.role === 'host') {
          state.myVotesHost[myId()] = state.myVotes;
          bcast({ type: 'vote-progress', id: myId() });
        } else {
          send({ type: 'vote', votes: state.myVotes });
        }
        // auto-envoi quand tous les mots ont un vote
        if (entries.length && Object.keys(state.myVotes).length >= entries.length) {
          submitVotes();
        }
      });
    });
    const submit = $('#btn-submit-votes');
    if (submit) { submit.classList.remove('hidden'); submit.textContent = '📨 Envoyer mes votes'; }
    const forceBtn = document.getElementById('btn-force-votes');
    if (forceBtn) forceBtn.classList.toggle('hidden', state.role !== 'host');
    refreshVoteButtons();
    updateVoteCount(entries);
    updateVoteProgress();
    show('#screen-vote');
    const vr = $('#vote-round');
    if (vr) vr.textContent = 'Manche ' + (state.round + 1) + ' — lettre « ' + state.letter.toUpperCase() + ' »';
  }

  function refreshVoteButtons() {
    $$('#vote-list .vote-btns .btn').forEach(b => {
      const id = b.dataset.id;
      const v = b.dataset.v === '1';
      b.classList.toggle('on', state.myVotes[id] === v);
    });
  }

  function updateVoteCount(entries) {
    const el = $('#vote-count');
    if (!el) return;
    const n = Object.keys(state.myVotes || {}).length;
    el.textContent = '🗳️ ' + n + ' / ' + entries.length + ' mots votés';
  }

  function submitVotes() {
    if (state.phase !== 'vote') return;
    if (state.role === 'host') {
      state.myVotesHost[myId()] = state.myVotes;
      state.finishedFlags['vote:' + myId()] = true;
      bcast({ type: 'vote-progress', id: myId() });
      maybeFinishVotes();
    } else {
      send({ type: 'votes-done', votes: state.myVotes });
      const btn = $('#btn-submit-votes');
      if (btn) { btn.classList.add('hidden'); btn.textContent = '📨 Votes envoyés !'; }
      toast('🗳️ Votes envoyés !');
    }
  }

  function initVote() {
    $('#btn-submit-votes').addEventListener('click', submitVotes);
    // filet anti-blocage : si un joueur ne peut plus voter (déconnexion), l'hôte peut débloquer
    const force = document.getElementById('btn-force-votes');
    if (force) force.addEventListener('click', () => {
      if (state.role !== 'host' || state.phase !== 'vote') return;
      state.players.forEach(p => { state.finishedFlags['vote:' + p.id] = true; });
      toast('⏭ Votes clôturés par l\'hôte');
      maybeFinishVotes();
    });
  }

  function allVotesCollected() {
    return state.players.every(p => state.finishedFlags['vote:' + p.id]);
  }

  function updateVoteProgress() {
    const done = state.players.filter(p => state.finishedFlags['vote:' + p.id]).length;
    const el = $('#vote-progress');
    if (el) el.textContent = '🗳️ ' + done + ' / ' + state.players.length + ' joueurs ont voté — on attend tout le monde…';
  }

  function maybeFinishVotes() {
    if (state.role !== 'host' || state.phase !== 'vote') return;
    if (!allVotesCollected()) {
      updateVoteProgress();
      return;
    }
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
    const myPts = (roundScore && myId() && roundScore[myId()]) || 0;
    let myLine = document.getElementById('my-round-points');
    if (!myLine) {
      myLine = document.createElement('p');
      myLine.id = 'my-round-points';
      myLine.style.cssText = 'text-align:center;font-size:1.3rem;font-weight:900;margin:4px 0 10px';
      const h = document.querySelector('#scores-round');
      h.parentElement.insertBefore(myLine, h.nextSibling);
    }
    myLine.textContent = myPts > 0 ? '⭐ Tu marques +' + myPts + ' pts cette manche !' : '😅 0 pt cette manche…';
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
    renderPodium(totals, '#podium');
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

  function renderPodium(totals, targetSel) {
    const box = $(targetSel);
    if (!box) return;
    box.innerHTML = '';
    const ranking = state.players.map(p => ({ p, pts: totals[p.id] || 0 })).sort((a, b) => b.pts - a.pts);
    const top = ranking.slice(0, 3);
    const medals = ['🥇', '🥈', '🥉'];
    top.forEach((r, i) => {
      const slot = document.createElement('div');
      slot.className = 'podium-slot p' + (i + 1);
      slot.innerHTML = '<div class="avatar">' + r.p.avatar + '</div>' +
        '<div class="name">' + esc(r.p.name) + '</div>' +
        '<div class="pts">' + r.pts + ' pts</div>' +
        '<div class="bar">' + medals[i] + '</div>';
      box.appendChild(slot);
    });
  }

  function showFinal(totals) {
    state.phase = 'final';
    renderTotals(totals, '#score-totals-final-list');
    renderPodium(totals, '#podium-final');
    const box = $('#final-winners');
    box.innerHTML = '';
    const ranking = state.players.map(p => ({ p, pts: totals[p.id] || 0 })).sort((a, b) => b.pts - a.pts);
    const best = ranking.length ? ranking[0].pts : 0;
    const winners = ranking.filter(r => r.pts === best);
    box.innerHTML = winners.map(r => '<div style="font-size:1.4rem;font-weight:800">🏆 ' + esc(r.p.name) + ' — ' + r.pts + ' pts</div>').join('');
    sfx('win');
    confetti();
    buzz([60, 60, 60, 60, 200]);
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

  const RING_LEN = 119.4;
  function updateRing() {
    const el = $('#play-timer');
    const fg = $('#ring-fg');
    if (!el || !fg) return;
    el.textContent = Math.max(0, state.timeLeft);
    const frac = state.timer > 0 ? Math.max(0, state.timeLeft / state.timer) : 0;
    fg.style.strokeDashoffset = String(RING_LEN * (1 - frac));
    fg.classList.toggle('low', state.timeLeft <= 10);
  }

  function renderProgressDots(roundNo) {
    const box = $('#progress-dots');
    if (!box) return;
    box.innerHTML = '';
    for (let i = 1; i <= state.numRounds; i++) {
      const d = document.createElement('span');
      d.className = 'dot' + (i < roundNo ? ' done' : i === roundNo ? ' current' : '');
      box.appendChild(d);
    }
  }

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
  const THEMES = ['carnet', 'espace', 'jungle', 'mer', 'bonbon', 'xp'];
  function applyTheme(name) {
    document.body.dataset.theme = THEMES.indexOf(name) >= 0 ? name : 'carnet';
    $$('.theme-chip').forEach(c => c.classList.toggle('on', c.dataset.theme === document.body.dataset.theme));
    try { localStorage.setItem('pb-theme', document.body.dataset.theme); } catch (e) {}
  }
  function initTheme() {
    $$('.theme-chip').forEach(c => c.addEventListener('click', () => applyTheme(c.dataset.theme)));
    let saved = 'carnet';
    try { saved = localStorage.getItem('pb-theme') || 'carnet'; } catch (e) {}
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

  // ---------- overlay debug (masqué par défaut ; ?debug=1 ou #debug pour l'afficher) ----------
  const JSERRS = [];
  window.addEventListener('error', e => {
    JSERRS.push(new Date().toLocaleTimeString() + ' ' + e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno);
    if (JSERRS.length > 10) JSERRS.shift();
    if (window.__debugOn) renderDebug();
  });

  function debugSnapshot() {
    const net = state.net;
    let connInfo = 'net: aucun';
    if (net && net.peer) {
      let conns = '?';
      if (net.isHost) conns = [...net.conns.entries()].map(([id, c]) => id.slice(-8) + ':' + (c.open ? 'open' : 'closed')).join(' ') || 'aucune';
      else conns = Object.entries(net.peer.connections || {}).map(([id, arr]) => id.slice(-8) + ':' + (arr[0] && arr[0].open ? 'open' : 'closed')).join(' ') || 'aucune';
      connInfo = (net.isHost ? 'HOST' : 'GUEST') + ' peerId=' + String(net.peer.id).slice(-14) + ' open=' + net.peer.open + ' conns=[' + conns + ']';
    }
    const catInfo = Object.entries(state.catSets || {}).map(([k, v]) => k + ':' + (v.size || 0)).join(' ');
    const entriesInfo = (state.entries || []).map(e => e.word + (e.auto ? '✓' : (e.catCheck === false ? '✗cat' : '?'))).join(' | ');
    const answersInfo = Object.entries(state.answers || {}).map(([id, a]) => id.slice(-6) + '=' + JSON.stringify(a)).join(' ');
    return [
      '=== PETIT BAC DEBUG ' + new Date().toLocaleTimeString() + ' ===',
      'phase=' + state.phase + '  manche=' + (state.round + 1) + '/' + state.numRounds + '  lettre=' + (state.letter || '-') + '  timer=' + (state.timeLeft != null ? state.timeLeft + 's' : 'off'),
      'role=' + (state.role || '-') + '  code=' + (state.code || '-') + '  room=' + location.hash,
      connInfo,
      'joueurs: ' + state.players.map(p => p.name + (p.isHost ? '★' : '') + (p.offline ? '💤' : '')).join(', '),
      'catSets: ' + (catInfo || 'aucune') + '  dict=' + state.dict.size + ' entrées',
      'finishedFlags: ' + JSON.stringify(state.finishedFlags),
      'votesHost: ' + Object.keys(state.myVotesHost || {}).length + '/' + state.players.length + '  myVotes=' + JSON.stringify(state.myVotes || {}),
      'file d\'envoi: ' + (state.net && state.net.pendingCount ? state.net.pendingCount() : 'n/a') + ' msg(s) en attente  connexion=' + (state.net && state.net.isConnected ? (state.net.isConnected() ? 'OK' : 'PERDUE') : 'n/a'),
      'réponses: ' + (answersInfo || '-') + '  [mes champs: ' + [...document.querySelectorAll('#answers-form input')].map(i => JSON.stringify(i.value)).join(',') + ']',
      'entrées manche: ' + (entriesInfo || '-'),
      'totaux: ' + JSON.stringify(state.totals || {}),
      'écran visible: ' + (([...document.querySelectorAll('.screen')].find(e => !e.classList.contains('hidden')) || {}).id || '-') + '  voteList=' + document.querySelectorAll('#vote-list > *').length + ' rows  playForm=' + document.querySelectorAll('#answers-form input').length + ' champs',
      'erreurs JS: ' + (JSERRS.join(' ;; ') || 'aucune'),
      '--- réseau (30 derniers) ---',
      NETLOG.slice(-30).map(l => new Date(l.t).toLocaleTimeString() + '.' + String(l.t % 1000).padStart(3, '0') + ' ' + l.dir + ' ' + l.type + (l.from ? ' de ' + l.from : '')).join('\n'),
      'UA: ' + navigator.userAgent
    ].join('\n');
  }

  function renderDebug() {
    let el = document.getElementById('debug-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'debug-overlay';
      el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:rgba(10,10,10,.92);color:#8dff8d;font:10px/1.35 monospace;padding:5px 8px;max-height:38vh;overflow:auto;white-space:pre-wrap;pointer-events:none;border-bottom:2px solid #ff0';
      document.body.appendChild(el);
      const btn = document.createElement('button');
      btn.id = 'debug-copy';
      btn.textContent = '📋 copier le rapport debug';
      btn.style.cssText = 'position:fixed;bottom:calc(96px + env(safe-area-inset-bottom));right:10px;z-index:2147483647;font:700 12px sans-serif;padding:8px 10px;border-radius:10px;border:2px solid #ff0;background:#111;color:#ff0;cursor:pointer';
      btn.addEventListener('click', () => {
        const txt = debugSnapshot();
        if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => toast('📋 Rapport debug copié !'));
        else toast('Copie impossible');
      });
      document.body.appendChild(btn);
    }
    el.textContent = debugSnapshot();
  }
  function initDebug() {
    // debug masqué par défaut ; ?debug=1 (ou #debug) pour l'activer
    if (!/[?&]debug=1/.test(location.search) && !/debug=1/.test(location.hash)) return;
    window.__debugOn = true;
    renderDebug();
    setInterval(renderDebug, 500);
  }

  // ---------- clavier virtuel : la barre d'actions remonte au-dessus ----------
  function initVisualViewport() {
    if (!window.visualViewport) return;
    const adjust = () => {
      const kb = window.innerHeight - window.visualViewport.height; // hauteur du clavier
      document.querySelectorAll('.sticky-bar').forEach(bar => {
        bar.style.bottom = kb > 80 ? (kb + 10 + (parseFloat(getComputedStyle(document.body).getPropertyValue('--safe-b')) || 0)) + 'px' : '';
      });
    };
    window.visualViewport.addEventListener('resize', adjust);
    window.visualViewport.addEventListener('scroll', adjust);
  }

  // ---------- mobile : fermer le clavier au 1er tap sur un bouton ----------
  function initMobileTapFix() {
    document.addEventListener('pointerdown', e => {
      const btn = e.target.closest && e.target.closest('button');
      if (btn && document.activeElement && document.activeElement.tagName === 'INPUT') {
        document.activeElement.blur(); // ferme le clavier virtuel → le click passe au 1er tap
      }
    }, true);
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
    const forceBtn = $('#btn-force-end');
    if (forceBtn) forceBtn.addEventListener('click', () => { if (state.role === 'host' && state.phase === 'playing') { endRoundByHost(); toast('⏭ Manche terminée de force par l\'hôte'); } });
    setInterval(updateConnBadge, 2000);
    $('#btn-print-play').addEventListener('click', () => { buildPrintSheet(); window.print(); });
    $('#btn-quit').addEventListener('click', () => { if (confirm('Quitter la partie ?')) { location.hash = ''; location.reload(); } });
    $('#btn-mute').addEventListener('click', () => {
      muted = !muted;
      $('#btn-mute').textContent = muted ? '🔇 Son off' : '🔊 Son on';
    });
    $$('.btn-share').forEach(b => b.addEventListener('click', shareInvite));
    $$('.btn-print-final').forEach(b => b.addEventListener('click', () => { buildPrintSheet(); window.print(); }));
    initDebug();
    initVisualViewport();
    initMobileTapFix();
    loadDict();
    show('#screen-home');
    try { window.__pb = state; } catch (e) {}  // accès debug à l'état (support/diagnostic)
    sfx && setTimeout(() => sfx('start'), 300);
    window.addEventListener('beforeunload', () => { if (state.net) { sendOrBcast({ type: 'leave' }); } });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
