# Vercel Dynamic Proxy

Un **seul** projet Vercel qui sert de reverse-proxy à routage dynamique pour
toutes vos applications web **et** mobile. Chaque app appelle ce proxy ; le
proxy identifie automatiquement le backend de destination (vos services Render,
souvent inaccessibles directement sans VPN) et relaie la requête.

```
  app_x (web)   ─┐
  app_x (mobile)─┤                      ┌─► back_x  (https://back-x.onrender.com)
  app_y (web)   ─┼─►  Vercel proxy  ────┤
  app_y (mobile)─┘   (ce projet)        └─► back_y  (https://back-y.onrender.com)
```

Pourquoi : Render n'est pas toujours joignable depuis votre zone (VPN requis),
mais Vercel l'est. Au lieu de configurer un proxy par projet front (et sans
solution pour le mobile), **un seul proxy** centralise tout. Ajouter une app =
un clic dans l'**interface d'administration** (`/__admin`) — **sans redéploiement**.

---

## Comment fonctionne le routage

Le proxy détermine la destination dans cet ordre (le premier qui matche gagne) :

| # | Mécanisme | Exemple | Chemin transmis au backend |
|---|-----------|---------|----------------------------|
| 1 | **Header explicite** `X-Proxy-Target` | `X-Proxy-Target: app_x` + `GET /api/users` | `/api/users` (chemin complet) |
| 2 | **Hôte** (domaine personnalisé) | `api-x.mondomaine.com/api/users` | `/api/users` (chemin complet) |
| 3 | **Préfixe de chemin** (par défaut) | `GET /app_x/api/users` | `/api/users` (préfixe `/app_x` retiré) |

Le **préfixe de chemin** est le mode recommandé : identique pour le web et le
mobile, il suffit de configurer l'URL de base de l'app.

```
https://mon-proxy.vercel.app/app_x/api/users   ─►  https://back-x.onrender.com/api/users
https://mon-proxy.vercel.app/app_y/api/orders  ─►  https://back-y.onrender.com/api/orders
```

> Ce n'est **pas** un open-proxy : seules les destinations déclarées dans la
> configuration sont joignables. Une clé partagée optionnelle peut verrouiller
> l'accès.

---

## Déploiement (5 minutes)

1. **Importer ce dossier dans Vercel**
   - Soit via `git push` d'un repo + import depuis le dashboard Vercel.
   - Soit en local :
     ```bash
     npm i -g vercel
     vercel link        # crée/associe le projet
     vercel deploy --prod
     ```
   - Le framework détecté est « Other » : aucune configuration de build n'est
     nécessaire, `vercel.json` route déjà tout vers `api/proxy.ts`.

2. **Configurer les routes** (Project → Settings → Environment Variables) :
   ```
   PROXY_ROUTES = {"app_x":"https://back-x.onrender.com","app_y":"https://back-y.onrender.com"}
   ```

3. **Redéployer** pour appliquer les variables, puis vérifier :
   ```bash
   curl https://mon-proxy.vercel.app/__proxy/health
   # { "status": "ok", "routes": ["app_x", "app_y"], ... }
   ```

C'est tout. Vos apps pointent désormais vers `https://mon-proxy.vercel.app/<appKey>/...`.

---

## Configuration (variables d'environnement)

Voir [`.env.example`](.env.example) pour la liste commentée complète.

### Routes (obligatoire)

**Option A — un seul JSON** (recommandé) :
```
PROXY_ROUTES = {
  "app_x": "https://back-x.onrender.com",
  "app_y": { "target": "https://back-y.onrender.com", "stripPrefix": true, "key": "secret-y" }
}
```
Forme objet par route :
| Champ | Défaut | Rôle |
|-------|--------|------|
| `target` | — | URL de base du backend (obligatoire) |
| `stripPrefix` | `true` | retire `/<appKey>` avant de transmettre |
| `keySecret` | — | secret partagé par route (header `X-Proxy-Key`) |
| `hosts` | — | tableau de domaines personnalisés routés vers cette route |
| `disabled` | `false` | conserve la route mais cesse de la servir |
| `timeoutMs` | global | timeout spécifique à ce backend |

> ⚠️ Avec un store connecté (Upstash, voir plus bas), `PROXY_ROUTES`/`ROUTE_*`
> ne servent qu'à **amorcer** un store vide : la gestion se fait ensuite via
> l'**interface d'administration**. Sans store, ils restent la source de vérité.

**Option B — une variable par route** :
```
ROUTE_APP_X = https://back-x.onrender.com     # → clé "app_x"
ROUTE_APP_Y = https://back-y.onrender.com     # → clé "app_y"
```

### Options globales

| Variable | Défaut | Rôle |
|----------|--------|------|
| `ADMIN_KEY` | — | **active** l'API + l'UI d'admin `/__admin` ; non défini = admin désactivé |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | — | store persistant (voir « Stockage ») |
| `PROXY_GLOBAL_KEY` | — | si défini, exige `X-Proxy-Key` sur **toutes** les requêtes |
| `PROXY_ALLOWED_ORIGINS` | `*` | origines CORS autorisées (liste séparée par virgules) |
| `PROXY_ALLOW_CREDENTIALS` | `false` | autorise les credentials CORS (reflète l'origine) |
| `PROXY_TIMEOUT_MS` | `55000` | timeout amont (marge pour le cold start Render) |
| `PROXY_MAX_RETRIES` | `1` | retries sur erreur réseau (méthodes idempotentes) |
| `PROXY_TARGET_HEADER` | `x-proxy-target` | nom du header de ciblage explicite |

> Le routage par domaine se configure désormais **par route** (champ `hosts`),
> via `PROXY_ROUTES` ou l'UI d'admin — il n'y a plus de variable `PROXY_HOSTS`.

---

## Interface d'administration (gérer les destinations sans redéployer)

Plus besoin de modifier une variable d'environnement pour ajouter / éditer /
supprimer une destination : tout se fait depuis une UI.

1. Définir `ADMIN_KEY` (un secret long et aléatoire) dans les variables d'env.
2. Ouvrir `https://mon-proxy.vercel.app/__admin`, coller le token.
3. Ajouter / éditer / supprimer / **tester** les destinations. Les changements
   sont pris en compte en quelques secondes (cache TTL), sans redéploiement.

> Sans `ADMIN_KEY`, l'admin renvoie `403` — impossible de laisser un panneau
> ouvert par mégarde en production.

**API d'admin** (token via header `Authorization: Bearer <ADMIN_KEY>` ou `X-Admin-Key`) :

| Méthode & endpoint | Rôle |
|--------------------|------|
| `GET /__proxy/admin/routes` | lister les routes |
| `POST /__proxy/admin/routes` | créer/mettre à jour (corps JSON `{key,target,stripPrefix,keySecret?,hosts?,disabled?}`) |
| `DELETE /__proxy/admin/routes/:key` | supprimer une route |
| `POST /__proxy/admin/test` | sonder un backend (`{key}` ou `{target}`) |

```bash
curl -X POST https://mon-proxy.vercel.app/__proxy/admin/routes \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"key":"app_z","target":"https://back-z.onrender.com"}'
```

## Stockage des routes

| Backend | Quand | Persistance |
|---------|-------|-------------|
| **Mémoire** (défaut) | dev local / tests | éphémère (par instance, perdu au redéploiement) |
| **Upstash Redis** | production | persistant, écritures immédiates |

En production, connectez **Upstash for Redis** depuis le Vercel Marketplace : il
injecte `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`, le proxy le détecte
automatiquement et y stocke les routes (amorcées depuis `PROXY_ROUTES` au premier
démarrage si le store est vide). Le hot path lit via un cache mémoire à TTL, donc
la grande majorité des requêtes ne touche pas Redis. ([Redis sur Vercel](https://vercel.com/docs/redis))

---

## Utilisation côté client

### Web (React / Vue / etc.)

```js
// Une seule base URL pointant vers le proxy + la clé de l'app.
const API = "https://mon-proxy.vercel.app/app_x";

const res = await fetch(`${API}/api/users`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Ada" }),
});
```

Le CORS est géré par le proxy ; configurez `PROXY_ALLOWED_ORIGINS` avec le
domaine de votre front si vous voulez restreindre.

### Mobile (React Native / Flutter / natif)

Identique au web — il suffit de définir l'URL de base :

```js
// React Native
const API_BASE = "https://mon-proxy.vercel.app/app_x";
fetch(`${API_BASE}/api/profile`);
```

```dart
// Flutter / Dio
final dio = Dio(BaseOptions(baseUrl: "https://mon-proxy.vercel.app/app_x"));
await dio.get("/api/profile");
```

> Les apps mobiles n'ont pas de contrainte CORS : le proxy fonctionne sans
> configuration supplémentaire.

### Variante sans préfixe (header)

Si vous préférez ne pas préfixer les chemins :
```js
fetch("https://mon-proxy.vercel.app/api/users", {
  headers: { "X-Proxy-Target": "app_x" },
});
```

---

## Sécurité

- **Liste blanche implicite** : seules les clés configurées sont routables, les
  destinations sont fixées par la config (pas d'open-proxy).
- **Clé partagée optionnelle** : `PROXY_GLOBAL_KEY` (globale) ou `keySecret` par
  route. Envoyée via le header `X-Proxy-Key`. Comparaison à temps constant.
  > Pour le mobile, une clé statique embarquée n'est pas un vrai secret : c'est
  > une couche de dissuasion, pas une authentification. Conservez l'auth
  > applicative (JWT, etc.) côté backend.
- **Admin verrouillé** : token `ADMIN_KEY` obligatoire (sinon admin désactivé),
  comparaison à temps constant ; la page UI ne contient aucun secret.
- **Headers nettoyés** : les headers hop-by-hop et de contrôle (`X-Proxy-*`) ne
  sont jamais transmis au backend ; `X-Forwarded-Host/Proto/For` sont ajoutés.
- **Boucles** : Vercel empêche automatiquement les boucles de proxy (`x-vercel-id`).

---

## Endpoints de diagnostic

| Endpoint | Description |
|----------|-------------|
| `GET /__proxy/health` | état, backend de stockage, nombre de routes, avertissements |
| `GET /__proxy/routes` | mapping complet (cibles incluses) — exige `X-Proxy-Key` si `PROXY_GLOBAL_KEY` est défini |
| `GET /__admin` + `…/admin/*` | interface et API d'administration (voir plus haut) |

---

## Développement local

```bash
npm install
npm run typecheck     # vérification TypeScript
npm test              # 43 tests (unitaires + intégration : proxy, store, admin)

# Optionnel : émuler la plateforme Vercel en local
cp .env.example .env  # renseigner PROXY_ROUTES + ADMIN_KEY
npm run dev           # vercel dev  (nécessite la CLI Vercel)
```

---

## Architecture du code

```
api/
  proxy.ts        Entrypoint Vercel (signature Web fetch, runtime Node.js)
src/
  types.ts        Types partagés (RouteRecord, Settings, ResolvedConfig)
  settings.ts     Settings env + parsing des routes d'amorçage (seed)
  store.ts        Stockage mutable : MemoryStore, UpstashStore, cache TTL, resolveConfig()
  router.ts       Résolution de la destination (header → hôte → préfixe) — pur
  headers.ts      Filtrage des headers hop-by-hop + headers de forwarding
  cors.ts         Préflight et headers CORS
  admin.ts        API CRUD + UI d'administration (/__admin)
  util.ts         Comparaison à temps constant
  proxy.ts        Handler principal : streaming, timeout, retry, erreurs, /__proxy/*
test/
  unit.test.ts    Tests purs (settings, routeur, parsing de chemin)
  proxy.test.ts   Tests d'intégration du proxy de bout en bout
  store.test.ts   Tests des backends (mémoire + faux serveur Upstash)
  admin.test.ts   Tests de l'API d'admin (auth + CRUD + proxy à chaud)
vercel.json       Rewrite catch-all → api/proxy + maxDuration
```

### Choix techniques

- **Runtime Node.js** (et non Edge, désormais déprécié par Vercel) via la
  signature Web `fetch` : `fetch`/`Request`/`Response` natifs, **streaming** des
  corps de requête et de réponse, pas de tampon mémoire.
- **Rewrite catch-all** : `vercel.json` envoie tout vers `api/proxy.ts`. Le
  chemin original est récupéré depuis `request.url` (cas nominal) avec repli sur
  le paramètre `__path` injecté par le rewrite (robustesse maximale).
- **Streaming + timeout via `AbortController`**, retries bornés sur les méthodes
  idempotentes uniquement (pas de double POST), `maxDuration: 60s` pour absorber
  les cold starts Render.
- **Stockage abstrait** (`RouteStore`) à backends interchangeables (mémoire /
  Upstash Redis), source de vérité + cache mémoire à TTL sur le hot path, et
  invalidation immédiate à chaque écriture admin. Prêt à accueillir un backend
  Postgres pour une évolution multi-tenant / SaaS.
```
