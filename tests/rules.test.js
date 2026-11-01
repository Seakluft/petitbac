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

t('categoryCheck : banane dans ville = hors catégorie, paris = ok, catégorie inconnue = vote (null)', () => {
  const catSets = { ville: new Set(['paris', 'londres', 'katmandou']), animal: new Set(['lion', 'chien']) };
  assert.strictEqual(R.categoryCheck('Banane', 'ville', catSets), false);
  assert.strictEqual(R.categoryCheck('Paris', 'ville', catSets), true);
  assert.strictEqual(R.categoryCheck('Lyon', 'ville', catSets), false);
  assert.strictEqual(R.categoryCheck('Lion', 'animal', catSets), true);
  assert.strictEqual(R.categoryCheck('Lion', 'ville', catSets), false);
  assert.strictEqual(R.categoryCheck('Whatever', 'inconnue', catSets), null);
  assert.strictEqual(R.categoryCheck('Whatever', null, catSets), null);
});

t('buildRoundEntries : hors catégorie marqué auto=false même si dans le dictionnaire', () => {
  const catSets = { ville: new Set(['paris']) };
  const catKeys = ['ville'];
  const players = [
    { playerId: 'a', answers: ['Paris'] },
    { playerId: 'b', answers: ['Banane'] }
  ];
  const entries = R.buildRoundEntries(players, ['Ville'], 'p', new Set(['paris', 'banane']), catSets, catKeys);
  const paris = entries.find(e => e.norm === 'paris');
  const banane = entries.find(e => e.norm === 'banane');
  assert.strictEqual(paris.auto, true);
  assert.strictEqual(paris.catCheck, true);
  assert.strictEqual(banane.auto, false);
  assert.strictEqual(banane.catCheck, false);
});

t('singularize : pluriels usuels', () => {
  assert.strictEqual(R.singularize('pommes'), 'pomme');
  assert.strictEqual(R.singularize('chevaux'), 'cheval');
  assert.strictEqual(R.singularize('bateaux'), 'bateau');
  assert.strictEqual(R.singularize('hiboux'), 'hibou');
  assert.strictEqual(R.singularize('nez'), null);
});

t('pluriel accepté dans le dictionnaire et les catégories', () => {
  const d = new Set(['pomme', 'paris']);
  assert.ok(R.isInDictionary('Pommes', d));
  assert.ok(!R.isInDictionary('zzzzz', d));
  const cs = { ville: new Set(['paris']) };
  assert.strictEqual(R.categoryCheck('Paris', 'ville', cs), true);
  assert.strictEqual(R.categoryCheck('Villes', 'ville', cs), false); // pluriel de la catégorie, pas d'une entrée
});

t('pickLetter avec usedLetters ne rejoue pas une lettre', () => {
  const pool = R.LETTERS.filter(l => R.HARD_LETTERS.indexOf(l) === -1);
  const used = new Set(pool.slice(0, pool.length - 3)); // il reste 3 lettres
  for (let i = 0; i < 50; i++) {
    const l = R.pickLetter(Math.random, false, used);
    assert.ok(!used.has(l), 'lettre déjà jouée: ' + l);
  }
  // si tout est utilisé, on retombe sur le pool complet sans planter
  const all = new Set(R.LETTERS);
  const l = R.pickLetter(Math.random, false, all);
  assert.ok(R.LETTERS.includes(l));
});

t('totalScores additionne les manches', () => {
  const totals = R.totalScores([{ a: 2, b: 1 }, { a: 1, b: 2 }], ['a', 'b']);
  assert.deepStrictEqual(totals, { a: 3, b: 3 });
});

console.log('\n' + passed + ' tests OK');
