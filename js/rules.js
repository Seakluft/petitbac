(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Rules = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function normalizeWord(s) {
    if (typeof s !== 'string') return '';
    return s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[’‘`´]/g, "'")
      .replace(/['’]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function startsWithLetter(word, letter) {
    const w = normalizeWord(word);
    const l = normalizeWord(letter);
    if (!w || !l) return false;
    return w.charAt(0) === l.charAt(0);
  }

  function isInDictionary(word, dictSet) {
    const w = normalizeWord(word);
    if (!w) return false;
    if (dictSet.has(w)) return true;
    const s = singularize(w);
    if (s && s !== w && dictSet.has(s)) return true;
    return false;
  }

  // Pluriel -> singulier (règles simples, couvre l'essentiel en français)
  function singularize(w) {
    if (w.length < 4) return null;
    if (w.endsWith('eaux')) return w.slice(0, -4) + 'eau';
    if (w.endsWith('aux')) return w.slice(0, -3) + 'al';
    if (w.endsWith('oux')) return w.slice(0, -3) + 'ou';
    if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
    return null;
  }

  function autoValid(word, letter, dictSet) {
    return startsWithLetter(word, letter) && isInDictionary(word, dictSet);
  }

  // Validation par catégorie : catKeys = clé OU tableau de clés (groupe de listes),
  // catSets = { cle: Set(mots normalisés) } chargé à la demande.
  // true = dans au moins une liste du groupe, false = listes connues mais mot hors de toutes,
  // null = aucune liste connue pour cette catégorie -> vote des joueurs.
  function categoryCheck(word, catKeys, catSets) {
    const keys = Array.isArray(catKeys) ? catKeys : (catKeys ? [catKeys] : []);
    const known = keys.filter(k => catSets && catSets[k]);
    if (!known.length) return null;
    const w = normalizeWord(word);
    if (!w) return false;
    const s = singularize(w);
    for (const k of known) {
      if (catSets[k].has(w)) return true;
      if (s && s !== w && catSets[k].has(s)) return true;
    }
    return false;
  }

  const HARD_LETTERS = ['k', 'w', 'x', 'y', 'z'];
  const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

  function pickLetter(rng, includeHard, usedLetters) {
    rng = rng || Math.random;
    let pool = includeHard ? LETTERS : LETTERS.filter(l => HARD_LETTERS.indexOf(l) === -1);
    if (usedLetters && usedLetters.size) {
      const remaining = pool.filter(l => !usedLetters.has(l));
      if (remaining.length) pool = remaining;
    }
    return pool[Math.floor(rng() * pool.length)];
  }

  function genRoomCode(rng) {
    rng = rng || Math.random;
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 5; i++) out += chars[Math.floor(rng() * chars.length)];
    return out;
  }

  function buildRoundEntries(playersAnswers, categories, letter, dictSet, catSets, catKeys) {
    const entries = [];
    categories.forEach((cat, ci) => {
      const key = catKeys ? catKeys[ci] : null;
      const byWord = new Map();
      playersAnswers.forEach(pa => {
        const raw = (pa.answers && pa.answers[ci]) || '';
        const norm = normalizeWord(raw);
        if (!norm) return;
        if (!byWord.has(norm)) {
          const dictOk = autoValid(raw, letter, dictSet);
          const catOk = categoryCheck(raw, key, catSets);
          byWord.set(norm, {
            id: 'e' + entries.length + '_' + ci + '_' + norm,
            categoryIndex: ci,
            category: cat,
            word: raw.trim(),
            norm: norm,
            players: [],
            auto: dictOk && catOk !== false,
            catCheck: catOk,
            letterOk: startsWithLetter(raw, letter)
          });
        }
        byWord.get(norm).players.push(pa.playerId);
      });
      byWord.forEach(e => entries.push(e));
    });
    return entries;
  }

  function applyVotes(entries, allVotes) {
    entries.forEach(e => {
      let up = 0, down = 0;
      allVotes.forEach(v => {
        const val = v[e.id];
        if (val === true) up++;
        else if (val === false) down++;
      });
      e.up = up;
      e.down = down;
      e.accepted = e.auto ? true : up > down;
    });
    return entries;
  }

  const PTS_UNIQUE = 2;
  const PTS_DUPLICATE = 1;

  function scoreRound(entries, playerIds) {
    const perPlayer = {};
    playerIds.forEach(id => { perPlayer[id] = 0; });
    const byCat = new Map();
    entries.forEach(e => {
      if (!e.accepted) return;
      if (!byCat.has(e.categoryIndex)) byCat.set(e.categoryIndex, []);
      byCat.get(e.categoryIndex).push(e);
    });
    byCat.forEach(list => {
      list.forEach(e => {
        const pts = e.players.length >= 2 ? PTS_DUPLICATE : PTS_UNIQUE;
        e.players.forEach(pid => {
          if (perPlayer[pid] !== undefined) perPlayer[pid] += pts;
        });
        e.points = pts;
      });
    });
    return perPlayer;
  }

  function totalScores(roundScoresList, playerIds) {
    const totals = {};
    playerIds.forEach(id => { totals[id] = 0; });
    roundScoresList.forEach(rs => {
      playerIds.forEach(id => { if (rs[id]) totals[id] += rs[id]; });
    });
    return totals;
  }

  return {
    normalizeWord,
    singularize,
    startsWithLetter,
    isInDictionary,
    autoValid,
    categoryCheck,
    pickLetter,
    genRoomCode,
    buildRoundEntries,
    applyVotes,
    scoreRound,
    totalScores,
    PTS_UNIQUE,
    PTS_DUPLICATE,
    HARD_LETTERS,
    LETTERS
  };
});
