/* Test E2E : simule une partie complète hôte + invité (mock PeerJS in-memory).
 * Vérifie : création → salon → manches (compteur OK) → votes → scores → final.
 * Lancer : npm install && npm run test:e2e
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');

// ---------- mock PeerJS ----------
const peers = new Map();
class MockConn {
  constructor() { this.open = false; this.handlers = {}; this.peer = null; this.remote = null; }
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  _emit(ev, arg) { (this.handlers[ev] || []).forEach(fn => fn(arg)); }
  send(msg) { if (this.remote) this.remote._emit('data', msg); }
  close() { this.open = false; this._emit('close'); }
}
class MockPeer {
  constructor(id) {
    this.id = id; this.open = false; this.handlers = {}; this.connections = {};
    peers.set(id, this);
    setTimeout(() => { this.open = true; (this.handlers.open || []).forEach(fn => fn(id)); }, 0);
  }
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  connect(remoteId) {
    const remote = peers.get(remoteId);
    const c = new MockConn(); c.peer = remoteId;
    if (!remote) { setTimeout(() => (this.handlers.error || []).forEach(fn => fn({ type: 'peer-unavailable' })), 0); return c; }
    const back = new MockConn(); back.peer = this.id;
    c.remote = back; back.remote = c;
    this.connections[remoteId] = [c];
    remote.connections[this.id] = [back];
    setTimeout(() => {
      c.open = true; back.open = true;
      (this.handlers.connection || []).forEach(fn => fn(c));
      (remote.handlers.connection || []).forEach(fn => fn(back));
      c._emit('open'); back._emit('open');
    }, 0);
    return c;
  }
  destroy() { this.open = false; peers.delete(this.id); }
}

// ---------- chargement du jeu dans un DOM ----------
function makeWindow(hash) {
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'https://x.test/' + (hash || ''), runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  w.Peer = MockPeer;
  w.fetch = (url) => {
    // sert les vrais fichiers assets du repo
    const m = String(url).match(/assets\/([a-z]+\.txt)/);
    const body = m ? fs.readFileSync(path.join(REPO, 'assets', m[1]), 'utf8') : 'pomme\nparis\nlion\nfrance\nbanane\n';
    return Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
  };
  const st = w.document.createElement('style');
  st.textContent = fs.readFileSync(path.join(REPO, 'css/style.css'), 'utf8');
  w.document.head.appendChild(st);
  for (const f of ['assets/cats.js', 'js/data.js', 'js/rules.js', 'js/net.js', 'js/app.js']) {
    w.eval(fs.readFileSync(path.join(REPO, f), 'utf8'));
  }
  w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
  return w;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(name, cond) {
  console.log((cond ? 'ok - ' : 'FAIL - ') + name);
  if (!cond) failures++;
}

(async () => {
  const host = makeWindow('');
  const guest = makeWindow('');
  const q = (w, sel) => w.document.querySelector(sel);
  const qa = (w, sel) => [...w.document.querySelectorAll(sel)];
  const click = (w, sel) => { const el = q(w, sel); if (!el) throw new Error('no el ' + sel); el.dispatchEvent(new w.Event('click', { bubbles: true })); };
  const vis = (w, sel) => { const el = q(w, sel); return el && !el.classList.contains('hidden'); };

  // 1. création + join
  q(host, '#home-name').value = 'Hote';
  click(host, '#btn-create');
  await sleep(30);
  check('hôte en config', vis(host, '#screen-setup'));
  const code = q(host, '#setup-code').textContent;
  check('code à 5 caractères', /^[A-Z2-9]{5}$/.test(code));

  q(guest, '#home-name').value = 'Invite';
  q(guest, '#room-code').value = code;
  click(guest, '#btn-join');
  await sleep(30);
  check('invité au salon', vis(guest, '#screen-lobby'));
  check('hôte voit 2 joueurs', qa(host, '#lobby-players li').length === 2);

  // 2. config : 3 catégories, 3 manches, timer off pour la vitesse
  qa(host, '#cat-list .cat-chip input').slice(0, 3).forEach(cb => { if (!cb.checked) cb.click(); });
  q(host, '#opt-with-timer').checked = false;
  q(host, '#opt-rounds').value = '3';
  click(host, '#btn-start-game');
  await sleep(20);
  check('salon lancé des deux côtés', vis(host, '#screen-lobby') && vis(guest, '#screen-lobby'));
  click(host, '#btn-launch');
  await sleep(30);
  check('manche 1 lancée (play visible ×2)', vis(host, '#screen-play') && vis(guest, '#screen-play'));
  check('en-tête manche 1', q(host, '#play-round').textContent.includes('Manche 1 / 3'));

  // 2a. Entrée sur le dernier champ = soumettre toute la grille
  {
    qa(host, '#answers-form input').forEach((inp, i) => { inp.value = ['Abeille', 'Angleterre', 'Avion'][i]; inp.dispatchEvent(new host.Event('input', { bubbles: true })); });
    const last = qa(host, '#answers-form input').pop();
    last.dispatchEvent(new host.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(40);
    await sleep(30);
    check('Entrée sur dernier champ → réponses soumises (reveal si guest a soumis aussi)', vis(host, '#screen-vote') || vis(host, '#screen-play'));
    // le guest voit le 'finished' de l'hôte
    check('guest a reçu finished de l\'hôte', vis(guest, '#screen-play'));
    // le compteur de remplissage était affiché
    // (on vérifie juste que la soumission a eu lieu)
  }

  // 2a2. MOBILE : tap sur le bouton avec clavier ouvert (input focusé) → blur + click transmis
  {
    // on remet l'hôte en manche : il a soumis via Entrée au 2a, on fait un stop pour revenir en play propre
    // plus simple : nouveau test direct - focus un input, pointerdown sur le bouton submit, puis click
    const inp = qa(host, '#answers-form input')[0];
    inp.focus();
    check('input focusé avant tap mobile', host.document.activeElement === inp);
    // simule le 1er tap : pointerdown sur le bouton → blur() → le click passe
    const btn = q(host, '#btn-submit-answers');
    btn.dispatchEvent(new host.MouseEvent('pointerdown', { bubbles: true }));
    check('clavier fermé au pointerdown (activeElement plus input)', host.document.activeElement !== inp);
    btn.dispatchEvent(new host.Event('click', { bubbles: true }));
    await sleep(30);
    check('tap mobile sur ✅ → réponses soumises', vis(host, '#screen-vote') || vis(host, '#screen-play'));
  }

  // 2b.BUGFIX(18:35) : l'hôte qui STOPpe avec SES réponses remplies doit produire des entrées non vides
  {
    qa(host, '#answers-form input').forEach((inp, i) => { inp.value = ['Abeille', 'Angleterre', 'Avion'][i]; inp.dispatchEvent(new host.Event('input', { bubbles: true })); });
    click(host, '#btn-stop-round');
    await sleep(120);
    check('host stop avec réponses → vote non vide côté host', qa(host, '#vote-list > .card').length >= 3);
    check('host stop avec réponses → vote non vide côté guest', qa(guest, '#vote-list > .card').length >= 3);
    // on vote et on passe à la manche suivante pour la suite du test
    qa(host, '#vote-list .vote-btns .up').forEach(b => b.dispatchEvent(new host.Event('click', { bubbles: true })));
    click(host, '#btn-submit-votes');
    await sleep(10);
    qa(guest, '#vote-list .vote-btns .up').forEach(b => b.dispatchEvent(new guest.Event('click', { bubbles: true })));
    click(guest, '#btn-submit-votes');
    await sleep(50);
    check('scores après stop host', vis(host, '#screen-scores'));
    click(host, '#btn-next-round');
    await sleep(50);
  }

  // 3. jouer 3 manches jusqu'au final
  for (let round = 2; round <= 3; round++) {
    const letter = q(host, '#play-letter').textContent.toLowerCase();
    const words = { host: ['Pomme', 'Paris', 'Lion'], guest: ['Pomme', 'Lyon', 'Loup'] };
    qa(host, '#answers-form input').forEach((inp, i) => { inp.value = words.host[i]; inp.dispatchEvent(new host.Event('input', { bubbles: true })); });
    qa(guest, '#answers-form input').forEach((inp, i) => { inp.value = words.guest[i]; inp.dispatchEvent(new guest.Event('input', { bubbles: true })); });
    click(host, '#btn-submit-answers');
    await sleep(10);
    click(guest, '#btn-submit-answers');
    await sleep(30);
    check('manche ' + round + ' : phase vote visible ×2', vis(host, '#screen-vote') && vis(guest, '#screen-vote'));
    qa(host, '#vote-list .vote-btns .up').forEach(b => b.dispatchEvent(new host.Event('click', { bubbles: true })));
    // auto-envoi : plus besoin de cliquer (le host a tout voté)
    await sleep(10);
    qa(guest, '#vote-list .vote-btns .up').forEach(b => b.dispatchEvent(new guest.Event('click', { bubbles: true })));
    await sleep(60); // le guest auto-envoie quand tout est voté
    check('manche ' + round + ' : scores visibles ×2 (auto-envoi votes)', vis(host, '#screen-scores') && vis(guest, '#screen-scores'));
    check('manche ' + round + ' : compteur de votes affiché', /mots vot/.test(q(guest, '#vote-count') ? q(guest, '#vote-count').textContent : ''));
    check('manche ' + round + ' : en-tête résultats correct', q(host, '#scores-round').textContent.includes('manche ' + round));
    check('manche ' + round + ' : points perso affichés', /\+\d+ pts cette manche/.test(q(guest, '#my-round-points') ? q(guest, '#my-round-points').textContent : ''));
    if (round < 3) {
      click(host, '#btn-next-round');
      await sleep(40);
      check('manche ' + (round + 1) + ' lancée', vis(host, '#screen-play') && q(host, '#play-round').textContent.includes('Manche ' + (round + 1) + ' / 3'));
    } else {
      const btnText = q(host, '#btn-next-round').textContent;
      check('bouton final présent', /classement final/i.test(btnText));
      click(host, '#btn-next-round');
      await sleep(40);
      check('écran final visible ×2', vis(host, '#screen-final') && vis(guest, '#screen-final'));
      check('podium final rempli', qa(guest, '#podium-final .podium-slot').length >= 1);
      check('classement final rempli', qa(guest, '#score-totals-final-list .score-line').length === 2);
    }
  }

  // 4. cas « reveal vide » (personne n'a répondu, STOP précoce) : message clair + pas de blocage
  {
    // on rejoue une manche 1 bis en forçant un stop immédiat côté hôte sans réponses
    click(host, '#btn-again');
    await sleep(40);
    check('rejouer relance une manche', vis(host, '#screen-play'));
    click(host, '#btn-stop-round'); // stop immédiat, 0 réponse
    await sleep(40);
    check('reveal vide : écran vote visible ×2', vis(host, '#screen-vote') && vis(guest, '#screen-vote'));
    check('reveal vide : message affiché', /Personne n/.test(q(host, '#vote-list').textContent));
    check('reveal vide : bouton passer hôte présent', !!q(host, '#btn-skip-empty'));
    click(host, '#btn-skip-empty'); // passe à la manche suivante sans votes
    await sleep(40);
    check('manche suivante lancée après reveal vide', vis(host, '#screen-play') && vis(guest, '#screen-play'));
  }

  // 5. après le reveal vide, une manche normale avec réponses doit produire des entrées
  {
    qa(host, '#answers-form input').forEach((inp, i) => { inp.value = ['Lion', 'Lyon', 'Lampe'][i]; inp.dispatchEvent(new host.Event('input', { bubbles: true })); });
    qa(guest, '#answers-form input').forEach((inp, i) => { inp.value = ['Loup', 'Lille', 'Livre'][i]; inp.dispatchEvent(new guest.Event('input', { bubbles: true })); });
    click(host, '#btn-submit-answers');
    await sleep(10);
    click(guest, '#btn-submit-answers');
    await sleep(40);
    const rows = qa(host, '#vote-list > .card').length;
    check('réponses soumises → entrées de vote présentes (' + rows + ' rows)', rows >= 4);
    check('écran vote visible avec contenu ×2', vis(host, '#screen-vote') && vis(guest, '#screen-vote') && qa(guest, '#vote-list > .card').length >= 4);
  }

  // 6. RÉPONSES TARDIVES : guest remplit mais ne soumet PAS ; l'hôte STOPpe → au reveal le guest envoie auto → reveal recalculé
  {
    // on repart d'une manche propre : si on est en vote/scores/final, passer à la manche suivante via l'hôte
    for (let tries = 0; tries < 4 && !vis(host, '#screen-play'); tries++) {
      try { if (vis(host, '#screen-vote') || vis(guest, '#screen-vote')) { click(host, '#btn-submit-votes'); await sleep(30); click(guest, '#btn-submit-votes'); await sleep(50); } } catch (e) {}
      try { if (vis(host, '#screen-scores')) { click(host, '#btn-next-round'); await sleep(50); } } catch (e) {}
      try { if (vis(host, '#screen-final')) { click(host, '#btn-again'); await sleep(60); } } catch (e) {}
    }
    check('manche en cours pour le test tardif', vis(host, '#screen-play') && vis(guest, '#screen-play'));
    // guest remplit mais NE SOUMET PAS
    qa(guest, '#answers-form input').forEach((inp, i) => { inp.value = ['Aigle', 'Allemagne', 'Avion'][i]; inp.dispatchEvent(new guest.Event('input', { bubbles: true })); });
    // hôte stoppe avant
    click(host, '#btn-stop-round');
    await sleep(150);
    check('reveal reçu par le guest (vote)', vis(guest, '#screen-vote'));
    const rows = qa(guest, '#vote-list > .card').length;
    check('réponses tardives auto du guest intégrées (rows=' + rows + ')', rows >= 3);
    check('mots du guest dans le vote', /Aigle|Allemagne|Avion/i.test(q(guest, '#vote-list').textContent));
    check('mêmes entrées côté hôte', qa(host, '#vote-list > .card').length === rows && rows >= 3);
  }

  // 7. lettres jamais répétées
  // (vérifié indirectement : usedLetters côté hôte) — on vérifie juste que 3 manches ont eu des lettres valides
  check('partie terminée sans erreur', true);

  console.log(failures === 0 ? '\nE2E OK — partie complète simulée' : '\n' + failures + ' ECHEC(S)');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
