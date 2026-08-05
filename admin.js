// =====================================================================
// admin.js — Espace Gérance de l'Hôpital de Sunagakure
// Dépend de common.js (chargé avant ce fichier).
// =====================================================================

const ADMIN_SESSION_KEY = 'hopital_admin_session';
const esc = escapeHtml; // alias local, conservé pour rester proche du code d'origine

let currentUser = null;
let tauxParGrade = { stagiaire: 0, aspirant: 0, adepte: 0, expert: 0 };
let allShinobis = [];
let shinobiMap = {};
let chatInterval = null;

const loginThrottle = makeLoginThrottle('hopital_admin_login_throttle');

// --- Charger tous les shinobis (utilisé partout pour les jointures) ---
async function refreshShinobis() {
  allShinobis = await supaGet('shinobis', 'select=id,prenom,nom,role,grade,absent&order=nom.asc,prenom.asc');
  shinobiMap = {};
  allShinobis.forEach(s => { shinobiMap[s.id] = s; });
}

// --- Auth ---
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

    const user = users[0];
    if (user.role !== 'gerant' && user.role !== 'co_gerant') {
      loginThrottle.registerFailure();
      // Message volontairement identique à "sceau incorrect" pour ne pas
      // révéler à un compte non-autorisé qu'il a un mot de passe valide.
      errEl.textContent = 'Identité ou sceau incorrect.';
      return;
    }

    loginThrottle.registerSuccess();
    currentUser = user;
    saveSession(ADMIN_SESSION_KEY, currentUser);
    showAdmin();
  } catch (err) {
    errEl.textContent = 'Erreur de connexion au registre.';
    console.error(err);
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById('logout-btn').addEventListener('click', () => {
  currentUser = null;
  clearSession(ADMIN_SESSION_KEY);
  if (chatInterval) { clearInterval(chatInterval); chatInterval = null; }
  document.getElementById('admin-screen').classList.add('hidden');
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('login-form').reset();
});

async function showAdmin() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('admin-screen').classList.remove('hidden');
  document.getElementById('user-name').textContent = `${currentUser.prenom} ${currentUser.nom}`;

  const badge = document.getElementById('user-role-badge');
  badge.textContent = currentUser.role === 'gerant' ? 'Gérant' : 'Co-Gérant';
  badge.className = `role-badge ${currentUser.role}`;

  await loadTauxHoraire();
  await refreshShinobis();
  populateShinobiSelects();
  await loadAll();

  showGroup('presence');

  if (chatInterval) clearInterval(chatInterval);
  chatInterval = setInterval(loadChat, 5000);
}

// =====================
// NAVIGATION SIDEBAR (groupes)
// =====================
function showGroup(name) {
  document.querySelectorAll('.group-panel').forEach(p => p.classList.toggle('active', p.dataset.group === name));
  document.querySelectorAll('.snav').forEach(b => b.classList.toggle('active', b.dataset.group === name));
}
document.querySelectorAll('.snav').forEach(b => {
  b.addEventListener('click', () => showGroup(b.dataset.group));
});

// --- Populate selects ---
function populateShinobiSelects() {
  const filterSelect = document.getElementById('filter-shinobi');
  filterSelect.innerHTML = '<option value="all">Tous</option>';
  allShinobis.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.prenom} ${s.nom}`;
    filterSelect.appendChild(opt);
  });

  const avertSelect = document.getElementById('avert-shinobi');
  avertSelect.innerHTML = '';
  allShinobis.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.prenom} ${s.nom}`;
    avertSelect.appendChild(opt);
  });
}

function getDateRange(selectId) {
  const period = document.getElementById(selectId).value;
  const now = new Date();
  let from = null, to = null;

  if (period === 'today') {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (period === 'week') {
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1;
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
  } else if (period.startsWith('week-')) {
    const weeksAgo = parseInt(period.split('-')[1], 10);
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1;
    const thisMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
    from = new Date(thisMonday.getTime() - weeksAgo * 7 * 86400000);
    to = new Date(from.getTime() + 7 * 86400000);
  } else if (period === 'month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  return { from: from ? from.toISOString() : null, to: to ? to.toISOString() : null };
}

document.getElementById('btn-refresh').addEventListener('click', loadAll);
document.getElementById('filter-period').addEventListener('change', loadAll);
document.getElementById('filter-shinobi').addEventListener('change', loadAll);
document.getElementById('paye-period').addEventListener('change', loadPaye);

// --- Load all ---
async function loadAll() {
  await refreshShinobis();
  await loadTauxLavandeAdmin();
  await Promise.all([
    loadStats(), loadRecap(), loadDetail(), loadGrades(), loadRoles(),
    loadPostesAdmin(), loadPaye(), loadAvertissements(), loadChat(),
    loadCoursAdmin(), loadAbsences(), loadLavandeAdmin()
  ]);
}

// --- Stats ---
async function loadStats() {
  try {
    const postes = await supaGet('postes', 'actif=eq.true&select=id');
    const alertes = await supaGet('alertes', 'actif=eq.true&select=id');
    document.getElementById('stat-inscrits').textContent = allShinobis.length;
    document.getElementById('stat-en-poste').textContent = postes.length;
    document.getElementById('stat-alertes').textContent = alertes.length;
  } catch (e) { console.error(e); }
}

// --- Récapitulatif des heures ---
async function loadRecap() {
  try {
    let query = 'select=id,debut,fin,actif,shinobi_id';
    const range = getDateRange('filter-period');
    if (range.from) query += `&debut=gte.${range.from}`;
    if (range.to) query += `&debut=lt.${range.to}`;

    const shinobiFilter = document.getElementById('filter-shinobi').value;
    if (shinobiFilter !== 'all') query += `&shinobi_id=eq.${shinobiFilter}`;

    query += '&order=debut.desc';
    const postes = await supaGet('postes', query);

    const map = {};
    postes.forEach(p => {
      const s = shinobiMap[p.shinobi_id];
      if (!s) return;
      if (!map[s.id]) map[s.id] = { prenom: s.prenom, nom: s.nom, role: s.role || 'membre', postes: [] };
      map[s.id].postes.push(p);
    });

    const tbody = document.getElementById('recap-body');
    tbody.innerHTML = '';

    const entries = Object.values(map);
    if (entries.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-row">Aucune donnée pour cette période</td></tr>';
      return;
    }

    entries.sort((a, b) => totalMinutes(b.postes) - totalMinutes(a.postes));

    entries.forEach(e => {
      const nbPostes = e.postes.length;
      const totalMin = totalMinutes(e.postes);
      const avgMin = nbPostes > 0 ? Math.round(totalMin / nbPostes) : 0;
      const lastPoste = e.postes[0];
      const lastDate = new Date(lastPoste.debut).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
      const roleLabel = e.role === 'gerant' ? 'Gérant' : e.role === 'co_gerant' ? 'Co-Gérant' : 'Membre';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${esc(e.prenom)} ${esc(e.nom)}</strong></td>
        <td>${roleLabel}</td>
        <td>${nbPostes}</td>
        <td>${formatDuration(totalMin)}</td>
        <td>${formatDuration(avgMin)}</td>
        <td>${lastDate}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) { console.error(e); }
}

// --- Détail des postes ---
let detailPostesCache = [];
let detailEditingId = null;

function toDatetimeLocal(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function loadDetail() {
  try {
    let query = 'select=id,debut,fin,actif,shinobi_id';
    const range = getDateRange('filter-period');
    if (range.from) query += `&debut=gte.${range.from}`;
    if (range.to) query += `&debut=lt.${range.to}`;

    const shinobiFilter = document.getElementById('filter-shinobi').value;
    if (shinobiFilter !== 'all') query += `&shinobi_id=eq.${shinobiFilter}`;

    query += '&order=debut.desc&limit=100';
    detailPostesCache = await supaGet('postes', query);
    detailEditingId = null;
    renderDetail();
  } catch (e) { console.error(e); }
}

function renderDetail() {
  const postes = detailPostesCache;
  const tbody = document.getElementById('detail-body');
  tbody.innerHTML = '';

  if (postes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-row">Aucun poste enregistré</td></tr>';
    return;
  }

  postes.forEach(p => {
    const s = shinobiMap[p.shinobi_id];
    if (!s) return;
    const debut = new Date(p.debut);
    const fin = p.fin ? new Date(p.fin) : null;
    const dureeMin = fin ? Math.round((fin - debut) / 60000) : Math.round((new Date() - debut) / 60000);

    const tr = document.createElement('tr');

    if (detailEditingId === p.id) {
      tr.innerHTML = `
        <td>${esc(s.prenom)} ${esc(s.nom)}</td>
        <td colspan="2"><input type="datetime-local" class="inline-input detail-edit-debut" value="${toDatetimeLocal(debut)}"></td>
        <td><input type="datetime-local" class="inline-input detail-edit-fin" value="${fin ? toDatetimeLocal(fin) : ''}"></td>
        <td colspan="2"><span class="info-text" style="margin:0">Laisser "Fin" vide = poste toujours en cours</span></td>
        <td>
          <button class="btn-sm btn-detail-valider" data-id="${p.id}">Valider</button>
          <button class="btn-sm btn-detail-annuler">Annuler</button>
        </td>
      `;
    } else {
      const date = debut.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' });
      const heureDebut = debut.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const heureFin = fin ? fin.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—';
      const duree = fin ? formatDuration(Math.round((fin - debut) / 60000)) : '—';
      const statut = p.actif
        ? '<span class="badge-actif en-cours">En cours</span>'
        : '<span class="badge-actif termine">Terminé</span>';

      tr.innerHTML = `
        <td>${esc(s.prenom)} ${esc(s.nom)}</td>
        <td>${date}</td>
        <td>${heureDebut}</td>
        <td>${heureFin}</td>
        <td>${duree}</td>
        <td>${statut}</td>
        <td>
          <button class="btn-sm btn-poste-modifier" data-id="${p.id}">Modifier</button>
          <button class="btn-sm btn-poste-delete" data-id="${p.id}" data-nom="${esc(s.prenom)} ${esc(s.nom)}" data-duree="${formatDuration(dureeMin)}">Supprimer</button>
        </td>
      `;
    }
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.btn-poste-modifier').forEach(btn => {
    btn.addEventListener('click', () => {
      detailEditingId = btn.dataset.id;
      renderDetail();
    });
  });

  tbody.querySelectorAll('.btn-detail-annuler').forEach(btn => {
    btn.addEventListener('click', () => {
      detailEditingId = null;
      renderDetail();
    });
  });

  tbody.querySelectorAll('.btn-detail-valider').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const debutVal = tr.querySelector('.detail-edit-debut').value;
      const finVal = tr.querySelector('.detail-edit-fin').value;
      if (!debutVal) { alert('La date de début est obligatoire.'); return; }
      const nouveauDebut = new Date(debutVal);
      const nouveauFin = finVal ? new Date(finVal) : null;
      if (nouveauFin && nouveauFin <= nouveauDebut) { alert('La fin doit être après le début.'); return; }
      btn.disabled = true;
      try {
        await supaPatch('postes', `id=eq.${btn.dataset.id}`, {
          debut: nouveauDebut.toISOString(),
          fin: nouveauFin ? nouveauFin.toISOString() : null,
          actif: !nouveauFin
        }, true);
        await loadAll();
      } catch (e) { console.error(e); alert('Erreur lors de la modification du poste.'); btn.disabled = false; }
    });
  });

  tbody.querySelectorAll('.btn-poste-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ok = confirm(`Supprimer ce poste de ${btn.dataset.nom} (${btn.dataset.duree}) ?\n\nLe temps correspondant sera retiré de son total et de sa paie. Action définitive.`);
      if (!ok) return;
      btn.disabled = true;
      try {
        await supaDelete('postes', `id=eq.${btn.dataset.id}`);
        await loadAll();
      } catch (e) { console.error(e); btn.disabled = false; }
    });
  });
}

// =====================
// GESTION DES POSTES (ADMIN)
// =====================
async function loadPostesAdmin() {
  try {
    const postesActifs = await supaGet('postes', 'actif=eq.true&select=id,shinobi_id,debut');
    const posteMap = {};
    postesActifs.forEach(p => { posteMap[p.shinobi_id] = p; });

    const tbody = document.getElementById('postes-admin-body');
    tbody.innerHTML = '';

    allShinobis.forEach(s => {
      const poste = posteMap[s.id];
      const enPoste = !!poste;
      const depuis = enPoste ? new Date(poste.debut).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${esc(s.prenom)} ${esc(s.nom)}</strong></td>
        <td>${enPoste ? '<span class="badge-actif en-cours">En poste</span>' : '<span class="badge-actif termine">Hors poste</span>'}</td>
        <td>${depuis}</td>
        <td>
          ${enPoste
            ? `<button class="btn-action retirer-poste" data-poste-id="${poste.id}">Retirer du poste</button>`
            : `<button class="btn-action mettre-poste" data-shinobi-id="${s.id}">Mettre en poste</button>`
          }
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.retirer-poste').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await supaPatch('postes', `id=eq.${btn.dataset.posteId}`, {
            actif: false, fin: new Date().toISOString(), force_par: currentUser.id
          });
          await loadAll();
        } catch (e) { console.error(e); btn.disabled = false; }
      });
    });

    tbody.querySelectorAll('.mettre-poste').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await supaPost('postes', { shinobi_id: btn.dataset.shinobiId, debut: new Date().toISOString(), actif: true });
          await loadAll();
        } catch (e) { console.error(e); btn.disabled = false; }
      });
    });
  } catch (e) { console.error(e); }
}

// =====================
// GESTION DE LA PAYE
// =====================
async function loadTauxHoraire() {
  try {
    const rows = await supaGet('config', 'select=cle,valeur');
    rows.forEach(r => {
      if (r.cle && r.cle.indexOf('taux_') === 0) {
        const g = r.cle.slice(5);
        if (g in tauxParGrade) tauxParGrade[g] = parseInt(r.valeur, 10) || 0;
      }
    });
    const ancien = rows.find(r => r.cle === 'taux_horaire');
    if (ancien) {
      const v = parseInt(ancien.valeur, 10) || 0;
      GRADES.forEach(g => { if (tauxParGrade[g] === 0 && g !== 'aucun') tauxParGrade[g] = v; });
    }
    GRADES.forEach(g => {
      const el = document.getElementById('taux-' + g);
      if (el) el.value = tauxParGrade[g];
    });
  } catch (e) { console.error(e); }
}

document.getElementById('btn-save-taux').addEventListener('click', async () => {
  const btn = document.getElementById('btn-save-taux');
  btn.disabled = true;
  try {
    for (const g of GRADES) {
      const el = document.getElementById('taux-' + g);
      if (!el) continue;
      const val = Math.max(0, parseInt(el.value, 10) || 0);
      tauxParGrade[g] = val;
      await supaUpsert('config', { cle: 'taux_' + g, valeur: String(val) });
    }
    await loadPaye();
    const old = btn.textContent;
    btn.textContent = '✓ Sauvegardé';
    setTimeout(() => { btn.textContent = old; }, 1500);
  } catch (e) {
    console.error(e);
    alert('Erreur lors de la sauvegarde des taux.');
  } finally {
    btn.disabled = false;
  }
});

async function loadPaye() {
  try {
    let query = 'select=id,debut,fin,actif,shinobi_id';
    const range = getDateRange('paye-period');
    if (range.from) query += `&debut=gte.${range.from}`;
    if (range.to) query += `&debut=lt.${range.to}`;
    query += '&order=debut.desc';

    const postes = await supaGet('postes', query);

    const map = {};
    postes.forEach(p => {
      const s = shinobiMap[p.shinobi_id];
      if (!s) return;
      if (!map[s.id]) map[s.id] = { id: s.id, prenom: s.prenom, nom: s.nom, grade: s.grade || 'aucun', postes: [] };
      map[s.id].postes.push(p);
    });

    const periodeKey = `${range.from || 'null'}_${range.to || 'null'}`;
    const versements = await supaGet('paye_versements', `periode_key=eq.${encodeURIComponent(periodeKey)}&select=shinobi_id`);
    const paidSet = new Set(versements.map(v => v.shinobi_id));

    const tbody = document.getElementById('paye-body');
    tbody.innerHTML = '';

    const entries = Object.values(map);
    if (entries.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-row">Aucune donnée pour cette période</td></tr>';
      document.getElementById('paye-grand-total').textContent = '0';
      return;
    }

    entries.sort((a, b) => totalMinutes(b.postes) - totalMinutes(a.postes));

    let grandTotal = 0;
    entries.forEach(e => {
      const minutes = totalMinutes(e.postes);
      const heures = Math.floor(minutes / 60);
      const taux = tauxParGrade[e.grade] || 0;
      const paye = heures * taux;
      grandTotal += paye;

      const gradeLabel = GRADE_LABELS[e.grade] || 'Aucun';
      const isPaid = paidSet.has(e.id);

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${esc(e.prenom)} ${esc(e.nom)}</strong></td>
        <td><span class="grade-badge ${e.grade}">${gradeLabel}</span></td>
        <td>${formatDuration(minutes)}</td>
        <td>${taux} Ryos</td>
        <td class="paye-ryos">${paye.toLocaleString('fr-FR')} Ryos</td>
        <td style="text-align:center"><input type="checkbox" class="paye-checkbox" data-shinobi-id="${e.id}" ${isPaid ? 'checked' : ''}></td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.paye-checkbox').forEach(cb => {
      cb.addEventListener('change', () => togglePaye(cb.dataset.shinobiId, periodeKey, cb.checked));
    });

    document.getElementById('paye-grand-total').textContent = grandTotal.toLocaleString('fr-FR');
  } catch (e) { console.error(e); }
}

async function togglePaye(shinobiId, periodeKey, checked) {
  try {
    if (checked) {
      await supaUpsert('paye_versements', { shinobi_id: shinobiId, periode_key: periodeKey, paye: true });
    } else {
      await supaDelete('paye_versements', `shinobi_id=eq.${shinobiId}&periode_key=eq.${encodeURIComponent(periodeKey)}`);
    }
  } catch (e) { console.error(e); alert('Erreur lors de la mise à jour du statut de paye.'); }
}

// =====================
// GESTION DES RACHATS DE LAVANDE
// =====================
let tauxLavande = 100;

async function loadTauxLavandeAdmin() {
  try {
    const rows = await supaGet('config', 'cle=eq.taux_lavande&select=valeur');
    if (rows.length > 0) tauxLavande = parseInt(rows[0].valeur, 10) || 100;
    document.getElementById('taux-lavande').value = tauxLavande;
  } catch (e) { console.error(e); }
}

document.getElementById('btn-save-taux-lavande').addEventListener('click', async () => {
  const btn = document.getElementById('btn-save-taux-lavande');
  const el = document.getElementById('taux-lavande');
  const val = Math.max(0, parseInt(el.value, 10) || 0);
  btn.disabled = true;
  try {
    await supaUpsert('config', { cle: 'taux_lavande', valeur: String(val) });
    tauxLavande = val;
    await loadLavandeAdmin();
    const old = btn.textContent;
    btn.textContent = '✓ Sauvegardé';
    setTimeout(() => { btn.textContent = old; }, 1500);
  } catch (e) {
    console.error(e);
    alert('Erreur lors de la sauvegarde du taux.');
  } finally {
    btn.disabled = false;
  }
});

let lavandeAchatsCache = [];
let lavandeEditingId = null;

async function loadLavandeAdmin() {
  try {
    lavandeAchatsCache = await supaGet('lavande', 'select=id,vendeur,montant,rembourse,shinobi_id,created_at&order=created_at.desc');
    lavandeEditingId = null;
    renderLavandeAdmin();
  } catch (e) { console.error(e); }
}

function renderLavandeAdmin() {
  const achats = lavandeAchatsCache;
  const tbody = document.getElementById('lavande-admin-body');
  tbody.innerHTML = '';

  if (achats.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-row">Aucun achat enregistré</td></tr>';
    document.getElementById('lavande-grand-total').textContent = '0';
    document.getElementById('lavande-solde-acheteurs').innerHTML = '';
    return;
  }

  let grandTotal = 0;
  const soldeParAcheteur = {};

  achats.forEach(a => {
    const s = shinobiMap[a.shinobi_id];
    const nomAcheteur = s ? `${s.prenom} ${s.nom}` : 'Inconnu';
    const total = Number(a.montant) * tauxLavande;
    const date = new Date(a.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });

    if (!a.rembourse) {
      grandTotal += total;
      soldeParAcheteur[nomAcheteur] = (soldeParAcheteur[nomAcheteur] || 0) + total;
    }

    const tr = document.createElement('tr');
    if (lavandeEditingId === a.id) {
      tr.innerHTML = `
        <td>${date}</td>
        <td><input type="text" class="inline-input lavande-edit-vendeur" value="${esc(a.vendeur)}" maxlength="80"></td>
        <td><input type="number" class="inline-input lavande-edit-montant" value="${a.montant}" min="1" style="width:70px"></td>
        <td>${esc(nomAcheteur)}</td>
        <td>${total.toLocaleString('fr-FR')} Ryos</td>
        <td style="text-align:center"><input type="checkbox" disabled ${a.rembourse ? 'checked' : ''}></td>
        <td>
          <button class="btn-sm btn-lavande-valider" data-id="${a.id}">Valider</button>
          <button class="btn-sm btn-lavande-annuler">Annuler</button>
        </td>
      `;
    } else {
      tr.innerHTML = `
        <td>${date}</td>
        <td><strong>${esc(a.vendeur)}</strong></td>
        <td>${Number(a.montant).toLocaleString('fr-FR')}</td>
        <td>${esc(nomAcheteur)}</td>
        <td>${total.toLocaleString('fr-FR')} Ryos</td>
        <td style="text-align:center"><input type="checkbox" class="lavande-rembourse-checkbox" data-id="${a.id}" ${a.rembourse ? 'checked' : ''}></td>
        <td>
          <button class="btn-sm btn-lavande-modifier" data-id="${a.id}">Modifier</button>
          <button class="btn-sm btn-lavande-supprimer" data-id="${a.id}" data-vendeur="${esc(a.vendeur)}">Supprimer</button>
        </td>
      `;
    }
    tbody.appendChild(tr);
  });

  document.getElementById('lavande-grand-total').textContent = grandTotal.toLocaleString('fr-FR');

  const soldeEl = document.getElementById('lavande-solde-acheteurs');
  const entries = Object.entries(soldeParAcheteur).sort((a, b) => b[1] - a[1]);
  soldeEl.innerHTML = entries.length === 0
    ? ''
    : '<h4>À rembourser par personne</h4><ul>' + entries.map(([nom, total]) =>
        `<li>${esc(nom)} : <strong>${total.toLocaleString('fr-FR')} Ryos</strong></li>`
      ).join('') + '</ul>';

  tbody.querySelectorAll('.lavande-rembourse-checkbox').forEach(cb => {
    cb.addEventListener('change', async () => {
      cb.disabled = true;
      try {
        await supaPatch('lavande', `id=eq.${cb.dataset.id}`, {
          rembourse: cb.checked,
          rembourse_at: cb.checked ? new Date().toISOString() : null
        }, true);
        await loadLavandeAdmin();
      } catch (e) { console.error(e); alert('Erreur lors de la mise à jour du remboursement.'); cb.disabled = false; }
    });
  });

  tbody.querySelectorAll('.btn-lavande-modifier').forEach(btn => {
    btn.addEventListener('click', () => {
      lavandeEditingId = btn.dataset.id;
      renderLavandeAdmin();
    });
  });

  tbody.querySelectorAll('.btn-lavande-annuler').forEach(btn => {
    btn.addEventListener('click', () => {
      lavandeEditingId = null;
      renderLavandeAdmin();
    });
  });

  tbody.querySelectorAll('.btn-lavande-valider').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const nouveauVendeur = tr.querySelector('.lavande-edit-vendeur').value.trim();
      const nouveauMontant = parseInt(tr.querySelector('.lavande-edit-montant').value, 10);
      if (!nouveauVendeur || !nouveauMontant || nouveauMontant < 1) { alert('Vendeur ou quantité invalide.'); return; }
      btn.disabled = true;
      try {
        await supaPatch('lavande', `id=eq.${btn.dataset.id}`, { vendeur: nouveauVendeur, montant: nouveauMontant }, true);
        await loadLavandeAdmin();
      } catch (e) { console.error(e); alert('Erreur lors de la modification.'); btn.disabled = false; }
    });
  });

  tbody.querySelectorAll('.btn-lavande-supprimer').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Supprimer cet achat de lavande (${btn.dataset.vendeur}) ?`)) return;
      btn.disabled = true;
      try {
        await supaDelete('lavande', `id=eq.${btn.dataset.id}`);
        await loadLavandeAdmin();
      } catch (e) { console.error(e); btn.disabled = false; }
    });
  });
}

// =====================
// ABSENCES
// =====================
async function loadAbsences() {
  try {
    const tbody = document.getElementById('absences-body');
    tbody.innerHTML = '';
    if (allShinobis.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty-row">Aucun shinobi inscrit</td></tr>';
      return;
    }
    allShinobis.forEach(s => {
      const absent = !!s.absent;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${esc(s.prenom)} ${esc(s.nom)}</strong></td>
        <td><span class="statut-badge ${absent ? 'statut-absent' : 'statut-present'}">${absent ? 'Absent' : 'Présent'}</span></td>
        <td><button class="btn-sm btn-toggle-absent" data-id="${s.id}" data-current="${absent}">${absent ? 'Marquer présent' : 'Marquer absent'}</button></td>
      `;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('.btn-toggle-absent').forEach(btn => {
      btn.addEventListener('click', () => toggleAbsent(btn.dataset.id, btn.dataset.current === 'true'));
    });
  } catch (e) { console.error(e); }
}

async function toggleAbsent(id, current) {
  try {
    await supaPatch('shinobis', `id=eq.${id}`, { absent: !current }, true);
    await refreshShinobis();
    loadAbsences();
  } catch (e) { console.error(e); alert("Erreur lors de la mise à jour de l'absence."); }
}

// =====================
// GRADES
// =====================
const GRADES = ['observateur', 'stagiaire', 'aspirant', 'adepte', 'expert'];
const GRADE_LABELS = { observateur: 'Observateur', stagiaire: 'Stagiaire', aspirant: 'Aspirant', adepte: 'Adepte', expert: 'Expert' };

function nextGrade(current) {
  const i = GRADES.indexOf(current || 'aucun');
  return i < GRADES.length - 1 ? GRADES[i + 1] : null;
}
function prevGrade(current) {
  const i = GRADES.indexOf(current || 'aucun');
  return i > 0 ? GRADES[i - 1] : null;
}

let gradeSortDir = 1;
const GRADE_ORDER = { observateur: 0, stagiaire: 1, aspirant: 2, adepte: 3, expert: 4 };

async function loadGrades() {
  const tbody = document.getElementById('grades-body');
  tbody.innerHTML = '';

  if (allShinobis.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-row">Aucun shinobi inscrit</td></tr>';
    return;
  }

  const sorted = allShinobis.slice().sort((a, b) => {
    const ga = a.grade || 'stagiaire';
    const gb = b.grade || 'stagiaire';
    const diff = ((GRADE_ORDER[ga] != null ? GRADE_ORDER[ga] : 0) - (GRADE_ORDER[gb] != null ? GRADE_ORDER[gb] : 0)) * gradeSortDir;
    return diff !== 0 ? diff : (a.nom + a.prenom).localeCompare(b.nom + b.prenom);
  });

  sorted.forEach(s => {
    const grade = s.grade || 'stagiaire';
    const roleLabel = ROLE_LABELS[s.role] || 'Membre';
    const next = nextGrade(grade);
    const prev = prevGrade(grade);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${esc(s.prenom)} ${esc(s.nom)}</strong></td>
      <td>${roleLabel}</td>
      <td><span class="grade-badge ${grade}">${GRADE_LABELS[grade] || grade}</span></td>
      <td>
        ${prev ? `<button class="btn-grade demote" data-id="${s.id}" data-grade="${prev}">↓ ${GRADE_LABELS[prev]}</button>` : ''}
        ${next ? `<button class="btn-grade promote" data-id="${s.id}" data-grade="${next}">↑ ${GRADE_LABELS[next]}</button>` : '<span class="grade-max-hint">Grade max</span>'}
        <button class="btn-licencier" data-id="${s.id}" data-nom="${esc(s.prenom)} ${esc(s.nom)}">Licencier</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.btn-licencier').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Licencier ' + btn.dataset.nom + ' ? Son profil sera supprimé du registre.')) return;
      btn.disabled = true;
      try {
        await supaDelete('shinobis', `id=eq.${btn.dataset.id}`);
        await loadAll();
      } catch (e) {
        console.error(e);
        btn.disabled = false;
        alert('Impossible de licencier : une erreur est survenue.');
      }
    });
  });

  tbody.querySelectorAll('.btn-grade').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const grade = btn.dataset.grade;
      btn.disabled = true;
      try {
        await supaPatch('shinobis', `id=eq.${id}`, { grade }, true);
        await loadAll();
      } catch (e) { console.error(e); btn.disabled = false; }
    });
  });
}

document.getElementById('th-grade').addEventListener('click', () => {
  gradeSortDir *= -1;
  loadGrades();
});

// =====================
// GESTION DES RÔLES
// =====================
const ROLE_LABELS = { gerant: 'Gérant', co_gerant: 'Co-Gérant', membre: 'Membre' };

async function loadRoles() {
  const tbody = document.getElementById('roles-body');
  tbody.innerHTML = '';

  if (allShinobis.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-row">Aucun shinobi inscrit</td></tr>';
    return;
  }

  allShinobis.forEach(s => {
    const role = s.role || 'membre';
    const btn = (r) => `<button class="btn-role ${r}" data-id="${s.id}" data-role="${r}"${role === r ? ' disabled' : ''}>${ROLE_LABELS[r]}</button>`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${esc(s.prenom)} ${esc(s.nom)}</strong></td>
      <td><span class="role-badge ${role}">${ROLE_LABELS[role] || role}</span></td>
      <td>${btn('gerant') + btn('co_gerant') + btn('membre')}</td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.btn-role').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const role = btn.dataset.role;
      btn.disabled = true;
      try {
        await supaPatch('shinobis', `id=eq.${id}`, { role }, true);
        if (currentUser && id === currentUser.id && role === 'membre') {
          alert('Vous venez de retirer vos propres droits de gérance. Vous allez être déconnecté.');
          clearSession(ADMIN_SESSION_KEY);
          location.reload();
          return;
        }
        if (currentUser && id === currentUser.id) currentUser.role = role;
        await loadAll();
      } catch (e) { console.error(e); btn.disabled = false; }
    });
  });
}

// =====================
// AVERTISSEMENTS
// =====================
document.getElementById('btn-add-avert').addEventListener('click', async () => {
  const btn = document.getElementById('btn-add-avert');
  const shinobiId = document.getElementById('avert-shinobi').value;
  const raison = document.getElementById('avert-raison').value.trim();
  if (!shinobiId || !raison) return;

  btn.disabled = true;
  try {
    await supaPost('avertissements', { shinobi_id: shinobiId, par_id: currentUser.id, raison, actif: true });
    document.getElementById('avert-raison').value = '';
    await loadAvertissements();
  } catch (e) { console.error(e); alert("Erreur lors de l'ajout de l'avertissement."); } finally {
    btn.disabled = false;
  }
});

async function loadAvertissements() {
  try {
    const averts = await supaGet('avertissements', 'select=id,raison,actif,created_at,shinobi_id,par_id&order=created_at.desc&limit=100');

    const tbody = document.getElementById('avert-body');
    tbody.innerHTML = '';

    if (averts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-row">Aucun avertissement</td></tr>';
      return;
    }

    averts.forEach(a => {
      const s = shinobiMap[a.shinobi_id];
      const par = shinobiMap[a.par_id];
      if (!s) return;
      const date = new Date(a.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const heure = new Date(a.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${esc(s.prenom)} ${esc(s.nom)}</strong></td>
        <td>${esc(a.raison)}</td>
        <td>${par ? `${esc(par.prenom)} ${esc(par.nom)}` : '—'}</td>
        <td>${date} à ${heure}</td>
        <td>${a.actif ? '<span class="badge-avert actif">Actif</span>' : '<span class="badge-avert retire">Retiré</span>'}</td>
        <td>${a.actif ? `<button class="btn-avert-remove" data-id="${a.id}">Retirer</button>` : ''}</td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.btn-avert-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await supaPatch('avertissements', `id=eq.${btn.dataset.id}`, { actif: false });
          await loadAvertissements();
        } catch (e) { console.error(e); btn.disabled = false; }
      });
    });
  } catch (e) { console.error(e); }
}

// =====================
// GESTION DES COURS
// =====================
async function loadCoursAdmin() {
  try {
    const cours = await supaGet('cours', 'select=id,titre,description,created_at,shinobi_id&order=created_at.desc&limit=300');

    const counts = {};
    cours.forEach(c => { counts[c.shinobi_id] = (counts[c.shinobi_id] || 0) + 1; });

    const cb = document.getElementById('cours-count-body');
    cb.innerHTML = '';
    const entries = allShinobis.map(s => ({ s, n: counts[s.id] || 0 })).sort((a, b) => b.n - a.n);
    if (entries.length === 0) {
      cb.innerHTML = '<tr><td colspan="2" class="empty-row">Aucun shinobi inscrit</td></tr>';
    } else {
      entries.forEach(({ s, n }) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td><strong>${esc(s.prenom)} ${esc(s.nom)}</strong></td><td>${n}</td>`;
        cb.appendChild(tr);
      });
    }

    const lb = document.getElementById('cours-list-body');
    lb.innerHTML = '';
    if (cours.length === 0) {
      lb.innerHTML = '<tr><td colspan="4" class="empty-row">Aucun cours enregistré</td></tr>';
      return;
    }
    cours.forEach(c => {
      const s = shinobiMap[c.shinobi_id];
      const nom = s ? `${s.prenom} ${s.nom}` : 'Inconnu';
      const date = new Date(c.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${esc(c.titre)}</strong>${c.description ? `<br><span class="cours-desc-inline">${esc(c.description)}</span>` : ''}</td>
        <td>${esc(nom)}</td>
        <td>${date}</td>
        <td><button class="btn-poste-delete" data-id="${c.id}">Supprimer</button></td>
      `;
      lb.appendChild(tr);
    });

    lb.querySelectorAll('.btn-poste-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Supprimer définitivement ce cours ?')) return;
        btn.disabled = true;
        try {
          await supaDelete('cours', `id=eq.${btn.dataset.id}`);
          await loadCoursAdmin();
        } catch (e) { console.error(e); btn.disabled = false; }
      });
    });
  } catch (e) { console.error(e); }
}

// =====================
// CHAT DE GÉRANCE
// =====================
let lastChatCount = -1;

document.getElementById('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const contenu = input.value.trim();
  if (!contenu || !currentUser) return;
  input.value = '';
  try {
    await supaPost('messages_gerance', { auteur_id: currentUser.id, contenu });
    await loadChat(true);
  } catch (err) { console.error(err); input.value = contenu; }
});

async function loadChat(forceScroll = false) {
  try {
    const msgs = await supaGet('messages_gerance', 'select=id,auteur_id,contenu,created_at&order=created_at.asc&limit=200');
    const box = document.getElementById('chat-messages');
    if (!box) return;

    if (!forceScroll && msgs.length === lastChatCount) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    lastChatCount = msgs.length;

    box.innerHTML = '';
    if (msgs.length === 0) {
      box.innerHTML = '<div class="chat-empty">Aucun message. Lance la discussion !</div>';
      return;
    }

    msgs.forEach(m => {
      const s = shinobiMap[m.auteur_id];
      const nom = s ? `${s.prenom} ${s.nom}` : 'Inconnu';
      const mine = currentUser && m.auteur_id === currentUser.id;
      const heure = new Date(m.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const div = document.createElement('div');
      div.className = `chat-msg ${mine ? 'mine' : 'theirs'}`;
      div.innerHTML = `<div class="meta">${esc(nom)} · ${heure}</div><div class="texte">${esc(m.contenu)}</div>`;
      box.appendChild(div);
    });

    if (forceScroll || nearBottom) box.scrollTop = box.scrollHeight;
  } catch (err) { console.error(err); }
}

// =====================
// AJOUT OBSERVATEUR
// =====================
document.getElementById('btn-add-obs').addEventListener('click', async () => {
  const btn = document.getElementById('btn-add-obs');
  const prenom = document.getElementById('obs-prenom').value.trim();
  const nom = document.getElementById('obs-nom').value.trim();
  const msg = document.getElementById('obs-msg');
  msg.innerHTML = '';

  if (!prenom || !nom) {
    msg.innerHTML = '<span class="obs-msg-error">Remplis le prénom et le nom.</span>';
    return;
  }

  btn.disabled = true;
  try {
    // Un observateur n'a pas de compte utilisable : on lui attribue un
    // sceau aléatoire et jamais divulgué (au lieu d'une chaîne vide),
    // pour qu'il soit réellement impossible de se connecter avec ce
    // profil, comme annoncé dans le formulaire.
    const randomSceau = generateTempSceau() + generateTempSceau();
    const hashed = await hashSceau(randomSceau);
    await supaPost('shinobis', { prenom, nom, role: 'membre', grade: 'observateur', sceau: hashed }, true);
    document.getElementById('obs-prenom').value = '';
    document.getElementById('obs-nom').value = '';
    msg.innerHTML = '<span class="obs-msg-success">' + esc(prenom) + ' ' + esc(nom) + ' ajouté au registre.</span>';
    await loadAll();
    setTimeout(() => { msg.innerHTML = ''; }, 3000);
  } catch (e) {
    console.error(e);
    msg.innerHTML = '<span class="obs-msg-error">Erreur lors de l\'ajout.</span>';
  } finally {
    btn.disabled = false;
  }
});

// --- Auto-login from session ---
(async function autoLogin() {
  const saved = loadSession(ADMIN_SESSION_KEY);
  if (!saved || !saved.id) return;
  try {
    const users = await supaGet('shinobis', `id=eq.${saved.id}&select=id,nom,prenom,role,grade,absent,created_at`);
    if (users.length > 0 && (users[0].role === 'gerant' || users[0].role === 'co_gerant')) {
      currentUser = users[0];
      saveSession(ADMIN_SESSION_KEY, currentUser);
      showAdmin();
    } else {
      clearSession(ADMIN_SESSION_KEY);
    }
  } catch (e) {
    console.error(e);
    clearSession(ADMIN_SESSION_KEY);
  }
})();

// --- Helpers ---
function totalMinutes(postes) {
  let total = 0;
  postes.forEach(p => {
    const debut = new Date(p.debut);
    const fin = p.fin ? new Date(p.fin) : (p.actif ? new Date() : debut);
    total += (fin - debut) / 60000;
  });
  return Math.round(total);
}

function formatDuration(minutes) {
  if (minutes < 1) return '< 1 min';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return `${h}h${m.toString().padStart(2, '0')}`;
}

// --- Thème clair / sombre ---
initThemeToggle();
