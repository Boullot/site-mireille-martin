# Site de Mireille Martin

Site statique, sans framework et sans dépendance côté navigateur. Un script Python lit
le contenu (`content/`) et les photographies (`assets/originals/`) et écrit un site
complet dans `dist/`.

Le pari : dans dix ans, ce dossier devra encore se construire. Pas de `node_modules`,
pas de CMS, pas de webfont chargée depuis un CDN.

## Construire

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-build.txt
.venv/bin/python build.py
```

Résultat : `dist/` (117 pages, ~700 fichiers image dérivés). Prévisualiser :

```bash
cd dist && python3 -m http.server 8000
```

Les images dérivées sont conservées entre deux builds (`dist/img/` n'est pas effacé).
Pour tout régénérer : `rm -rf dist/img`.

## Déployer

Le site est préconstruit dans `dist/` (Pillow / Python 3.14 casse sur
Vercel). Workflow :

1. Modifier le contenu ou les photos localement
2. Relancer `build.py`
3. Committer `dist/` et pousser — Vercel sert `dist/` tel quel

Dans le dashboard Vercel : Framework **Other**, pas d’override de
Build / Install (tout est dans `vercel.json`).

### Formulaire de contact

`api/contact.js` est une fonction serverless qui envoie le message par
[Resend](https://resend.com) (offre gratuite : 3 000 envois/mois). Trois variables
d'environnement à définir dans le projet Vercel :

| Variable | Valeur |
| --- | --- |
| `RESEND_API_KEY` | la clé API Resend |
| `CONTACT_TO` | `mireillemartin8@free.fr` |
| `CONTACT_FROM` | une adresse du domaine vérifié chez Resend, ex. `site@mireille-martin.fr` |

Tant qu'elles ne sont pas définies, la fonction répond `503` et le formulaire bascule
tout seul sur un lien `mailto:` pré-rempli. Rien n'est cassé, l'envoi passe juste par le
logiciel de messagerie du visiteur.

## Ajouter une œuvre

1. Déposer la photographie dans `assets/originals/` sous le nom `mon-slug.jpg`
   (JPEG, le plus grand côté à 2000 px au minimum, cadrage serré sur la toile).
2. Ajouter une entrée dans `content/works.json` :

```json
{
  "title": "Aller Retour XXXVI",
  "series": "aller-retour",
  "group": "Aller Retour",
  "technique": "Acrylique sur toile",
  "dimensions": ["60 × 80"],
  "note": null,
  "slug": "aller-retour-xxxvi",
  "untitled": false,
  "file": "aller-retour-xxxvi.jpg"
}
```

3. Relancer `build.py`.

`series` doit valoir `aller-retour`, `peintures`, `carregraphies` ou `encres`.
`group` est le sous-ensemble affiché en intertitre. `note` sert à l'idéogramme chinois
des Carrégraphies.

## Ajouter une exposition

`content/exhibitions.json`. Les entrées de `exhibitions` sont triées automatiquement par
la clé `sort` (`"AAAA-MM"`). Les entrées de `upcoming` s'affichent en haut de la page
Expositions **et** sur la page d'accueil, sous « Prochainement » ; quand `upcoming` est
vide, l'accueil retombe sur les trois dernières expositions passées.

## Ce qu'il y a dans le dossier

```
content/          tout le texte et toutes les données, en JSON et en markdown allégé
  site.json       identité, contacts, liens, appartenances
  works.json      le catalogue : 108 œuvres
  views.json      52 vues d'accrochage, légendées
  exhibitions.json 64 expositions
  livre-dor.json  les extraits du livre d'or
  texts/          démarche, critique, récit
assets/
  styles.css      toute la feuille de style, tokens compris
  app.js          thème, menu, filtres, visionneuse, formulaire
  originals/      les photographies sources, jamais retouchées par le build
api/contact.js    fonction serverless d'envoi du formulaire
build.py          le générateur
dist/             le site produit — versionné pour Vercel ; régénéré par build.py
```

## Notes techniques

- **Polices** : Optima pour les titres, SF Pro pour le texte, SF Mono pour les libellés.
  Toutes présentes sur macOS et iOS ; ailleurs, la pile de repli tient (Gill Sans,
  Avenir Next, Segoe UI). Aucun chargement réseau.
- **Images** : WebP en quatre largeurs (420/840/1400/2000) avec `srcset`, plus un JPEG
  de repli à 1000 px. Une carte Open Graph 1200 × 630 est générée par œuvre.
- **Thème** : clair par défaut, sombre selon le réglage système, et un bouton qui
  écrit `data-theme` sur `<html>` — une seule source de vérité, l'attribut l'emporte
  toujours sur la media query.
- **SEO** : une page par œuvre avec JSON-LD `VisualArtwork`, fil d'Ariane, `sitemap.xml`,
  `robots.txt`, métadonnées Open Graph complètes.
- **Aucun traceur, aucun cookie.**
