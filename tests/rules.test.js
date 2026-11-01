'use strict';
const assert = require('assert');
const R = require('../js/rules.js');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('ok -', name); }

t('normalizeWord enlève accents et casse', () => {
  assert.strictEqual(R.normalizeWord('Éléphant'), 'elephant');
  assert.strictEqual(R.normalizeWord('  Chloé '), 'chloe');
  assert.strictEqual(R.normalizeWord("l'orage"), 'lorage');
});

t('startsWithLetter', () => {
  assert.ok(R.startsWithLetter('Mars', 'm'));
  assert.ok(R.startsWithLetter('terre', 'T'));
  assert.ok(!R.startsWithLetter('Vénus', 'm'));
});

const dict = new Set(['mars', 'astronaute', 'etoile', 'soleil', 'lune', 'meteorite']);

t('autoValid = lettre + dictionnaire', () => {
  assert.ok(R.autoValid('Mars', 'm', dict));
  assert.ok(R.autoValid('Météorite', 'm', dict));
  assert.ok(!R.autoValid('Vénus', 'm', dict));
  assert.ok(!R.autoValid('zzz', 'z', dict));
  assert.ok(!R.autoValid('', 'm', dict));
});

t('doublon détecté : même mot normalisé = 1 entrée, plusieurs joueurs', () => {
  const players = [
    { playerId: 'a', answers: ['Mars', 'Soleil'] },
    { playerId: 'b', answers: ['mars', 'Lune'] }
  ];
  const entries = R.buildRoundEntries(players, ['Planète', 'Objet'], 'm', dict);
  const mars = entries.find(e => e.norm === 'mars');
  assert.ok(mars);
  assert.deepStrictEqual(mars.players.sort(), ['a', 'b']);
  assert.ok(entries.find(e => e.norm === 'soleil'));
  assert.ok(entries.find(e => e.norm === 'lune'));
  assert.strictEqual(entries.length, 3);
});

t('scoring : unique=2, doublon=1, refusé=0 (barème standard)', () => {
  const players = [
    { playerId: 'a', answers: ['Mars', 'Météorite'] },
    { playerId: 'b', answers: ['mars', 'Lune'] },
    { playerId: 'c', answers: ['', 'zzzinconnu'] }
  ];
  const entries = R.buildRoundEntries(players, ['Planète', 'Objet'], 'm', dict);
  R.applyVotes(entries, [
    { [entries.find(e => e.norm === 'mars').id]: true },
    { [entries.find(e => e.norm === 'mars').id]: true },
    {}
  ]);
  const scores = R.scoreRound(entries, ['a', 'b', 'c']);
  assert.strictEqual(scores.a, 2 + 1);    // Météorite unique (2) + Mars doublon (1)
  assert.strictEqual(scores.b, 1);        // Mars doublon (1) + Lune hors lettre (0)
  assert.strictEqual(scores.c, 0);        // vide + mot non accepté
});

t('vote : majorité gagne, égalité = refusé', () => {
  const e = { id: 'x', players: ['a'], accepted: null };
  R.applyVotes([e], [{ x: true }, { x: false }, { x: true }]);
  assert.strictEqual(e.accepted, true);
  const e2 = { id: 'y', players: ['a'], accepted: null };
  R.applyVotes([e2], [{ y: true }, { y: false }]);
  assert.strictEqual(e2.accepted, false);
});

t('pickLetter évite K W X Y Z sans option difficile', () => {
  for (let i = 0; i < 200; i++) {
    const l = R.pickLetter(Math.random, false);
    assert.ok(R.HARD_LETTERS.indexOf(l) === -1);
  }
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(R.pickLetter(Math.random, true));
  assert.ok(seen.has('z') || seen.has('k'));
});

t('genRoomCode : 5 caractères valides', () => {
  const c = R.genRoomCode();
  assert.ok(/^[A-Z2-9]{5}$/.test(c));
  assert.ok(!/[OIL01]/.test(c));
});

t('totalScores additionne les manches', () => {
  const totals = R.totalScores([{ a: 2, b: 1 }, { a: 1, b: 2 }], ['a', 'b']);
  assert.deepStrictEqual(totals, { a: 3, b: 3 });
});

console.log('\n' + passed + ' tests OK');
