# 🚀 Petit Bac Espace

Jeu du **petit bac** multijoueur en direct, optimisé mobile, 100 % gratuit (hébergé sur GitHub Pages, aucun serveur payant).

## Jouer

Ouvre simplement : **https://Seakluft.github.io/petitbac/**

- L'**hôte** crée une partie et obtient un **code à 5 caractères** (ex : `K7XQM`) + un lien d'invitation à partager.
- Les autres joueurs entrent leur prénom + le code pour rejoindre **en direct**.
- Le lien d'invitation contient le code (`#room=K7XQM`) : un clic et on est pré-rempli.

## Règles

- Chaque manche tire une **lettre au hasard** (K, W, X, Y, Z exclus sauf option « lettres difficiles »).
- Chaque joueur remplit **une case par catégorie** avec un mot commençant par la lettre.
- **Points** : mot trouvé par un seul joueur = **10 pts** ; même mot trouvé par plusieurs (**doublon détecté automatiquement**, insensible à la casse/accents) = **1 pt** ; case vide ou mot refusé = **0 pt**.
- **Vérification** : un dictionnaire français (~319 000 mots) valide automatiquement les mots connus ; les mots inconnus passent au **vote des joueurs** (👍/👎, majorité, égalité = refusé).
- Timer optionnel (15–300 s, réglable) ou mode « sans timer » : la manche se termine quand tout le monde a fini.
- Nombre de manches réglable (1–10), 2 à 10 joueurs.

## Catégories

- **Liste prédéfinie** (~48 catégories simples : Prénom, Animal, Ville, Pays, Fruit, Objet, Métier, Couleur…) dans laquelle l'hôte coche ce qu'il veut.
- **Catégories personnalisées** ajoutables à la main.
- **Nombre de cases modifiable** : entre 3 et 15 catégories par manche.

## Version imprimable (PDF)

Depuis l'écran de configuration ou le salon : bouton **🖨️ Imprimer une grille A4** → « Enregistrer au format PDF » dans la boîte de dialogue d'impression. La feuille contient la grille vierge (catégories + cases vides) prête à remplir au stylo.

## Technique

- Site statique pur (HTML/CSS/JS), zéro build, zéro serveur applicatif.
- Multijoueur **WebRTC via PeerJS** (serveur de signalisation public gratuit de PeerJS) : l'hôte héberge la partie dans son navigateur, les joueurs se connectent directement entre eux par code de partie. Le code n'est jamais stocké nulle part.
- Dictionnaire français embarqué (`assets/dict.txt`, dérivé de *an-array-of-french-words*, licence MIT).
- Police Baloo 2 (Google Fonts), thème espace enfantin.
- Logique de jeu testable en Node : `node tests/rules.test.js`.

## Fichiers

```
index.html          page du jeu
css/style.css       thème + impression A4
js/rules.js         règles pures (normalisation, doublons, votes, scoring) — testable Node
js/net.js           réseau WebRTC (hôte / invité, code de partie)
js/app.js           interface et déroulement des manches
js/data.js          catégories prédéfinies, avatars
assets/dict.txt     dictionnaire FR (vérification auto)
vendor/peerjs.min.js  bibliothèque WebRTC (locale)
tests/rules.test.js tests Node des règles
```

## Développement local

Aucun build nécessaire : ouvre `index.html` via un petit serveur statique, ex. :

```bash
python3 -m http.server 8000
# puis http://localhost:8000
```

Tests : `node tests/rules.test.js`
docs: livraison directe sur main
