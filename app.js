// =====================================================================
// app.js — Hôpital de Sunagakure (espace membre)
// Dépend de common.js (chargé avant ce fichier) pour : SUPABASE_URL,
// supaGet/supaPost/supaPatch/supaDelete, hashSceau, escapeHtml,
// saveSession/loadSession/clearSession, makeLoginThrottle, initThemeToggle.
// =====================================================================

const SESSION_KEY = 'hopital_session';

// --- Icônes SVG ---
const _S = 'class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const ICO_WARN = `<svg ${_S}><path d="M12 3.5 2.5 20h19L12 3.5Z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.4" r="0.6" fill="currentColor" stroke="none"/></svg>`;
const ICO_SCISSORS = `<svg ${_S}><circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><path d="M8 7.2 20 17M8 16.8 20 7"/></svg>`;

let currentUser = null;
let enPoste = false;
let posteId = null;
let refreshInterval = null;
let annuaire = [];
let tauxLavande = 100;
let lastPlanning = [];
let editingPlanningId = null;

const loginThrottle = makeLoginThrottle('hopital_login_throttle');

// --- Time logic ---
function isServerOpen() {
  const now = new Date();
  const totalMin = now.getHours() * 60 + now.getMinutes();
  // 18h30 (1110) à 3h00 (180) — traverse minuit
  return totalMin >= 1110 || totalMin < 180;
}

function updateClock() {
  const now = new Date();
  document.getElementById('clock').textContent =
    now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const open = isServerOpen();
  const statusCard = document.getElementById('server-status');
  const indicator = statusCard.querySelector('.status-indicator');
  const text = statusCard.querySelector('span:last-child');

  if (open) {
    indicator.className = 'status-indicator online';
    text.textContent = "L'hôpital est ouvert — Service actif";
  } else {
    indicator.className = 'status-indicator offline';
    text.textContent = 'Le village est endormi — Hors horaires de service';
  }

  const btnPoste = document.getElementById('btn-poste');
  const btnUrgence = document.getElementById('btn-urgence');
  const btnChirurgien = document.getElementById('btn-chirurgien');

  if (open && currentUser) {
    btnPoste.disabled = false;
    btnUrgence.disabled = !enPoste;
    btnChirurgien.disabled = !enPoste;
  } else {
    if (!enPoste) btnPoste.disabled = true;
    btnUrgence.disabled = true;
    btnChirurgien.disabled = true;
    if (enPoste && !open) quitterPoste();
  }
}

// --- Auth : onglets ---
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.tab;
    document.getElementById('login-form').classList.toggle('hidden', target !== 'login');
    document.getElementById('register-form').classList.toggle('hidden', target !== 'register');
  });
});

// --- Enregistrement ---
document.getElementById('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const nom = document.getElementById('reg-nom').value.trim();
  const prenom = document.getElementById('reg-prenom').value.trim();
  const sceau = document.getElementById('reg-sceau').value;
  const sceau2 = document.getElementById('reg-sceau2').value;
  const errEl = document.getElementById('reg-error');
  const sucEl = document.getElementById('reg-success');
  errEl.textContent = '';
  sucEl.textContent = '';

  if (!nom || !prenom) { errEl.textContent = 'Merci de renseigner ton nom et ton prénom.'; return; }
  if (sceau !== sceau2) { errEl.textContent = 'Les sceaux ne correspondent pas.'; return; }
  if (sceau.length < 6) { errEl.textContent = 'Le sceau doit contenir au moins 6 caractères.'; return; }

  submitBtn.disabled = true;
  try {
    const existing = await supaGet('shinobis', `nom=eq.${encodeURIComponent(nom)}&prenom=eq.${encodeURIComponent(prenom)}&select=id`);
    if (existing.length > 0) { errEl.textContent = 'Ce shinobi est déjà enregistré.'; return; }

    const hashed = await hashSceau(sceau);
    await supaPost('shinobis', { nom, prenom, sceau: hashed, grade: 'stagiaire' }, true);
    sucEl.textContent = 'Enregistrement réussi ! Vous pouvez maintenant vous identifier.';
    document.getElementById('register-form').reset();
  } catch (err) {
    errEl.textContent = 'Erreur de connexion au registre. Réessaie dans un instant.';
    console.error(err);
  } finally {
    submitBtn.disabled = false;
  }
});

// --- Connexion ---
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';

  if (loginThrottle.isLocked()) {
    errEl.textContent = `Trop de tentatives. Réessaie dans ${loginThrottle.remainingSeconds()} s.`;
    return;
  }

  const nom = document.getElementById('login-nom').value.trim();
  const prenom = document.getElementById('login-prenom').value.trim();
  const sceau = document.getElementById('login-sceau').value;

  submitBtn.disabled = true;
  try {
    const hashed = await hashSceau(sceau);
    const users = await supaRpc('verifier_sceau', { p_nom: nom, p_prenom: prenom, p_sceau_hash: hashed });
    if (users.length === 0) {
      loginThrottle.registerFailure();
      errEl.textContent = 'Identité ou sceau incorrect.';
      return;
    }

    loginThrottle.registerSuccess();
    currentUser = users[0];
    saveSession(SESSION_KEY, currentUser);
    showDashboard();
  } catch (err) {
    errEl.textContent = 'Erreur de connexion au registre.';
    console.error(err);
  } finally {
    submitBtn.disabled = false;
  }
});

function showDashboard() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('dashboard-screen').classList.remove('hidden');
  document.getElementById('user-name').textContent = `${currentUser.prenom} ${currentUser.nom}`;
  checkExistingPoste();
  loadTauxLavande();
  loadData();
  showGroup('poste');
  refreshInterval = setInterval(loadData, 10000);
}

// --- Navigation sidebar (groupes) ---
function showGroup(name) {
  document.querySelectorAll('.group-panel').forEach(p => p.classList.toggle('active', p.dataset.group === name));
  document.querySelectorAll('.snav').forEach(b => b.classList.toggle('active', b.dataset.group === name));
}
document.querySelectorAll('.snav').forEach(b => {
  b.addEventListener('click', () => showGroup(b.dataset.group));
});

document.getElementById('logout-btn').addEventListener('click', () => {
  if (enPoste) quitterPoste();
  currentUser = null;
  enPoste = false;
  clearSession(SESSION_KEY);
  clearInterval(refreshInterval);
  document.getElementById('dashboard-screen').classList.add('hidden');
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('login-form').reset();
});

// --- Poste ---
async function checkExistingPoste() {
  try {
    const postes = await supaGet('postes', `shinobi_id=eq.${currentUser.id}&actif=eq.true`);
    if (postes.length > 0) {
      enPoste = true;
      posteId = postes[0].id;
      updatePosteUI();
    }
  } catch (e) { console.error(e); }
}

function updatePosteUI() {
  const btn = document.getElementById('btn-poste');
  const badge = document.getElementById('poste-status');
  if (enPoste) {
    btn.textContent = 'Quitter son poste';
    btn.classList.add('en-poste');
    badge.textContent = 'En service';
    badge.classList.add('actif');
  } else {
    btn.textContent = 'Prendre son poste';
    btn.classList.remove('en-poste');
    badge.textContent = 'Hors service';
    badge.classList.remove('actif');
  }
}

document.getElementById('btn-poste').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    if (enPoste) await quitterPoste();
    else await prendrePoste();
  } finally {
    updateClock(); // remet l'état disabled correct selon les horaires
  }
});

async function prendrePoste() {
  if (!isServerOpen()) return;
  try {
    const result = await supaPost('postes', {
      shinobi_id: currentUser.id,
      debut: new Date().toISOString(),
      actif: true
    });
    posteId = result[0].id;
    enPoste = true;
    updatePosteUI();
    loadData();
  } catch (e) { console.error(e); }
}

async function quitterPoste() {
  if (!posteId) return;
  try {
    await supaPatch('postes', `id=eq.${posteId}`, { actif: false, fin: new Date().toISOString() });
    enPoste = false;
    posteId = null;
    updatePosteUI();
    loadData();
  } catch (e) { console.error(e); }
}

// --- Sons d'alerte ---
const sonUrgence = new Audio('merle-sonnerie.mp3');
const sonChirurgien = new Audio('pluvier-dore-sonnerie.mp3');
let alertesConnues = new Set();

// --- Data refresh ---
async function loadData() {
  updateClock();
  try {
    const allShinobis = await supaGet('shinobis', 'select=id,prenom,nom');
    const shinobiMap = {};
    allShinobis.forEach(s => { shinobiMap[s.id] = s; });
    annuaire = allShinobis.slice().sort((a, b) => (a.prenom + a.nom).localeCompare(b.prenom + b.nom));

    await Promise.all([
      loadPersonnelEnPoste(shinobiMap),
      loadAlertes(shinobiMap),
      loadPlanning(shinobiMap),
      loadDossiersRecents(),
      loadLavande(shinobiMap),
      loadLavandeTop3()
    ]);
  } catch (e) { console.error('Erreur chargement données:', e); }
}

async function loadPersonnelEnPoste(shinobiMap) {
  const postes = await supaGet('postes', 'actif=eq.true&select=id,debut,shinobi_id');
  const list = document.getElementById('personnel-list');
  list.innerHTML = '';
  if (postes.length === 0) {
    list.innerHTML = '<li class="empty-hint">Aucun personnel en poste</li>';
    return;
  }
  postes.forEach(p => {
    const s = shinobiMap[p.shinobi_id];
    if (!s) return;
    const li = document.createElement('li');
    const heure = new Date(p.debut).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    li.textContent = `${s.prenom} ${s.nom} — en poste depuis ${heure}`;
    list.appendChild(li);
  });
}

async function loadAlertes(shinobiMap) {
  const alertes = await supaGet('alertes', 'actif=eq.true&select=id,type,message,created_at,shinobi_id&order=created_at.desc');
  const alertesList = document.getElementById('alertes-list');
  const alertesContainer = document.getElementById('alertes-actives');
  alertesList.innerHTML = '';

  const now = Date.now();
  const EXPIRE_MS = 20 * 60 * 1000;
  const expiredIds = [];
  const activeAlertes = alertes.filter(a => {
    if (now - new Date(a.created_at).getTime() > EXPIRE_MS) { expiredIds.push(a.id); return false; }
    return true;
  });
  expiredIds.forEach(id => { supaPatch('alertes', `id=eq.${id}`, { actif: false }).catch(() => {}); });

  // Son pour les nouvelles alertes (seulement celles non expirées)
  activeAlertes.forEach(a => {
    if (!alertesConnues.has(a.id)) {
      alertesConnues.add(a.id);
      const son = a.type === 'urgence' ? sonUrgence : sonChirurgien;
      son.currentTime = 0;
      son.play().catch(() => {});
    }
  });

  const isGerant = currentUser && (currentUser.role === 'gerant' || currentUser.role === 'co_gerant');
  if (activeAlertes.length === 0) {
    alertesContainer.classList.add('hidden');
    return;
  }

  alertesContainer.classList.remove('hidden');
  activeAlertes.forEach(a => {
    const s = shinobiMap[a.shinobi_id];
    if (!s) return;
    const li = document.createElement('li');
    li.className = a.type === 'urgence' ? 'urgence-item' : 'chirurgien-item';
    const time = new Date(a.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const canResolve = currentUser && s.id === currentUser.id;
    const canDelete = isGerant && !canResolve;
    li.innerHTML = `
      <div class="alerte-info">
        <div class="alerte-auteur">${a.type === 'urgence' ? ICO_WARN + ' Urgence' : ICO_SCISSORS + ' Chirurgien'} — ${escapeHtml(s.prenom)} ${escapeHtml(s.nom)}</div>
        ${a.message ? `<div class="alerte-msg">${escapeHtml(a.message)}</div>` : ''}
      </div>
      <span class="alerte-time">${time}</span>
      ${canResolve ? `<button class="btn-resolve" onclick="resolveAlerte('${a.id}')">Résoudre</button>` : ''}
      ${canDelete ? `<button class="btn-resolve btn-resolve-force" onclick="resolveAlerte('${a.id}')">Supprimer</button>` : ''}
    `;
    alertesList.appendChild(li);
  });
}

async function loadPlanning(shinobiMap) {
  const planning = await supaGet('planning_cours', 'select=id,titre,date_heure,enseignant,shinobi_id&order=date_heure.asc&limit=80');
  lastPlanning = planning;
  const planningParts = await supaGet('planning_participations', 'select=planning_id,shinobi_id');
  const partsByPlanning = {};
  planningParts.forEach(pp => {
    if (!partsByPlanning[pp.planning_id]) partsByPlanning[pp.planning_id] = [];
    partsByPlanning[pp.planning_id].push(pp.shinobi_id);
  });

  const planningList = document.getElementById('planning-list');
  planningList.innerHTML = '';
  if (planning.length === 0) {
    planningList.innerHTML = '<li class="empty-hint">Aucun cours planifié pour le moment</li>';
    return;
  }

  const now = Date.now();
  const isGerantPlanning = currentUser && (currentUser.role === 'gerant' || currentUser.role === 'co_gerant');
  const byDay = {};
  planning.forEach(p => {
    const d = new Date(p.date_heure);
    const key = dayKey(d);
    if (!byDay[key]) byDay[key] = { date: d, items: [] };
    byDay[key].items.push(p);
  });

  Object.keys(byDay).sort().forEach(key => {
    const day = byDay[key];
    const endOfDay = new Date(day.date.getFullYear(), day.date.getMonth(), day.date.getDate() + 1).getTime();
    const dayPasse = endOfDay < now;
    const dayLabel = day.date.toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: '2-digit' });

    const liHead = document.createElement('li');
    liHead.className = 'planning-day-head' + (dayPasse ? ' planning-passe' : '');
    liHead.textContent = dayLabel;
    planningList.appendChild(liHead);

    day.items.forEach(p => {
      planningList.appendChild(renderPlanningRow(p, shinobiMap, partsByPlanning[p.id] || [], now, isGerantPlanning));
    });
  });
}

function renderPlanningRow(p, shinobiMap, pIds, now, isGerantPlanning) {
  const d = new Date(p.date_heure);
  const heureStr = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const passe = d.getTime() < now;
  const canDelete = currentUser && (isGerantPlanning || p.shinobi_id === currentUser.id);
  const registered = currentUser && pIds.includes(currentUser.id);

  const partRows = pIds.map(id => {
    const s = shinobiMap[id];
    const n = s ? `${s.prenom} ${s.nom}` : 'Inconnu';
    return `<li>${escapeHtml(n)}${canDelete ? ` <button class="part-remove" onclick="removePlanningPart('${p.id}','${id}')" title="Retirer ce participant">✕</button>` : ''}</li>`;
  }).join('');

  const addOpts = canDelete
    ? annuaire.filter(s => !pIds.includes(s.id)).map(s => `<option value="${s.id}">${escapeHtml(s.prenom + ' ' + s.nom)}</option>`).join('')
    : '';

  const li = document.createElement('li');
  li.className = 'planning-row';
  li.innerHTML = `
    <div class="planning-item${passe ? ' planning-passe' : ''}">
      <span class="planning-heure-badge">${heureStr}</span>
      <div class="planning-info">
        <div class="cours-titre">${escapeHtml(p.titre)}</div>
        <div class="cours-meta">Enseignant : ${escapeHtml(p.enseignant)}</div>
      </div>
      ${!passe ? `<button class="btn-participer${registered ? ' participe' : ''}" onclick="togglePlanningPart('${p.id}',${registered})" title="${registered ? 'Cliquer pour se désinscrire' : "S'inscrire à ce cours"}">${registered ? '✓ Inscrit' : 'Je participe'}</button>` : ''}
      ${canDelete ? `<button class="btn-edit-planning" onclick="editPlanning('${p.id}')" title="Modifier ce cours">✎</button>` : ''}
      ${canDelete ? `<button class="btn-del-planning" onclick="deletePlanning('${p.id}')" title="Supprimer ce cours">✕</button>` : ''}
    </div>
    <details class="cours-participants">
      <summary>Participants (${pIds.length})</summary>
      ${pIds.length ? `<ul>${partRows}</ul>` : `<p class="no-participants">Personne d'inscrit pour le moment</p>`}
      ${addOpts ? `<div class="planning-add-part"><select id="addpart-${p.id}">${addOpts}</select><button type="button" class="btn-sm" onclick="addPlanningPart('${p.id}')">+ Ajouter</button></div>` : ''}
    </details>`;
  return li;
}

function dayKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function loadDossiersRecents() {
  try {
    const blessures = await supaGet('patient_blessures', 'select=patient_key,patient_nom,created_at&order=created_at.desc&limit=300');
    const dossiers = [];
    const seen = {};
    blessures.forEach(b => {
      if (!seen[b.patient_key]) {
        seen[b.patient_key] = { key: b.patient_key, nom: b.patient_nom, count: 0, last: b.created_at };
        dossiers.push(seen[b.patient_key]);
      }
      seen[b.patient_key].count++;
    });
    const patientsList = document.getElementById('patients-list');
    patientsList.innerHTML = '';
    if (dossiers.length === 0) {
      patientsList.innerHTML = '<li class="empty-hint">Aucun dossier pour le moment</li>';
      return;
    }
    dossiers.slice(0, 20).forEach(d => {
      const date = new Date(d.last).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="cours-item dossier-click">
          <div class="cours-left">
            <div class="cours-titre">${escapeHtml(d.nom)}</div>
            <div class="cours-meta">${d.count} blessure${d.count > 1 ? 's' : ''} · dernière le ${date}</div>
          </div>
        </div>`;
      li.addEventListener('click', () => selectPatient(d.key, d.nom, ''));
      patientsList.appendChild(li);
    });
  } catch (e) { console.error('Erreur chargement dossiers patients:', e); }
}

async function loadTauxLavande() {
  try {
    const rows = await supaGet('config', 'cle=eq.taux_lavande&select=valeur');
    if (rows.length > 0) tauxLavande = parseInt(rows[0].valeur, 10) || 100;
  } catch (e) { console.error(e); }
}

async function loadLavande(shinobiMap) {
  const lavande = await supaGet('lavande', 'select=id,vendeur,montant,rembourse,created_at,shinobi_id&order=created_at.desc&limit=60');
  const lavandeList = document.getElementById('lavande-list');
  lavandeList.innerHTML = '';
  if (lavande.length === 0) {
    lavandeList.innerHTML = '<li class="empty-hint">Aucun achat enregistré pour le moment</li>';
    return;
  }
  lavande.forEach(l => {
    const s = shinobiMap[l.shinobi_id];
    const par = s ? `${s.prenom} ${s.nom}` : 'Inconnu';
    const date = new Date(l.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
    const cout = Number(l.montant) * tauxLavande;
    const statut = l.rembourse
      ? '<span class="lavande-statut rembourse">Remboursé</span>'
      : '<span class="lavande-statut en-attente">En attente</span>';
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="cours-item">
        <div class="cours-left">
          <div class="cours-titre">${escapeHtml(l.vendeur)} <span class="lavande-montant">${Number(l.montant).toLocaleString('fr-FR')} lavande</span> <span class="lavande-montant">${cout.toLocaleString('fr-FR')} Ryos</span></div>
          <div class="cours-meta">Racheté par ${escapeHtml(par)} · ${date} · ${statut}</div>
        </div>
      </div>`;
    lavandeList.appendChild(li);
  });
}

async function loadLavandeTop3() {
  const top3List = document.getElementById('lavande-top3-list');
  try {
    const top3 = await supaGet('lavande_totaux', 'select=vendeur,total,nb_achats&order=total.desc&limit=3');
    top3List.innerHTML = '';
    if (top3.length === 0) {
      top3List.innerHTML = '<li class="empty-hint">Aucun achat enregistré pour le moment</li>';
      return;
    }
    const medailles = ['🥇', '🥈', '🥉'];
    top3.forEach((d, i) => {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="lavande-top3-medaille">${medailles[i] || ''}</span>
        <span class="lavande-top3-nom">${escapeHtml(d.vendeur)}</span>
        <span class="lavande-montant">${Number(d.total).toLocaleString('fr-FR')} lavande</span>
        <span class="lavande-top3-dons">(${d.nb_achats} achat${d.nb_achats > 1 ? 's' : ''})</span>`;
      top3List.appendChild(li);
    });
  } catch (e) { console.error('Erreur chargement top 3 lavande:', e); }
}

// Remplit le menu des jours (aujourd'hui + 13 jours), sans afficher l'année
(function populatePlanningJours() {
  const sel = document.getElementById('planning-jour');
  const today = new Date();
  for (let i = 0; i < 14; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    const opt = document.createElement('option');
    opt.value = dayKey(d);
    let label = d.toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: '2-digit' });
    if (i === 0) label += ' (aujourd\'hui)';
    if (i === 1) label += ' (demain)';
    opt.textContent = label;
    sel.appendChild(opt);
  }
})();

document.getElementById('planning-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser) return;
  const submitBtn = document.getElementById('planning-submit-btn');
  const titre = document.getElementById('planning-titre').value.trim();
  const jour = document.getElementById('planning-jour').value;
  const heure = document.getElementById('planning-heure').value;
  const enseignant = document.getElementById('planning-enseignant').value.trim();
  if (!titre || !jour || !heure || !enseignant) return;

  submitBtn.disabled = true;
  try {
    const dateHeure = new Date(jour + 'T' + heure);
    const dayLabel = dateHeure.toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: '2-digit' });
    const description = `Prévu le ${dayLabel} à ${heure} — Enseignant : ${enseignant}`;

    if (editingPlanningId) {
      await supaPatch('planning_cours', `id=eq.${editingPlanningId}`, { titre, date_heure: dateHeure.toISOString(), enseignant });
      await supaPatch('cours', `planning_id=eq.${editingPlanningId}`, { titre, description });
      cancelEditPlanning();
    } else {
      const created = await supaPost('planning_cours', {
        shinobi_id: currentUser.id, titre, date_heure: dateHeure.toISOString(), enseignant
      });
      await supaPost('cours', { shinobi_id: currentUser.id, titre, description, planning_id: created[0].id });
      document.getElementById('planning-titre').value = '';
      document.getElementById('planning-heure').value = '';
      document.getElementById('planning-enseignant').value = '';
    }
    loadData();
  } catch (err) {
    console.error(err);
    alert("Erreur lors de l'enregistrement du cours.");
  } finally {
    submitBtn.disabled = false;
  }
});

// ── Registre des patients (personnages de l'API Zenkai) ──
const ZENKAI_API = 'https://db.builtbyloris.dev';

const RANK_ORDER = [
  'apprentis_genin', 'genin', 'genin confirme', 'chunin', 'chunin confirme',
  'tk-jonin', 'jonin', 'cmd', 'kage'
];
const RANK_LABELS = {
  'apprentis_genin': 'Apprentis genin', 'genin': 'Genin', 'genin confirme': 'Genin confirme',
  'chunin': 'Chunin', 'chunin confirme': 'Konin', 'tk-jonin': 'Tokubetsu-jonin',
  'jonin': 'Jonin', 'cmd': 'Commandant-jonin', 'kage': 'Kazekage'
};
function rankLabel(v) { return RANK_LABELS[v] || v || 'rang inconnu'; }

let selectedPatientKey = null;
let selectedPatientNom = '';
let patientSearchTimer = null;
let browseChars = [];
let browsePage = 0;
let browsePages = 1;
let browseTotal = 0;
let browseLoading = false;
let browseSeq = 0;

async function loadPatientFilters() {
  try {
    const res = await fetch(`${ZENKAI_API}/api/filters`);
    if (!res.ok) throw new Error('Réponse API invalide');
    const body = await res.json();
    const d = body.data || {};
    const rankSel = document.getElementById('filter-rank');
    const divSel = document.getElementById('filter-division');
    const counts = {};
    (d.ranks || []).forEach(r => { counts[r.value] = r.count; });
    const known = RANK_ORDER.filter(v => counts[v] != null);
    const extras = (d.ranks || []).map(r => r.value).filter(v => RANK_ORDER.indexOf(v) === -1);
    known.concat(extras).forEach(v => {
      rankSel.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(v)}">${escapeHtml(rankLabel(v))} (${counts[v]})</option>`);
    });
    (d.divisions || []).forEach(v => {
      divSel.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(v.value)}">${escapeHtml(v.value)} (${v.count})</option>`);
    });
  } catch (e) { console.error('Filtres Zenkai indisponibles:', e); }
}

async function loadBrowsePage(reset) {
  if (!reset) {
    if (browseLoading) return;
    if (browsePage > 0 && browsePage >= browsePages) return;
  }
  if (reset) { browseChars = []; browsePage = 0; browsePages = 1; browseTotal = 0; }
  const seq = ++browseSeq;
  browseLoading = true;
  try {
    const q = document.getElementById('patient-search').value.trim();
    const rank = document.getElementById('filter-rank').value;
    const division = document.getElementById('filter-division').value;
    let url = `${ZENKAI_API}/api/characters?sort=name&order=asc&limit=50&page=${browsePage + 1}`;
    if (q.length >= 2) url += `&search=${encodeURIComponent(q)}`;
    if (rank) url += `&rank=${encodeURIComponent(rank)}`;
    if (division) url += `&division=${encodeURIComponent(division)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Réponse API invalide');
    const body = await res.json();
    if (seq !== browseSeq) return;
    browsePage = body.page;
    browsePages = body.pages;
    browseTotal = body.total;
    browseChars = browseChars.concat(body.data || []);
    renderPatientResults(browseChars, true);
  } catch (e) {
    if (seq !== browseSeq) return;
    console.error(e);
    document.getElementById('patient-results').innerHTML = '<li class="patient-result-empty">API Zenkai injoignable</li>';
  } finally {
    if (seq === browseSeq) browseLoading = false;
  }
}

document.querySelectorAll('.snav[data-group="patients"]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (browsePage === 0 && browseChars.length === 0) loadBrowsePage(true);
  });
});

document.getElementById('patient-search').addEventListener('input', () => {
  clearTimeout(patientSearchTimer);
  patientSearchTimer = setTimeout(() => loadBrowsePage(true), 300);
});
document.getElementById('filter-rank').addEventListener('change', () => loadBrowsePage(true));
document.getElementById('filter-division').addEventListener('change', () => loadBrowsePage(true));
loadPatientFilters();

function renderPatientResults(chars, isBrowse) {
  const ul = document.getElementById('patient-results');
  ul.innerHTML = '';
  if (chars.length === 0) {
    ul.innerHTML = '<li class="patient-result-empty">Aucun patient trouvé</li>';
    return;
  }
  chars.forEach(c => {
    const d = (c.divisions && c.divisions[0]) || null;
    const meta = `${rankLabel(c.rank)}${d ? ' · ' + d.type + (d.grade ? ' (' + d.grade + ')' : '') : ''}`;
    const li = document.createElement('li');
    li.className = 'patient-result';
    li.innerHTML = `<strong>${escapeHtml(c.name)}</strong> <span class="cours-meta">${escapeHtml(meta)}</span>`;
    li.addEventListener('click', () => selectPatient(c.charKey, c.name, meta));
    ul.appendChild(li);
  });
  if (isBrowse && browsePage < browsePages) {
    const li = document.createElement('li');
    li.className = 'patient-result patient-load-more';
    li.textContent = 'Charger plus (' + (browseTotal - browseChars.length) + ' patients restants)';
    li.addEventListener('click', () => loadBrowsePage());
    ul.appendChild(li);
  }
}

function selectPatient(key, nom, meta) {
  selectedPatientKey = key;
  selectedPatientNom = nom;
  document.getElementById('patient-card-nom').textContent = nom;
  document.getElementById('patient-card-meta').textContent = meta || '';
  const isGerant = currentUser && (currentUser.role === 'gerant' || currentUser.role === 'co_gerant');
  document.getElementById('patient-clear-btn').style.display = isGerant ? 'inline-block' : 'none';
  document.getElementById('patient-modal-overlay').classList.remove('hidden');
  loadBlessures();
  loadFiche();
}

// ── Fiche d'identité du patient ──
const FICHE_FIELDS = {
  'fiche-nom': 'nom_prenom', 'fiche-sexe': 'sexe', 'fiche-taille': 'taille',
  'fiche-poids': 'poids', 'fiche-chakra': 'nature_chakra', 'fiche-sang': 'groupe_sanguin',
  'fiche-infos': 'infos'
};

function clearFiche() {
  Object.keys(FICHE_FIELDS).forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('fiche-status').textContent = '';
}

async function loadFiche() {
  if (!selectedPatientKey) return;
  clearFiche();
  document.getElementById('fiche-nom').value = selectedPatientNom;
  try {
    const rows = await supaGet('patient_fiches', `patient_key=eq.${encodeURIComponent(selectedPatientKey)}&select=*`);
    if (!rows.length) return;
    const f = rows[0];
    Object.keys(FICHE_FIELDS).forEach(id => {
      const v = f[FICHE_FIELDS[id]];
      if (v != null && v !== '') document.getElementById(id).value = v;
    });
    if (f.updated_at) {
      const s = annuaire.find(x => x.id === f.updated_by);
      const date = new Date(f.updated_at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      document.getElementById('fiche-status').textContent = 'Mise à jour le ' + date + (s ? ' par ' + s.prenom + ' ' + s.nom : '');
    }
  } catch (e) { console.error('Erreur chargement fiche:', e); }
}

document.getElementById('fiche-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser || !selectedPatientKey) return;
  const row = {
    patient_key: selectedPatientKey, patient_nom: selectedPatientNom,
    updated_by: currentUser.id, updated_at: new Date().toISOString()
  };
  Object.keys(FICHE_FIELDS).forEach(id => {
    const v = document.getElementById(id).value.trim();
    row[FICHE_FIELDS[id]] = v || null;
  });
  const status = document.getElementById('fiche-status');
  status.textContent = 'Enregistrement...';
  try {
    await supaUpsert('patient_fiches', [row], '?on_conflict=patient_key');
    status.textContent = '✓ Fiche enregistrée';
    setTimeout(loadFiche, 1200);
  } catch (err) {
    console.error(err);
    status.textContent = '';
    alert("Erreur lors de l'enregistrement de la fiche.");
  }
});

document.getElementById('patient-modal-close').addEventListener('click', () => {
  document.getElementById('patient-modal-overlay').classList.add('hidden');
});
document.getElementById('patient-modal-overlay').addEventListener('click', function (e) {
  if (e.target === this) this.classList.add('hidden');
});

async function loadBlessures() {
  if (!selectedPatientKey) return;
  const list = document.getElementById('blessures-list');
  list.innerHTML = '<li class="empty-hint">Chargement...</li>';
  try {
    const rows = await supaGet('patient_blessures', `patient_key=eq.${encodeURIComponent(selectedPatientKey)}&select=id,blessure,operation,soigne_par,created_at&order=created_at.desc`);
    const isGerant = currentUser && (currentUser.role === 'gerant' || currentUser.role === 'co_gerant');
    const nameById = {};
    annuaire.forEach(s => { nameById[s.id] = `${s.prenom} ${s.nom}`; });
    list.innerHTML = '';
    if (rows.length === 0) {
      list.innerHTML = '<li class="empty-hint">Aucune blessure enregistrée pour ce patient</li>';
      return;
    }
    rows.forEach(b => {
      const par = nameById[b.soigne_par] || 'Inconnu';
      const date = new Date(b.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const li = document.createElement('li');
      li.innerHTML = `<div class="cours-item"><div class="cours-left">` +
        `<div class="cours-titre">${escapeHtml(b.blessure)}</div>` +
        (b.operation ? `<div class="blessure-operation">Soins : ${escapeHtml(b.operation)}</div>` : '') +
        `<div class="cours-meta">Soigné par ${escapeHtml(par)} · ${date}</div></div>` +
        (isGerant ? `<button class="part-remove" onclick="deleteBlessure('${b.id}')" title="Supprimer cette blessure">✕</button>` : '') +
        `</div>`;
      list.appendChild(li);
    });
  } catch (e) {
    console.error(e);
    list.innerHTML = '<li class="empty-hint">Erreur de chargement</li>';
  }
}

document.getElementById('blessure-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser || !selectedPatientKey) return;
  const blessure = document.getElementById('blessure-desc').value.trim();
  const operation = document.getElementById('blessure-operation').value.trim();
  if (!blessure) return;
  try {
    await supaPost('patient_blessures', {
      patient_key: selectedPatientKey, patient_nom: selectedPatientNom,
      blessure, operation: operation || null, soigne_par: currentUser.id
    });
    document.getElementById('blessure-desc').value = '';
    document.getElementById('blessure-operation').value = '';
    loadBlessures();
    loadData();
  } catch (err) { console.error(err); alert("Erreur lors de l'enregistrement des soins."); }
});

window.deleteBlessure = async function (id) {
  if (!currentUser) return;
  if (!confirm('Supprimer cette blessure du dossier ?')) return;
  try {
    await supaDelete('patient_blessures', `id=eq.${id}`);
    loadBlessures();
    loadData();
  } catch (e) { console.error(e); alert('Erreur lors de la suppression de la blessure.'); }
};

document.getElementById('patient-clear-btn').addEventListener('click', async function () {
  if (!currentUser || !selectedPatientKey) return;
  if (!confirm('Supprimer TOUT le dossier de ' + selectedPatientNom + ' (blessures et fiche) ?')) return;
  try {
    const key = encodeURIComponent(selectedPatientKey);
    await supaDelete('patient_blessures', `patient_key=eq.${key}`);
    await supaDelete('patient_fiches', `patient_key=eq.${key}`);
    loadBlessures();
    loadFiche();
    loadData();
  } catch (e) { console.error(e); alert('Erreur lors de la suppression du dossier.'); }
});

document.getElementById('lavande-montant').addEventListener('input', () => {
  const montant = parseInt(document.getElementById('lavande-montant').value, 10);
  const coutEl = document.getElementById('lavande-cout');
  coutEl.textContent = (montant > 0) ? `= ${(montant * tauxLavande).toLocaleString('fr-FR')} Ryos à avancer` : '';
});

document.getElementById('lavande-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser) return;
  const prenom = document.getElementById('lavande-prenom').value.trim();
  const nom = document.getElementById('lavande-nom').value.trim();
  const montant = parseInt(document.getElementById('lavande-montant').value, 10);
  if (!prenom || !nom || !montant || montant < 1) return;
  const vendeur = `${prenom} ${nom}`;
  try {
    await supaPost('lavande', { shinobi_id: currentUser.id, vendeur, montant });
    document.getElementById('lavande-prenom').value = '';
    document.getElementById('lavande-nom').value = '';
    document.getElementById('lavande-montant').value = '';
    document.getElementById('lavande-cout').textContent = '';
    loadData();
  } catch (err) { console.error(err); alert("Erreur lors de l'enregistrement de l'achat."); }
});

// --- Alertes ---
let pendingAlertType = null;

document.getElementById('btn-urgence').addEventListener('click', () => openAlertModal('urgence'));
document.getElementById('btn-chirurgien').addEventListener('click', () => openAlertModal('chirurgien'));

function openAlertModal(type) {
  pendingAlertType = type;
  document.getElementById('modal-title').innerHTML =
    type === 'urgence' ? ICO_WARN + " Appel d'Urgence — Renforts Médicaux" : ICO_SCISSORS + ' Demande de Chirurgien';
  document.getElementById('modal-message').value = '';
  document.getElementById('modal-overlay').classList.remove('hidden');
}

document.getElementById('modal-cancel').addEventListener('click', () => {
  document.getElementById('modal-overlay').classList.add('hidden');
  pendingAlertType = null;
});

document.getElementById('modal-confirm').addEventListener('click', async (e) => {
  if (!pendingAlertType || !currentUser) return;
  e.target.disabled = true;
  const message = document.getElementById('modal-message').value.trim();
  try {
    await supaPost('alertes', { type: pendingAlertType, shinobi_id: currentUser.id, message: message || null, actif: true });
    document.getElementById('modal-overlay').classList.add('hidden');
    pendingAlertType = null;
    loadData();
  } catch (err) {
    console.error(err);
    alert("Erreur lors de l'envoi de l'alerte.");
  } finally {
    e.target.disabled = false;
  }
});

window.editPlanning = function (id) {
  const p = lastPlanning.find(x => x.id === id);
  if (!p) return;
  editingPlanningId = id;
  const d = new Date(p.date_heure);
  const jourVal = dayKey(d);
  const sel = document.getElementById('planning-jour');
  if (!Array.from(sel.options).some(o => o.value === jourVal)) {
    const opt = document.createElement('option');
    opt.value = jourVal;
    opt.textContent = d.toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: '2-digit' });
    opt.dataset.temp = '1';
    sel.insertBefore(opt, sel.firstChild);
  }
  sel.value = jourVal;
  document.getElementById('planning-titre').value = p.titre;
  document.getElementById('planning-heure').value = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  document.getElementById('planning-enseignant').value = p.enseignant;
  document.getElementById('planning-submit-btn').textContent = 'Modifier le cours';
  document.getElementById('planning-cancel-edit').classList.remove('hidden');
  document.getElementById('planning-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

function cancelEditPlanning() {
  editingPlanningId = null;
  document.getElementById('planning-titre').value = '';
  document.getElementById('planning-heure').value = '';
  document.getElementById('planning-enseignant').value = '';
  const sel = document.getElementById('planning-jour');
  Array.from(sel.options).forEach(o => { if (o.dataset.temp) o.remove(); });
  sel.selectedIndex = 0;
  document.getElementById('planning-submit-btn').textContent = 'Ajouter au planning';
  document.getElementById('planning-cancel-edit').classList.add('hidden');
}
document.getElementById('planning-cancel-edit').addEventListener('click', cancelEditPlanning);

window.addPlanningPart = async function (planningId) {
  if (!currentUser) return;
  const sel = document.getElementById('addpart-' + planningId);
  if (!sel || !sel.value) return;
  try {
    await supaPost('planning_participations', { planning_id: planningId, shinobi_id: sel.value });
    loadData();
  } catch (e) { console.error(e); alert("Erreur lors de l'ajout du participant."); }
};

window.removePlanningPart = async function (planningId, shinobiId) {
  if (!currentUser) return;
  try {
    await supaDelete('planning_participations', `planning_id=eq.${planningId}&shinobi_id=eq.${shinobiId}`);
    loadData();
  } catch (e) { console.error(e); alert('Erreur lors du retrait du participant.'); }
};

window.togglePlanningPart = async function (planningId, registered) {
  if (!currentUser) return;
  try {
    if (registered) {
      await supaDelete('planning_participations', `planning_id=eq.${planningId}&shinobi_id=eq.${currentUser.id}`);
    } else {
      await supaPost('planning_participations', { planning_id: planningId, shinobi_id: currentUser.id });
    }
    loadData();
  } catch (e) { console.error(e); alert("Erreur lors de l'inscription."); }
};

window.deletePlanning = async function (id) {
  if (!currentUser) return;
  if (!confirm('Supprimer ce cours du planning ?')) return;
  try {
    await supaDelete('planning_cours', `id=eq.${id}`);
    loadData();
  } catch (e) { console.error(e); alert('Erreur lors de la suppression.'); }
};

window.resolveAlerte = async function (id) {
  try {
    await supaPatch('alertes', `id=eq.${id}`, { actif: false });
    loadData();
  } catch (e) { console.error(e); }
};

// --- Auto-login from session ---
(async function autoLogin() {
  const saved = loadSession(SESSION_KEY);
  if (!saved || !saved.id) return;
  try {
    const users = await supaGet('shinobis', `id=eq.${saved.id}&select=id,nom,prenom,role,grade,absent,created_at`);
    if (users.length > 0) {
      currentUser = users[0];
      saveSession(SESSION_KEY, currentUser);
      showDashboard();
    } else {
      clearSession(SESSION_KEY);
    }
  } catch (e) {
    console.error(e);
    clearSession(SESSION_KEY);
  }
})();

// --- Fermeture automatique de tous les postes à 3h00 ---
let lastCheckHour = new Date().getHours();

async function checkAutoClosePostes() {
  const now = new Date();
  const h = now.getHours();
  if (h === 3 && lastCheckHour !== 3) {
    try {
      const postesActifs = await supaGet('postes', 'actif=eq.true&select=id');
      for (const p of postesActifs) {
        await supaPatch('postes', `id=eq.${p.id}`, { actif: false, fin: now.toISOString() });
      }
      if (enPoste) {
        enPoste = false;
        posteId = null;
        updatePosteUI();
      }
      loadData();
    } catch (e) { console.error('Erreur fermeture auto:', e); }
  }
  lastCheckHour = h;
}
setInterval(checkAutoClosePostes, 30000);

// --- Init ---
setInterval(updateClock, 1000);
updateClock();
initThemeToggle();
