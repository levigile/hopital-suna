// =====================================================================
// common.js — Fonctions partagées entre index.html (app.js) et
// admin.html (admin.js) : accès Supabase, hash du sceau, échappement
// HTML, gestion de session, thème clair/sombre.
//
// Regrouper ce code évite la duplication (il était identique dans les
// deux fichiers) et centralise les points sensibles pour la sécurité
// (session, échappement) pour que les corrections s'appliquent
// automatiquement partout.
// =====================================================================

const SUPABASE_URL = 'https://kqqvjcyymbhxkrhjjhqm.supabase.co/rest/v1';
const SUPABASE_KEY = 'sb_publishable_VnpnG8C2ASnQfDUKLIAfQA_Uk1PaSTN';

const SUPA_HEADERS = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation'
};

// --- Petit helper d'erreur qui ne fait jamais fuiter le corps brut
// d'une réponse Postgrest dans l'UI (juste dans la console, pour debug) ---
async function supaError(res) {
  let detail = '';
  try { detail = await res.text(); } catch (_) {}
  console.error(`Supabase ${res.status} ${res.statusText}:`, detail);
  const err = new Error(detail || `Erreur ${res.status}`);
  err.status = res.status;
  err.raw = detail;
  return err;
}

// `minimal`: quand true, demande à Postgrest de ne pas renvoyer la ligne
// modifiée (Prefer: return=minimal). Indispensable pour les écritures sur
// `shinobis` : la colonne `sceau` n'est plus lisible par la clé publique
// (voir 02_rls_et_rpc.sql), donc une réponse "return=representation" sur
// cette table échouerait puisque Postgrest tenterait de la relire.
function headersFor(minimal) {
  return minimal ? { ...SUPA_HEADERS, 'Prefer': 'return=minimal' } : SUPA_HEADERS;
}

async function supaGet(table, query = '') {
  const res = await fetch(`${SUPABASE_URL}/${table}?${query}`, { headers: SUPA_HEADERS });
  if (!res.ok) throw await supaError(res);
  return res.json();
}

async function supaPost(table, data, minimal = false) {
  const res = await fetch(`${SUPABASE_URL}/${table}`, {
    method: 'POST', headers: headersFor(minimal), body: JSON.stringify(data)
  });
  if (!res.ok) throw await supaError(res);
  return minimal ? null : res.json();
}

async function supaPatch(table, query, data, minimal = false) {
  const res = await fetch(`${SUPABASE_URL}/${table}?${query}`, {
    method: 'PATCH', headers: headersFor(minimal), body: JSON.stringify(data)
  });
  if (!res.ok) throw await supaError(res);
  return minimal ? null : res.json();
}

// Toujours en mode minimal : aucun appelant n'utilise la ligne supprimée,
// et pour `shinobis` c'est requis (voir headersFor ci-dessus).
async function supaDelete(table, query) {
  const res = await fetch(`${SUPABASE_URL}/${table}?${query}`, { method: 'DELETE', headers: headersFor(true) });
  if (!res.ok) throw await supaError(res);
}

async function supaUpsert(table, data, query = '') {
  const res = await fetch(`${SUPABASE_URL}/${table}${query}`, {
    method: 'POST',
    headers: { ...SUPA_HEADERS, 'Prefer': 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw await supaError(res);
  return res.json();
}

// Appel d'une fonction Postgres exposée en RPC par Postgrest (ex:
// verifier_sceau, qui compare le sceau côté serveur sans jamais
// renvoyer sa valeur au navigateur).
async function supaRpc(fn, args = {}) {
  const res = await fetch(`${SUPABASE_URL}/rpc/${fn}`, {
    method: 'POST', headers: SUPA_HEADERS, body: JSON.stringify(args)
  });
  if (!res.ok) throw await supaError(res);
  return res.json();
}

// --- Hash du "sceau" (mot de passe RP) ---
// IMPORTANT (voir SECURITY.md) : ce hash SHA-256 côté client protège
// contre la lecture "à l'œil nu" d'un mot de passe en clair, mais ne
// protège PAS contre quelqu'un qui lit directement la table `shinobis`
// via la clé publique Supabase (anon key) : il pourrait alors essayer
// de casser les hashs hors-ligne. La vraie protection vient des règles
// RLS côté Supabase — voir SECURITY.md.
async function hashSceau(sceau) {
  const data = new TextEncoder().encode(sceau);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- Échappement HTML (obligatoire avant toute insertion via innerHTML
// de texte qui vient d'un utilisateur ou d'une source externe) ---
function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text == null ? '' : String(text);
  return d.innerHTML;
}

// --- Session ---
// On ne stocke JAMAIS le hash du sceau dans localStorage : un script
// tiers (extension malveillante, XSS ailleurs sur le domaine, accès
// physique au poste) qui lirait le localStorage n'a alors accès à
// aucun secret réutilisable pour se faire passer pour l'utilisateur
// ailleurs.
function sanitizeUserForStorage(user) {
  if (!user) return null;
  const { sceau, ...safe } = user;
  return safe;
}

function saveSession(key, user) {
  localStorage.setItem(key, JSON.stringify(sanitizeUserForStorage(user)));
}

function loadSession(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function clearSession(key) {
  localStorage.removeItem(key);
}

// --- Anti-brute-force basique côté client ---
// Ceci ne remplace pas une vraie limite côté serveur (facilement
// contournable en modifiant le JS local), mais décourage les essais
// répétés accidentels ou un script naïf lancé depuis la console.
// Voir SECURITY.md pour la vraie protection à mettre en place.
function makeLoginThrottle(storageKey, maxAttempts = 5, lockoutMs = 30000) {
  function state() {
    try { return JSON.parse(sessionStorage.getItem(storageKey)) || { count: 0, until: 0 }; }
    catch (_) { return { count: 0, until: 0 }; }
  }
  function save(s) { sessionStorage.setItem(storageKey, JSON.stringify(s)); }
  return {
    isLocked() {
      const s = state();
      return s.until > Date.now();
    },
    remainingSeconds() {
      const s = state();
      return Math.max(0, Math.ceil((s.until - Date.now()) / 1000));
    },
    registerFailure() {
      const s = state();
      s.count += 1;
      if (s.count >= maxAttempts) {
        s.until = Date.now() + lockoutMs;
        s.count = 0;
      }
      save(s);
    },
    registerSuccess() {
      save({ count: 0, until: 0 });
    }
  };
}

// --- Génère un mot de passe temporaire lisible (pour la création de
// comptes "observateur" côté gérance, à la place d'un sceau vide) ---
function generateTempSceau() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(36)).join('').slice(0, 10);
}

// --- Thème clair / sombre (identique sur les deux pages) ---
function initThemeToggle() {
  if (localStorage.getItem('hopital_theme') === 'dark') document.body.classList.add('dark');
  const ICO_SUN = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4 19 19M19 5l-1.6 1.6M6.6 17.4 5 19"/></svg>';
  const ICO_MOON = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13.5A7.5 7.5 0 1 1 10.5 4 6 6 0 0 0 20 13.5Z"/></svg>';
  const tbtn = document.getElementById('theme-toggle');
  if (!tbtn) return;
  const sync = () => { tbtn.innerHTML = document.body.classList.contains('dark') ? ICO_SUN : ICO_MOON; };
  sync();
  tbtn.addEventListener('click', () => {
    document.body.classList.toggle('dark');
    localStorage.setItem('hopital_theme', document.body.classList.contains('dark') ? 'dark' : 'light');
    sync();
  });
}
