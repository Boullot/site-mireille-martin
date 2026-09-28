# Site de Mireille Martin

Site statique, sans framework et sans dépendance côté navigateur. Un script Python lit
le contenu (`content/`) et les photographies (`assets/originals/`) et écrit un site
complet dans `dist/`.

Le pari : dans dix ans, ce dossier devra encore se construire. Le build n'a besoin que de
Python ; pas de CMS, pas de webfont chargée depuis un CDN. La seule dépendance Node
(sharp) sert à la fonction d'administration, jamais au site.

## Comment le site se met à jour

```
admin (/admin/) ──► api/admin.js ──► un commit sur main ──► Vercel : npm ci + python3 build.py ──► en ligne
```

- **Git est la base de données.** Tout le contenu vit dans `content/` ; les images dans
  `assets/originals/` (sources) et `dist/img/` (dérivés, versionnés).
- **Le site reste 100 % statique.** L'admin n'écrit jamais dans le HTML : elle valide et
  commite des données, Vercel reconstruit tout le site et le bascule d'un bloc (~30 s).
  Rien n'est chargé après coup côté navigateur.
- **Un build raté ne casse rien** : `build.py` vérifie l'intégrité du contenu (`validate()`)
  et s'arrête en erreur ; Vercel garde alors la version précédente en ligne.
- Le HTML de `dist/` n'est plus versionné (reconstruit par Vercel). `dist/img/` l'est.
- Pillow n'est nécessaire qu'en local, pour fabriquer des dérivés manquants. Les images
  envoyées depuis l'admin sont dérivées par sharp dans la fonction (mêmes tailles, même
  carte Open Graph), si bien que le build distant n'utilise que la bibliothèque standard
  (Python 3.9+).

## Travailler en local

```bash
git pull                      # l'admin commite sur main : toujours partir de la dernière version
python3 -m venv .venv && .venv/bin/pip install -r requirements-build.txt
.venv/bin/python build.py     # → dist/
npm ci && npm test            # 28 tests : API admin complète contre un faux GitHub + build
```

Prévisualiser avec l'admin : `npm run dev` (http://localhost:3000), avec un `.env.local`
(voir plus bas) et `GITHUB_BRANCH` pointé sur **une branche de test**, jamais `main`.

## Espace administrateur

`/admin/` (lien discret « Administration » en pied de page). Un seul compte : `ADMIN_EMAIL`.
Rubriques : œuvres (photo, série, technique, formats, texte, mise en avant), séries et
familles, page d'accueil, démarche / critiques / récit, expositions et vues d'accrochage,
livre d'or, coordonnées.

### Variables d'environnement (Vercel)

| Variable | Valeur | Qui |
| --- | --- | --- |
| `ADMIN_EMAIL` | `michel.martin54@free.fr` | posée |
| `GITHUB_REPO` / `GITHUB_BRANCH` | `Boullot/site-mireille-martin` / `main` (preview : `admin-e2e`, inexistante exprès) | posées |
| `SITE_URL` | `https://site-mireille-martin.vercel.app` → le domaine définitif | posée |
| `CONTACT_TO` | `mireillemartin8@free.fr` | posée |
| `ADMIN_SECRET` | la valeur de `.env.local` (64 caractères hex) | **à poser** |
| `GITHUB_TOKEN` | jeton *fine-grained* limité à ce dépôt (voir ci-dessous) | **à poser** |
| `RESEND_API_KEY` / `MAIL_FROM` | voir « E-mails » | **à poser** |

Jeton GitHub : github.com → Settings → Developer settings → Fine-grained tokens → accès au
seul dépôt `site-mireille-martin`, permissions **Contents : Read and write**, **Variables :
Read and write**, **Commit statuses : Read**. Pas d'expiration (ou la plus longue possible,
et un rappel pour le renouveler : un jeton expiré bloque l'admin, jamais le site).

Diagnostic sans connexion : `/api/admin/?a=health` (ce qui est configuré, sharp chargé).

### Mot de passe

- `npm run invite` affiche le lien de création du mot de passe (valable 30 jours, un seul
  usage). Il lit `ADMIN_SECRET` et `SITE_URL` dans `.env.local`, qui doivent être identiques
  à Vercel. Le même lien sert à réinitialiser un mot de passe oublié.
- Le hachage (scrypt + clé serveur) vit dans la variable Actions privée `ADMIN_AUTH` du
  dépôt ; changer de mot de passe ferme toutes les sessions.
- Changer `ADMIN_SECRET` invalide le mot de passe et les sessions : renvoyer une invitation.

### E-mails (contact + mot de passe oublié)

[Resend](https://resend.com), offre gratuite. Il faut un domaine vérifié : créer le compte,
ajouter le domaine du site, poser chez le registrar les enregistrements DNS donnés par
Resend (SPF, DKIM), puis `RESEND_API_KEY` et `MAIL_FROM` (ex. `site@mireille-martin.fr`)
sur Vercel, et redéployer. Tant que ce n'est pas fait, le formulaire bascule tout seul sur
un lien `mailto:` pré-rempli, et « mot de passe oublié » renvoie vers Léo.

## Ce qu'il y a dans le dossier

```
content/          tout le texte et toutes les données, en JSON et en markdown allégé
  site.json       identité, contacts, liens, appartenances
  series.json     familles et séries, dans l'ordre d'affichage
  home.json       œuvre en grand et « Un choix d'œuvres » de l'accueil
  critiques.json  textes critiques de la page Démarche
  works.json      le catalogue
  views.json      52 vues d'accrochage, légendées
  exhibitions.json 64 expositions
  livre-dor.json  les extraits du livre d'or
  texts/          démarche, récit
assets/
  styles.css      toute la feuille de style, tokens compris
  app.js          thème, menu, filtres, visionneuse, formulaire
  originals/      les photographies sources, jamais retouchées par le build
admin/            l'espace administrateur (statique)
api/admin.js      son API : session, lecture, envoi d'image, enregistrement → commit
api/_lib/         auth, GitHub, validation des contenus, images (sharp), e-mails
api/contact.js    fonction serverless d'envoi du formulaire
scripts/          serveur local, lien d'invitation
tests/            tests de l'API admin (faux GitHub) et du build
build.py          le générateur
dist/             le site produit ; seul dist/img/ est versionné
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
