# 🚀 Petit Bac

Jeu du **petit bac** multijoueur en direct, optimisé mobile, 100 % gratuit (hébergé sur GitHub Pages, aucun serveur payant).

## Jouer

Ouvre simplement : **https://Seakluft.github.io/petitbac/**

- L'**hôte** crée une partie et obtient un **code à 5 caractères** (ex : `K7XQM`) + un lien d'invitation à partager.
- Les autres joueurs entrent leur prénom + le code pour rejoindre **en direct**.
- Le lien d'invitation contient le code (`#room=K7XQM`) : un clic et on est pré-rempli.

## Règles

- Chaque manche tire une **lettre au hasard** (K, W, X, Y, Z exclus sauf option « lettres difficiles »).
- Chaque joueur remplit **une case par catégorie** avec un mot commençant par la lettre.
- **Barème standard** : mot **unique** = **2 pts** ; mot **partagé** (doublon détecté automatiquement, insensible à la casse/accents) = **1 pt** ; case vide, hors sujet ou refusé = **0 pt**.
- **Vérification en deux niveaux** :
  - un dictionnaire général embarqué (~600 000 entrées : mots français complets + prénoms/noms + villes + pays) valide l'existence du mot ;
  - une **validation par catégorie** : chaque catégorie reconnue (Ville, Pays, Animal, Prénom, Fruit, Légume, Métier, Couleur, Objet, Aliment…) a sa propre liste (`assets/villes.txt` ~85 000 villes, `assets/pays.txt`, `assets/animaux.txt` ~3 200 animaux, `assets/prenoms.txt` ~200 000 prénoms, listes embarquées pour le reste). Exemple : « banane » dans **Ville** = hors catégorie (0 pt ou vote), « paris » dans **Ville** = OK ;
  - listes dédiées aussi pour **Célébrité** (`celebrites.txt`) et **Film/Série** (`films.txt`)
  - les mots hors catégorie ou inconnus passent au **vote des joueurs** (👍/👎, majorité, égalité = refusé). **La manche ne passe aux scores que quand tous les joueurs ont voté.**
- Timer optionnel (15–300 s, réglable) ou mode « sans timer » : la manche se termine quand tout le monde a fini.
- Nombre de manches réglable (1–10), 2 à 10 joueurs.

## Catégories

- **Liste prédéfinie** (~36 catégories regroupées et logiques : Prénom, Nom de famille, Animal, **Fruits & légumes**, Aliment/Boisson, Objet du quotidien, Métier, Couleur, **Ville**, **Pays**, **Géographie (montagne, fleuve, mer…)**, Célébrité/Personnage, Film ou série, Chanson/Groupe, Jeu vidéo, Livre, Marque, Sport, Instrument, Véhicule, Fromage, Pâtisserie, École, Partie du corps, Maladie, Danse, Fête, Monument, Expression, Parfum, Insecte, Oiseau, Poisson/Coquillage, Plante/Fleur, Métal, Pierre précieuse, Parc d'attractions, Planète/Objet de l'espace, Dinosaure, Créature imaginaire, Super-pouvoir, Robot) dans laquelle l'hôte coche ce qu'il veut.
- **Catégories personnalisées** ajoutables à la main, avec **badge de vérification** : si le nom correspond à une liste connue (ex. tu crées « Géographie » → ville + pays + montagnes/fleuves/mers, « Fruits & légumes » → fruits + légumes), les mots sont vérifiés automatiquement (badge ✅) ; sinon ils passent au vote (badge 🗳️). Les **groupes multi-listes** sont supportés.
- **Nombre de cases modifiable** : entre 3 et 15 catégories par manche.

## Version imprimable (PDF)

Depuis l'écran de configuration ou le salon : bouton **🖨️ Imprimer une grille A4** → « Enregistrer au format PDF » dans la boîte de dialogue d'impression. La feuille est en **A4 paysage**, façon grille classique : **lettres A à Z en colonnes**, **catégories en lignes** (Prénom, Animal, Fruit ou légume, Ville ou pays, Objet, Métier, Star ou personnage, Film ou série), avec une **colonne POINTS** et un **pointage final** — prête à remplir au stylo.

## Technique

- Site statique pur (HTML/CSS/JS), zéro build, zéro serveur applicatif.
- Multijoueur **WebRTC via PeerJS** (serveur de signalisation public gratuit de PeerJS) : l'hôte héberge la partie dans son navigateur, les joueurs se connectent directement entre eux par code de partie. Le code n'est jamais stocké nulle part.
- Dictionnaire embarqué (`assets/dict.txt`, ~600 000 entrées : mots français complets + prénoms + noms de personnes + ~80 000 villes + pays/capitales).
- Interface inspirée des meilleurs jeux casual mobiles (Wordle, Duolingo, StopotS) : **accueil en 1 champ** (prénom + créer/rejoindre), code de partie XXL, **boutons d'action fixes en bas** (pouce-friendly), lettre géante animée, **anneau de timer circulaire**, **points de progression des manches** ●●○○, **podium 🥇🥈🥉**, champs qui se colorent en direct (vert ✔ / jaune ❓), **modal « Règles en 30 secondes »**, sélecteur d'**avatar** au salon, vibrations mobiles, barre d'actions floutée
- Direction artistique **« carnet d'écolier » par défaut** (thème 🖍️) : papier quadrillé kraft, bordures dessinées à la main (coins irréguliers), ombres dures style crayon, police manuscrite Patrick Hand + Nunito — plus de dégradés violets génériques
- **6 thèmes au choix** mémorisés localement : 🖍️ carnet (défaut), 🚀 espace, 🌴 jungle, 🌊 océan, 🍬 bonbon, 🪟 **Windows XP**
- **Reconnexion** : fermer l'onglet puis rouvrir avec le même code + même prénom = on retrouve sa place, même en pleine manche
- **Chat rapide** à boutons prédéfinis (🛑 Stop !, 👏 Bravo !…) dans le salon et pendant la manche
- **Sons** générés en WebAudio (zéro fichier) + bouton muet 🔇, **confettis** sur le gagnant
- **Partage natif** de l'invitation (Web Share API sur mobile, copie presse-papiers sinon)
- Statut en direct : qui a terminé sa saisie pendant la manche
- Logique de jeu testable en Node : `node tests/rules.test.js`.

## Fichiers

```
index.html          page du jeu
css/style.css       thème + impression A4
js/rules.js         règles pures (normalisation, doublons, votes, scoring) — testable Node
js/net.js           réseau WebRTC (hôte / invité, code de partie)
js/app.js           interface et déroulement des manches
js/data.js          catégories prédéfinies, avatars
assets/dict.txt     dictionnaire FR élargi ~600k entrées (vérification auto)
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
