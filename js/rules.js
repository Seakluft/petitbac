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
    return false;
  }

  function autoValid(word, letter, dictSet) {
    return startsWithLetter(word, letter) && isInDictionary(word, dictSet);
  }

  const HARD_LETTERS = ['k', 'w', 'x', 'y', 'z'];
  const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

  function pickLetter(rng, includeHard) {
    rng = rng || Math.random;
    const pool = includeHard ? LETTERS : LETTERS.filter(l => HARD_LETTERS.indexOf(l) === -1);
    return pool[Math.floor(rng() * pool.length)];
  }

  function genRoomCode(rng) {
    rng = rng || Math.random;
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 5; i++) out += chars[Math.floor(rng() * chars.length)];
    return out;
  }

  function buildRoundEntries(playersAnswers, categories, letter, dictSet) {
    const entries = [];
    categories.forEach((cat, ci) => {
      const byWord = new Map();
      playersAnswers.forEach(pa => {
        const raw = (pa.answers && pa.answers[ci]) || '';
        const norm = normalizeWord(raw);
        if (!norm) return;
        if (!byWord.has(norm)) {
          byWord.set(norm, {
            id: 'e' + entries.length + '_' + ci + '_' + norm,
            categoryIndex: ci,
            category: cat,
            word: raw.trim(),
            norm: norm,
            players: [],
            auto: autoValid(raw, letter, dictSet)
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

  const PTS_UNIQUE = 10;
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
    startsWithLetter,
    isInDictionary,
    autoValid,
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
