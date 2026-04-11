# Precision Explorer v2 — Installation locale

Le générateur fonctionne **100 % en local** une fois la base OSM extraite.
Ce que GitHub ne contient pas (trop volumineux) : le PBF source, les tuiles
extraites, et `node_modules`. Voici les étapes à reproduire après un `git clone`.

## 1. Prérequis logiciels

| Outil | Version | Pourquoi |
|---|---|---|
| **Node.js** | ≥ 18 | exécution de `extract_trails.js` (parse du PBF) |
| **Python** | ≥ 3.8 | `python -m http.server` lancé par `start.bat` |
| **Navigateur** | Chrome/Edge récent | `DecompressionStream` pour lire les tuiles `.json.gz` |

Vérifier l'installation :
```bash
node --version
python --version
```

## 2. Télécharger le PBF OpenStreetMap

Le script attend le fichier **`v2/france-260408.osm.pbf`** (~4 Go).

1. Aller sur https://download.geofabrik.de/europe/france.html
2. Télécharger `france-latest.osm.pbf`
3. Le placer dans le dossier `v2/` et le **renommer** en `france-260408.osm.pbf`
   *(ou modifier la constante `PBF_PATH` en haut de `extract_trails.js`)*

> Pour ne couvrir qu'une région, télécharger un sous-fichier régional plus petit
> (ex. `rhone-alpes-latest.osm.pbf`, ~500 Mo) et adapter `PBF_PATH`.

## 3. Installer les dépendances Node

```bash
cd v2
npm install
```

Installe `osm-pbf-parser` et `through2`. Crée le dossier `v2/node_modules/`
(ignoré par git).

## 4. Extraire les tuiles depuis le PBF

```bash
cd v2
npm run extract
```

Ce qui équivaut à `node --max-old-space-size=8192 extract_trails.js`.

- Lit le PBF en 2 passes (chemins, puis coordonnées)
- Filtre uniquement les `highway=track | path | unclassified`
- Groupe en tuiles de 0.1° × 0.1° (~11 km)
- Compresse chaque tuile en `.json.gz` (gain ~70 %)
- Écrit `v2/tiles/{ty}_{tx}.json.gz` + `v2/tiles/meta.json`

**Durée** : ~10–20 min pour la France entière sur SSD.
**Taille finale** : ~460 Mo de tuiles compressées (France complète).
**RAM** : ~6–8 Go pendant l'extraction (d'où le `--max-old-space-size=8192`).

## 5. Lancer le générateur

Double-clic sur **`v2/start.bat`** (Windows) :
- démarre `python -m http.server 8080`
- ouvre automatiquement http://localhost:8080/gpx_enduro_generator.html

Sur Linux/Mac, l'équivalent :
```bash
cd v2
python3 -m http.server 8080
# puis ouvrir http://localhost:8080/gpx_enduro_generator.html
```

> **Important** : ne pas ouvrir le HTML directement avec `file:///` — le
> navigateur bloque alors `fetch()` sur les tuiles locales (CORS) et le
> générateur retombe sur Overpass en ligne.

## 6. Vérifier que tout fonctionne

Au premier clic sur **Générer**, le journal doit afficher :
```
[Tuiles] XXXXXXX chemins, YYYY tuiles locales
[Tuiles] Chargement N tuiles locales...
[Tuiles] ZZZZZ pistes/chemins (local, instantane)
```

Si tu vois `[Reseau] overpass.kumi.systems ...` à la place, c'est que les
tuiles ne sont pas trouvées : vérifie que `v2/tiles/meta.json` existe et que
le serveur HTTP sert bien le dossier `v2/`.

## Notes mode Ultra Hard

Le niveau 4 (Ultra Hard) utilise en plus l'API **Open-Meteo** pour récupérer
l'altitude des nœuds et calculer les pentes. Pas de clé API, mais quota
journalier ~10 000 requêtes. Les altitudes sont mises en cache dans
`localStorage` (`elevCache_v1`) pour ne pas refaire les appels d'une session
à l'autre. Si le quota est épuisé, le générateur abandonne rapidement et
poursuit avec des données partielles.
