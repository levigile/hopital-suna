# Sécurité du site — Hôpital de Sunagakure

Ce document explique honnêtement ce qui a été amélioré dans le code, et surtout ce qui **ne peut pas être corrigé sans accès au tableau de bord Supabase**. Comme tu m'as indiqué ne pas avoir cet accès, transmets cette page à la personne qui gère le projet Supabase (celle qui a créé le compte / le projet `bublcszbqqedcqhbwoak`).

## 1. Ce qui a été corrigé dans le code (déjà fait)

- **Faille XSS corrigée** : le nom/prénom d'un shinobi s'affichait sans échappement dans la liste des alertes actives. Un shinobi malintentionné aurait pu s'inscrire avec un nom contenant du code, puis déclencher une alerte pour l'exécuter dans le navigateur de tout le personnel connecté. C'est corrigé.
- **Le sceau (mot de passe) n'est plus stocké dans le navigateur** : avant, le hash du sceau était conservé dans `localStorage` avec le reste du profil. Il n'est plus jamais écrit sur le disque du visiteur.
- **Comptes "observateur" réellement impossibles à utiliser pour se connecter** : la gérance peut ajouter un observateur sans compte. Avant, son sceau était enregistré comme une chaîne vide — ce qui revenait, avec l'ancien mécanisme, à un mot de passe connu de tous ("rien"), permettant à n'importe qui de se connecter sous cette identité. Le sceau est maintenant un secret aléatoire, jamais affiché ni réutilisable.
- **Messages d'erreur de connexion plus prudents** : la page de gérance ne dit plus "accès refusé, ce n'est pas un gérant" (ce qui confirmait qu'un mot de passe était correct) — elle renvoie le même message générique que pour une identité invalide.
- **Freinage basique contre les essais répétés** : après plusieurs échecs de connexion, un court blocage s'applique. (Ce n'est qu'une gêne côté navigateur, voir limite ci-dessous.)
- **Champs limités en longueur** (nom, prénom, sceau) là où ils ne l'étaient pas, pour éviter des saisies abusives.
- **Code dédupliqué** : les deux pages partagent maintenant `common.js` (accès Supabase, hash, échappement HTML, session) au lieu d'avoir deux copies qui pouvaient diverger silencieusement.
- **Petits bugs visuels corrigés** : certains messages utilisaient des couleurs CSS (`var(--danger)`, `var(--success)`) qui n'étaient définies nulle part et ne s'affichaient donc jamais correctement.

Le style visuel (sable, Cinzel/Noto Sans JP, mise en page) n'a volontairement pas changé.

## 2. Ce qui NE PEUT PAS être corrigé sans accès à Supabase — et pourquoi c'est important

Le site appelle directement l'API REST de Supabase avec une clé (`sb_publishable_...`) écrite en clair dans le JavaScript. **C'est normal et voulu par Supabase** : cette clé est publique par nature, exactement comme une adresse de guichet. Ce n'est pas elle le problème.

Le vrai problème : **la vraie sécurité, avec Supabase, se fait avec des règles "Row Level Security" (RLS) côté serveur, sur chaque table.** Si elles ne sont pas configurées (ce qui semble être le cas ici, vu que le site fonctionne en lisant/écrivant librement toutes les tables avec juste la clé publique), alors **n'importe qui peut, sans même utiliser le site** :
- lire la table `shinobis` en entier — y compris la colonne `sceau` (les hash des mots de passe) — avec une simple requête `curl` en utilisant la clé visible dans `app.js` ;
- créer, modifier ou supprimer n'importe quelle alerte, poste, dossier patient, avertissement, ligne de paye, message de chat de gérance, etc., toujours avec cette même clé, sans jamais se connecter.

Aucune modification du JavaScript ne peut empêcher ça : le JavaScript ne fait que décider quoi *afficher*, pas qui a le droit de lire ou écrire dans la base. Cette limite est fixe tant que RLS n'est pas activé.

### Ce qu'il faut demander à la personne qui gère le projet Supabase

1. Ouvrir chaque table dans **Table Editor → (table) → RLS** et l'activer ("Enable RLS").
2. Ajouter des politiques. Ci-dessous un point de départ **à adapter** au schéma réel (les noms de colonnes ci-dessous sont déduits du code, à vérifier avant d'exécuter) :

```sql
-- Active RLS sur toutes les tables du jeu de rôle
alter table shinobis enable row level security;
alter table postes enable row level security;
alter table alertes enable row level security;
alter table planning_cours enable row level security;
alter table planning_participations enable row level security;
alter table lavande enable row level security;
alter table patient_blessures enable row level security;
alter table patient_fiches enable row level security;
alter table cours enable row level security;
alter table config enable row level security;
alter table paye_versements enable row level security;
alter table avertissements enable row level security;
alter table messages_gerance enable row level security;

-- Empêche la lecture de la colonne sceau (mot de passe) via l'API publique.
-- Le rôle "anon" perd le droit SELECT sur cette colonne précise.
revoke select (sceau) on shinobis from anon;

-- Exemple de politique de lecture publique minimale (à ajuster) :
create policy "lecture publique shinobis (sans sceau)"
  on shinobis for select
  to anon
  using (true);
```

**Important : sans une vraie authentification Supabase (voir §3), RLS ne peut pas savoir "qui" fait la requête** — toutes les requêtes arrivent avec la même clé publique, quel que soit le shinobi connecté dans l'app. RLS peut donc bloquer les accès depuis l'extérieur du site (curl, scripts), mais ne peut pas empêcher un utilisateur du site de modifier des données au nom d'un autre en trafiquant les requêtes depuis la console du navigateur — tant que ce point n'est pas réglé, il faut considérer que **tout utilisateur connecté a de facto les mêmes droits d'écriture que la gérance**, quoi que montre l'interface.

## 3. La vraie solution, pour plus tard : migrer vers Supabase Auth

La façon standard et robuste de résoudre ça est de remplacer le système `shinobis.sceau` fait maison par **Supabase Auth** (email/mot de passe ou lien magique). Cela permet à Supabase de savoir *réellement* qui fait chaque requête (via `auth.uid()`), et les politiques RLS peuvent alors dire des choses comme *"un membre ne peut modifier que ses propres postes"* ou *"seuls les gérants peuvent changer un rôle"*, avec une vraie garantie côté serveur.

C'est un changement d'architecture (migration des comptes existants, mise à jour des formulaires de connexion) qui dépasse un nettoyage de code — je peux vous accompagner dessus si vous voulez, mais il faut un accès complet au projet Supabase (dashboard + éventuellement service role key, à ne jamais mettre dans le frontend) pour le faire correctement.

## 4. Résumé pour la personne pressée

- Le code du site est maintenant plus propre, sans la faille XSS trouvée, et sans mot de passe stocké côté navigateur.
- **Le point le plus urgent est côté Supabase, pas côté code** : sans RLS, toute la base est lisible et modifiable par n'importe qui connaissant l'URL et la clé publique (visibles dans le code source de la page). Fais suivre ce fichier à qui gère le projet Supabase.
