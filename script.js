// IMPORTACION DE MODULOS DE FIREBASE SDK
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDocFromServer,
  collection,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// CARGA DE CONFIGURACION DE FIREBASE (PROYECTO AHORROS-SA)
let firebaseConfig = {
  projectId: "ahorros-sa",
  appId: "1:161318086592:web:f795e936d14ea7cc6d4a25",
  apiKey: "AIzaSyASRcR-3pV6LUcdbN4YwzGRF235z5PNb54",
  authDomain: "ahorros-sa.firebaseapp.com",
  storageBucket: "ahorros-sa.firebasestorage.app",
  messagingSenderId: "161318086592",
  measurementId: "G-FVK1SHVFFY"
};

try {
  const configResponse = await fetch('./firebase-applet-config.json');
  if (configResponse.ok) {
    const fetched = await configResponse.json();
    if (fetched && fetched.projectId) {
      firebaseConfig = { ...firebaseConfig, ...fetched };
    }
  }
} catch (e) {
  console.warn('Usando configuración bundled de Firebase (ahorros-sa)');
}

// INICIALIZACION DE FIREBASE
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

// ERROR HANDLER CONFORME A LA ESPECIFICACION DE FIREBASE
const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
};

function handleFirestoreError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path
  };
  console.warn('Firestore Notice:', errInfo);
}

// VALIDACION DE CONEXION INICIAL A FIRESTORE
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn("Firebase client is currently offline");
      updateSyncStatus(false, 'MODO LOCAL (OFFLINE)');
    } else {
      updateSyncStatus(true, 'CONECTADO A LA NUBE');
    }
  }
}
testConnection();

// GESTION DE BOVEDAS Y CODIGOS MULTI-DISPOSITIVO (CORTO Y MEMORABLE)
function generateVaultCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let rand = '';
  for (let i = 0; i < 4; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `AHO-${rand}`;
}

// ORDENACION CRONOLOGICA ESTRICTA POR FECHA (MÁS RECIENTES PRIMERO) Y DEDUPLICACION DEFENSIVA
function sortTransactionsByDate(list) {
  if (!Array.isArray(list)) return [];
  const seenIds = new Set();
  const seenSignatures = new Map();
  const unique = [];

  for (const item of list) {
    if (!item) continue;
    const uid = String(item.id || item.firestoreId || item.localId || item.tempId || '');
    if (uid && seenIds.has(uid)) continue;

    // Firma para detectar registros idénticos ingresados en ráfaga (<45 segundos)
    const cleanType = String(item.type || '').trim().toLowerCase();
    const cleanAmt = Math.round((parseFloat(item.amount) || 0) * 100);
    const cleanDate = String(item.date || '').trim();
    const cleanDesc = String(item.description || '').trim().toLowerCase();
    const sig = `${cleanType}_${cleanAmt}_${cleanDate}_${cleanDesc}`;
    const itemTime = new Date(item.createdAt || 0).getTime();

    if (sig && cleanAmt > 0) {
      if (seenSignatures.has(sig)) {
        const prevTime = seenSignatures.get(sig);
        // Si no tienen createdAt o la diferencia es menor a 45 segundos, es un duplicado inequívoco
        if (!itemTime || !prevTime || Math.abs(itemTime - prevTime) < 45000) {
          continue;
        }
      }
      seenSignatures.set(sig, itemTime || Date.now());
    }

    if (uid) seenIds.add(uid);
    if (item.firestoreId) seenIds.add(String(item.firestoreId));
    if (item.localId) seenIds.add(String(item.localId));
    if (item.tempId) seenIds.add(String(item.tempId));
    unique.push(item);
  }

  return unique.sort((a, b) => {
    // 1. Prioridad: Fecha del movimiento (YYYY-MM-DD)
    const da = a.date || '';
    const db = b.date || '';
    if (da !== db) return db.localeCompare(da);
    // 2. Si la fecha es igual, ordenar por hora exacta
    const ta = a.time || '';
    const tb = b.time || '';
    if (ta && tb && ta !== tb) return tb.localeCompare(ta);
    // 3. Si no hay hora, ordenar por fecha de creación (createdAt)
    const ca = a.createdAt || '';
    const cb = b.createdAt || '';
    return cb.localeCompare(ca);
  });
}

// DEDUPLICACIÓN DE DEUDAS Y OBLIGACIONES (DEBO vs ME DEBEN)
function deduplicateDebts(list) {
  if (!Array.isArray(list)) return [];
  const seenIds = new Set();
  const seenSignatures = new Map();
  const result = [];

  for (const d of list) {
    if (!d) continue;
    const uid = String(d.id || d.firestoreId || d.localId || d.tempId || '');
    if (uid && seenIds.has(uid)) continue;

    const cleanType = String(d.type || 'debt_payable').trim().toLowerCase();
    const cleanName = String(d.name || '').trim().toLowerCase();
    const cleanTotal = Math.round((parseFloat(d.total) || 0) * 100);
    const sig = `${cleanType}_${cleanName}_${cleanTotal}`;

    if (sig && cleanName && cleanTotal > 0) {
      if (seenSignatures.has(sig)) {
        // Ya existe una deuda idéntica registrada: conservar la que tenga más abonos o id de firestore
        const existing = seenSignatures.get(sig);
        if ((d.paid || 0) > (existing.paid || 0)) {
          existing.paid = d.paid;
          existing.history = d.history || existing.history;
        }
        if (d.firestoreId && !existing.firestoreId) {
          existing.firestoreId = d.firestoreId;
          existing.id = d.firestoreId;
        }
        continue;
      }
      seenSignatures.set(sig, d);
    }

    if (uid) seenIds.add(uid);
    if (d.firestoreId) seenIds.add(String(d.firestoreId));
    if (d.localId) seenIds.add(String(d.localId));
    if (d.tempId) seenIds.add(String(d.tempId));
    result.push(d);
  }
  return result;
}

// DEDUPLICACIÓN DE METAS DE AHORRO
function deduplicateGoals(list) {
  if (!Array.isArray(list)) return [];
  const seenIds = new Set();
  const seenSignatures = new Map();
  const result = [];

  for (const g of list) {
    if (!g) continue;
    const uid = String(g.id || g.firestoreId || g.localId || g.tempId || '');
    if (uid && seenIds.has(uid)) continue;

    const cleanName = String(g.name || '').trim().toLowerCase();
    const cleanTarget = Math.round((parseFloat(g.targetAmount) || 0) * 100);
    const sig = `${cleanName}_${cleanTarget}`;

    if (sig && cleanName && cleanTarget > 0) {
      if (seenSignatures.has(sig)) {
        const existing = seenSignatures.get(sig);
        if ((g.currentAmount || 0) > (existing.currentAmount || 0)) {
          existing.currentAmount = g.currentAmount;
        }
        if (g.firestoreId && !existing.firestoreId) {
          existing.firestoreId = g.firestoreId;
          existing.id = g.firestoreId;
        }
        continue;
      }
      seenSignatures.set(sig, g);
    }

    if (uid) seenIds.add(uid);
    if (g.firestoreId) seenIds.add(String(g.firestoreId));
    if (g.localId) seenIds.add(String(g.localId));
    if (g.tempId) seenIds.add(String(g.tempId));
    result.push(g);
  }
  return result;
}

// DEDUPLICACIÓN DE FINANZAS FIJAS / RECURRENTES
function deduplicateRecurring(list) {
  if (!Array.isArray(list)) return [];
  const seenIds = new Set();
  const seenSignatures = new Map();
  const result = [];

  for (const r of list) {
    if (!r) continue;
    const uid = String(r.id || r.firestoreId || r.localId || r.tempId || '');
    if (uid && seenIds.has(uid)) continue;

    const cleanType = String(r.type || 'expense').trim().toLowerCase();
    const cleanName = String(r.name || '').trim().toLowerCase();
    const cleanAmt = Math.round((parseFloat(r.amount) || 0) * 100);
    const sig = `${cleanType}_${cleanName}_${cleanAmt}`;

    if (sig && cleanName && cleanAmt > 0) {
      if (seenSignatures.has(sig)) {
        const existing = seenSignatures.get(sig);
        if (r.lastPaidMonth && !existing.lastPaidMonth) {
          existing.lastPaidMonth = r.lastPaidMonth;
        }
        if (r.dueWeekday !== undefined && existing.dueWeekday === undefined) {
          existing.dueWeekday = r.dueWeekday;
        }
        if (r.dueQuincenaDays && !existing.dueQuincenaDays) {
          existing.dueQuincenaDays = r.dueQuincenaDays;
        }
        if (r.dueMonth && !existing.dueMonth) {
          existing.dueMonth = r.dueMonth;
        }
        if (Array.isArray(r.paidPeriods) && r.paidPeriods.length > 0) {
          existing.paidPeriods = Array.from(new Set([...(existing.paidPeriods || []), ...r.paidPeriods]));
        }
        if (r.firestoreId && !existing.firestoreId) {
          existing.firestoreId = r.firestoreId;
          existing.id = r.firestoreId;
        }
        continue;
      }
      seenSignatures.set(sig, r);
    }

    if (uid) seenIds.add(uid);
    if (r.firestoreId) seenIds.add(String(r.firestoreId));
    if (r.localId) seenIds.add(String(r.localId));
    if (r.tempId) seenIds.add(String(r.tempId));
    result.push(r);
  }
  return result;
}

// SESIÓN DE USUARIO AUTENTICADO & PROTECCIÓN DE ACCESO
const savedSessionRaw = localStorage.getItem('ahorros_current_user');
let savedUserSession = null;
if (savedSessionRaw) {
  try {
    savedUserSession = JSON.parse(savedSessionRaw);
  } catch (e) {
    savedUserSession = null;
  }
}

// Si no hay sesión válida registrada, crear sesión local de invitado para permitir probar la app libremente
if (!savedUserSession || !savedUserSession.userCode) {
  const demoCode = 'USR-INVITADO';
  savedUserSession = {
    uid: 'usr_invitado',
    username: 'Invitado',
    email: '',
    userCode: demoCode,
    isGuest: true
  };
  localStorage.setItem('ahorros_current_user', JSON.stringify(savedUserSession));
  localStorage.setItem('ahorros_active_vault', demoCode);
  localStorage.setItem('ahorros_boveda_code', demoCode);
}

// Banner de bienvenida e información de modo libre / invitado
const guestBanner = document.getElementById('guest-welcome-banner');
const btnCloseGuestBanner = document.getElementById('btn-close-guest-banner');
if (guestBanner) {
  const isDismissed = sessionStorage.getItem('ahorros_guest_banner_dismissed') === 'true';
  if (savedUserSession && savedUserSession.isGuest && !isDismissed) {
    guestBanner.classList.remove('hidden');
  }
}
if (btnCloseGuestBanner && guestBanner) {
  btnCloseGuestBanner.addEventListener('click', () => {
    guestBanner.classList.add('hidden');
    sessionStorage.setItem('ahorros_guest_banner_dismissed', 'true');
  });
}

// Comprobar parámetros de URL (?boveda=... o ?code=... o ?vault=...)
const urlSearch = new URLSearchParams(window.location.search);
const paramCode = urlSearch.get('boveda') || urlSearch.get('code') || urlSearch.get('vault');
if (paramCode && paramCode.trim().length >= 3) {
  localStorage.setItem('ahorros_active_vault', paramCode.trim().toUpperCase());
  if (window.history && window.history.replaceState) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

let activeVaultId = (savedUserSession && savedUserSession.userCode) ||
                    localStorage.getItem('ahorros_active_vault') ||
                    localStorage.getItem('ahorros_boveda_code') ||
                    generateVaultCode();
activeVaultId = activeVaultId.trim().toUpperCase();
localStorage.setItem('ahorros_active_vault', activeVaultId);
localStorage.setItem('ahorros_boveda_code', activeVaultId);

// Inicializar datos visuales del perfil en la cabecera
const userBadgeName = document.getElementById('user-badge-name');
const userBadgeCode = document.getElementById('user-badge-code');
if (userBadgeName && savedUserSession) {
  userBadgeName.textContent = savedUserSession.username || savedUserSession.email || 'Mi Usuario';
}
if (userBadgeCode && savedUserSession) {
  userBadgeCode.textContent = savedUserSession.userCode;
}

// MODAL DE CONFIRMACIÓN IN-APP (REEMPLAZO SEGURO Y UNIVERSAL DE WINDOW.CONFIRM)
function appConfirm(message, options = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('app-confirm-modal');
    const msgEl = document.getElementById('confirm-modal-message');
    const titleEl = document.getElementById('confirm-modal-title');
    const iconEl = document.getElementById('confirm-modal-icon');
    const btnOk = document.getElementById('btn-confirm-ok');
    const btnCancel = document.getElementById('btn-confirm-cancel');

    if (!modal || !btnOk || !btnCancel) {
      resolve(true);
      return;
    }

    if (msgEl) msgEl.textContent = message;
    if (titleEl) titleEl.textContent = options.title || 'Confirmar Acción';
    if (iconEl) iconEl.textContent = options.icon || (options.isDanger === false ? '❓' : '🗑️');
    if (btnOk) {
      btnOk.textContent = options.okText || (options.isDanger === false ? 'Aceptar' : 'Eliminar');
      btnOk.className = options.isDanger === false ? 'btn btn-primary' : 'btn btn-danger';
    }

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    modal.style.zIndex = '200000';

    let isDone = false;
    const cleanup = () => {
      if (isDone) return;
      isDone = true;
      modal.classList.add('hidden');
      modal.style.display = '';
      btnOk.onclick = null;
      btnCancel.onclick = null;
      modal.onclick = null;
      document.removeEventListener('keydown', onKeyDown);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup();
        resolve(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        cleanup();
        resolve(true);
      }
    };

    const handleOk = (e) => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      cleanup();
      resolve(true);
    };

    const handleCancel = (e) => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      cleanup();
      resolve(false);
    };

    btnOk.onclick = handleOk;
    btnCancel.onclick = handleCancel;

    modal.onclick = (e) => {
      if (e.target === modal) {
        e?.preventDefault?.();
        cleanup();
        resolve(false);
      }
    };

    document.addEventListener('keydown', onKeyDown);
  });
}

const btnLogout = document.getElementById('btn-logout');
if (btnLogout) {
  btnLogout.addEventListener('click', async () => {
    const confirmed = await appConfirm('¿Deseas cerrar tu sesión? Tus finanzas permanecen seguras y sincronizadas en tu bóveda.', {
      title: 'Cerrar Sesión Segura',
      icon: '🚪',
      okText: 'Cerrar Sesión',
      isDanger: false
    });
    if (confirmed) {
      localStorage.removeItem('ahorros_current_user');
      if (auth) {
        try { await signOut(auth); } catch (e) {}
      }
      window.location.replace('login.html');
    }
  });
}

// ESTADO GLOBAL DE LA APLICACION
let currentUser = null;

function getVaultApiKey(vaultId) {
  const vId = String(vaultId || activeVaultId || 'DEFAULT').trim().toUpperCase();
  const vaultKeyItem = localStorage.getItem('ahorros_shortcut_key_' + vId);
  if (vaultKeyItem) return vaultKeyItem;
  const legacyKey = localStorage.getItem('ahorros_shortcut_key');
  if (legacyKey && !localStorage.getItem('ahorros_shortcut_key_migrated')) {
    localStorage.setItem('ahorros_shortcut_key_' + vId, legacyKey);
    localStorage.setItem('ahorros_shortcut_key_migrated', '1');
    return legacyKey;
  }
  // Generar clave única para esta bóveda
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let rand = '';
  for (let i = 0; i < 6; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const newKey = `AHO-SC-${rand}`;
  localStorage.setItem('ahorros_shortcut_key_' + vId, newKey);
  localStorage.setItem('ahorros_shortcut_key', newKey);
  return newKey;
}

let userApiKey = getVaultApiKey(activeVaultId);
let transactions = sortTransactionsByDate(JSON.parse(localStorage.getItem('finances_v10_trans')) || []);
let debts = deduplicateDebts(JSON.parse(localStorage.getItem('finances_v10_debts')) || []);
let savingsGoals = deduplicateGoals(JSON.parse(localStorage.getItem('finances_v10_goals')) || []);
let recurringPayments = deduplicateRecurring(JSON.parse(localStorage.getItem('finances_v10_recurring')) || []);
let shortcutEvents = [];

// Normalización defensiva: asegurar IDs estables y campos requeridos para eliminar y abonar sin fallos
transactions.forEach((t, i) => {
  if (!t.id) t.id = t.firestoreId || t.localId || t.tempId || (`tx_${Date.now()}_${i}_${Math.random().toString(36).substr(2, 6)}`);
});
debts.forEach((d, i) => {
  if (!d.id) d.id = d.firestoreId || d.localId || d.tempId || (`debt_${Date.now()}_${i}_${Math.random().toString(36).substr(2, 6)}`);
  if (!d.type) d.type = 'debt_payable';
  if (!d.frequency) d.frequency = 'mensual';
  if (!d.paymentMethod) d.paymentMethod = 'BANCO';
});
savingsGoals.forEach((g, i) => {
  if (!g.id) g.id = g.firestoreId || g.localId || g.tempId || (`goal_${Date.now()}_${i}_${Math.random().toString(36).substr(2, 6)}`);
});
recurringPayments.forEach((r, i) => {
  if (!r.id) r.id = r.firestoreId || r.localId || r.tempId || (`rec_${Date.now()}_${i}_${Math.random().toString(36).substr(2, 6)}`);
  if (!r.paymentMethod) r.paymentMethod = 'NEQUI';
  if (!r.frequency) r.frequency = 'MENSUAL';
});

// Estado de filtro de deudas (Todas, Por Pagar, Por Cobrar)
let activeDebtFilter = 'all';

// Sets de IDs y Firmas eliminadas recientemente para evitar resurrección por snapshot en tiempo real
const recentlyDeletedTxIds = new Set();
const recentlyDeletedTxSignatures = new Set();
const recentlyDeletedDebtIds = new Set();
const recentlyDeletedGoalIds = new Set();
const recentlyDeletedRecurringIds = new Set();

// Persistencia en localStorage (y sessionStorage) para sobrevivir recargas y multi-pestaña
function loadRecentlyDeletedIds() {
  try {
    const raw = localStorage.getItem('ahorros_tombstones') || sessionStorage.getItem('ahorros_tombstones');
    if (raw) {
      const data = JSON.parse(raw);
      (data.tx || []).forEach(id => recentlyDeletedTxIds.add(String(id)));
      (data.txSig || []).forEach(sig => recentlyDeletedTxSignatures.add(String(sig)));
      (data.debt || []).forEach(id => recentlyDeletedDebtIds.add(String(id)));
      (data.goal || []).forEach(id => recentlyDeletedGoalIds.add(String(id)));
      (data.recurring || []).forEach(id => recentlyDeletedRecurringIds.add(String(id)));
    }
  } catch (e) {}
}
loadRecentlyDeletedIds();

function saveRecentlyDeletedId(type, id) {
  if (!id) return;
  try {
    const raw = localStorage.getItem('ahorros_tombstones') || sessionStorage.getItem('ahorros_tombstones');
    const data = raw ? JSON.parse(raw) : { tx: [], txSig: [], debt: [], goal: [], recurring: [] };
    if (!data[type]) data[type] = [];
    const strId = String(id);
    if (!data[type].includes(strId)) {
      data[type].push(strId);
      if (data[type].length > 300) data[type].shift();
    }
    localStorage.setItem('ahorros_tombstones', JSON.stringify(data));
    sessionStorage.setItem('ahorros_tombstones', JSON.stringify(data));
  } catch (e) {}
}

const initDateObj = new Date();
let activeYear = String(initDateObj.getFullYear());
let activeMonth = String(initDateObj.getMonth() + 1).padStart(2, '0');
let activeMedium = 'ALL'; // 'ALL', 'FISICO', 'DIGITAL'
let activeMethod = 'ALL'; // 'ALL', 'EFECTIVO', 'NEQUI', 'DAVIPLATA', 'BANCO', 'TARJETA_DEBITO', 'TARJETA_CREDITO', 'OTRO'
let activeRecurringFilter = 'ALL'; // 'ALL', 'income', 'expense'
let calendarCurrentDate = new Date();

// INSTANCIAS DE GRAFICOS CHART.JS
let monthlyBarChart = null;
let categoryPieChart = null;
let balanceLineChart = null;
let mediumDoughnutChart = null;
let paymentMethodsBarChart = null;

// SUBCRIPTORES DE FIRESTORE
let unsubscribeTransactions = null;
let unsubscribeDebts = null;
let unsubscribeGoals = null;
let unsubscribeRecurring = null;
let unsubscribeVaultMeta = null;

function generateApiKey() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let rand = '';
  for (let i = 0; i < 6; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const key = `AHO-SC-${rand}`;
  localStorage.setItem('ahorros_shortcut_key_' + activeVaultId, key);
  localStorage.setItem('ahorros_shortcut_key', key);
  return key;
}

// DETERMINAR SI UN MÉTODO ES PAGO FÍSICO (EFECTIVO) O DIGITAL
function getPaymentMedium(method) {
  const m = String(method || '').trim().toUpperCase();
  return m === 'EFECTIVO' ? 'FISICO' : 'DIGITAL';
}

// FORMATO DE MONEDA ($ COP)
function formatCurrency(amount) {
  return '$ ' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(amount || 0);
}

function parseAmount(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return isNaN(val) ? 0 : Math.round(val);
  const digits = String(val).replace(/\D/g, '');
  return parseInt(digits, 10) || 0;
}

function getTodayStr() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getCurrentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

let showExactTime = localStorage.getItem('finances_show_time') === 'true';

function formatDateDisplay(dateStr, timeStrOrCreatedAt) {
  if (!dateStr) return '';
  let formattedDate = dateStr;
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    formattedDate = `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  
  if (showExactTime && timeStrOrCreatedAt) {
    let timeText = '';
    if (typeof timeStrOrCreatedAt === 'string') {
      if (timeStrOrCreatedAt.includes('T')) {
        try {
          const dt = new Date(timeStrOrCreatedAt);
          if (!isNaN(dt.getTime())) {
            timeText = dt.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: true });
          }
        } catch (e) {}
      } else {
        timeText = timeStrOrCreatedAt;
      }
    }
    if (timeText) {
      return `${formattedDate} <span style="display:inline-block; font-size:0.7rem; color:var(--primary-color); margin-left:4px; font-weight:700;">🕒 ${timeText}</span>`;
    }
  }

  return formattedDate;
}

// ELEMENTOS DOM
const syncDot = document.getElementById('sync-dot');
const syncText = document.getElementById('sync-text');
const authBtn = document.getElementById('auth-btn');
const authBtnText = document.getElementById('auth-btn-text');

const globalFilterYear = document.getElementById('global-filter-year');
const globalFilterMonth = document.getElementById('global-filter-month');
const globalFilterMedium = document.getElementById('global-filter-medium');
const globalFilterMethod = document.getElementById('global-filter-method');
const activePeriodSummary = document.getElementById('active-period-summary');
const btnClearMethodFilter = document.getElementById('btn-clear-method-filter');
const btnToggleShowTime = document.getElementById('btn-toggle-show-time');

const totalIncomeEl = document.getElementById('total-income');
const totalExpenseEl = document.getElementById('total-expense');
const totalBalanceEl = document.getElementById('total-balance');
const totalDebtPendingEl = document.getElementById('total-debt-pending');
const alertsContainer = document.getElementById('alerts-container');
const dashboardSummaryList = document.getElementById('dashboard-summary-list');
const summaryCountBadge = document.getElementById('summary-count-badge');

const incomeForm = document.getElementById('income-form');
const expenseForm = document.getElementById('expense-form');
const debtForm = document.getElementById('debt-form');
const goalForm = document.getElementById('goal-form');
const recurringForm = document.getElementById('recurring-form');

const incomePaymentMethodEl = document.getElementById('income-payment-method');
const expensePaymentMethodEl = document.getElementById('expense-payment-method');
const incomeMediumNotice = document.getElementById('income-medium-notice');
const expenseMediumNotice = document.getElementById('expense-medium-notice');
const expenseCreditGroup = document.getElementById('expense-credit-group');
const expenseInstallmentsEl = document.getElementById('expense-installments');

const incomeList = document.getElementById('income-list');
const expenseList = document.getElementById('expense-list');
const debtList = document.getElementById('debt-list');
const incomePeriodTotal = document.getElementById('income-period-total');
const expensePeriodTotal = document.getElementById('expense-period-total');
const debtsCountBadge = document.getElementById('debts-count-badge');

const goalsContainer = document.getElementById('goals-container');
const goalsSummaryBadge = document.getElementById('goals-summary-badge');
const recurringContainer = document.getElementById('recurring-container');
const recurringSummaryBadge = document.getElementById('recurring-summary-badge');

const calendarDaysContainer = document.getElementById('calendar-days-container');
const calendarMonthTitle = document.getElementById('calendar-month-title');
const calendarPrevBtn = document.getElementById('calendar-prev-btn');
const calendarNextBtn = document.getElementById('calendar-next-btn');

const shortcutApiKeyEl = document.getElementById('shortcut-api-key');
const shortcutWebhookUrlEl = document.getElementById('shortcut-webhook-url');
const btnCopyKey = document.getElementById('btn-copy-key');
const btnCopyUrl = document.getElementById('btn-copy-url');
const btnRegenKey = document.getElementById('btn-regen-key');
const shortcutEventsList = document.getElementById('shortcut-events-list');

// MODAL METAS DE AHORRO
const goalActionModal = document.getElementById('goal-action-modal');
const btnCloseGoalModal = document.getElementById('btn-close-goal-modal');
const goalActionForm = document.getElementById('goal-action-form');
const modalGoalId = document.getElementById('modal-goal-id');
const modalGoalAction = document.getElementById('modal-goal-action');
const modalGoalIcon = document.getElementById('modal-goal-icon');
const modalGoalTitle = document.getElementById('modal-goal-title');
const modalGoalSubtitle = document.getElementById('modal-goal-subtitle');
const modalGoalAmount = document.getElementById('modal-goal-amount');
const modalGoalAmountLabel = document.getElementById('modal-goal-amount-label');
const modalGoalAccount = document.getElementById('modal-goal-account');
const modalGoalSubmitBtn = document.getElementById('modal-goal-submit-btn');

// MODAL TRANSFERENCIA / RETIRO A EFECTIVO FÍSICO
const btnOpenTransferModal = document.getElementById('btn-open-transfer-modal');
const transferModal = document.getElementById('transfer-modal');
const btnCloseTransferModal = document.getElementById('btn-close-transfer-modal');
const transferForm = document.getElementById('transfer-form');
const transferFrom = document.getElementById('transfer-from');
const transferTo = document.getElementById('transfer-to');
const transferAmount = document.getElementById('transfer-amount');
const transferConcept = document.getElementById('transfer-concept');
const transferDate = document.getElementById('transfer-date');

// MODAL PAGAR TARJETA DE CRÉDITO
const btnOpenPayCardModal = document.getElementById('btn-open-pay-card-modal');
const payCardModal = document.getElementById('pay-card-modal');
const btnClosePayCardModal = document.getElementById('btn-close-pay-card-modal');
const payCardForm = document.getElementById('pay-card-form');
const payCardAmount = document.getElementById('pay-card-amount');
const payCardSource = document.getElementById('pay-card-source');
const payCardDate = document.getElementById('pay-card-date');
const payCardCurrentSpent = document.getElementById('pay-card-current-spent');

// CONTROL DE PESTAÑAS (CON PERSISTENCIA DE NAVEGACION Y SOPORTE MOVIL)
const tabButtons = document.querySelectorAll('.tab-btn');
const mobileNavButtons = document.querySelectorAll('.mobile-nav-btn');
const tabContents = document.querySelectorAll('.tab-content');

const tabOrder = [
  'tab-dashboard',
  'tab-movements',
  'tab-savings',
  'tab-recurring',
  'tab-charts',
  'tab-debts',
  'tab-shortcuts'
];
let currentActiveTabId = 'tab-dashboard';

function activateTab(tabId, isInitial = false) {
  if (!tabId) return;
  const target = document.getElementById(tabId);
  if (!target) return;

  // Evitar re-animar si la pestaña ya está activa y visible
  if (currentActiveTabId === tabId && target.classList.contains('active')) {
    return;
  }

  const targetBtn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
  const targetMobileBtn = document.querySelector(`.mobile-nav-btn[data-tab="${tabId}"]`);

  const prevIndex = tabOrder.indexOf(currentActiveTabId);
  const nextIndex = tabOrder.indexOf(tabId);

  // Determinar dirección de desplazamiento: si avanza (derecha a izquierda) o retrocede
  let direction = null;
  if (!isInitial && prevIndex !== -1 && nextIndex !== -1 && prevIndex !== nextIndex) {
    direction = nextIndex > prevIndex ? 'forward' : 'backward';
  }

  // Identificar la pestaña saliente y el contenedor relativo de transición
  const outgoingTab = currentActiveTabId ? document.getElementById(currentActiveTabId) : null;
  const stage = document.getElementById('tabs-stage');

  // Limpiar cualquier pestaña que haya quedado en proceso de salida anterior (soporte clics rápidos)
  document.querySelectorAll('.tab-content.tab-exiting').forEach(el => {
    el.classList.remove('tab-exiting', 'exit-left', 'exit-right', 'exit-fade');
    el.style.display = 'none';
    el.style.willChange = 'auto';
  });

  // Limpiar clases de preparación previas
  tabContents.forEach(c => {
    c.classList.remove('tab-prepare-right', 'tab-prepare-left', 'tab-prepare-fade');
  });

  // 1. Fijar y transicionar elásticamente la altura de .tabs-stage para evitar colapso vertical
  if (stage && outgoingTab && outgoingTab !== target && !isInitial) {
    const fromHeight = outgoingTab.offsetHeight;
    if (fromHeight > 0) {
      stage.style.height = `${fromHeight}px`;
    }

    // Medir la altura natural del destino sin provocar parpadeo
    target.style.visibility = 'hidden';
    target.style.display = 'block';
    target.style.position = 'relative';
    const toHeight = target.offsetHeight;
    target.style.display = 'none';
    target.style.visibility = '';
    target.style.position = '';

    if (toHeight > 0 && fromHeight > 0) {
      requestAnimationFrame(() => {
        stage.style.height = `${toHeight}px`;
      });
    }
  }

  // 2. Gestionar la salida suave en paralelo de la pestaña anterior (~200ms)
  if (outgoingTab && outgoingTab !== target && !isInitial) {
    outgoingTab.classList.remove('active', 'tab-slide-right', 'tab-slide-left', 'tab-fade-enter');
    outgoingTab.classList.add('tab-exiting');

    if (direction === 'forward') {
      outgoingTab.classList.add('exit-left');
    } else if (direction === 'backward') {
      outgoingTab.classList.add('exit-right');
    } else {
      outgoingTab.classList.add('exit-fade');
    }

    const onExitEnd = () => {
      outgoingTab.classList.remove('tab-exiting', 'exit-left', 'exit-right', 'exit-fade');
      outgoingTab.style.display = 'none';
      outgoingTab.style.willChange = 'auto';
      outgoingTab.removeEventListener('animationend', onExitEnd);
    };

    outgoingTab.addEventListener('animationend', onExitEnd, { once: true });
    setTimeout(onExitEnd, 220); // Respaldo seguro
  } else {
    // Si es carga inicial o no hay pestaña previa, ocultar los demás contenidos
    tabContents.forEach(c => {
      if (c !== target) {
        c.classList.remove('active', 'tab-slide-right', 'tab-slide-left', 'tab-fade-enter', 'tab-exiting', 'exit-left', 'exit-right', 'exit-fade');
        c.style.display = 'none';
        c.style.willChange = 'auto';
      }
    });
  }

  // Actualizar estados visuales de los botones de navegación
  tabButtons.forEach(b => b.classList.remove('active'));
  mobileNavButtons.forEach(b => b.classList.remove('active'));
  if (targetBtn) targetBtn.classList.add('active');
  if (targetMobileBtn) targetMobileBtn.classList.add('active');

  // 4. Garantizar Estado Inicial Cero (FOUC Fix)
  let prepareClass = 'tab-prepare-fade';
  let animationClass = 'tab-fade-enter';
  if (direction === 'forward') {
    prepareClass = 'tab-prepare-right';
    animationClass = 'tab-slide-right';
  } else if (direction === 'backward') {
    prepareClass = 'tab-prepare-left';
    animationClass = 'tab-slide-left';
  }

  target.style.display = 'block';
  target.classList.remove('tab-exiting', 'exit-left', 'exit-right', 'exit-fade', 'tab-slide-right', 'tab-slide-left', 'tab-fade-enter');

  if (!isInitial && outgoingTab) {
    target.classList.add(prepareClass);
    // Iniciar animación en el siguiente cuadro para garantizar que arranca desde opacidad cero absoluta
    requestAnimationFrame(() => {
      target.classList.remove(prepareClass);
      target.classList.add('active', animationClass);
    });
  } else {
    target.classList.add('active', animationClass);
  }

  // Liberar recursos de composición GPU y restaurar altura automática al terminar
  const onEnterEnd = () => {
    target.style.willChange = 'auto';
    if (stage) stage.style.height = '';
    target.removeEventListener('animationend', onEnterEnd);
  };
  target.addEventListener('animationend', onEnterEnd, { once: true });
  setTimeout(() => {
    if (stage) stage.style.height = '';
  }, 360);

  currentActiveTabId = tabId;
  localStorage.setItem('ahorros_active_tab', tabId);

  // Scroll instantáneo al inicio si es en móvil para evitar sacudidas
  if (window.innerWidth <= 768 && window.scrollY > 0) {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  // 2. Desacoplar renderizado pesado en un requestAnimationFrame doble (Async Render)
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (tabId === 'tab-charts') renderCharts();
      else if (tabId === 'tab-debts') renderCalendar();
      else if (tabId === 'tab-savings') renderSavingsGoals();
      else if (tabId === 'tab-recurring') renderRecurringPayments();
    });
  });
}

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    activateTab(btn.dataset.tab);
  });
});

mobileNavButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    activateTab(btn.dataset.tab);
  });
});

// Restaurar pestaña activa al recargar la página
try {
  const savedTab = localStorage.getItem('ahorros_active_tab') || 'tab-dashboard';
  if (savedTab && document.getElementById(savedTab)) {
    activateTab(savedTab, true);
  }
} catch (e) {}

// CONTROL DE ESTILOS Y TEMAS (BASE POR DEFECTO: GRAFITO CARBÓN)
const themeSelect = document.getElementById('theme-select');
let currentTheme = localStorage.getItem('app_theme');
if (!currentTheme || currentTheme === 'dark') {
  currentTheme = 'carbon';
  localStorage.setItem('app_theme', 'carbon');
}

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) {
    const metaColors = {
      carbon: '#000000',
      dark: '#0b0c10',
      sapphire: '#040914',
      amethyst: '#0a0812',
      light: '#f2f2f7'
    };
    themeMeta.setAttribute('content', metaColors[theme] || '#000000');
  }
}

applyTheme(currentTheme);
if (themeSelect) themeSelect.value = currentTheme;

if (themeSelect) {
  themeSelect.addEventListener('change', (e) => {
    applyTheme(e.target.value);
    localStorage.setItem('app_theme', currentTheme);
    renderCharts();
  });
}

// MODAL PWA INSTALACION Y COMPARTIR
const btnPwaInstall = document.getElementById('btn-pwa-install');
const btnPwaInstallText = document.getElementById('btn-pwa-install-text');
const pwaInstallModal = document.getElementById('pwa-install-modal');
const btnClosePwaModal = document.getElementById('btn-close-pwa-modal');
const btnPwaDirectInstall = document.getElementById('btn-pwa-direct-install');
const pwaQrImg = document.getElementById('pwa-qr-img');
const pwaShareUrlInput = document.getElementById('pwa-share-url-input');
const btnCopyPwaUrl = document.getElementById('btn-copy-pwa-url');

// MODAL MI BOVEDA (SIN FRICCION DE LOGINS)
const vaultModal = document.getElementById('vault-modal');
const btnCloseVaultModal = document.getElementById('btn-close-vault-modal');
const vaultCodeText = document.getElementById('vault-code-text');
const btnCopyVaultCode = document.getElementById('btn-copy-vault-code');
const btnShareVaultLink = document.getElementById('btn-share-vault-link');
const btnNewVault = document.getElementById('btn-new-vault');
const vaultLinkCodeInput = document.getElementById('vault-link-code-input');
const btnLinkVault = document.getElementById('btn-link-vault');
const vaultLinkFeedback = document.getElementById('vault-link-feedback');
const vaultGoogleEmail = document.getElementById('vault-google-email');
const vaultGoogleNote = document.getElementById('vault-google-note');
const btnVaultGoogleLogin = document.getElementById('btn-vault-google-login');
const btnTestCloudVault = document.getElementById('btn-test-cloud-vault');
const vaultTestResult = document.getElementById('vault-test-result');
const vaultQrImg = document.getElementById('vault-qr-img');
const vaultDirectUrlText = document.getElementById('vault-direct-url-text');

function updateVaultModalDirectUrl() {
  const origin = window.location.origin;
  const path = window.location.pathname;
  const directUrl = `${origin}${path}?boveda=${activeVaultId}`;
  if (vaultDirectUrlText) vaultDirectUrlText.textContent = directUrl;
  if (vaultQrImg) {
    vaultQrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(directUrl)}`;
  }
}

// URL COMPARTIDA LIMPIA Y CONFIGURABLE
let storedCustomDomain = localStorage.getItem('ahorros_shortcut_custom_domain');
let appOrigin = (storedCustomDomain && storedCustomDomain.trim()) || (window.location && window.location.origin && window.location.origin !== 'null' ? window.location.origin : '');
if (!appOrigin || appOrigin.startsWith('file://')) {
  appOrigin = window.location.protocol + '//' + window.location.host;
}
if (!appOrigin || appOrigin === 'null//null' || appOrigin.length < 5) {
  appOrigin = 'https://ahorros-sa.netlify.app';
}
let publicSharedOrigin = appOrigin.replace(/\/+$/, '');
if (pwaShareUrlInput) pwaShareUrlInput.value = publicSharedOrigin;
if (pwaQrImg) {
  pwaQrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(publicSharedOrigin)}`;
}

// GESTIÓN DE EVENTO PWA BEFOREINSTALLPROMPT
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (btnPwaInstallText) btnPwaInstallText.textContent = 'INSTALAR APP';
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  if (btnPwaInstall) {
    btnPwaInstall.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg> <span>App Instalada</span>';
    btnPwaInstall.classList.add('installed');
  }
});

// Detectar si ya corre como App nativa en standalone
const isAppStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
if (isAppStandalone && btnPwaInstall) {
  btnPwaInstall.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg> <span>App Instalada</span>';
  btnPwaInstall.classList.add('installed');
}

// ABRIR Y CERRAR MODALES PWA Y BÓVEDA
if (btnPwaInstall) {
  btnPwaInstall.addEventListener('click', () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.then((choiceResult) => {
        if (choiceResult.outcome === 'accepted') {
          deferredInstallPrompt = null;
        }
      });
    } else {
      if (pwaInstallModal) pwaInstallModal.classList.remove('hidden');
    }
  });
}

if (btnPwaDirectInstall) {
  btnPwaDirectInstall.addEventListener('click', () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
    } else {
      alert('Para instalar en iPhone: pulsa el botón Compartir de Safari y luego "Agregar a pantalla de inicio".');
    }
  });
}

const btnPwaDismiss = document.getElementById('btn-pwa-dismiss');
if (btnPwaDismiss) {
  btnPwaDismiss.addEventListener('click', () => {
    localStorage.setItem('ahorros_welcome_guide_dismissed', 'true');
    if (pwaInstallModal) pwaInstallModal.classList.add('hidden');
    showQuickToast('¡Bienvenido a Ahorros SA! Puedes probar y usar la app libremente.');
  });
}

if (btnClosePwaModal) {
  btnClosePwaModal.addEventListener('click', () => {
    localStorage.setItem('ahorros_welcome_guide_dismissed', 'true');
    if (pwaInstallModal) pwaInstallModal.classList.add('hidden');
  });
}

if (pwaInstallModal) {
  pwaInstallModal.addEventListener('click', (e) => {
    if (e.target === pwaInstallModal) {
      localStorage.setItem('ahorros_welcome_guide_dismissed', 'true');
      pwaInstallModal.classList.add('hidden');
    }
  });
}

// CERRAR CUALQUIER MODAL CON TECLA ESCAPE
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay').forEach(modal => {
      modal.classList.add('hidden');
    });
  }
});

if (btnCopyPwaUrl && pwaShareUrlInput) {
  btnCopyPwaUrl.addEventListener('click', () => {
    navigator.clipboard.writeText(pwaShareUrlInput.value).then(() => {
      btnCopyPwaUrl.textContent = '¡Copiado!';
      setTimeout(() => { btnCopyPwaUrl.textContent = 'Copiar Link'; }, 2000);
    });
  });
}

// REGISTRO DE SERVICE WORKER PARA CARGA INSTANTANEA Y OFFLINE
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(() => {
      console.log('PWA Service Worker activo');
    }).catch(err => {
      console.warn('Service worker no registrado:', err);
    });
  });
}

// MANEJO DEL MODAL DE BÓVEDA
authBtn.addEventListener('click', () => {
  updateVaultModalDirectUrl();
  if (vaultModal) vaultModal.classList.remove('hidden');
});

if (btnCloseVaultModal) {
  btnCloseVaultModal.addEventListener('click', () => {
    if (vaultModal) vaultModal.classList.add('hidden');
  });
}

if (vaultModal) {
  vaultModal.addEventListener('click', (e) => {
    if (e.target === vaultModal) vaultModal.classList.add('hidden');
  });
}

if (btnCopyVaultCode && vaultCodeText) {
  btnCopyVaultCode.addEventListener('click', () => {
    navigator.clipboard.writeText(activeVaultId).then(() => {
      btnCopyVaultCode.textContent = '¡Copiado!';
      setTimeout(() => {
        btnCopyVaultCode.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> <span>Copiar Código</span>';
      }, 2000);
    });
  });
}

if (btnShareVaultLink) {
  btnShareVaultLink.addEventListener('click', () => {
    const origin = window.location.origin;
    const path = window.location.pathname;
    const directUrl = `${origin}${path}?boveda=${activeVaultId}`;
    navigator.clipboard.writeText(directUrl).then(() => {
      btnShareVaultLink.textContent = '¡Enlace Copiado!';
      setTimeout(() => {
        btnShareVaultLink.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> <span>Copiar Enlace Directo</span>';
      }, 2000);
      alert(`¡Enlace directo copiado al portapapeles!\n\n${directUrl}\n\nÁbrelo en tu celular o envíatelo por WhatsApp para ingresar a tu bóveda sin tener que escribir el código.`);
    });
  });
}

if (btnTestCloudVault) {
  btnTestCloudVault.addEventListener('click', async () => {
    if (!vaultTestResult) return;
    vaultTestResult.style.display = 'block';
    vaultTestResult.style.background = 'rgba(6, 182, 212, 0.15)';
    vaultTestResult.style.border = '1px solid var(--primary-color)';
    vaultTestResult.style.color = 'var(--text-main)';
    vaultTestResult.innerHTML = '⏳ Realizando prueba de lectura y escritura en Firebase Firestore...';

    const t0 = performance.now();
    try {
      const pingRef = doc(db, 'vaults', activeVaultId, '_diagnostics', 'test_ping');
      await setDoc(pingRef, {
        timestamp: new Date().toISOString(),
        testBy: 'user_diagnostic',
        vaultId: activeVaultId
      });
      const snap = await getDoc(pingRef);
      const latency = Math.round(performance.now() - t0);

      if (snap.exists()) {
        vaultTestResult.style.background = 'rgba(16, 185, 129, 0.15)';
        vaultTestResult.style.border = '1px solid var(--success-color)';
        vaultTestResult.style.color = 'var(--success-color)';
        vaultTestResult.innerHTML = `
          <strong>✅ ¡BASE DE DATOS Y BÓVEDA OPERATIVAS!</strong><br>
          • <strong>Servidor Nube:</strong> Conexión Firestore verificada (${latency} ms).<br>
          • <strong>Código de Bóveda:</strong> <code>${activeVaultId}</code><br>
          • <strong>Sincronización Celular:</strong> Todo lo que agregues aquí se reflejará en tiempo real en tu teléfono con este código.
        `;
      } else {
        throw new Error('No se pudo verificar el documento de prueba en Firestore.');
      }
    } catch (err) {
      const latency = Math.round(performance.now() - t0);
      vaultTestResult.style.background = 'rgba(239, 68, 68, 0.15)';
      vaultTestResult.style.border = '1px solid var(--danger-color)';
      vaultTestResult.style.color = 'var(--danger-color)';
      vaultTestResult.innerHTML = `
        <strong>⚠️ Resultado de la prueba (${latency} ms):</strong><br>
        ${err.message || String(err)}<br>
        <small style="color: var(--text-muted);">Tus datos continúan guardándose localmente en tu dispositivo.</small>
      `;
    }
  });
}

if (btnNewVault) {
  btnNewVault.addEventListener('click', async () => {
    const confirmed = await appConfirm('¿Deseas crear una nueva Bóveda en blanco con código independiente? Tu bóveda actual no se borrará y podrás volver a ella en cualquier momento con su código.', {
      title: 'Crear Nueva Bóveda',
      icon: '➕',
      okText: 'Crear Bóveda',
      isDanger: false
    });
    if (confirmed) {
      const newCode = generateVaultCode();
      await switchVault(newCode, true);
    }
  });
}

if (btnLinkVault && vaultLinkCodeInput) {
  btnLinkVault.addEventListener('click', async () => {
    const code = vaultLinkCodeInput.value.trim().toUpperCase();
    if (!code || code.length < 3) return alert('Por favor ingresa un código de Bóveda válido.');
    await switchVault(code, false);
  });

  vaultLinkCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      btnLinkVault.click();
    }
  });
}

function updateSyncStatus(isOnline, text) {
  if (isOnline) {
    syncDot.classList.remove('offline');
    syncText.textContent = text || 'NUBE ACTIVA';
  } else {
    syncDot.classList.add('offline');
    syncText.textContent = text || 'MODO LOCAL';
  }
}

// TOAST NOTIFICADOR RÁPIDO
function showQuickToast(message, type = 'success') {
  const container = document.getElementById('app-toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `app-toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(12px) scale(0.96)';
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

// Reemplazo seguro de window.alert para entornos sandboxed / iFrame
window.alert = function(msg) {
  showQuickToast(String(msg || ''), 'warning');
};

// SELECTOR DE EMOJIS DE METAS DE AHORRO
const goalEmojiPicker = document.getElementById('goal-emoji-picker');
const goalIconPreview = document.getElementById('goal-icon-preview');
const goalIconInput = document.getElementById('goal-icon');
const goalCustomEmojiInput = document.getElementById('goal-custom-emoji-input');

if (goalEmojiPicker) {
  goalEmojiPicker.querySelectorAll('.goal-emoji-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      goalEmojiPicker.querySelectorAll('.goal-emoji-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const emoji = btn.dataset.emoji || '🎯';
      if (goalIconInput) goalIconInput.value = emoji;
      if (goalIconPreview) goalIconPreview.textContent = emoji;
      if (goalCustomEmojiInput) goalCustomEmojiInput.value = '';
    });
  });
}

if (goalCustomEmojiInput) {
  goalCustomEmojiInput.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (val) {
      if (goalEmojiPicker) {
        goalEmojiPicker.querySelectorAll('.goal-emoji-btn').forEach(b => b.classList.remove('active'));
      }
      if (goalIconInput) goalIconInput.value = val;
      if (goalIconPreview) goalIconPreview.textContent = val;
    }
  });
}

// MASCARA DE MONEDA
document.querySelectorAll('.currency-input').forEach(input => {
  input.addEventListener('input', (e) => {
    let value = e.target.value.replace(/\D/g, '');
    if (value) {
      e.target.value = new Intl.NumberFormat('es-CO').format(parseInt(value));
    }
  });
});

// MANEJO DE CATEGORIA "OTROS" DESPLEGABLE
document.querySelectorAll('.category-select').forEach(select => {
  select.addEventListener('change', (e) => {
    const otherGroupId = e.target.dataset.other;
    const otherGroup = document.getElementById(otherGroupId);
    if (e.target.value === 'OTROS') {
      otherGroup.classList.remove('hidden');
    } else {
      otherGroup.classList.add('hidden');
    }
  });
});

// DEFAULT VALUES FOR DATE INPUTS
const todayStr = getTodayStr();
const incomeDateInput = document.getElementById('income-date');
const expenseDateInput = document.getElementById('expense-date');
const debtDateInput = document.getElementById('debt-start-date');
if (incomeDateInput) incomeDateInput.value = todayStr;
if (expenseDateInput) expenseDateInput.value = todayStr;
if (debtDateInput) debtDateInput.value = todayStr;
if (transferDate) transferDate.value = todayStr;
if (payCardDate) payCardDate.value = todayStr;

// ACTUALIZAR AVISO DE MEDIO DE PAGO EN FORMULARIOS
function updateMediumNotice(selectEl, noticeEl, isExpense = false) {
  if (!selectEl || !noticeEl) return;
  const val = selectEl.value;
  if (val === 'EFECTIVO') {
    noticeEl.innerHTML = `<span>💵</span> <span>Medio: PAGO FÍSICO (Efectivo en mano)</span>`;
    noticeEl.style.color = 'var(--success-color)';
  } else if (val === 'TARJETA_CREDITO') {
    noticeEl.innerHTML = `<span>💳</span> <span>Medio: PAGO DIGITAL (Tarjeta de Crédito)</span>`;
    noticeEl.style.color = 'var(--danger-color)';
  } else {
    noticeEl.innerHTML = `<span>📱</span> <span>Medio: PAGO DIGITAL (Transferencia / App / Tarjeta)</span>`;
    noticeEl.style.color = 'var(--primary-color)';
  }

  if (isExpense && expenseCreditGroup) {
    if (val === 'TARJETA_CREDITO') {
      expenseCreditGroup.classList.remove('hidden');
    } else {
      expenseCreditGroup.classList.add('hidden');
    }
  }
}

if (incomePaymentMethodEl) {
  incomePaymentMethodEl.addEventListener('change', () => {
    updateMediumNotice(incomePaymentMethodEl, incomeMediumNotice, false);
  });
  updateMediumNotice(incomePaymentMethodEl, incomeMediumNotice, false);
}

if (expensePaymentMethodEl) {
  expensePaymentMethodEl.addEventListener('change', () => {
    updateMediumNotice(expensePaymentMethodEl, expenseMediumNotice, true);
  });
  updateMediumNotice(expensePaymentMethodEl, expenseMediumNotice, true);
}

// CHIPS RAPIDOS DE MONTO (METAS DE AHORRO, TRANSFERENCIAS Y DEUDAS)
document.querySelectorAll('.amount-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const addAmt = parseInt(chip.dataset.add, 10) || 0;
    if (chip.classList.contains('debt-quick-chip')) {
      const targetInput = document.getElementById('modal-debt-amount');
      if (!targetInput) return;
      const currentVal = parseAmount(targetInput.value) || 0;
      const newVal = currentVal + addAmt;
      targetInput.value = new Intl.NumberFormat('es-CO').format(newVal);
      return;
    }
    const isTransfer = chip.classList.contains('transfer-chip');
    const targetInput = isTransfer ? transferAmount : modalGoalAmount;
    if (!targetInput) return;

    const currentVal = parseAmount(targetInput.value) || 0;
    const newVal = currentVal + addAmt;
    targetInput.value = new Intl.NumberFormat('es-CO').format(newVal);
  });
});

// SINCRONIZACIÓN DE SELECTORES VISUALES TÁCTILES (CHIPS) CON LOS SELECTS DE CUENTA Y CATEGORÍA
function setupQuickChipSync(chipsContainerId, selectElementId) {
  const container = document.getElementById(chipsContainerId);
  const select = document.getElementById(selectElementId);
  if (!container || !select) return;

  const chips = container.querySelectorAll('.quick-chip');
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      const val = chip.dataset.val;
      select.value = val;
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });

  select.addEventListener('change', () => {
    chips.forEach(chip => {
      if (chip.dataset.val === select.value) {
        chip.classList.add('active');
      } else {
        chip.classList.remove('active');
      }
    });
  });
}

setupQuickChipSync('income-account-chips', 'income-payment-method');
setupQuickChipSync('income-category-chips', 'income-category');
setupQuickChipSync('expense-account-chips', 'expense-payment-method');
setupQuickChipSync('expense-category-chips', 'expense-category');

// SELECTOR DE TIPO DE DEUDA: DEBO (POR PAGAR) vs ME DEBEN (POR COBRAR)
const debtTypeInput = document.getElementById('debt-type');
const btnDebtTypePayable = document.getElementById('btn-debt-type-payable');
const btnDebtTypeReceivable = document.getElementById('btn-debt-type-receivable');
const debtNameLabel = document.getElementById('debt-name-label');
const debtNameInput = document.getElementById('debt-name');
const debtSubmitBtn = document.getElementById('debt-submit-btn');

function setDebtType(type) {
  if (!debtTypeInput) return;
  debtTypeInput.value = type;
  if (type === 'debt_receivable') {
    btnDebtTypeReceivable?.classList.add('active');
    btnDebtTypePayable?.classList.remove('active');
    if (debtNameLabel) debtNameLabel.textContent = 'Persona o Entidad que te debe (Deudor)';
    if (debtNameInput) debtNameInput.placeholder = 'Ej: Carlos Gómez, cliente, amigo a quien presté';
    if (debtSubmitBtn) {
      debtSubmitBtn.textContent = 'Registrar Dinero por Cobrar';
      debtSubmitBtn.className = 'btn btn-success';
    }
  } else {
    btnDebtTypePayable?.classList.add('active');
    btnDebtTypeReceivable?.classList.remove('active');
    if (debtNameLabel) debtNameLabel.textContent = 'Nombre de la Obligación / Acreedor (¿A quién le debes?)';
    if (debtNameInput) debtNameInput.placeholder = 'Ej: Banco, préstamo, tarjeta o familiar';
    if (debtSubmitBtn) {
      debtSubmitBtn.textContent = 'Registrar Deuda por Pagar';
      debtSubmitBtn.className = 'btn btn-purple';
    }
  }
}

if (btnDebtTypePayable && btnDebtTypeReceivable) {
  btnDebtTypePayable.addEventListener('click', () => setDebtType('debt_payable'));
  btnDebtTypeReceivable.addEventListener('click', () => setDebtType('debt_receivable'));
}

// GESTIÓN DEL MODAL DE ABONO LIBRE A DEUDAS (PAGO / COBRO)
const debtActionModal = document.getElementById('debt-action-modal');
const btnCloseDebtModal = document.getElementById('btn-close-debt-modal');
const debtActionForm = document.getElementById('debt-action-form');
const modalDebtId = document.getElementById('modal-debt-id');
const modalDebtTitle = document.getElementById('modal-debt-title');
const modalDebtSubtitle = document.getElementById('modal-debt-subtitle');
const modalDebtTypeBadge = document.getElementById('modal-debt-type-badge');
const modalDebtName = document.getElementById('modal-debt-name');
const modalDebtPendingAmount = document.getElementById('modal-debt-pending-amount');
const modalDebtAmountInput = document.getElementById('modal-debt-amount');
const modalDebtAmountLabel = document.getElementById('modal-debt-amount-label');
const modalDebtAccount = document.getElementById('modal-debt-account');
const modalDebtAccountLabel = document.getElementById('modal-debt-account-label');
const modalDebtDate = document.getElementById('modal-debt-date');
const modalDebtNote = document.getElementById('modal-debt-note');
const modalDebtSubmitBtn = document.getElementById('modal-debt-submit-btn');
const chipDebtSuggested = document.getElementById('chip-debt-suggested');
const chipDebtLiquidate = document.getElementById('chip-debt-liquidate');

let activeModalDebt = null;

window.openDebtActionModal = function(idOrIndex, defaultAmount = null) {
  const strId = String(idOrIndex).trim();
  let targetDebt = debts.find(d => 
    d && (
      String(d.id) === strId ||
      String(d.firestoreId) === strId ||
      String(d.localId) === strId ||
      String(d.tempId) === strId
    )
  );
  if (!targetDebt && !isNaN(parseInt(idOrIndex, 10)) && debts[parseInt(idOrIndex, 10)]) {
    targetDebt = debts[parseInt(idOrIndex, 10)];
  }

  if (!targetDebt) return;
  activeModalDebt = targetDebt;

  const interestRate = targetDebt.interest || 0;
  const totalWithInterest = targetDebt.total + (targetDebt.total * (interestRate / 100));
  const currentPaid = targetDebt.paid || 0;
  const pending = Math.max(0, totalWithInterest - currentPaid);
  const totalQuotas = targetDebt.installments || 1;
  const suggestedQuota = Math.round(totalWithInterest / totalQuotas);

  const isReceivable = targetDebt.type === 'debt_receivable';

  if (modalDebtId) modalDebtId.value = targetDebt.id || strId;
  if (modalDebtName) modalDebtName.textContent = targetDebt.name;
  if (modalDebtPendingAmount) modalDebtPendingAmount.textContent = formatCurrency(pending);

  if (isReceivable) {
    if (modalDebtTitle) modalDebtTitle.textContent = 'Registrar Cobro / Abono Recibido';
    if (modalDebtSubtitle) modalDebtSubtitle.textContent = `Deudor: ${targetDebt.name}`;
    if (modalDebtTypeBadge) {
      modalDebtTypeBadge.textContent = '🟢 DINERO POR COBRAR (A FAVOR)';
      modalDebtTypeBadge.className = 'tag-badge text-success';
    }
    if (modalDebtAmountLabel) modalDebtAmountLabel.textContent = 'Monto recaudado o que te pagaron hoy ($ COP)';
    if (modalDebtAccountLabel) modalDebtAccountLabel.textContent = 'Cuenta de Destino (¿A dónde entra el dinero?)';
    if (modalDebtSubmitBtn) {
      modalDebtSubmitBtn.textContent = 'Confirmar Cobro Recibido (Ingreso)';
      modalDebtSubmitBtn.className = 'btn btn-success';
    }
  } else {
    if (modalDebtTitle) modalDebtTitle.textContent = 'Registrar Abono a Obligación';
    if (modalDebtSubtitle) modalDebtSubtitle.textContent = `Acreedor: ${targetDebt.name}`;
    if (modalDebtTypeBadge) {
      modalDebtTypeBadge.textContent = '🔻 DEUDA POR PAGAR (PASIVO)';
      modalDebtTypeBadge.className = 'tag-badge text-danger';
    }
    if (modalDebtAmountLabel) modalDebtAmountLabel.textContent = 'Monto que deseas abonar hoy ($ COP)';
    if (modalDebtAccountLabel) modalDebtAccountLabel.textContent = 'Cuenta de Pago (¿De dónde sale el dinero?)';
    if (modalDebtSubmitBtn) {
      modalDebtSubmitBtn.textContent = 'Confirmar Abono (Gasto)';
      modalDebtSubmitBtn.className = 'btn btn-purple';
    }
  }

  // Pre-seleccionar cuenta/método habitual o por defecto
  const preferredAccount = targetDebt.method || targetDebt.paymentMethod || (isReceivable ? 'NEQUI' : 'BANCO');
  if (modalDebtAccount) {
    modalDebtAccount.value = preferredAccount;
  }
  document.querySelectorAll('.debt-acc-chip').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.acc === preferredAccount);
    btn.onclick = () => {
      document.querySelectorAll('.debt-acc-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (modalDebtAccount) modalDebtAccount.value = btn.dataset.acc;
    };
  });

  // Prellenar monto si se pasó un monto explícito o cuota sugerida
  let initialAmount = pending > 0 ? Math.min(pending, suggestedQuota) : 0;
  if (defaultAmount !== null && defaultAmount !== undefined) {
    const parsed = parseAmount(String(defaultAmount));
    if (parsed && parsed > 0) initialAmount = parsed;
  }

  if (modalDebtAmountInput) {
    modalDebtAmountInput.value = initialAmount > 0 ? new Intl.NumberFormat('es-CO').format(initialAmount) : '';
  }

  if (chipDebtSuggested) {
    chipDebtSuggested.textContent = `Cuota Sugerida (${formatCurrency(suggestedQuota)})`;
    chipDebtSuggested.onclick = () => {
      if (modalDebtAmountInput) {
        modalDebtAmountInput.value = new Intl.NumberFormat('es-CO').format(Math.min(pending, suggestedQuota));
      }
    };
  }

  if (chipDebtLiquidate) {
    chipDebtLiquidate.textContent = `Liquidar Total (${formatCurrency(pending)})`;
    chipDebtLiquidate.onclick = () => {
      if (modalDebtAmountInput) {
        modalDebtAmountInput.value = new Intl.NumberFormat('es-CO').format(pending);
      }
    };
  }

  if (modalDebtDate) modalDebtDate.value = getTodayStr();
  if (modalDebtNote) modalDebtNote.value = '';

  if (debtActionModal) debtActionModal.classList.remove('hidden');
  setTimeout(() => modalDebtAmountInput?.focus(), 100);
};

if (btnCloseDebtModal && debtActionModal) {
  btnCloseDebtModal.addEventListener('click', () => {
    debtActionModal.classList.add('hidden');
    activeModalDebt = null;
  });

  debtActionModal.addEventListener('click', (e) => {
    if (e.target === debtActionModal) {
      debtActionModal.classList.add('hidden');
      activeModalDebt = null;
    }
  });
}

if (debtActionForm) {
  debtActionForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (debtActionForm.dataset.submitting === 'true') return;
    if (!activeModalDebt) return;

    const payAmount = parseAmount(modalDebtAmountInput.value);
    if (!payAmount || payAmount <= 0) return alert('Por favor ingresa un monto de abono válido.');

    const interestRate = activeModalDebt.interest || 0;
    const totalWithInterest = activeModalDebt.total + (activeModalDebt.total * (interestRate / 100));
    const currentPaid = activeModalDebt.paid || 0;
    const pending = Math.max(0, totalWithInterest - currentPaid);

    if (payAmount > pending) {
      const confirmed = await appConfirm(
        `El monto ($ ${formatCurrency(payAmount)}) supera el saldo restante ($ ${formatCurrency(pending)}). ¿Deseas liquidar el saldo exacto restante?`,
        {
          title: 'Liquidar Saldo',
          icon: '💳',
          okText: 'Liquidar Total',
          isDanger: false
        }
      );
      if (!confirmed) return;
    }

    debtActionForm.dataset.submitting = 'true';
    if (modalDebtSubmitBtn) modalDebtSubmitBtn.disabled = true;

    try {
      const finalAbono = Math.min(payAmount, pending);
      const newPaid = currentPaid + finalAbono;
      const paymentAccountVal = modalDebtAccount?.value || 'BANCO';
      const paymentDateVal = modalDebtDate?.value || getTodayStr();
      const noteVal = modalDebtNote?.value?.trim() || '';

      let historyArr = [];
      try {
        historyArr = typeof activeModalDebt.history === 'string' ? JSON.parse(activeModalDebt.history) : (activeModalDebt.history || []);
      } catch (err) { historyArr = []; }

      historyArr.push({
        date: paymentDateVal,
        amount: finalAbono,
        account: paymentAccountVal,
        note: noteVal
      });

      activeModalDebt.paid = newPaid;
      activeModalDebt.history = JSON.stringify(historyArr);

      localStorage.setItem('finances_v10_debts', JSON.stringify(debts));
      updateUI();

      const isReceivable = activeModalDebt.type === 'debt_receivable';

      if (isReceivable) {
        // Dinero que me debían: el abono entra a mi cuenta como un INGRESO
        await addTransactionLocallyOrCloud({
          type: 'income',
          date: paymentDateVal,
          description: `ABONO RECIBIDO DE: ${activeModalDebt.name}${noteVal ? ` (${noteVal})` : ''}`,
          amount: finalAbono,
          category: 'REEMBOLSOS',
          paymentMethod: paymentAccountVal
        });
        showQuickToast(`✅ Cobro de ${formatCurrency(finalAbono)} recibido de "${activeModalDebt.name}" registrado como Ingreso`);
      } else {
        // Deuda que debo: el abono sale de mi cuenta como un GASTO
        await addTransactionLocallyOrCloud({
          type: 'expense',
          date: paymentDateVal,
          description: `ABONO A ${activeModalDebt.name}${noteVal ? ` (${noteVal})` : ''}`,
          amount: finalAbono,
          category: 'PAGO DE DEUDAS',
          paymentMethod: paymentAccountVal
        });
        showQuickToast(`✅ Abono de ${formatCurrency(finalAbono)} a "${activeModalDebt.name}" registrado como Gasto`);
      }

      try {
        const docId = activeModalDebt.firestoreId || activeModalDebt.id;
        const dRef = doc(db, 'vaults', activeVaultId, 'debts', docId);
        await setDoc(dRef, {
          vaultId: activeVaultId,
          ...activeModalDebt,
          paid: newPaid,
          history: JSON.stringify(historyArr)
        }, { merge: true });
      } catch (err) {
        console.warn('Error actualizando deuda en Firestore:', err);
      }

      debtActionModal.classList.add('hidden');
      debtActionForm.reset();
      activeModalDebt = null;
      syncClientTotalsToServer();
    } finally {
      debtActionForm.dataset.submitting = 'false';
      if (modalDebtSubmitBtn) modalDebtSubmitBtn.disabled = false;
    }
  });
}

// ============================================================================
// GESTIÓN DINÁMICA DE FINANZAS FIJAS (PERIODICIDAD, CRONOGRAMA Y PAGOS FLEXIBLES)
// ============================================================================

// HELPER: Formatear texto descriptivo de la fecha/periodicidad
function formatRecurringSchedule(r) {
  if (!r) return 'Mensual';
  const freq = (r.frequency || 'mensual').toLowerCase();
  if (freq === 'semanal') {
    const weekdays = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const wd = (r.dueWeekday !== undefined && r.dueWeekday !== null) ? Number(r.dueWeekday) : 5;
    return `Cada ${weekdays[wd] || 'Viernes'}`;
  }
  if (freq === 'quincenal') {
    if (r.dueQuincenaDays) {
      return `Días ${r.dueQuincenaDays.replace(',', ' y ')}`;
    }
    return 'Días 15 y 30';
  }
  if (freq === 'anual') {
    const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    const m = r.dueMonth ? months[Number(r.dueMonth) - 1] : 'Diciembre';
    return `${r.dueDay || 15} de ${m}`;
  }
  // Mensual por defecto
  return `Día ${r.dueDay || 5} de cada mes`;
}

// HELPER: Impacto mensual proyectado según la periodicidad
function getRecurringMonthlyAmount(r) {
  if (!r) return 0;
  const freq = (r.frequency || 'mensual').toLowerCase();
  const amt = Number(r.amount) || 0;
  if (freq === 'quincenal') return amt * 2;
  if (freq === 'semanal') return amt * 4;
  if (freq === 'anual') return amt / 12;
  return amt;
}

// HELPER: Alternar visibilidad de campos de periodicidad (Creación y Edición)
function updateRecScheduleFields(isEdit = false) {
  const prefix = isEdit ? 'edit-rec-' : 'rec-';
  const freqSelect = document.getElementById(`${prefix}frequency`);
  if (!freqSelect) return;
  const freq = (freqSelect.value || 'mensual').toLowerCase();

  const mensualDiv = document.getElementById(`${prefix}field-mensual`);
  const quincenalDiv = document.getElementById(`${prefix}field-quincenal`);
  const semanalDiv = document.getElementById(`${prefix}field-semanal`);
  const anualDiv = document.getElementById(`${prefix}field-anual`);

  if (mensualDiv) mensualDiv.classList.toggle('hidden', freq !== 'mensual');
  if (quincenalDiv) quincenalDiv.classList.toggle('hidden', freq !== 'quincenal');
  if (semanalDiv) semanalDiv.classList.toggle('hidden', freq !== 'semanal');
  if (anualDiv) anualDiv.classList.toggle('hidden', freq !== 'anual');

  // Ajustar opción personalizada de quincena
  const qScheme = document.getElementById(`${prefix}quincena-scheme`);
  const qCustomRow = document.getElementById(`${prefix}quincena-custom-row`);
  if (qScheme && qCustomRow) {
    qCustomRow.classList.toggle('hidden', qScheme.value !== 'custom');
  }
}

// Listeners de cambios de frecuencia y esquemas
const recFreqEl = document.getElementById('rec-frequency');
if (recFreqEl) {
  recFreqEl.addEventListener('change', () => updateRecScheduleFields(false));
}
const recQSchemeEl = document.getElementById('rec-quincena-scheme');
if (recQSchemeEl) {
  recQSchemeEl.addEventListener('change', () => updateRecScheduleFields(false));
}
const editRecFreqEl = document.getElementById('edit-rec-frequency');
if (editRecFreqEl) {
  editRecFreqEl.addEventListener('change', () => updateRecScheduleFields(true));
}
const editRecQSchemeEl = document.getElementById('edit-rec-quincena-scheme');
if (editRecQSchemeEl) {
  editRecQSchemeEl.addEventListener('change', () => updateRecScheduleFields(true));
}

// Inicializar visibilidad en carga
updateRecScheduleFields(false);

// MODAL PARA REGISTRAR PAGO/COBRO DE FINANZAS FIJAS
const recurringPayModal = document.getElementById('recurring-pay-modal');
const btnCloseRecModal = document.getElementById('btn-close-rec-modal');
const recurringPayForm = document.getElementById('recurring-pay-form');

window.openRecurringPayModal = function(idOrIndex) {
  const strId = String(idOrIndex).trim();
  let targetR = recurringPayments.find(r => 
    r && (String(r.id) === strId || String(r.firestoreId) === strId || String(r.localId) === strId)
  );
  if (!targetR && !isNaN(parseInt(idOrIndex, 10))) {
    targetR = recurringPayments[parseInt(idOrIndex, 10)];
  }
  if (!targetR) return;

  const isIncome = targetR.type === 'income';
  const idEl = document.getElementById('modal-rec-id');
  if (idEl) idEl.value = targetR.id || strId;
  const titleEl = document.getElementById('modal-rec-title');
  if (titleEl) titleEl.textContent = isIncome ? `Registrar Cobro: ${targetR.name}` : `Registrar Pago: ${targetR.name}`;
  
  const scheduleText = formatRecurringSchedule(targetR);
  const freqName = (targetR.frequency || 'mensual').toLowerCase();
  const subEl = document.getElementById('modal-rec-subtitle');
  if (subEl) subEl.textContent = `Compromiso ${freqName} • ${scheduleText}`;

  const iconEl = document.getElementById('modal-rec-icon');
  if (iconEl) iconEl.textContent = isIncome ? '🟢' : '🔴';
  const amtEl = document.getElementById('modal-rec-amount-display');
  if (amtEl) amtEl.textContent = formatCurrency(targetR.amount || 0);
  const dateEl = document.getElementById('modal-rec-date');
  if (dateEl) dateEl.value = getTodayStr();
  const noteEl = document.getElementById('modal-rec-note');
  if (noteEl) noteEl.value = '';

  const defaultMethod = targetR.paymentMethod || (isIncome ? 'BANCO' : 'NEQUI');
  const accSelect = document.getElementById('modal-rec-account');
  if (accSelect) accSelect.value = defaultMethod;

  document.querySelectorAll('.rec-acc-chip').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.acc === defaultMethod);
    btn.onclick = () => {
      document.querySelectorAll('.rec-acc-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (accSelect) accSelect.value = btn.dataset.acc;
    };
  });

  // Selector dinámico de periodos (Quincenas, Semanas, Anual o Mes)
  const periodGroup = document.getElementById('modal-rec-period-group');
  const periodLabel = document.getElementById('modal-rec-period-label');
  const periodSelect = document.getElementById('modal-rec-period-select');
  const periodHelper = document.getElementById('modal-rec-period-helper');

  if (periodSelect) {
    periodSelect.innerHTML = '';
    const currentYM = getCurrentYearMonth();
    const currentYear = currentYM.substring(0, 4);

    // Obtener transacciones vinculadas a este compromiso en el mes actual
    const matchingTxsThisMonth = transactions.filter(t => {
      if (!t.date || !t.date.startsWith(currentYM)) return false;
      if (t.recurringId && (String(t.recurringId) === String(targetR.id) || String(t.recurringId) === String(targetR.firestoreId) || String(t.recurringId) === String(targetR.localId))) return true;
      const desc = (t.description || '').toLowerCase();
      const expectedDesc = `${isIncome ? 'INGRESO FIJO' : 'PAGO FIJO'}: ${targetR.name}`.toLowerCase();
      return desc.startsWith(expectedDesc) || (targetR.name && desc.includes(targetR.name.toLowerCase()) && (desc.includes('fijo') || desc.includes('recurrente')));
    });

    if (freqName === 'quincenal') {
      if (periodGroup) periodGroup.classList.remove('hidden');
      if (periodLabel) periodLabel.textContent = 'Quincena a Registrar:';
      
      const hasQ1 = matchingTxsThisMonth.some(t => (t.recurringPeriod && t.recurringPeriod.endsWith('Q1')) || (t.description && t.description.includes('1ª Quincena')));
      const hasQ2 = matchingTxsThisMonth.some(t => (t.recurringPeriod && t.recurringPeriod.endsWith('Q2')) || (t.description && t.description.includes('2ª Quincena')));

      periodSelect.innerHTML = `
        <option value="Q1" ${!hasQ1 ? 'selected' : ''}>1ª Quincena (Días 1 - 15) ${hasQ1 ? '✓ (Registrada)' : ''}</option>
        <option value="Q2" ${(hasQ1 && !hasQ2) ? 'selected' : ''}>2ª Quincena (Días 16 - Fin de mes) ${hasQ2 ? '✓ (Registrada)' : ''}</option>
        <option value="EXTRA" ${(hasQ1 && hasQ2) ? 'selected' : ''}>Quincena Adicional / Extraordinaria</option>
      `;
      if (periodHelper) {
        periodHelper.textContent = 'Puedes pagar o cobrar la primera o segunda quincena por separado en cualquier momento.';
      }
    } else if (freqName === 'semanal') {
      if (periodGroup) periodGroup.classList.remove('hidden');
      if (periodLabel) periodLabel.textContent = 'Semana a Registrar:';
      const paidCount = matchingTxsThisMonth.length;
      const nextWeek = paidCount + 1;

      let optionsHtml = '';
      for (let w = 1; w <= 5; w++) {
        const isAlready = w <= paidCount;
        optionsHtml += `<option value="W${w}" ${w === nextWeek ? 'selected' : ''}>Semana ${w} del mes ${isAlready ? '✓ (Registrada)' : ''}</option>`;
      }
      optionsHtml += `<option value="EXTRA" ${nextWeek > 5 ? 'selected' : ''}>Semana Adicional / Extra</option>`;
      periodSelect.innerHTML = optionsHtml;
      if (periodHelper) {
        periodHelper.textContent = `Llevas ${paidCount} ${paidCount === 1 ? 'semana registrada' : 'semanas registradas'} este mes. Puedes registrar tantas semanas como necesites sin bloqueo.`;
      }
    } else if (freqName === 'anual') {
      if (periodGroup) periodGroup.classList.remove('hidden');
      if (periodLabel) periodLabel.textContent = 'Año a Registrar:';
      periodSelect.innerHTML = `
        <option value="YEAR" selected>Año en Curso (${currentYear})</option>
        <option value="NEXT_YEAR">Adelanto Año Siguiente (${Number(currentYear) + 1})</option>
      `;
      if (periodHelper) {
        periodHelper.textContent = 'Compromiso anual. Se marca como cubierto para todo el año calendario.';
      }
    } else {
      // Mensual
      if (periodGroup) periodGroup.classList.remove('hidden');
      if (periodLabel) periodLabel.textContent = 'Periodo del Pago/Cobro:';
      periodSelect.innerHTML = `
        <option value="MONTH" selected>Mes en Curso (${currentYM})</option>
        <option value="EXTRA">Cobro / Pago Adicional de este mes</option>
      `;
      if (periodHelper) {
        periodHelper.textContent = 'Compromiso habitual de facturación o cobro mensual.';
      }
    }
  }

  const submitBtn = document.getElementById('modal-rec-submit-btn');
  if (submitBtn) {
    submitBtn.textContent = isIncome ? 'Confirmar Cobro / Ingreso' : 'Confirmar Pago / Gasto';
    submitBtn.className = isIncome ? 'btn btn-success' : 'btn btn-primary';
  }

  if (recurringPayModal) recurringPayModal.classList.remove('hidden');
};

if (btnCloseRecModal && recurringPayModal) {
  btnCloseRecModal.addEventListener('click', () => {
    recurringPayModal.classList.add('hidden');
  });
  recurringPayModal.addEventListener('click', (e) => {
    if (e.target === recurringPayModal) recurringPayModal.classList.add('hidden');
  });
}

if (recurringPayForm) {
  recurringPayForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (recurringPayForm.dataset.submitting === 'true') return;

    const id = document.getElementById('modal-rec-id')?.value;
    const targetR = recurringPayments.find(r => 
      r && (String(r.id) === String(id) || String(r.firestoreId) === String(id) || String(r.localId) === String(id))
    );
    if (!targetR) return;

    recurringPayForm.dataset.submitting = 'true';
    const submitBtn = recurringPayForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    try {
      const chosenMethod = document.getElementById('modal-rec-account')?.value || targetR.paymentMethod || 'NEQUI';
      const chosenDate = document.getElementById('modal-rec-date')?.value || getTodayStr();
      const noteVal = document.getElementById('modal-rec-note')?.value?.trim() || '';
      const currentYM = chosenDate.substring(0, 7) || getCurrentYearMonth();
      const isIncome = targetR.type === 'income';
      const freq = (targetR.frequency || 'mensual').toLowerCase();

      // Construcción del periodo y descripción
      const periodVal = document.getElementById('modal-rec-period-select')?.value || 'MONTH';
      let periodLabel = '';
      let periodCode = `${currentYM}`;

      if (freq === 'quincenal') {
        if (periodVal === 'Q1') {
          periodLabel = '1ª Quincena';
          periodCode = `${currentYM}-Q1`;
        } else if (periodVal === 'Q2') {
          periodLabel = '2ª Quincena';
          periodCode = `${currentYM}-Q2`;
        } else {
          periodLabel = 'Quincena Extra';
          periodCode = `${currentYM}-QX`;
        }
      } else if (freq === 'semanal') {
        if (periodVal.startsWith('W')) {
          periodLabel = `Semana ${periodVal.replace('W', '')}`;
          periodCode = `${currentYM}-${periodVal}`;
        } else {
          periodLabel = 'Semana Extra';
          periodCode = `${currentYM}-WX`;
        }
      } else if (freq === 'anual') {
        const year = chosenDate.substring(0, 4);
        periodLabel = `Año ${year}`;
        periodCode = year;
      }

      const descPeriodPart = periodLabel ? ` [${periodLabel}]` : '';
      const finalDesc = `${isIncome ? 'INGRESO FIJO' : 'PAGO FIJO'}: ${targetR.name}${descPeriodPart}${noteVal ? ` (${noteVal})` : ''}`;

      await addTransactionLocallyOrCloud({
        type: isIncome ? 'income' : 'expense',
        description: finalDesc,
        recurringId: targetR.id,
        recurringName: targetR.name,
        recurringPeriod: periodCode,
        recurringFrequency: targetR.frequency,
        amount: targetR.amount,
        category: targetR.category,
        paymentMethod: chosenMethod,
        date: chosenDate
      });

      targetR.lastPaidMonth = currentYM;
      targetR.lastPaidPeriod = periodCode;
      if (!Array.isArray(targetR.paidPeriods)) targetR.paidPeriods = [];
      if (!targetR.paidPeriods.includes(periodCode)) {
        targetR.paidPeriods.push(periodCode);
      }

      localStorage.setItem('finances_v10_recurring', JSON.stringify(recurringPayments));
      renderRecurringPayments();

      try {
        const rRef = doc(db, 'vaults', activeVaultId, 'recurringPayments', targetR.firestoreId || targetR.id);
        await setDoc(rRef, {
          vaultId: activeVaultId,
          ...targetR,
          lastPaidMonth: currentYM,
          lastPaidPeriod: periodCode,
          paidPeriods: targetR.paidPeriods
        }, { merge: true });
      } catch (err) {
        console.warn('Error actualizando compromiso fijo en Firestore:', err);
      }

      if (recurringPayModal) recurringPayModal.classList.add('hidden');
      recurringPayForm.reset();
      showQuickToast(`⚡ ${isIncome ? 'Cobro' : 'Pago'} de "${targetR.name}" registrado con ${chosenMethod}`);
    } finally {
      recurringPayForm.dataset.submitting = 'false';
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

// MODAL Y GESTIÓN PARA EDITAR DEUDA / OBLIGACIÓN SIN ELIMINAR
const debtEditModal = document.getElementById('debt-edit-modal');
const btnCloseDebtEditModal = document.getElementById('btn-close-debt-edit-modal');
const debtEditForm = document.getElementById('debt-edit-form');

window.openEditDebtModal = function(idOrIndex) {
  const strId = String(idOrIndex).trim();
  let d = debts.find(item => item && (String(item.id) === strId || String(item.firestoreId) === strId || String(item.localId) === strId));
  if (!d && !isNaN(parseInt(idOrIndex, 10))) d = debts[parseInt(idOrIndex, 10)];
  if (!d) return;

  const isReceivable = d.type === 'debt_receivable';
  document.getElementById('edit-debt-id').value = d.id || strId;
  document.getElementById('edit-debt-name').value = d.name || '';
  const labelEl = document.getElementById('edit-debt-name-label');
  if (labelEl) labelEl.textContent = isReceivable ? 'Nombre del Deudor / Concepto' : 'Nombre de la Obligación / Acreedor';
  const titleEl = document.getElementById('modal-debt-edit-title');
  if (titleEl) titleEl.textContent = isReceivable ? 'Editar Cuenta Por Cobrar' : 'Editar Deuda Por Pagar';
  document.getElementById('edit-debt-frequency').value = (d.frequency || 'mensual').toLowerCase();
  document.getElementById('edit-debt-method').value = d.method || d.paymentMethod || 'BANCO';
  document.getElementById('edit-debt-installments').value = d.installments || 1;
  document.getElementById('edit-debt-interest').value = d.interest || 0;
  document.getElementById('edit-debt-start-date').value = d.startDate || getTodayStr();

  if (debtEditModal) debtEditModal.classList.remove('hidden');
};

if (btnCloseDebtEditModal && debtEditModal) {
  btnCloseDebtEditModal.addEventListener('click', () => {
    debtEditModal.classList.add('hidden');
  });
  debtEditModal.addEventListener('click', (e) => {
    if (e.target === debtEditModal) debtEditModal.classList.add('hidden');
  });
}

if (debtEditForm) {
  debtEditForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (debtEditForm.dataset.submitting === 'true') return;

    const id = document.getElementById('edit-debt-id').value;
    const d = debts.find(item => item && (String(item.id) === String(id) || String(item.firestoreId) === String(id) || String(item.localId) === String(id)));
    if (!d) return;

    debtEditForm.dataset.submitting = 'true';
    const submitBtn = debtEditForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    try {
      d.name = document.getElementById('edit-debt-name').value.trim();
      d.frequency = document.getElementById('edit-debt-frequency').value;
      d.method = document.getElementById('edit-debt-method').value;
      d.paymentMethod = d.method;
      d.installments = parseInt(document.getElementById('edit-debt-installments').value, 10) || 1;
      d.interest = parseFloat(document.getElementById('edit-debt-interest').value) || 0;
      d.startDate = document.getElementById('edit-debt-start-date').value || getTodayStr();

      localStorage.setItem('finances_v10_debts', JSON.stringify(debts));
      updateUI();
      showQuickToast(`✅ Obligación "${d.name}" actualizada con éxito`);

      try {
        const docId = d.firestoreId || d.id;
        await setDoc(doc(db, 'vaults', activeVaultId, 'debts', docId), {
          name: d.name,
          frequency: d.frequency,
          method: d.method,
          paymentMethod: d.method,
          installments: d.installments,
          interest: d.interest,
          startDate: d.startDate
        }, { merge: true });
      } catch (err) {
        console.warn('Error sincronizando edición de deuda en Firestore:', err);
      }

      if (debtEditModal) debtEditModal.classList.add('hidden');
    } finally {
      debtEditForm.dataset.submitting = 'false';
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

// CAMBIO RÁPIDO INLINE DE FRECUENCIA Y MÉTODO DE DEUDA
window.changeDebtFrequency = async function(debtId, newFreq) {
  const strId = String(debtId).trim();
  const d = debts.find(item => item && (String(item.id) === strId || String(item.firestoreId) === strId || String(item.localId) === strId));
  if (!d) return;

  d.frequency = newFreq;
  localStorage.setItem('finances_v10_debts', JSON.stringify(debts));
  updateUI();
  showQuickToast(`🗓️ Frecuencia cambiada a "${newFreq}" para ${d.name}`);

  try {
    const docId = d.firestoreId || d.id;
    await setDoc(doc(db, 'vaults', activeVaultId, 'debts', docId), { frequency: newFreq }, { merge: true });
  } catch (err) {
    console.warn('Error guardando frecuencia en Firestore:', err);
  }
};

window.changeDebtMethod = async function(debtId, newMethod) {
  const strId = String(debtId).trim();
  const d = debts.find(item => item && (String(item.id) === strId || String(item.firestoreId) === strId || String(item.localId) === strId));
  if (!d) return;

  d.method = newMethod;
  d.paymentMethod = newMethod;
  localStorage.setItem('finances_v10_debts', JSON.stringify(debts));
  updateUI();
  showQuickToast(`💳 Método habitual cambiado a "${newMethod}" para ${d.name}`);

  try {
    const docId = d.firestoreId || d.id;
    await setDoc(doc(db, 'vaults', activeVaultId, 'debts', docId), { method: newMethod, paymentMethod: newMethod }, { merge: true });
  } catch (err) {
    console.warn('Error guardando método en Firestore:', err);
  }
};

// MODAL Y GESTIÓN PARA EDITAR FINANZA FIJA SIN ELIMINAR
const recurringEditModal = document.getElementById('recurring-edit-modal');
const btnCloseRecEditModal = document.getElementById('btn-close-rec-edit-modal');
const recurringEditForm = document.getElementById('recurring-edit-form');

window.openEditRecurringModal = function(idOrIndex) {
  const strId = String(idOrIndex).trim();
  let r = recurringPayments.find(item => item && (String(item.id) === strId || String(item.firestoreId) === strId || String(item.localId) === strId));
  if (!r && !isNaN(parseInt(idOrIndex, 10))) r = recurringPayments[parseInt(idOrIndex, 10)];
  if (!r) return;

  const freq = (r.frequency || 'mensual').toLowerCase();
  document.getElementById('edit-rec-id').value = r.id || strId;
  document.getElementById('edit-rec-name').value = r.name || '';
  document.getElementById('edit-rec-amount').value = new Intl.NumberFormat('es-CO').format(r.amount || 0);
  document.getElementById('edit-rec-frequency').value = freq;
  document.getElementById('edit-rec-method').value = r.paymentMethod || 'NEQUI';
  if (document.getElementById('edit-rec-category')) {
    document.getElementById('edit-rec-category').value = r.category || 'SERVICIOS';
  }

  // Actualizar visibilidad de campos de periodicidad
  updateRecScheduleFields(true);

  if (freq === 'semanal') {
    const wdSelect = document.getElementById('edit-rec-weekday');
    if (wdSelect) wdSelect.value = (r.dueWeekday !== undefined && r.dueWeekday !== null) ? String(r.dueWeekday) : '5';
  } else if (freq === 'quincenal') {
    const qSchemeSelect = document.getElementById('edit-rec-quincena-scheme');
    const qDays = r.dueQuincenaDays || '15,30';
    if (qSchemeSelect) {
      const matchOpt = Array.from(qSchemeSelect.options).find(o => o.value === qDays);
      if (matchOpt) {
        qSchemeSelect.value = qDays;
      } else {
        qSchemeSelect.value = 'custom';
        const parts = qDays.split(',');
        const d1El = document.getElementById('edit-rec-quincena-day1');
        const d2El = document.getElementById('edit-rec-quincena-day2');
        if (d1El) d1El.value = parts[0] || '15';
        if (d2El) d2El.value = parts[1] || '30';
      }
      updateRecScheduleFields(true);
    }
  } else if (freq === 'anual') {
    const mSelect = document.getElementById('edit-rec-annual-month');
    const dInput = document.getElementById('edit-rec-annual-day');
    if (mSelect) mSelect.value = String(r.dueMonth || 12);
    if (dInput) dInput.value = String(r.dueDay || 15);
  } else {
    // mensual
    const dInput = document.getElementById('edit-rec-day');
    if (dInput) dInput.value = String(r.dueDay || 5);
  }

  if (recurringEditModal) recurringEditModal.classList.remove('hidden');
};

if (btnCloseRecEditModal && recurringEditModal) {
  btnCloseRecEditModal.addEventListener('click', () => {
    recurringEditModal.classList.add('hidden');
  });
  recurringEditModal.addEventListener('click', (e) => {
    if (e.target === recurringEditModal) recurringEditModal.classList.add('hidden');
  });
}

if (recurringEditForm) {
  recurringEditForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('edit-rec-id').value;
    const r = recurringPayments.find(item => item && (String(item.id) === String(id) || String(item.firestoreId) === String(id) || String(item.localId) === String(id)));
    if (!r) return;

    const freqVal = document.getElementById('edit-rec-frequency').value;
    r.name = document.getElementById('edit-rec-name').value.trim();
    r.amount = parseAmount(document.getElementById('edit-rec-amount').value) || r.amount;
    r.frequency = freqVal;
    r.paymentMethod = document.getElementById('edit-rec-method').value;
    if (document.getElementById('edit-rec-category')) {
      r.category = document.getElementById('edit-rec-category').value;
    }

    if (freqVal === 'semanal') {
      r.dueWeekday = parseInt(document.getElementById('edit-rec-weekday')?.value, 10) || 5;
      r.dueDay = r.dueWeekday + 1; // 1-7, cumple validación numérica de 1-31
    } else if (freqVal === 'quincenal') {
      const qScheme = document.getElementById('edit-rec-quincena-scheme')?.value || '15,30';
      if (qScheme === 'custom') {
        const d1 = parseInt(document.getElementById('edit-rec-quincena-day1')?.value, 10) || 15;
        const d2 = parseInt(document.getElementById('edit-rec-quincena-day2')?.value, 10) || 30;
        r.dueQuincenaDays = `${d1},${d2}`;
        r.dueDay = d1;
      } else {
        r.dueQuincenaDays = qScheme;
        r.dueDay = parseInt(qScheme.split(',')[0], 10) || 15;
      }
    } else if (freqVal === 'anual') {
      r.dueMonth = parseInt(document.getElementById('edit-rec-annual-month')?.value, 10) || 12;
      r.dueDay = parseInt(document.getElementById('edit-rec-annual-day')?.value, 10) || 15;
    } else {
      // mensual
      r.dueDay = parseInt(document.getElementById('edit-rec-day')?.value, 10) || 5;
    }

    localStorage.setItem('finances_v10_recurring', JSON.stringify(recurringPayments));
    renderRecurringPayments();
    showQuickToast(`✅ Finanza fija "${r.name}" actualizada con éxito`);

    try {
      const docId = r.firestoreId || r.id;
      await setDoc(doc(db, 'vaults', activeVaultId, 'recurringPayments', docId), {
        name: r.name,
        amount: r.amount,
        dueDay: r.dueDay,
        dueWeekday: r.dueWeekday !== undefined ? r.dueWeekday : null,
        dueQuincenaDays: r.dueQuincenaDays || null,
        dueMonth: r.dueMonth || null,
        frequency: r.frequency,
        paymentMethod: r.paymentMethod,
        category: r.category
      }, { merge: true });
    } catch (err) {
      console.warn('Error sincronizando edición de pago fijo en Firestore:', err);
    }

    if (recurringEditModal) recurringEditModal.classList.add('hidden');
  });
}

window.changeRecurringMethod = async function(rId, newMethod) {
  const strId = String(rId).trim();
  const r = recurringPayments.find(item => item && (String(item.id) === strId || String(item.firestoreId) === strId || String(item.localId) === strId));
  if (!r) return;

  r.paymentMethod = newMethod;
  localStorage.setItem('finances_v10_recurring', JSON.stringify(recurringPayments));
  renderRecurringPayments();
  showQuickToast(`💳 Método habitual de "${r.name}" cambiado a ${newMethod}`);

  try {
    const docId = r.firestoreId || r.id;
    await setDoc(doc(db, 'vaults', activeVaultId, 'recurringPayments', docId), { paymentMethod: newMethod }, { merge: true });
  } catch (err) {
    console.warn('Error guardando método en Firestore:', err);
  }
};

window.changeRecurringFrequency = async function(rId, newFreq) {
  const strId = String(rId).trim();
  const r = recurringPayments.find(item => item && (String(item.id) === strId || String(item.firestoreId) === strId || String(item.localId) === strId));
  if (!r) return;

  r.frequency = newFreq;
  localStorage.setItem('finances_v10_recurring', JSON.stringify(recurringPayments));
  renderRecurringPayments();
  showQuickToast(`🗓️ Frecuencia de "${r.name}" cambiada a ${newFreq}`);

  try {
    const docId = r.firestoreId || r.id;
    await setDoc(doc(db, 'vaults', activeVaultId, 'recurringPayments', docId), { frequency: newFreq }, { merge: true });
  } catch (err) {
    console.warn('Error guardando frecuencia en Firestore:', err);
  }
};

// PESTAÑAS SEGMENTADAS PARA FILTRAR OBLIGACIONES
activeDebtFilter = 'all'; // 'all' | 'payable' | 'receivable'

window.setDebtFilter = function(filter) {
  activeDebtFilter = filter;
  document.querySelectorAll('.debts-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });

  const payableSec = document.getElementById('section-debts-payable');
  const receivableSec = document.getElementById('section-debts-receivable');

  if (payableSec && receivableSec) {
    if (filter === 'all') {
      payableSec.style.display = 'block';
      receivableSec.style.display = 'block';
    } else if (filter === 'payable') {
      payableSec.style.display = 'block';
      receivableSec.style.display = 'none';
    } else if (filter === 'receivable') {
      payableSec.style.display = 'none';
      receivableSec.style.display = 'block';
    }
  }
};

const debtsFilterTabs = document.getElementById('debts-filter-tabs');
if (debtsFilterTabs) {
  debtsFilterTabs.querySelectorAll('.debts-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      window.setDebtFilter(btn.dataset.filter);
    });
  });
}

// Atajos de clic en las tarjetas KPI de Deudas
setTimeout(() => {
  const kpiPayable = document.getElementById('debts-total-payable')?.closest('.kpi-card');
  if (kpiPayable) {
    kpiPayable.style.cursor = 'pointer';
    kpiPayable.title = 'Filtrar solo deudas por pagar';
    kpiPayable.addEventListener('click', () => window.setDebtFilter('payable'));
  }
  const kpiReceivable = document.getElementById('debts-total-receivable')?.closest('.kpi-card');
  if (kpiReceivable) {
    kpiReceivable.style.cursor = 'pointer';
    kpiReceivable.title = 'Filtrar solo cuentas por cobrar';
    kpiReceivable.addEventListener('click', () => window.setDebtFilter('receivable'));
  }
  const kpiNet = document.getElementById('debts-net-balance')?.closest('.kpi-card');
  if (kpiNet) {
    kpiNet.style.cursor = 'pointer';
    kpiNet.title = 'Ver todas las obligaciones';
    kpiNet.addEventListener('click', () => window.setDebtFilter('all'));
  }
}, 500);



// GESTIÓN Y SINCRONIZACIÓN DE CREDENCIALES DE ATAJOS DE IPHONE
const shortcutVaultTag = document.getElementById('shortcut-vault-tag');
const btnDownloadPdfGuide = document.getElementById('btn-download-pdf-guide');

function updateShortcutCredentialsUI() {
  const webhookUrl = `${publicSharedOrigin}/api/shortcut/transaction`;
  if (shortcutVaultTag) shortcutVaultTag.textContent = activeVaultId;
  if (shortcutApiKeyEl) shortcutApiKeyEl.textContent = userApiKey;
  if (shortcutWebhookUrlEl) shortcutWebhookUrlEl.textContent = webhookUrl;
}
updateShortcutCredentialsUI();

if (btnCopyKey) {
  btnCopyKey.addEventListener('click', () => {
    navigator.clipboard.writeText(userApiKey).then(() => {
      btnCopyKey.textContent = '¡Copiada!';
      showQuickToast('Clave secreta de Atajo copiada al portapapeles');
      setTimeout(() => { btnCopyKey.textContent = 'Copiar Clave'; }, 2000);
    });
  });
}

if (btnCopyUrl) {
  btnCopyUrl.addEventListener('click', () => {
    const webhookUrl = `${publicSharedOrigin}/api/shortcut/transaction`;
    navigator.clipboard.writeText(webhookUrl).then(() => {
      btnCopyUrl.textContent = '¡Copiada!';
      showQuickToast('URL de Webhook copiada al portapapeles');
      setTimeout(() => { btnCopyUrl.textContent = 'Copiar URL'; }, 2000);
    });
  });
}

// GENERADOR DE GUÍA OFICIAL EN PDF DE ALTA FIDELIDAD (3 PÁGINAS MAESTRAS PERFECTAS, CON NUEVO ATAJO UNIVERSAL)
if (btnDownloadPdfGuide) {
  btnDownloadPdfGuide.addEventListener('click', () => {
    showQuickToast('📄 Generando Guía Visual Pro en PDF...');

    if (typeof window.jspdf === 'undefined' || !window.jspdf.jsPDF) {
      window.print();
      return;
    }

    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
      });

      // Paleta Corporativa Limpia y de Alta Legibilidad
      const cPrimary = [2, 132, 199];      // Cyan / Azul primario (#0284c7)
      const cEmerald = [5, 150, 105];      // Verde Esmeralda (#059669)
      const cCrimson = [220, 38, 38];      // Rojo Alerta (#dc2626)
      const cAmber = [217, 119, 6];        // Ámbar (#d97706)
      const cDark = [15, 23, 42];          // Slate oscuro texto principal (#0f172a)
      const cBody = [51, 65, 85];          // Slate cuerpo de texto (#334155)
      const cMuted = [100, 116, 139];      // Slate atenuado (#64748b)
      const cBorder = [226, 232, 240];     // Borde suave (#e2e8f0)
      const cBgCard = [248, 250, 252];     // Fondo tarjeta (#f8fafc)
      const cBgBox = [241, 245, 249];      // Fondo caja de código (#f1f5f9)

      const cleanBaseWebhook = `${publicSharedOrigin}/api/shortcut/transaction`;

      // Helper para encabezado estándar
      const drawHeader = (pageTitle, subTitle, pageNum, bannerColor = cPrimary) => {
        doc.setFillColor(255, 255, 255);
        doc.rect(0, 0, 210, 297, 'F');

        doc.setFillColor(240, 249, 255);
        doc.roundedRect(12, 10, 186, 23, 3, 3, 'F');
        doc.setDrawColor(...bannerColor);
        doc.setLineWidth(0.6);
        doc.roundedRect(12, 10, 186, 23, 3, 3, 'D');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11.5);
        doc.setTextColor(...bannerColor);
        doc.text(pageTitle, 18, 17.5);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.6);
        doc.setTextColor(...cBody);
        doc.text(subTitle, 18, 23.5);

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.6);
        doc.text(`Bóveda Sincronizada: ${activeVaultId}   |   Tu Clave API Personal: ${userApiKey}`, 18, 29);

        // Pie de página
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.2);
        doc.setTextColor(...cMuted);
        doc.text(`PÁGINA ${pageNum}/3   |   AHORROS SA - GUÍA OFICIAL MAESTRA   |   FINANZAS EN TIEMPO REAL`, 38, 288);
      };

      // =========================================================================
      // PÁGINA 1: NUEVO ATAJO MAESTRO UNIVERSAL (TODO EN UNO) & DATOS DE CONEXIÓN
      // =========================================================================
      drawHeader(
        'AHORROS SA  |  GUÍA OFICIAL MAESTRA DE ATAJOS PARA IPHONE & SIRI',
        'Configuración paso a paso para registro instantáneo por voz, widgets y botones rápidos en iOS',
        1,
        cPrimary
      );

      // Tarjeta: Datos Oficiales de Conexión Sincronizados
      doc.setFillColor(...cBgCard);
      doc.roundedRect(12, 36, 186, 18, 2.5, 2.5, 'F');
      doc.setDrawColor(...cBorder);
      doc.setLineWidth(0.4);
      doc.roundedRect(12, 36, 186, 18, 2.5, 2.5, 'D');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(...cPrimary);
      doc.text('DATOS OFICIALES DE CONEXIÓN PARA TU IPHONE (100% LIMPIOS & VÁLIDOS)', 18, 41.5);

      doc.setFont('courier', 'bold');
      doc.setFontSize(7.3);
      doc.setTextColor(...cCrimson);
      doc.text(`URL de Webhook: ${cleanBaseWebhook}`, 18, 46.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.2);
      doc.setTextColor(...cBody);
      doc.text(`Clave de Atajo: ${userApiKey}  (Identifica de forma exclusiva tu cuenta en la nube sin pedir contraseñas)`, 18, 51);

      // Tarjeta Principal: NUEVO ATAJO MAESTRO UNIVERSAL (POST JSON)
      let curY = 57;
      doc.setFillColor(...cBgCard);
      doc.roundedRect(12, curY, 186, 126, 2.5, 2.5, 'F');
      doc.setDrawColor(...cEmerald);
      doc.setLineWidth(0.6);
      doc.roundedRect(12, curY, 186, 126, 2.5, 2.5, 'D');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.8);
      doc.setTextColor(...cEmerald);
      doc.text('⭐ NUEVO ATAJO MAESTRO UNIVERSAL: DECIDE GASTO O INGRESO EN UN SOLO BOTÓN', 18, curY + 6.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.2);
      doc.setTextColor(...cBody);
      doc.text('¿Por qué tener atajos separados si puedes tener uno solo que te pregunte? Con este atajo universal podrás registrar ambos:', 18, curY + 12);

      const universalSteps = [
        ['Paso 1 (Crear):', 'Abre "Atajos", pulsa "+" arriba a la derecha y nombra el atajo "Finanzas" o "Registrar Movimiento".'],
        ['Paso 2 (Decidir Tipo):', 'Acción "Elegir de la lista" -> Opciones: "Gasto" e "Ingreso". [Variable Tipo de Movimiento]'],
        ['Paso 3 (Pedir Monto):', 'Acción "Solicitar entrada" -> Tipo: Número -> "¿Cuánto dinero es?". (¡OBLIGATORIO: Tipo Número, NO Texto!)'],
        ['Paso 4 (Método / Cuenta):', 'Acción "Elegir de la lista" -> Opciones: NEQUI, BANCOLOMBIA, DAVIPLATA, EFECTIVO, TARJETA.'],
        ['Paso 5 (Categoría):', 'Acción "Elegir de la lista" -> Opciones: ALIMENTACIÓN, TRANSPORTE, VIVIENDA, SERVICIOS, SALARIO, OTROS.'],
        ['Paso 6 (Detalle):', 'Acción "Solicitar entrada" -> Tipo: Texto -> Pregunta: "¿Concepto o detalle? (Opcional)".'],
        ['Paso 7 (Petición Web):', 'Acción "Obtener contenido de URL" con los ajustes exactos mostrados a continuación:']
      ];

      let sY = curY + 17.5;
      universalSteps.forEach(([label, desc]) => {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.1);
        doc.setTextColor(...cPrimary);
        doc.text(label, 18, sY);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...cDark);
        doc.text(desc, 48, sY);
        sY += 5.1;
      });

      // Detalle de configuración de Obtener contenido de URL en POST JSON
      doc.setFillColor(...cBgBox);
      doc.roundedRect(18, sY - 0.5, 174, 29, 2, 2, 'F');
      doc.setDrawColor(...cBorder);
      doc.setLineWidth(0.3);
      doc.roundedRect(18, sY - 0.5, 174, 29, 2, 2, 'D');

      doc.setFont('courier', 'bold');
      doc.setFontSize(6.8);
      doc.setTextColor(...cDark);
      doc.text(`• URL a pegar: ${cleanBaseWebhook}   |   Método: POST   |   Cuerpo: JSON`, 22, sY + 3.5);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.8);
      doc.text(`• Campo 1 (Texto): key -> "${userApiKey}"`, 22, sY + 7.5);
      doc.text(`• Campo 2 (Texto): type -> [Variable azul Tipo de Movimiento (Gasto o Ingreso)]`, 22, sY + 11.5);
      doc.text(`• Campo 3 (Texto): amount -> [Variable azul Número de ¿Cuánto dinero es?]`, 22, sY + 15.5);
      doc.text(`• Campo 4 (Texto): account -> [Variable azul Método]   |   Campo 5: category -> [Variable azul Categoría]`, 22, sY + 19.5);
      doc.text(`• Campo 6 (Texto): desc -> [Variable azul Detalle]   |   Campo 7: format -> "text"`, 22, sY + 23.5);
      doc.text(`• Nota: Para enlazar variables mágicas, toca sobre el campo de texto y selecciona la variable azul sobre el teclado.`, 22, sY + 27.5);

      sY += 32;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.2);
      doc.setTextColor(...cEmerald);
      doc.text('Paso 8 (Confirmar):', 18, sY);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...cDark);
      doc.text('Acción "Hablar texto" pasando el [Resultado de Obtener contenido de URL].', 48, sY);
      sY += 4.5;
      doc.text('Siri leerá en voz alta: "Gasto de $ 25.000 registrado en Alimentación. Tu saldo disponible es de $ 1.250.000".', 48, sY);

      // Tarjeta Inferior: Ventajas del Atajo Maestro
      let vY = 187;
      doc.setFillColor(240, 249, 255);
      doc.roundedRect(12, vY, 186, 32, 2.5, 2.5, 'F');
      doc.setDrawColor(...cPrimary);
      doc.setLineWidth(0.4);
      doc.roundedRect(12, vY, 186, 32, 2.5, 2.5, 'D');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.2);
      doc.setTextColor(...cPrimary);
      doc.text('💡 ¿POR QUÉ ESTE MÉTODO POST JSON ES EL ESTÁNDAR 100% LIBRE DE ERRORES?', 18, vY + 6.5);

      const mAdv = [
        '1. URL 100% Limpia: Al no llevar parámetros en la barra de URL, Apple jamás mostrará "La URL no es válida".',
        '2. Soporta Cualquier Texto: Permite espacios, tildes, signos de puntuación y descripciones largas sin errores de codificación.',
        '3. Un Solo Ícono en Pantalla: No saturas tu pantalla con 3 o 4 atajos diferentes; todo se gestiona desde un único botón.',
        '4. Idempotencia y Cero Duplicados: El servidor cuenta con protección anti-duplicados de 60s por reenvíos de red o doble toque.'
      ];
      let ay = vY + 12;
      mAdv.forEach(adv => {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.1);
        doc.setTextColor(...cDark);
        doc.text(adv, 18, ay);
        ay += 4.8;
      });

      // Tarjeta de Prueba Rápida
      let testY = 222;
      doc.setFillColor(...cBgCard);
      doc.roundedRect(12, testY, 186, 61, 2.5, 2.5, 'F');
      doc.setDrawColor(...cAmber);
      doc.setLineWidth(0.4);
      doc.roundedRect(12, testY, 186, 61, 2.5, 2.5, 'D');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.2);
      doc.setTextColor(...cAmber);
      doc.text('🚀 CÓMO PROBAR TU NUEVO ATAJO EN 5 SEGUNDOS', 18, testY + 6.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.1);
      doc.setTextColor(...cDark);
      doc.text('1. Dentro del editor del atajo en tu iPhone, pulsa el botón azul de reproducción (▶) en la esquina inferior derecha.', 18, testY + 12.5);
      doc.text('2. Elige "Gasto", escribe un monto de prueba (ej: 10000), selecciona "Nequi" y "Alimentación".', 18, testY + 18);
      doc.text('3. Tu iPhone contactará la nube, Siri te confirmará en voz alta y verás aparecer el movimiento en la web en tiempo real.', 18, testY + 23.5);
      doc.text('4. En caso de que desees eliminar esa prueba, haz clic en la "X" en la tabla web: se eliminará al instante sin trabas.', 18, testY + 29);

      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...cPrimary);
      doc.text('¿Quieres tener atajos directos sin menú de selección? Continúa en la Página 2 para los atajos dedicados.', 18, testY + 37);

      // =========================================================================
      // PÁGINA 2: ATAJOS DEDICADOS, MÉTODO GET Y ADVERTENCIAS CRÍTICAS DEL MONTO
      // =========================================================================
      doc.addPage();
      drawHeader(
        '2. ATAJOS DEDICADOS, MÉTODO GET Y ADVERTENCIAS CRÍTICAS DEL MONTO',
        'Alternativas directas de 1 toque, explicación del error de corchetes y reglas del formato numérico',
        2,
        cEmerald
      );

      // Tarjeta 1: Atajos Dedicados de 1 Toque
      let p2Y = 36;
      doc.setFillColor(...cBgCard);
      doc.roundedRect(12, p2Y, 186, 46, 2.5, 2.5, 'F');
      doc.setDrawColor(...cEmerald);
      doc.setLineWidth(0.5);
      doc.roundedRect(12, p2Y, 186, 46, 2.5, 2.5, 'D');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...cEmerald);
      doc.text('OPCIÓN ALTERNATIVA: ATAJOS DEDICADOS ESPECÍFICOS (1 TOQUE)', 18, p2Y + 6.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.2);
      doc.setTextColor(...cDark);
      doc.text('Si prefieres tener 2 íconos separados ("Registrar Gasto" y "Registrar Ingreso") sin que te pregunte el tipo:', 18, p2Y + 12);
      doc.text('• Atajo "Registrar Gasto": Sigue los mismos pasos del atajo universal, pero omite el Paso 2 y fija en JSON type: "gasto".', 18, p2Y + 18);
      doc.text('• Atajo "Registrar Ingreso": Omite el Paso 2 y fija en JSON type: "ingreso". Pregunta: "¿Cuánto dinero recibiste?".', 18, p2Y + 24);
      doc.text('• En ambos casos puedes agregar la acción "Hablar texto" para que Siri te confirme el saldo actualizado de inmediato.', 18, p2Y + 30);
      doc.text('• Ambos atajos se sincronizan en la misma Bóveda (' + activeVaultId + ') usando tu misma clave API.', 18, p2Y + 36);

      // Tarjeta 2: MÉTODO GET Y ERROR "LA URL NO ES VÁLIDA"
      let getY = 85;
      doc.setFillColor(254, 252, 232);
      doc.roundedRect(12, getY, 186, 46, 2.5, 2.5, 'F');
      doc.setDrawColor(...cAmber);
      doc.setLineWidth(0.4);
      doc.roundedRect(12, getY, 186, 46, 2.5, 2.5, 'D');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...cAmber);
      doc.text('MÉTODO GET POR ENLACE DIRECTO & ¿POR QUÉ SURGE "LA URL NO ES VÁLIDA"?', 18, getY + 6.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.1);
      doc.setTextColor(...cDark);
      const urlInvalidExplain = '¿Por qué la app Atajos rechaza URLs que contienen corchetes [ ]? En los estándares oficiales de internet (RFC 3986), los caracteres "[" y "]" son ilegales dentro de una URL. Si copias un texto que dice literalmente "[Monto]" o "[Metodo]", Apple mostrará inmediatamente "La URL no es válida".';
      const uLines = doc.splitTextToSize(urlInvalidExplain, 174);
      doc.text(uLines, 18, getY + 12);

      doc.setFont('helvetica', 'bold');
      doc.text('Cómo configurar el enlace GET correctamente en tu iPhone (si no usas POST JSON):', 18, getY + 23);

      doc.setFont('courier', 'bold');
      doc.setFontSize(6.7);
      doc.setTextColor(...cCrimson);
      doc.text(`1. URL base limpia: ${cleanBaseWebhook}?key=${userApiKey}&type=gasto&amount=`, 18, getY + 28);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.1);
      doc.setTextColor(...cDark);
      doc.text('2. Justo al final de "amount=", NO escribas corchetes: toca la burbuja azul de la variable mágica "¿Cuánto dinero es?".', 18, getY + 33.5);
      doc.text('3. Agrega &account= y la variable azul del Método, &category= y la Categoría, &desc= y el Detalle, y &format=text.', 18, getY + 39);

      // Tarjeta 3: ADVERTENCIAS CRÍTICAS DEL MONTO INGRESADO
      let warnY = 134;
      doc.setFillColor(254, 242, 242);
      doc.roundedRect(12, warnY, 186, 92, 2.5, 2.5, 'F');
      doc.setDrawColor(...cCrimson);
      doc.setLineWidth(0.6);
      doc.roundedRect(12, warnY, 186, 92, 2.5, 2.5, 'D');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.8);
      doc.setTextColor(...cCrimson);
      doc.text('⚠️ ADVERTENCIAS CRÍTICAS DEL MONTO Y POSIBLES ERRORES AL USAR LA OPCIÓN', 18, warnY + 6.5);

      const detailedWarnings = [
        ['1. Tipo de Entrada Obligatorio (¡Configurar siempre como NÚMERO!):', 'En la acción "Solicitar entrada" para el monto, el Tipo SIEMPRE debe ser Número (no Texto). Si lo dejas configurado como Texto, el teclado de tu iPhone permitirá ingresar comas, símbolos monetarios, espacios o letras accidentales que impedirán calcular el valor en la nube.'],
        ['2. Error "El monto debe ser un número mayor a 0":', 'Ocurre cuando en tu atajo quedó escrito el texto "[Monto]" literalmente en vez de seleccionar la burbuja/variable mágica azul sobre el teclado de tu iPhone. Para corregirlo: borra las letras escritas y toca la burbuja azul "¿Cuánto dinero es?".'],
        ['3. Formato de Puntos y Cifras:', 'Puedes ingresar tanto números continuos (ej: 50000) como con puntos de miles (ej: 50.000). El motor de Ahorros SA interpreta ambos formatos perfectamente. NUNCA escribas palabras como "pesos", "$" o "COP" dentro del campo de monto.'],
        ['4. Detección Inteligente de Categoría y Cuenta si se omiten:', 'Si omites la categoría o el método de pago por prisa, el sistema analizará el concepto escrito (ej: "Uber" -> Transporte, "Almuerzo" -> Alimentación, "Sueldo" -> Salario) y asignará Nequi o Efectivo automáticamente para que ningún movimiento se pierda.'],
        ['5. Comportamiento de Decimales y Centavos:', 'Si vas a ingresar valores con decimales (ej: 12.50), usa punto decimal. No obstante, para monedas sin centavos habituales como el peso colombiano (COP), se recomienda ingresar siempre cifras enteras.']
      ];

      let wY = warnY + 13;
      detailedWarnings.forEach(([title, body]) => {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.1);
        doc.setTextColor(...cCrimson);
        doc.text(title, 18, wY);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...cDark);
        const bLines = doc.splitTextToSize(body, 174);
        doc.text(bLines, 18, wY + 4);
        wY += 14.5;
      });

      // Tarjeta 4: Seguridad y Sincronización en la Nube
      let secY = 230;
      doc.setFillColor(240, 249, 255);
      doc.roundedRect(12, secY, 186, 53, 2.5, 2.5, 'F');
      doc.setDrawColor(...cPrimary);
      doc.setLineWidth(0.4);
      doc.roundedRect(12, secY, 186, 53, 2.5, 2.5, 'D');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.2);
      doc.setTextColor(...cPrimary);
      doc.text('🔒 PRIVACIDAD, SEGURIDAD Y SINCRONIZACIÓN AUTOMÁTICA EN LA NUBE', 18, secY + 6.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.1);
      doc.setTextColor(...cDark);
      doc.text('• Cifrado Extremo a Extremo: Todas las peticiones viajan bajo el protocolo HTTPS TLS 1.3 con certificados de alta seguridad.', 18, secY + 13);
      doc.text('• Llave de Atajo Segura: Tu clave API personal identifica exclusivamente tu Bóveda (' + activeVaultId + ') sin exponer tus contraseñas.', 18, secY + 19);
      doc.text('• Sincronización Multi-Dispositivo: Al registrar un movimiento en tu iPhone, la web abierta en tu PC se actualiza al instante.', 18, secY + 25);
      doc.text('• Eliminación Instantánea y Limpia: Si eliminas un movimiento en la web, se borra de memoria y de la base de datos sin trabas.', 18, secY + 31);
      doc.text('• Modo Desconectado: Si tu iPhone no tiene señal en ese momento, el atajo te avisará y podrás reintentarlo al recuperar cobertura.', 18, secY + 37);

      // =========================================================================
      // PÁGINA 3: ACTIVACIÓN POR VOZ CON SIRI, WIDGETS, DICCIONARIO Y FAQ
      // =========================================================================
      doc.addPage();
      drawHeader(
        '3. ACTIVACIÓN POR VOZ CON SIRI, WIDGETS, DICCIONARIO Y FAQ',
        'Dictado por voz con Siri, widgets en pantalla de inicio, carátulas de Apple Watch y preguntas frecuentes',
        3,
        cPrimary
      );

      // Tarjeta 1: Activación por Voz con Siri
      let siriY = 36;
      doc.setFillColor(240, 249, 255);
      doc.roundedRect(12, siriY, 186, 44, 2.5, 2.5, 'F');
      doc.setDrawColor(...cPrimary);
      doc.setLineWidth(0.5);
      doc.roundedRect(12, siriY, 186, 44, 2.5, 2.5, 'D');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.8);
      doc.setTextColor(...cPrimary);
      doc.text('🎙️ ACTIVACIÓN POR VOZ CON SIRI & APPLE WATCH (SIN TOCAR LA PANTALLA)', 18, siriY + 6.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.2);
      doc.setTextColor(...cDark);
      doc.text('1. El nombre del atajo es la frase mágica de activación. Si lo llamaste "Finanzas", solo di: "Oye Siri, Finanzas".', 18, siriY + 13);
      doc.text('2. Siri te responderá por voz preguntándote si es Gasto o Ingreso, luego el monto, la cuenta y el concepto.', 18, siriY + 19);
      doc.text('3. Respóndele con naturalidad (ej: "Gasto", "Veinticinco mil", "Nequi", "Almuerzo con compañeros").', 18, siriY + 25);
      doc.text('4. Siri enviará la información a la nube y te confirmará en voz alta tu nuevo saldo disponible en tiempo real.', 18, siriY + 31);
      doc.text('5. Apple Watch: Agrega la complicación de Atajos a tu carátula para registrar gastos con 1 toque en tu muñeca.', 18, siriY + 37);

      // Tarjeta 2: Botón en Pantalla de Inicio y Bloqueo
      let widY = 83;
      doc.setFillColor(...cBgCard);
      doc.roundedRect(12, widY, 186, 38, 2.5, 2.5, 'F');
      doc.setDrawColor(...cBorder);
      doc.setLineWidth(0.4);
      doc.roundedRect(12, widY, 186, 38, 2.5, 2.5, 'D');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...cPrimary);
      doc.text('📱 CÓMO AGREGAR EL BOTÓN A TU PANTALLA DE INICIO O BLOQUEO (WIDGET)', 18, widY + 6.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.2);
      doc.setTextColor(...cDark);
      doc.text('1. Abre la app Atajos y localiza tu atajo "Finanzas" o "Registrar Movimiento".', 18, widY + 13);
      doc.text('2. Toca el ícono de tres puntos (...) para entrar a los ajustes del atajo.', 18, widY + 18.5);
      doc.text('3. Toca el ícono de Compartir (o la "i" de información) y selecciona "Agregar a pantalla de inicio".', 18, widY + 24);
      doc.text('4. Asígnalo con un ícono de moneda o billete. Ahora tendrás un botón rápido para usar cada vez que salgas de compras.', 18, widY + 29.5);

      // Tarjeta 3: Diccionario Trilingüe de Acciones de iOS
      let dicY = 124;
      doc.setFillColor(...cBgCard);
      doc.roundedRect(12, dicY, 186, 68, 2.5, 2.5, 'F');
      doc.setDrawColor(...cBorder);
      doc.setLineWidth(0.4);
      doc.roundedRect(12, dicY, 186, 68, 2.5, 2.5, 'D');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.8);
      doc.setTextColor(...cPrimary);
      doc.text('DICCIONARIO DE ACCIONES SEGÚN EL IDIOMA DE TU IPHONE', 18, dicY + 6.5);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.2);
      doc.setTextColor(...cBody);
      doc.text('FUNCIÓN EN EL ATAJO', 18, dicY + 13);
      doc.text('ESPAÑOL (LATAM)', 65, dicY + 13);
      doc.text('ESPAÑOL (ESPAÑA)', 115, dicY + 13);
      doc.text('ENGLISH (iOS)', 162, dicY + 13);

      doc.setDrawColor(...cBorder);
      doc.setLineWidth(0.3);
      doc.line(16, dicY + 15, 194, dicY + 15);

      const trilingualRows = [
        ['1. Pedir Monto (Número)', 'Solicitar entrada', 'Solicitar entrada', 'Ask for Input'],
        ['2. Elegir Tipo / Cuenta / Cat', 'Elegir de la lista', 'Seleccionar del menú', 'Choose from Menu'],
        ['3. Pedir Detalle (Texto)', 'Solicitar entrada', 'Solicitar entrada', 'Ask for Input'],
        ['4. Enviar datos al webhook', 'Obtener contenido de URL', 'Obtener contenido de la URL', 'Get Contents of URL'],
        ['5. Voz de Siri (Confirmación)', 'Hablar texto', 'Leer texto con la voz', 'Speak Text'],
        ['6. Notificación visual', 'Mostrar notificación', 'Mostrar resultado', 'Show Notification']
      ];

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.1);
      doc.setTextColor(...cDark);

      let rY = dicY + 21;
      trilingualRows.forEach(row => {
        doc.text(row[0], 18, rY);
        doc.text(row[1], 65, rY);
        doc.text(row[2], 115, rY);
        doc.text(row[3], 162, rY);
        rY += 6.5;
      });

      // Tarjeta 4: Preguntas Frecuentes y Diagnóstico
      let faqY = 195;
      doc.setFillColor(...cBgCard);
      doc.roundedRect(12, faqY, 186, 88, 2.5, 2.5, 'F');
      doc.setDrawColor(...cAmber);
      doc.setLineWidth(0.4);
      doc.roundedRect(12, faqY, 186, 88, 2.5, 2.5, 'D');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...cAmber);
      doc.text('PREGUNTAS FRECUENTES Y DIAGNÓSTICO EN TIEMPO REAL', 18, faqY + 6.5);

      const faqs = [
        ['• ¿Qué ocurre si pulso "Nueva" Clave en la web?', 'Al generar una nueva clave, se vincula automáticamente a tu Bóveda en Firestore. Solo debes actualizar el campo "key" en tu atajo con el nuevo valor copiado.'],
        ['• ¿Por qué antes aparecían transacciones duplicadas?', 'Ocurría cuando la conexión móvil tenía microcortes y el iPhone reintentaba enviar la petición. Ahora el sistema cuenta con control nativo de idempotencia que descarta envíos idénticos en menos de 60 segundos.'],
        ['• ¿Por qué siempre se guardaba el mismo monto (ej: $ 25.000)?', 'Porque en el atajo se escribió el número como texto estático en lugar de enlazar la variable azul mágica de la pregunta previa. Borra el texto y selecciona la variable.'],
        ['• ¿Cómo eliminar un movimiento en la web?', 'En el historial web, haz clic en el botón "X". La eliminación es inmediata, no se traba ni vuelve a aparecer gracias a las firmas de seguridad.'],
        ['• ¿Puedo usar este atajo desde otro iPhone o iPad?', '¡Sí! Puedes compartir el atajo por AirDrop a tu familia o colaboradores usando la misma clave de Bóveda para consolidar las finanzas del hogar o negocio.']
      ];

      let fY = faqY + 13;
      faqs.forEach(([q, a]) => {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.1);
        doc.setTextColor(...cDark);
        doc.text(q, 18, fY);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...cBody);
        const aLines = doc.splitTextToSize(a, 174);
        doc.text(aLines, 18, fY + 3.8);
        fY += 13.5;
      });

      doc.save(`Guia_Oficial_Atajos_iPhone_AhorrosSA_${activeVaultId}.pdf`);
      showQuickToast('✅ Guía visual en PDF de 3 páginas descargada con éxito');
    } catch (pdfErr) {
      console.error('Error generando PDF:', pdfErr);
      showQuickToast('⚠️ Error generando PDF. Abriendo versión para imprimir...');
      window.print();
    }
  });
}

// GESTIÓN DE LA ZONA DE PELIGRO: ELIMINAR BÓVEDA DEFINITIVAMENTE
const btnDeleteActiveVault = document.getElementById('btn-delete-active-vault');
if (btnDeleteActiveVault) {
  btnDeleteActiveVault.addEventListener('click', async () => {
    const confirmed = await appConfirm(
      `⚠️ ADVERTENCIA CRÍTICA:\nEsta acción ELIMINARÁ DEFINITIVAMENTE la Bóveda (${activeVaultId}) y TODOS sus datos (ingresos, gastos, deudas, metas y finanzas fijas) tanto de este dispositivo como de la nube.\n\n¿Estás completamente seguro de borrar todo?`,
      {
        title: 'Eliminar Bóveda Definitivamente',
        icon: '⚠️',
        okText: 'Sí, Eliminar Todo',
        isDanger: true
      }
    );

    if (!confirmed) return;

    showQuickToast('⏳ Eliminando permanentemente todos los datos de la bóveda...');

    try {
      // 1. Borrar subcolección de transacciones
      const txColl = collection(db, 'vaults', activeVaultId, 'transactions');
      const txSnap = await getDocs(txColl);
      for (const d of txSnap.docs) {
        await deleteDoc(d.ref);
      }

      // 2. Borrar subcolección de deudas
      const debtColl = collection(db, 'vaults', activeVaultId, 'debts');
      const debtSnap = await getDocs(debtColl);
      for (const d of debtSnap.docs) {
        await deleteDoc(d.ref);
      }

      // 3. Borrar subcolección de metas de ahorro
      const gColl = collection(db, 'vaults', activeVaultId, 'savingsGoals');
      const gSnap = await getDocs(gColl);
      for (const d of gSnap.docs) {
        await deleteDoc(d.ref);
      }

      // 4. Borrar subcolección de pagos fijos / recurrentes
      const rColl = collection(db, 'vaults', activeVaultId, 'recurringPayments');
      const rSnap = await getDocs(rColl);
      for (const d of rSnap.docs) {
        await deleteDoc(d.ref);
      }

      // 5. Borrar documento de la bóveda principal
      await deleteDoc(doc(db, 'vaults', activeVaultId));

      // 6. Borrar índices de usuario si existían
      if (currentUser) {
        if (currentUser.email) {
          try { await deleteDoc(doc(db, 'users_index', currentUser.email.toLowerCase())); } catch (e) {}
        }
        if (currentUser.userCode) {
          try { await deleteDoc(doc(db, 'users_index', currentUser.userCode.toUpperCase())); } catch (e) {}
        }
        if (currentUser.uid) {
          try { await deleteDoc(doc(db, 'users', currentUser.uid)); } catch (e) {}
        }
      }
    } catch (delErr) {
      console.warn('Nota eliminando de Firestore:', delErr);
    }

    // 7. Borrar todos los datos de localStorage
    localStorage.removeItem('finances_v10_trans');
    localStorage.removeItem('finances_v10_debts');
    localStorage.removeItem('finances_v10_goals');
    localStorage.removeItem('finances_v10_recurring');
    localStorage.removeItem('finances_v10_accounts');
    localStorage.removeItem('ahorros_current_user');
    localStorage.removeItem('ahorros_active_vault');
    localStorage.removeItem('ahorros_boveda_code');
    localStorage.removeItem('ahorros_shortcut_key');
    localStorage.removeItem('ahorros_active_tab');

    // Desuscribir listeners
    if (unsubscribeTransactions) unsubscribeTransactions();
    if (unsubscribeDebts) unsubscribeDebts();
    if (unsubscribeGoals) unsubscribeGoals();
    if (unsubscribeRecurring) unsubscribeRecurring();

    alert(`✅ La bóveda "${activeVaultId}" y todos sus registros han sido eliminados de raíz.`);
    window.location.replace('login.html');
  });
}

// COMANDO EXCLUSIVO DE CONSOLA PARA EL CREADOR DE LA APP (NO ACCESIBLE PARA USUARIOS COMUNES)
window.ahorrosCreatorPurgeResidualTestVaults = async function(confirmationWord) {
  if (confirmationWord !== 'PURGAR_PRUEBAS_CREADOR') {
    console.warn('Acceso restringido. Uso exclusivo del desarrollador/creador.');
    return 'Acceso denegado';
  }
  let purgedCount = 0;
  try {
    const vColl = collection(db, 'vaults');
    const vSnap = await getDocs(vColl);
    for (const vDoc of vSnap.docs) {
      const vId = vDoc.id;
      if (vId !== activeVaultId && (vId.startsWith('USR-') || vId.startsWith('AHO-') || vId.startsWith('TEST-'))) {
        for (const sub of ['transactions', 'debts', 'savingsGoals', 'recurringPayments']) {
          try {
            const subSnap = await getDocs(collection(db, 'vaults', vId, sub));
            for (const sd of subSnap.docs) await deleteDoc(sd.ref);
          } catch (se) {}
        }
        await deleteDoc(vDoc.ref);
        purgedCount++;
      }
    }
    console.log(`🧹 Purgadas ${purgedCount} bóvedas de prueba residuales.`);
    return `Exito: ${purgedCount} eliminadas`;
  } catch (err) {
    console.error('Error purgando:', err);
    return err.message;
  }
};

btnRegenKey.addEventListener('click', async () => {
  const confirmed = await appConfirm('¿Deseas generar una nueva clave secreta de Atajo? Se sincronizará inmediatamente entre tu celular y computador.', {
    title: 'Renovar Clave de Atajo',
    icon: '🔑',
    okText: 'Generar Clave',
    isDanger: false
  });
  if (confirmed) {
    userApiKey = generateApiKey();
    updateShortcutCredentialsUI();

    try {
      if (activeVaultId) {
        await setDoc(doc(db, 'vaults', activeVaultId), {
          shortcutApiKey: userApiKey,
          updatedAt: new Date().toISOString()
        }, { merge: true });

        await setDoc(doc(db, 'shortcut_keys', userApiKey), {
          vaultId: activeVaultId,
          updatedAt: new Date().toISOString()
        }, { merge: true });
      }

      if (currentUser && currentUser.uid) {
        try {
          await updateDoc(doc(db, 'users', currentUser.uid), {
            apiKey: userApiKey,
            activeVaultId: activeVaultId
          });
        } catch (uErr) {
          await setDoc(doc(db, 'users', currentUser.uid), {
            apiKey: userApiKey,
            activeVaultId: activeVaultId
          }, { merge: true });
        }
      }
    } catch (err) {
      console.warn('Nota guardando nueva clave en Firestore:', err);
    }

    syncClientTotalsToServer();
    showQuickToast('🔑 Clave renovada y sincronizada en tiempo real');
  }
});

// SELECTOR DE MODO DE DISPOSITIVO (AUTO / MOVIL / PC)
const deviceViewSelect = document.getElementById('device-view-select');
function applyDeviceMode(mode) {
  if (mode === 'mobile') {
    document.body.dataset.device = 'mobile';
  } else if (mode === 'desktop') {
    document.body.dataset.device = 'desktop';
  } else {
    delete document.body.dataset.device;
  }
}

if (deviceViewSelect) {
  const savedDeviceMode = localStorage.getItem('ahorros_device_mode') || 'auto';
  deviceViewSelect.value = savedDeviceMode;
  applyDeviceMode(savedDeviceMode);
  deviceViewSelect.addEventListener('change', (e) => {
    const val = e.target.value;
    localStorage.setItem('ahorros_device_mode', val);
    applyDeviceMode(val);
  });
}


// EXPLORADOR Y NAVEGADOR DE MES PARA INGRESOS Y GASTOS
const movementsMonthSelect = document.getElementById('movements-month-select');
const movementsYearSelect = document.getElementById('movements-year-select');
const btnMovementsPrevMonth = document.getElementById('btn-movements-prev-month');
const btnMovementsNextMonth = document.getElementById('btn-movements-next-month');

function syncGlobalAndMovementsFilters() {
  if (movementsMonthSelect) movementsMonthSelect.value = activeMonth;
  if (movementsYearSelect) movementsYearSelect.value = activeYear;
  const gm = document.getElementById('global-filter-month');
  if (gm) gm.value = activeMonth;
  const gy = document.getElementById('global-filter-year');
  if (gy) gy.value = activeYear;
}

if (movementsMonthSelect) {
  movementsMonthSelect.value = activeMonth;
  movementsMonthSelect.addEventListener('change', (e) => {
    activeMonth = e.target.value;
    syncGlobalAndMovementsFilters();
    updateUI();
  });
}

if (movementsYearSelect) {
  movementsYearSelect.value = activeYear;
  movementsYearSelect.addEventListener('change', (e) => {
    activeYear = e.target.value;
    syncGlobalAndMovementsFilters();
    updateUI();
  });
}

function navigateMovementsMonth(dir) {
  let curM = activeMonth === 'ALL' ? (new Date().getMonth() + 1) : parseInt(activeMonth, 10);
  curM += dir;
  let curY = parseInt(activeYear === 'ALL' ? '2026' : activeYear, 10);
  if (curM < 1) {
    curM = 12;
    curY -= 1;
  } else if (curM > 12) {
    curM = 1;
    curY += 1;
  }
  activeMonth = String(curM).padStart(2, '0');
  activeYear = String(curY);
  syncGlobalAndMovementsFilters();
  updateUI();
}

if (btnMovementsPrevMonth) {
  btnMovementsPrevMonth.addEventListener('click', () => navigateMovementsMonth(-1));
}
if (btnMovementsNextMonth) {
  btnMovementsNextMonth.addEventListener('click', () => navigateMovementsMonth(1));
}

// SELECTOR SEGMENTADO EN FORMULARIO DE FINANZAS FIJAS (GASTO VS INGRESO)
const btnTypeExpense = document.getElementById('btn-type-expense');
const btnTypeIncome = document.getElementById('btn-type-income');
const recTypeInput = document.getElementById('rec-type');
const recNameLabel = document.getElementById('rec-name-label');
const recNameInput = document.getElementById('rec-name');
const btnSubmitRecurring = document.getElementById('btn-submit-recurring');
const recurringFormTitle = document.getElementById('recurring-form-title');

function setRecurringType(type) {
  if (!recTypeInput) return;
  recTypeInput.value = type;
  if (type === 'income') {
    btnTypeIncome?.classList.add('active', 'income');
    btnTypeExpense?.classList.remove('active', 'expense');
    if (recNameLabel) recNameLabel.textContent = 'Nombre del Ingreso Fijo o Sueldo';
    if (recNameInput) recNameInput.placeholder = 'Ej: Sueldo empresa, Honorarios fijos, Renta cobrada';
    if (btnSubmitRecurring) {
      btnSubmitRecurring.textContent = 'Guardar Ingreso Fijo';
      btnSubmitRecurring.className = 'btn btn-success';
    }
    if (recurringFormTitle) recurringFormTitle.textContent = 'Registrar Ingreso Fijo (Sueldo / Entrada)';
  } else {
    btnTypeExpense?.classList.add('active', 'expense');
    btnTypeIncome?.classList.remove('active', 'income');
    if (recNameLabel) recNameLabel.textContent = 'Nombre del Servicio o Pago Fijo';
    if (recNameInput) recNameInput.placeholder = 'Ej: Arriendo, Netflix, Internet, Servicios';
    if (btnSubmitRecurring) {
      btnSubmitRecurring.textContent = 'Guardar Gasto Fijo';
      btnSubmitRecurring.className = 'btn btn-danger';
    }
    if (recurringFormTitle) recurringFormTitle.textContent = 'Registrar Gasto Fijo o Suscripción';
  }
}

if (btnTypeExpense) btnTypeExpense.addEventListener('click', () => setRecurringType('expense'));
if (btnTypeIncome) btnTypeIncome.addEventListener('click', () => setRecurringType('income'));

// FILTROS DE LISTA DE RECURRENTES (TODOS / INGRESOS / GASTOS)
document.querySelectorAll('.recurring-pill-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.recurring-pill-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeRecurringFilter = btn.dataset.filter || 'ALL';
    renderRecurringPayments();
  });
});


function renderShortcutEvents() {
  if (!shortcutEventsList) return;
  if (shortcutEvents.length === 0) {
    shortcutEventsList.innerHTML = '<tr><td colspan="6" style="text-align:center; color: var(--text-muted);">Sin transacciones recientes de atajos.</td></tr>';
    return;
  }
  shortcutEventsList.innerHTML = '';
  shortcutEvents.slice(0, 10).forEach(ev => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><small style="color:var(--text-muted);">${formatDateDisplay(ev.date, ev.time || ev.createdAt)}</small></td>
      <td><span class="tag-badge ${ev.type === 'income' ? 'text-success' : 'text-danger'}">${ev.type === 'income' ? 'INGRESO' : 'GASTO'}</span></td>
      <td><strong>${ev.description}</strong></td>
      <td><span class="tag-badge">${ev.paymentMethod || 'NEQUI'}</span></td>
      <td style="font-weight:700;" class="${ev.type === 'income' ? 'text-success' : 'text-danger'}">${formatCurrency(ev.amount)}</td>
      <td><span class="tag-badge">iPhone Atajo</span></td>
    `;
    shortcutEventsList.appendChild(row);
  });
}

// POLLING DE ATAJOS PENDIENTES DESDE EL SERVIDOR
let isPollingPendingShortcuts = false;
async function pollPendingShortcuts() {
  if (isPollingPendingShortcuts) return;
  isPollingPendingShortcuts = true;
  try {
    const res = await fetch(`/api/shortcut/pending?key=${encodeURIComponent(userApiKey)}&vault=${encodeURIComponent(activeVaultId)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.success && Array.isArray(data.transactions) && data.transactions.length > 0) {
      let anyAdded = false;
      for (const t of data.transactions) {
        // Verificar si la transacción ya está en memoria o en el estado local
        const alreadyExists = transactions.some(existing => 
          (t.id && (existing.id === t.id || existing.localId === t.id || existing.firestoreId === t.id)) ||
          (t.createdAt && existing.createdAt === t.createdAt) ||
          (existing.date === t.date && existing.type === t.type && Math.abs(existing.amount - t.amount) < 0.01 && existing.description === t.description && Math.abs(new Date(existing.createdAt || 0) - new Date(t.createdAt || 0)) < 60000)
        );
        const sig = `${t.type}_${t.amount}_${t.date}_${(t.description || '').trim().toLowerCase()}`;
        const isDeleted = (t.id && recentlyDeletedTxIds.has(String(t.id))) ||
                          (t.localId && recentlyDeletedTxIds.has(String(t.localId))) ||
                          recentlyDeletedTxSignatures.has(sig);
        if (!alreadyExists && !isDeleted) {
          shortcutEvents.unshift(t);
          await addTransactionLocallyOrCloud(t);
          anyAdded = true;
        }
      }
      if (anyAdded) {
        renderShortcutEvents();
        updateUI();
      }
    }
  } catch (e) {
    // Polling silencioso
  } finally {
    isPollingPendingShortcuts = false;
  }
}
setInterval(pollPendingShortcuts, 5000);

// SINCRONIZAR TOTALES AL SERVIDOR PARA RESPUESTAS DE SIRI
async function syncClientTotalsToServer() {
  try {
    let incomeSum = 0;
    let expenseSum = 0;
    transactions.forEach(t => {
      if (t.type === 'income') incomeSum += t.amount;
      else expenseSum += t.amount;
    });
    const balance = incomeSum - expenseSum;

    let pendingDebtsSum = 0;
    debts.forEach(d => {
      const interest = d.interest || 0;
      const total = d.total + (d.total * (interest / 100));
      pendingDebtsSum += Math.max(0, total - (d.paid || 0));
    });

    await fetch('/api/shortcut/sync-client', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': userApiKey
      },
      body: JSON.stringify({
        balance,
        totalIncome: incomeSum,
        totalExpense: expenseSum,
        pendingDebts: pendingDebtsSum
      })
    });
  } catch (err) {
    // silently fail
  }
}

// GESTION DE SESION Y BÓVEDA EN LA NUBE
if (btnVaultGoogleLogin) {
  btnVaultGoogleLogin.addEventListener('click', async () => {
    if (currentUser && !currentUser.isAnonymous) {
      const confirmed = await appConfirm('¿Cerrar sesión de Google? Tu Bóveda seguirá activa y protegida con tu código.', {
        title: 'Cerrar Sesión Google',
        icon: '☁️',
        okText: 'Desvincular',
        isDanger: false
      });
      if (confirmed) {
        await signOut(auth);
      }
    } else {
      try {
        const result = await signInWithPopup(auth, googleProvider);
        console.log('Cuenta de Google vinculada:', result.user.email);
        alert(`¡Cuenta vinculada con éxito a ${result.user.email}! Tu bóveda ahora está asociada a tu correo.`);
      } catch (error) {
        console.error('Error al vincular con Google:', error);
        alert('No se pudo vincular con Google. Tu Bóveda sigue activa con tu código personal.');
      }
    }
  });
}

// CARGA DIRECTA DE LA BOVEDA DESDE FIRESTORE (INMEDIATA Y COMPLETA)
async function loadVaultFromCloud(vaultId) {
  if (!vaultId) return;
  try {
    // Sincronizar clave secreta de atajo de la bóveda
    try {
      const vDocRef = doc(db, 'vaults', vaultId);
      const vDocSnap = await getDoc(vDocRef);
      if (vDocSnap.exists()) {
        const vData = vDocSnap.data();
        if (vData.shortcutApiKey) {
          userApiKey = vData.shortcutApiKey;
          localStorage.setItem('ahorros_shortcut_key_' + vaultId, userApiKey);
          localStorage.setItem('ahorros_shortcut_key', userApiKey);
          updateShortcutCredentialsUI();
        } else {
          await setDoc(vDocRef, { shortcutApiKey: userApiKey }, { merge: true });
        }
      } else {
        await setDoc(vDocRef, { code: vaultId, shortcutApiKey: userApiKey, createdAt: new Date().toISOString() }, { merge: true });
      }
      // Registrar índice para búsqueda de webhooks
      await setDoc(doc(db, 'shortcut_keys', userApiKey), { vaultId: vaultId }, { merge: true });
    } catch (kErr) {
      console.warn('Nota sincronizando clave de bóveda:', kErr);
    }

    const txColl = collection(db, 'vaults', vaultId, 'transactions');
    const txSnap = await getDocs(txColl);
    if (!txSnap.empty) {
      const cloudTrans = [];
      const seenTxIds = new Set();
      txSnap.forEach(d => {
        if (!recentlyDeletedTxIds.has(d.id) && !seenTxIds.has(d.id)) {
          const tData = d.data();
          const sig = `${tData.type}_${tData.amount}_${tData.date}_${(tData.description || '').trim().toLowerCase()}`;
          if (recentlyDeletedTxSignatures.has(sig)) {
            return;
          }
          seenTxIds.add(d.id);
          // Limpiar transacciones residuales de metas que antes distorsionaban ingresos/gastos
          if (tData.description && (
            tData.description.startsWith('AHORRO EN META:') ||
            tData.description.startsWith('AHORRO INICIAL EN META:') ||
            tData.description.startsWith('RETIRO DE META:')
          )) {
            return;
          }
          // Evitar pintar registros idénticos si ingresaron duplicados en la base de datos dentro de 30s
          const isDuplicatedDoc = cloudTrans.some(prev =>
            prev.type === tData.type &&
            Math.abs(prev.amount - tData.amount) < 0.01 &&
            prev.description === tData.description &&
            prev.date === tData.date &&
            Math.abs(new Date(prev.createdAt || 0) - new Date(tData.createdAt || 0)) < 30000
          );
          if (!isDuplicatedDoc) {
            cloudTrans.push({ ...tData, id: d.id, firestoreId: d.id, localId: tData.localId || d.id });
          }
        }
      });
      transactions = sortTransactionsByDate(cloudTrans);
      localStorage.setItem('finances_v10_trans', JSON.stringify(transactions));
      updateUI();
    }

    const debtsColl = collection(db, 'vaults', vaultId, 'debts');
    const debtsSnap = await getDocs(debtsColl);
    if (!debtsSnap.empty) {
      const cloudDebts = [];
      debtsSnap.forEach(d => {
        if (!recentlyDeletedDebtIds.has(d.id)) {
          cloudDebts.push({ ...d.data(), id: d.id, firestoreId: d.id, localId: d.data().localId || d.id });
        }
      });
      debts = deduplicateDebts(cloudDebts);
      localStorage.setItem('finances_v10_debts', JSON.stringify(debts));
      updateUI();
    }

    const gColl = collection(db, 'vaults', vaultId, 'savingsGoals');
    const gSnap = await getDocs(gColl);
    if (!gSnap.empty) {
      const cloudGoals = [];
      gSnap.forEach(d => {
        if (!recentlyDeletedGoalIds.has(d.id)) {
          cloudGoals.push({ ...d.data(), id: d.id, firestoreId: d.id, localId: d.data().localId || d.id });
        }
      });
      savingsGoals = deduplicateGoals(cloudGoals);
      localStorage.setItem('finances_v10_goals', JSON.stringify(savingsGoals));
      renderSavingsGoals();
    }

    const rColl = collection(db, 'vaults', vaultId, 'recurringPayments');
    const rSnap = await getDocs(rColl);
    if (!rSnap.empty) {
      const cloudRec = [];
      rSnap.forEach(d => {
        if (!recentlyDeletedRecurringIds.has(d.id)) {
          cloudRec.push({ ...d.data(), id: d.id, firestoreId: d.id, localId: d.data().localId || d.id });
        }
      });
      recurringPayments = deduplicateRecurring(cloudRec);
      localStorage.setItem('finances_v10_recurring', JSON.stringify(recurringPayments));
      renderRecurringPayments();
    }
  } catch (err) {
    console.warn('Nota carga inicial de bóveda:', err);
  }
}

// CAMBIO O CONEXION A OTRA BOVEDA
async function switchVault(newCode, isNew = false) {
  let cleanCode = String(newCode || '').trim().toUpperCase();
  if (!cleanCode) return;

  // Si el usuario escribió sólo los 4 caracteres sin prefijo (ej: 8K3P -> AHO-8K3P)
  if (!cleanCode.startsWith('AHO-') && !cleanCode.startsWith('AHORRO-') && cleanCode.length === 4) {
    cleanCode = `AHO-${cleanCode}`;
  }

  if (vaultLinkFeedback) {
    vaultLinkFeedback.style.display = 'block';
    vaultLinkFeedback.style.color = 'var(--primary-color)';
    vaultLinkFeedback.textContent = '⏳ Conectando y descargando datos de la bóveda...';
  }

  activeVaultId = cleanCode;
  localStorage.setItem('ahorros_active_vault', cleanCode);
  localStorage.setItem('ahorros_boveda_code', cleanCode);

  if (vaultCodeText) vaultCodeText.textContent = cleanCode;
  if (vaultLinkCodeInput) vaultLinkCodeInput.value = '';
  authBtnText.textContent = `🔐 ${cleanCode}`;
  updateVaultModalDirectUrl();

  try {
    const vaultRef = doc(db, 'vaults', cleanCode);
    await setDoc(vaultRef, {
      code: cleanCode,
      lastAccessed: new Date().toISOString()
    }, { merge: true });
  } catch (err) {
    console.warn('Nota de metadatos de bóveda:', err);
  }

  if (isNew) {
    await syncLocalDataToVault(cleanCode);
  } else {
    // Descarga directa e inmediata de los datos existentes en la bóveda
    await loadVaultFromCloud(cleanCode);
  }

  setupVaultCloudListeners(cleanCode);

  if (vaultLinkFeedback) {
    vaultLinkFeedback.style.color = 'var(--success-color)';
    vaultLinkFeedback.textContent = `✅ ¡Bóveda ${cleanCode} conectada con éxito!`;
    setTimeout(() => {
      if (vaultLinkFeedback) vaultLinkFeedback.style.display = 'none';
      if (vaultModal) vaultModal.classList.add('hidden');
    }, 1200);
  } else {
    if (vaultModal) vaultModal.classList.add('hidden');
  }

  showQuickToast(`🔐 Bóveda ${cleanCode} sincronizada`);
}

// SINCRONIZACION AUTOMATICA DE DATOS LOCALES A LA BOVEDA
async function syncLocalDataToVault(vaultId) {
  if (!vaultId) return;
  const localTrans = JSON.parse(localStorage.getItem('finances_v10_trans')) || [];
  const localDebts = JSON.parse(localStorage.getItem('finances_v10_debts')) || [];
  const localGoals = JSON.parse(localStorage.getItem('finances_v10_goals')) || [];
  const localRecurring = JSON.parse(localStorage.getItem('finances_v10_recurring')) || [];

  try {
    const txColl = collection(db, 'vaults', vaultId, 'transactions');
    const existingSnap = await getDocs(txColl);
    if (existingSnap.empty && localTrans.length > 0) {
      for (const t of localTrans) {
        const docRef = await addDoc(txColl, {
          vaultId,
          ...t,
          createdAt: t.createdAt || new Date().toISOString()
        });
        t.firestoreId = docRef.id;
        t.id = docRef.id;
      }
      localStorage.setItem('finances_v10_trans', JSON.stringify(localTrans));
      transactions = localTrans;
    }
  } catch (err) { console.warn('Sync transacciones a bóveda:', err); }

  try {
    const debtColl = collection(db, 'vaults', vaultId, 'debts');
    const existingDebtSnap = await getDocs(debtColl);
    if (existingDebtSnap.empty && localDebts.length > 0) {
      for (const d of localDebts) {
        const docRef = await addDoc(debtColl, {
          vaultId,
          ...d,
          createdAt: d.createdAt || new Date().toISOString()
        });
        d.firestoreId = docRef.id;
        d.id = docRef.id;
      }
      localStorage.setItem('finances_v10_debts', JSON.stringify(localDebts));
      debts = localDebts;
    }
  } catch (err) { console.warn('Sync deudas a bóveda:', err); }

  try {
    const gColl = collection(db, 'vaults', vaultId, 'savingsGoals');
    const existingGSnap = await getDocs(gColl);
    if (existingGSnap.empty && localGoals.length > 0) {
      for (const g of localGoals) {
        const docRef = await addDoc(gColl, {
          vaultId,
          ...g,
          createdAt: g.createdAt || new Date().toISOString()
        });
        g.firestoreId = docRef.id;
        g.id = docRef.id;
      }
      localStorage.setItem('finances_v10_goals', JSON.stringify(localGoals));
      savingsGoals = localGoals;
    }
  } catch (err) { console.warn('Sync metas a bóveda:', err); }

  try {
    const rColl = collection(db, 'vaults', vaultId, 'recurringPayments');
    const existingRSnap = await getDocs(rColl);
    if (existingRSnap.empty && localRecurring.length > 0) {
      for (const r of localRecurring) {
        const docRef = await addDoc(rColl, {
          vaultId,
          ...r,
          createdAt: r.createdAt || new Date().toISOString()
        });
        r.firestoreId = docRef.id;
        r.id = docRef.id;
      }
      localStorage.setItem('finances_v10_recurring', JSON.stringify(localRecurring));
      recurringPayments = localRecurring;
    }
  } catch (err) { console.warn('Sync pagos fijos a bóveda:', err); }
}

// ESCUCHAS EN TIEMPO REAL CON ONSNAPSHOT POR BÓVEDA
function setupVaultCloudListeners(vaultId) {
  if (!vaultId) return;
  if (unsubscribeTransactions) { unsubscribeTransactions(); unsubscribeTransactions = null; }
  if (unsubscribeDebts) { unsubscribeDebts(); unsubscribeDebts = null; }
  if (unsubscribeGoals) { unsubscribeGoals(); unsubscribeGoals = null; }
  if (unsubscribeRecurring) { unsubscribeRecurring(); unsubscribeRecurring = null; }
  if (unsubscribeVaultMeta) { unsubscribeVaultMeta(); unsubscribeVaultMeta = null; }

  updateSyncStatus(true, `🟢 BÓVEDA ${vaultId}`);
  if (vaultCodeText) vaultCodeText.textContent = vaultId;

  // Escuchar metadatos de la bóveda (clave secreta de atajos en tiempo real entre celular y PC)
  const vDocRef = doc(db, 'vaults', vaultId);
  unsubscribeVaultMeta = onSnapshot(vDocRef, (snap) => {
    if (snap.exists()) {
      const vData = snap.data();
      if (vData.shortcutApiKey && vData.shortcutApiKey !== userApiKey) {
        console.log('🔄 Clave de atajo sincronizada desde la nube:', vData.shortcutApiKey);
        userApiKey = vData.shortcutApiKey;
        localStorage.setItem('ahorros_shortcut_key_' + vaultId, userApiKey);
        localStorage.setItem('ahorros_shortcut_key', userApiKey);
        updateShortcutCredentialsUI();
      }
    }
  }, (error) => {
    console.warn('Nota listener vault meta:', error);
  });

  const txColl = collection(db, 'vaults', vaultId, 'transactions');
  unsubscribeTransactions = onSnapshot(txColl, (snapshot) => {
    const rawCloudTrans = [];
    const seenTxDocIds = new Set();
    snapshot.forEach(docSnap => {
      const tData = docSnap.data();
      const docId = String(docSnap.id);
      const locId = tData.id ? String(tData.id) : '';
      const locField = tData.localId ? String(tData.localId) : '';
      const tmpField = tData.tempId ? String(tData.tempId) : '';
      const crAt = tData.createdAt ? String(tData.createdAt) : '';

      const sig = `${tData.type}_${tData.amount}_${tData.date}_${(tData.description || '').trim().toLowerCase()}`;
      if (recentlyDeletedTxSignatures.has(sig)) {
        return;
      }

      if (recentlyDeletedTxIds.has(docId) ||
          (locId && recentlyDeletedTxIds.has(locId)) ||
          (locField && recentlyDeletedTxIds.has(locField)) ||
          (tmpField && recentlyDeletedTxIds.has(tmpField)) ||
          (crAt && recentlyDeletedTxIds.has(crAt))) {
        return;
      }
      if (tData.description && (
        tData.description.startsWith('AHORRO EN META:') ||
        tData.description.startsWith('AHORRO INICIAL EN META:') ||
        tData.description.startsWith('RETIRO DE META:')
      )) {
        return;
      }

      if (!seenTxDocIds.has(docId)) {
        seenTxDocIds.add(docId);
        rawCloudTrans.push({
          ...tData,
          id: docSnap.id,
          firestoreId: docSnap.id,
          localId: tData.localId || tData.id || docSnap.id
        });
      }
    });

    // Deduplicar cloudTrans en caso de que en la base de datos existan dos registros idénticos ingresados en ráfaga (<30s)
    const cloudTrans = [];
    rawCloudTrans.forEach(ct => {
      const isDuplicate = cloudTrans.some(prev =>
        prev.type === ct.type &&
        Math.abs((prev.amount || 0) - (ct.amount || 0)) < 0.01 &&
        prev.description === ct.description &&
        prev.date === ct.date &&
        Math.abs(new Date(prev.createdAt || 0) - new Date(ct.createdAt || 0)) < 30000
      );
      if (!isDuplicate) {
        cloudTrans.push(ct);
      }
    });

    // Preservar transacciones locales provisionales recién insertadas que aún no hayan llegado a Firestore
    const localPending = transactions.filter(t => 
      typeof t.id === 'string' && t.id.startsWith('tx_') &&
      !recentlyDeletedTxIds.has(String(t.id)) &&
      !recentlyDeletedTxIds.has(String(t.localId)) &&
      !recentlyDeletedTxIds.has(String(t.firestoreId)) &&
      !cloudTrans.some(c => 
        (c.id && c.id === t.id) ||
        (c.firestoreId && c.firestoreId === t.id) ||
        (c.localId && (c.localId === t.id || c.localId === t.localId)) ||
        (c.createdAt && c.createdAt === t.createdAt) ||
        (c.type === t.type && Math.abs((c.amount || 0) - (t.amount || 0)) < 0.01 && c.description === t.description && c.date === t.date && Math.abs(new Date(c.createdAt || 0) - new Date(t.createdAt || 0)) < 60000)
      )
    );

    // Actualizar estado siempre con los datos autoritativos del snapshot
    transactions = sortTransactionsByDate([...cloudTrans, ...localPending]);
    localStorage.setItem('finances_v10_trans', JSON.stringify(transactions));
    updateUI();
  }, (error) => {
    console.warn('Nota listener transacciones:', error);
    setTimeout(() => {
      if (activeVaultId === vaultId) setupVaultCloudListeners(vaultId);
    }, 4000);
  });

  const debtsColl = collection(db, 'vaults', vaultId, 'debts');
  unsubscribeDebts = onSnapshot(debtsColl, (snapshot) => {
    const rawCloudDebts = [];
    snapshot.forEach(docSnap => {
      const dData = docSnap.data();
      const docId = String(docSnap.id);
      const locId = dData.id ? String(dData.id) : '';
      const locField = dData.localId ? String(dData.localId) : '';
      const tmpField = dData.tempId ? String(dData.tempId) : '';
      const crAt = dData.createdAt ? String(dData.createdAt) : '';
      const dSig = dData.name ? `sig_debt_${dData.name}` : '';

      if (recentlyDeletedDebtIds.has(docId) ||
          (locId && recentlyDeletedDebtIds.has(locId)) ||
          (locField && recentlyDeletedDebtIds.has(locField)) ||
          (tmpField && recentlyDeletedDebtIds.has(tmpField)) ||
          (crAt && recentlyDeletedDebtIds.has(crAt)) ||
          (dSig && recentlyDeletedDebtIds.has(dSig))) {
        return;
      }
      rawCloudDebts.push({ ...dData, id: docSnap.id, firestoreId: docSnap.id, localId: dData.localId || dData.id });
    });
    const cloudDebts = deduplicateDebts(rawCloudDebts);
    const localPending = debts.filter(d => 
      typeof d.id === 'string' && d.id.startsWith('debt_') &&
      !recentlyDeletedDebtIds.has(String(d.id)) &&
      !recentlyDeletedDebtIds.has(String(d.localId)) &&
      !recentlyDeletedDebtIds.has(String(d.firestoreId)) &&
      !cloudDebts.some(c => 
        (c.id && c.id === d.id) ||
        (c.firestoreId && c.firestoreId === d.id) ||
        (c.localId && (c.localId === d.id || c.localId === d.localId)) ||
        ((c.name || '').trim().toLowerCase() === (d.name || '').trim().toLowerCase() && Math.abs((c.total || 0) - (d.total || 0)) < 0.01 && c.type === d.type)
      )
    );
    debts = deduplicateDebts([...cloudDebts, ...localPending]);
    localStorage.setItem('finances_v10_debts', JSON.stringify(debts));
    updateUI();
  }, (error) => {
    console.warn('Nota listener deudas:', error);
    setTimeout(() => {
      if (activeVaultId === vaultId) setupVaultCloudListeners(vaultId);
    }, 4000);
  });

  const gColl = collection(db, 'vaults', vaultId, 'savingsGoals');
  unsubscribeGoals = onSnapshot(gColl, (snapshot) => {
    const rawCloudGoals = [];
    snapshot.forEach(docSnap => {
      const gData = docSnap.data();
      const docId = String(docSnap.id);
      const locId = gData.id ? String(gData.id) : '';
      const locField = gData.localId ? String(gData.localId) : '';
      const tmpField = gData.tempId ? String(gData.tempId) : '';
      const gName = gData.name ? String(gData.name) : '';
      const gSig = gName ? `sig_goal_${gName}` : '';

      if (recentlyDeletedGoalIds.has(docId) ||
          (locId && recentlyDeletedGoalIds.has(locId)) ||
          (locField && recentlyDeletedGoalIds.has(locField)) ||
          (tmpField && recentlyDeletedGoalIds.has(tmpField)) ||
          (gName && recentlyDeletedGoalIds.has(gName)) ||
          (gSig && recentlyDeletedGoalIds.has(gSig))) {
        return;
      }
      rawCloudGoals.push({ ...gData, id: docSnap.id, firestoreId: docSnap.id, localId: gData.localId || gData.id });
    });
    const cloudGoals = deduplicateGoals(rawCloudGoals);
    const localPending = savingsGoals.filter(g => 
      typeof g.id === 'string' && g.id.startsWith('goal_') &&
      !recentlyDeletedGoalIds.has(String(g.id)) &&
      !recentlyDeletedGoalIds.has(String(g.localId)) &&
      !recentlyDeletedGoalIds.has(String(g.firestoreId)) &&
      !cloudGoals.some(c => 
        (c.id && c.id === g.id) ||
        (c.firestoreId && c.firestoreId === g.id) ||
        (c.localId && (c.localId === g.id || c.localId === g.localId)) ||
        ((c.name || '').trim().toLowerCase() === (g.name || '').trim().toLowerCase() && Math.abs((c.targetAmount || 0) - (g.targetAmount || 0)) < 0.01)
      )
    );
    savingsGoals = deduplicateGoals([...cloudGoals, ...localPending]);
    localStorage.setItem('finances_v10_goals', JSON.stringify(savingsGoals));
    renderSavingsGoals();
  }, (error) => {
    console.warn('Nota listener metas:', error);
    setTimeout(() => {
      if (activeVaultId === vaultId) setupVaultCloudListeners(vaultId);
    }, 4000);
  });

  const rColl = collection(db, 'vaults', vaultId, 'recurringPayments');
  unsubscribeRecurring = onSnapshot(rColl, (snapshot) => {
    const rawCloudR = [];
    snapshot.forEach(docSnap => {
      const rData = docSnap.data();
      const docId = String(docSnap.id);
      const locId = rData.id ? String(rData.id) : '';
      const locField = rData.localId ? String(rData.localId) : '';
      const tmpField = rData.tempId ? String(rData.tempId) : '';
      const rName = rData.name ? String(rData.name) : '';
      const rSig = rName ? `sig_rec_${rName}` : '';

      if (recentlyDeletedRecurringIds.has(docId) ||
          (locId && recentlyDeletedRecurringIds.has(locId)) ||
          (locField && recentlyDeletedRecurringIds.has(locField)) ||
          (tmpField && recentlyDeletedRecurringIds.has(tmpField)) ||
          (rName && recentlyDeletedRecurringIds.has(rName)) ||
          (rSig && recentlyDeletedRecurringIds.has(rSig))) {
        return;
      }
      rawCloudR.push({ ...rData, id: docSnap.id, firestoreId: docSnap.id, localId: rData.localId || rData.id });
    });
    const cloudR = deduplicateRecurring(rawCloudR);
    const localPending = recurringPayments.filter(r => 
      typeof r.id === 'string' && r.id.startsWith('rec_') &&
      !recentlyDeletedRecurringIds.has(String(r.id)) &&
      !recentlyDeletedRecurringIds.has(String(r.localId)) &&
      !recentlyDeletedRecurringIds.has(String(r.firestoreId)) &&
      !cloudR.some(c => 
        (c.id && c.id === r.id) ||
        (c.firestoreId && c.firestoreId === r.id) ||
        (c.localId && (c.localId === r.id || c.localId === r.localId)) ||
        ((c.name || '').trim().toLowerCase() === (r.name || '').trim().toLowerCase() && Math.abs((c.amount || 0) - (r.amount || 0)) < 0.01 && c.type === r.type)
      )
    );
    recurringPayments = deduplicateRecurring([...cloudR, ...localPending]);
    localStorage.setItem('finances_v10_recurring', JSON.stringify(recurringPayments));
    renderRecurringPayments();
  }, (error) => {
    console.warn('Nota listener pagos fijos:', error);
    setTimeout(() => {
      if (activeVaultId === vaultId) setupVaultCloudListeners(vaultId);
    }, 4000);
  });
}

// INICIAR ESCUCHA INMEDIATA Y DESCARGA INICIAL DE LA NUBE
loadVaultFromCloud(activeVaultId);
setupVaultCloudListeners(activeVaultId);
updateSyncStatus(true, `🟢 BÓVEDA ${activeVaultId}`);
if (authBtnText) authBtnText.textContent = `🔐 ${activeVaultId}`;

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    try {
      await signInAnonymously(auth);
    } catch (e) {
      // Si el inicio anónimo no está activo en Firebase Console, la bóveda sigue 100% activa por código
      console.info('Operando con código de bóveda sin sesión de Firebase Auth');
    }
  }

  currentUser = auth.currentUser;
  const isAnon = !currentUser || currentUser.isAnonymous;

  // Si inició sesión con Google, sincronizar con su bóveda guardada si existía
  if (currentUser && !isAnon && currentUser.email) {
    try {
      const userRef = doc(db, 'users', currentUser.uid);
      const userDoc = await getDoc(userRef);
      if (userDoc.exists()) {
        const uData = userDoc.data();
        if (uData.bovedaCode && uData.bovedaCode !== activeVaultId) {
          activeVaultId = uData.bovedaCode;
          localStorage.setItem('ahorros_active_vault', activeVaultId);
          localStorage.setItem('ahorros_boveda_code', activeVaultId);
        }
      } else {
        await setDoc(userRef, {
          uid: currentUser.uid,
          email: currentUser.email,
          bovedaCode: activeVaultId,
          createdAt: new Date().toISOString()
        }, { merge: true });
      }
    } catch (e) {
      console.warn('Nota perfil Google:', e);
    }
  }

  if (vaultCodeText) vaultCodeText.textContent = activeVaultId;
  if (vaultGoogleEmail) {
    vaultGoogleEmail.textContent = (currentUser && !isAnon) ? (currentUser.email || 'Vinculado') : 'No vinculado (Bóveda sin correo)';
  }
  if (vaultGoogleNote) {
    vaultGoogleNote.textContent = (currentUser && !isAnon) ? `Asociado a ${currentUser.email}` : 'Tus finanzas se sincronizan en la nube con tu código';
  }
  if (btnVaultGoogleLogin) {
    btnVaultGoogleLogin.textContent = (currentUser && !isAnon) ? 'Desvincular Google' : 'Vincular Google';
  }

  authBtnText.textContent = `🔐 ${activeVaultId}`;
  updateSyncStatus(true, `🟢 BÓVEDA ${activeVaultId}`);

  setupVaultCloudListeners(activeVaultId);
  await syncLocalDataToVault(activeVaultId);
});

// FILTRADO GLOBAL POR AÑO, MES, MEDIO Y MÉTODO
globalFilterYear.addEventListener('change', () => {
  activeYear = globalFilterYear.value;
  syncGlobalAndMovementsFilters();
  updateActivePeriodLabel();
  updateUI();
});

globalFilterMonth.addEventListener('change', () => {
  activeMonth = globalFilterMonth.value;
  syncGlobalAndMovementsFilters();
  updateActivePeriodLabel();
  updateUI();
});

if (globalFilterMedium) {
  globalFilterMedium.addEventListener('change', () => {
    activeMedium = globalFilterMedium.value;
    updateActivePeriodLabel();
    updateUI();
  });
}

if (globalFilterMethod) {
  globalFilterMethod.addEventListener('change', () => {
    activeMethod = globalFilterMethod.value;
    syncAccountCardsActiveState();
    updateActivePeriodLabel();
    updateUI();
  });
}

if (btnClearMethodFilter) {
  btnClearMethodFilter.addEventListener('click', () => {
    activeMethod = 'ALL';
    activeMedium = 'ALL';
    if (globalFilterMethod) globalFilterMethod.value = 'ALL';
    if (globalFilterMedium) globalFilterMedium.value = 'ALL';
    syncAccountCardsActiveState();
    updateActivePeriodLabel();
    updateUI();
  });
}

if (btnToggleShowTime) {
  function updateTimeToggleUI() {
    if (showExactTime) {
      btnToggleShowTime.classList.add('active');
      btnToggleShowTime.innerHTML = `<span>🕒</span> <span>Hora: Visible</span>`;
    } else {
      btnToggleShowTime.classList.remove('active');
      btnToggleShowTime.innerHTML = `<span>🕒</span> <span>Ver Hora</span>`;
    }
  }
  updateTimeToggleUI();
  btnToggleShowTime.addEventListener('click', () => {
    showExactTime = !showExactTime;
    localStorage.setItem('finances_show_time', String(showExactTime));
    updateTimeToggleUI();
    updateUI();
    renderSavingsGoals();
    renderRecurringPayments();
    renderShortcutEvents();
    showQuickToast(showExactTime ? '🕒 Visualización de hora exacta activada' : '🕒 Hora exacta oculta');
  });
}

function syncAccountCardsActiveState() {
  document.querySelectorAll('.account-card').forEach(card => {
    const acc = card.dataset.account;
    if (acc && acc === activeMethod) {
      card.classList.add('active-filter');
    } else {
      card.classList.remove('active-filter');
    }
  });

  if (btnClearMethodFilter) {
    if (activeMethod !== 'ALL' || activeMedium !== 'ALL') {
      btnClearMethodFilter.classList.remove('hidden');
    } else {
      btnClearMethodFilter.classList.add('hidden');
    }
  }
}

// CLICK EN TARJETAS DE CUENTAS EN EL DASHBOARD
document.querySelectorAll('.account-card').forEach(card => {
  card.addEventListener('click', () => {
    const targetAcc = card.dataset.account;
    if (!targetAcc) return;

    if (targetAcc === 'GOALS') {
      // Navegar a la pestaña de metas de ahorro
      const goalsTabBtn = document.querySelector('.tab-btn[data-tab="tab-savings"]');
      if (goalsTabBtn) goalsTabBtn.click();
      return;
    }

    if (activeMethod === targetAcc) {
      // Toggle off
      activeMethod = 'ALL';
      if (globalFilterMethod) globalFilterMethod.value = 'ALL';
    } else {
      activeMethod = targetAcc;
      if (globalFilterMethod) globalFilterMethod.value = targetAcc;
    }

    syncAccountCardsActiveState();
    updateActivePeriodLabel();
    updateUI();
  });
});

function updateActivePeriodLabel() {
  const monthNames = {
    '01': 'Enero', '02': 'Febrero', '03': 'Marzo', '04': 'Abril',
    '05': 'Mayo', '06': 'Junio', '07': 'Julio', '08': 'Agosto',
    '09': 'Septiembre', '10': 'Octubre', '11': 'Noviembre', '12': 'Diciembre'
  };
  const yearText = activeYear === 'ALL' ? 'Todos los Años' : activeYear;
  const monthText = activeMonth === 'ALL' ? 'Todos los Meses' : monthNames[activeMonth];
  
  let mediumText = '';
  if (activeMedium === 'FISICO') mediumText = ' • 💵 Solo Físico';
  else if (activeMedium === 'DIGITAL') mediumText = ' • 📱 Solo Digital';

  let methodText = '';
  if (activeMethod !== 'ALL') {
    methodText = ` • Cuenta: ${activeMethod}`;
  }

  activePeriodSummary.textContent = `Mostrando: ${monthText} (${yearText})${mediumText}${methodText}`;
}

// INSERCION DE MOVIMIENTO (LOCAL O NUBE)
async function addTransactionLocallyOrCloud(txData) {
  const now = new Date();
  const timeStr = txData.time || now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  const localId = txData.id || ('tx_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8));
  const cleanTx = {
    id: localId,
    localId: localId,
    tempId: localId,
    firestoreId: localId,
    type: txData.type,
    description: txData.description,
    amount: txData.amount,
    category: txData.category,
    paymentMethod: txData.paymentMethod || 'EFECTIVO',
    date: txData.date,
    time: timeStr,
    createdAt: txData.createdAt || now.toISOString(),
    ...(txData.recurringId ? { recurringId: txData.recurringId } : {}),
    ...(txData.recurringName ? { recurringName: txData.recurringName } : {}),
    ...(txData.recurringPeriod ? { recurringPeriod: txData.recurringPeriod } : {}),
    ...(txData.recurringFrequency ? { recurringFrequency: txData.recurringFrequency } : {})
  };

  // Evitar duplicar en memoria si ya existe en transactions (mismo id o misma transacción recibida dentro de 45s)
  const isAlreadyInState = transactions.some(t => 
    (cleanTx.id && (t.id === cleanTx.id || t.localId === cleanTx.id || t.firestoreId === cleanTx.id)) ||
    (cleanTx.firestoreId && (t.id === cleanTx.firestoreId || t.firestoreId === cleanTx.firestoreId)) ||
    (t.type === cleanTx.type && Math.abs((t.amount || 0) - (cleanTx.amount || 0)) < 0.01 && t.description === cleanTx.description && t.date === cleanTx.date && Math.abs(new Date(t.createdAt || 0) - new Date(cleanTx.createdAt || 0)) < 45000)
  );
  if (isAlreadyInState) {
    return;
  }

  // 1. Guardar localmente y actualizar interfaz INMEDIATAMENTE
  transactions.push(cleanTx);
  sortTransactionsByDate(transactions);
  localStorage.setItem('finances_v10_trans', JSON.stringify(transactions));
  updateUI();
  showQuickToast(`✅ ${cleanTx.type === 'income' ? 'Ingreso' : 'Gasto'} registrado: ${formatCurrency(cleanTx.amount)}`);

  // 2. Persistir en Firebase Firestore para sincronización multi-dispositivo (PC <-> Celular)
  try {
    const txColl = collection(db, 'vaults', activeVaultId, 'transactions');
    const docRef = await addDoc(txColl, {
      vaultId: activeVaultId,
      ...cleanTx
    });
    // Actualizar el ID provisional con el de Firestore preservando localId
    cleanTx.firestoreId = docRef.id;
    cleanTx.id = docRef.id;
    localStorage.setItem('finances_v10_trans', JSON.stringify(transactions));
    // Refrescar para que los botones de eliminar en la tabla tengan el ID definitivo
    updateUI();
  } catch (e) {
    console.warn('Transacción guardada localmente (pendiente de sync en la nube):', e);
  }

  syncClientTotalsToServer();
}

// ELIMINACION DE TRANSACCION (FLUIDA, INSTANTANEA Y A PRUEBA DE RESURRECCION)
window.removeTransaction = async function(idOrIndex) {
  const confirmed = await appConfirm('¿Deseas eliminar este movimiento permanentemente?', {
    title: 'Eliminar Movimiento',
    icon: '🗑️',
    okText: 'Eliminar',
    isDanger: true
  });
  if (!confirmed) return;

  const strId = String(idOrIndex).trim();
  let targetTx = transactions.find(t => 
    t && (
      String(t.id) === strId ||
      String(t.firestoreId) === strId ||
      String(t.localId) === strId ||
      String(t.tempId) === strId ||
      (t.createdAt && String(t.createdAt) === strId)
    )
  );
  if (!targetTx && !isNaN(parseInt(idOrIndex, 10)) && transactions[parseInt(idOrIndex, 10)]) {
    targetTx = transactions[parseInt(idOrIndex, 10)];
  }

  // Recopilar exclusivamente los identificadores específicos de esta transacción
  const idsToDelete = new Set();
  idsToDelete.add(strId);
  if (targetTx) {
    if (targetTx.id) idsToDelete.add(String(targetTx.id));
    if (targetTx.firestoreId) idsToDelete.add(String(targetTx.firestoreId));
    if (targetTx.localId) idsToDelete.add(String(targetTx.localId));
    if (targetTx.tempId) idsToDelete.add(String(targetTx.tempId));
    if (targetTx.createdAt) idsToDelete.add(String(targetTx.createdAt));

    // Generar firma única para evitar resurrección en snapshots o reintentos
    const txSig = `${targetTx.type}_${targetTx.amount}_${targetTx.date}_${(targetTx.description || '').trim().toLowerCase()}`;
    recentlyDeletedTxSignatures.add(txSig);
    saveRecentlyDeletedId('txSig', txSig);
  }

  // Marcar como eliminado en memoria y localStorage
  idsToDelete.forEach(id => {
    recentlyDeletedTxIds.add(id);
    saveRecentlyDeletedId('tx', id);
  });

  // 1. Eliminar inmediatamente del estado local de forma síncrona
  if (targetTx) {
    transactions = transactions.filter(t => t !== targetTx && !idsToDelete.has(String(t.id)) && !idsToDelete.has(String(t.firestoreId)) && !idsToDelete.has(String(t.localId)));
  } else {
    transactions = transactions.filter(t => !idsToDelete.has(String(t.id)) && !idsToDelete.has(String(t.firestoreId)) && !idsToDelete.has(String(t.localId)));
  }

  sortTransactionsByDate(transactions);
  localStorage.setItem('finances_v10_trans', JSON.stringify(transactions));
  updateUI();
  showQuickToast('🗑️ Movimiento eliminado');

  // Sincronización automática con Compromisos Fijos / Recurrentes:
  if (targetTx) {
    const isFixed = targetTx.recurringId ||
      (targetTx.description && (targetTx.description.toUpperCase().includes('PAGO FIJO') || targetTx.description.toUpperCase().includes('INGRESO FIJO')));

    if (isFixed) {
      const fixedName = targetTx.recurringName || targetTx.description.replace(/^(PAGO FIJO:|INGRESO FIJO:)\s*/i, '').trim();
      const recItem = recurringPayments.find(r =>
        (targetTx.recurringId && (String(r.id) === String(targetTx.recurringId) || String(r.firestoreId) === String(targetTx.recurringId) || String(r.localId) === String(targetTx.recurringId))) ||
        (r.name && (r.name.toLowerCase() === fixedName.toLowerCase() || fixedName.toLowerCase().includes(r.name.toLowerCase()) || r.name.toLowerCase().includes(fixedName.toLowerCase())))
      );
      if (recItem) {
        recItem.lastPaidMonth = null;
        localStorage.setItem('finances_v10_recurring', JSON.stringify(recurringPayments));
        try {
          await setDoc(doc(db, 'vaults', activeVaultId, 'recurringPayments', recItem.firestoreId || recItem.id), {
            lastPaidMonth: null
          }, { merge: true });
        } catch (e) {
          console.warn('Error restableciendo compromiso fijo en Firestore:', e);
        }
        renderRecurringPayments();
        showQuickToast(`🔄 Pago fijo "${recItem.name}" reabierto como pendiente`);
      }
    }

    // Sincronización automática con Deudas:
    const isAbono = targetTx.debtId || (targetTx.description && targetTx.description.toUpperCase().includes('ABONO A '));
    if (isAbono) {
      const debtItem = debts.find(d =>
        (targetTx.debtId && (String(d.id) === String(targetTx.debtId) || String(d.firestoreId) === String(targetTx.debtId) || String(d.localId) === String(targetTx.debtId))) ||
        (d.name && targetTx.description.toUpperCase().includes(d.name.toUpperCase()))
      );
      if (debtItem) {
        debtItem.paid = Math.max(0, (debtItem.paid || 0) - (targetTx.amount || 0));
        localStorage.setItem('finances_v10_debts', JSON.stringify(debts));
        try {
          await setDoc(doc(db, 'vaults', activeVaultId, 'debts', debtItem.firestoreId || debtItem.id), {
            paid: debtItem.paid
          }, { merge: true });
        } catch (e) {
          console.warn('Error actualizando deuda tras eliminar abono:', e);
        }
        updateUI();
        showQuickToast(`🔄 Saldo de deuda "${debtItem.name}" sincronizado`);
      }
    }
  }

  // 2. Ejecutar borrado en Firestore y caché del servidor en segundo plano sin congelar la interfaz
  (async () => {
    // A. Eliminar por IDs directos
    for (const docId of idsToDelete) {
      if (!docId) continue;
      try {
        await deleteDoc(doc(db, 'vaults', activeVaultId, 'transactions', docId));
      } catch (e) {}
    }

    // B. Notificar al backend Express local para limpiar cache
    try {
      fetch('/api/shortcut/transaction', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: strId,
          type: targetTx?.type,
          amount: targetTx?.amount,
          description: targetTx?.description,
          apiKey: userApiKey,
          vaultId: activeVaultId
        })
      }).catch(() => {});
    } catch (e) {}

    // C. Búsqueda y eliminación profunda en Firestore por id exacto o localId
    if (targetTx) {
      try {
        const txColl = collection(db, 'vaults', activeVaultId, 'transactions');
        const snap = await getDocs(txColl);
        const delPromises = [];
        for (const docSnap of snap.docs) {
          const d = docSnap.data();
          const isTargetDoc = docSnap.id === strId ||
                              docSnap.id === targetTx.firestoreId ||
                              docSnap.id === targetTx.id ||
                              (targetTx.localId && (d.localId === targetTx.localId || d.id === targetTx.localId || docSnap.id === targetTx.localId));
          if (isTargetDoc) {
            recentlyDeletedTxIds.add(docSnap.id);
            saveRecentlyDeletedId('tx', docSnap.id);
            delPromises.push(deleteDoc(docSnap.ref).catch(() => {}));
          }
        }
        await Promise.all(delPromises);
      } catch (qErr) {
        console.warn('Limpieza en segundo plano:', qErr);
      }
    }

    syncClientTotalsToServer();
  })();
};
window.deleteTransaction = window.removeTransaction;

// FORMULARIO DE INGRESO
incomeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (incomeForm.dataset.submitting === 'true') return;

  const dateVal = document.getElementById('income-date').value || getTodayStr();
  const descVal = document.getElementById('income-description').value.trim();
  const amountVal = parseAmount(document.getElementById('income-amount').value);
  const paymentMethodVal = document.getElementById('income-payment-method').value;
  let catVal = document.getElementById('income-category').value;
  if (catVal === 'OTROS') {
    const otherDetail = document.getElementById('income-other-detail').value.trim();
    if (otherDetail) catVal = otherDetail;
  }

  if (!amountVal) return alert('Por favor ingresa un monto válido.');

  incomeForm.dataset.submitting = 'true';
  const submitBtn = incomeForm.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try {
    await addTransactionLocallyOrCloud({
      type: 'income',
      date: dateVal,
      description: descVal,
      amount: amountVal,
      category: catVal,
      paymentMethod: paymentMethodVal
    });

    incomeForm.reset();
    document.getElementById('income-date').value = todayStr;
    document.getElementById('income-other-group').classList.add('hidden');
  } finally {
    incomeForm.dataset.submitting = 'false';
    if (submitBtn) submitBtn.disabled = false;
  }
});

// FORMULARIO DE GASTO
expenseForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (expenseForm.dataset.submitting === 'true') return;

  const dateVal = document.getElementById('expense-date').value || getTodayStr();
  let descVal = document.getElementById('expense-description').value.trim();
  const amountVal = parseAmount(document.getElementById('expense-amount').value);
  const paymentMethodVal = document.getElementById('expense-payment-method').value;
  let catVal = document.getElementById('expense-category').value;
  if (catVal === 'OTROS') {
    const otherDetail = document.getElementById('expense-other-detail').value.trim();
    if (otherDetail) catVal = otherDetail;
  }

  if (!amountVal) return alert('Por favor ingresa un monto válido.');

  // Si es tarjeta de crédito y tiene cuotas seleccionadas
  if (paymentMethodVal === 'TARJETA_CREDITO' && expenseInstallmentsEl) {
    const quotas = expenseInstallmentsEl.value;
    if (quotas && quotas !== '1') {
      descVal += ` (${quotas} Cuotas TC)`;
    }
  }

  expenseForm.dataset.submitting = 'true';
  const submitBtn = expenseForm.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try {
    await addTransactionLocallyOrCloud({
      type: 'expense',
      date: dateVal,
      description: descVal,
      amount: amountVal,
      category: catVal,
      paymentMethod: paymentMethodVal
    });

    expenseForm.reset();
    document.getElementById('expense-date').value = todayStr;
    document.getElementById('expense-other-group').classList.add('hidden');
    updateMediumNotice(expensePaymentMethodEl, expenseMediumNotice, true);
  } finally {
    expenseForm.dataset.submitting = 'false';
    if (submitBtn) submitBtn.disabled = false;
  }
});

// MODAL TRANSFERENCIA / RETIRO A EFECTIVO FÍSICO
if (btnOpenTransferModal && transferModal) {
  btnOpenTransferModal.addEventListener('click', () => {
    transferModal.classList.remove('hidden');
    if (transferDate) transferDate.value = getTodayStr();
  });
}

if (btnCloseTransferModal && transferModal) {
  btnCloseTransferModal.addEventListener('click', () => {
    transferModal.classList.add('hidden');
  });
}

if (transferForm) {
  transferForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (transferForm.dataset.submitting === 'true') return;

    const from = transferFrom.value;
    const to = transferTo.value;
    const amountVal = parseAmount(transferAmount.value);
    const conceptVal = transferConcept.value.trim() || 'Movimiento entre cuentas';
    const dateVal = transferDate.value || getTodayStr();

    if (!amountVal || amountVal <= 0) return alert('Ingresa un monto válido a mover');
    if (from === to) return alert('La cuenta de origen y de destino no pueden ser la misma');

    transferForm.dataset.submitting = 'true';
    const submitBtn = transferForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    try {
      // 1. Salida de la cuenta de origen
      await addTransactionLocallyOrCloud({
        type: 'expense',
        date: dateVal,
        description: `SALIDA A ${to}: ${conceptVal}`,
        amount: amountVal,
        category: 'TRANSFERENCIA INTERNA',
        paymentMethod: from
      });

      // 2. Entrada a la cuenta de destino
      await addTransactionLocallyOrCloud({
        type: 'income',
        date: dateVal,
        description: `ENTRADA DESDE ${from}: ${conceptVal}`,
        amount: amountVal,
        category: 'TRANSFERENCIA INTERNA',
        paymentMethod: to
      });

      transferForm.reset();
      if (transferDate) transferDate.value = getTodayStr();
      transferModal.classList.add('hidden');
      alert(`¡Se movieron ${formatCurrency(amountVal)} de ${from} hacia ${to} exitosamente!`);
    } finally {
      transferForm.dataset.submitting = 'false';
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

// MODAL PAGAR TARJETA DE CRÉDITO
if (btnOpenPayCardModal && payCardModal) {
  btnOpenPayCardModal.addEventListener('click', () => {
    payCardModal.classList.remove('hidden');
    if (payCardDate) payCardDate.value = getTodayStr();

    // Calcular saldo actual de tarjeta de crédito
    let currentCardSpent = 0;
    transactions.forEach(t => {
      if ((t.paymentMethod || '').toUpperCase() === 'TARJETA_CREDITO') {
        if (t.type === 'expense') currentCardSpent += (t.amount || 0);
        else if (t.type === 'income') currentCardSpent -= (t.amount || 0);
      }
    });

    if (payCardCurrentSpent) {
      payCardCurrentSpent.textContent = `Saldo Gastado por Pagar: ${formatCurrency(Math.max(0, currentCardSpent))}`;
    }
    if (payCardAmount && currentCardSpent > 0) {
      payCardAmount.value = new Intl.NumberFormat('es-CO').format(currentCardSpent);
    }
  });
}

if (btnClosePayCardModal && payCardModal) {
  btnClosePayCardModal.addEventListener('click', () => {
    payCardModal.classList.add('hidden');
  });
}

if (payCardForm) {
  payCardForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (payCardForm.dataset.submitting === 'true') return;

    const amountVal = parseAmount(payCardAmount.value);
    const sourceAcc = payCardSource.value;
    const dateVal = payCardDate.value || getTodayStr();

    if (!amountVal || amountVal <= 0) return alert('Ingresa un monto válido a pagar');

    payCardForm.dataset.submitting = 'true';
    const submitBtn = payCardForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    try {
      // 1. Salida de la cuenta que paga (Banco, Nequi, etc.)
      await addTransactionLocallyOrCloud({
        type: 'expense',
        date: dateVal,
        description: `PAGO DE TARJETA DE CRÉDITO (Desde ${sourceAcc})`,
        amount: amountVal,
        category: 'PAGO DE DEUDAS',
        paymentMethod: sourceAcc
      });

      // 2. Abono que liquida el saldo de la tarjeta de crédito
      await addTransactionLocallyOrCloud({
        type: 'income',
        date: dateVal,
        description: `ABONO / LIQUIDACIÓN TARJETA DE CRÉDITO`,
        amount: amountVal,
        category: 'PAGO DE DEUDAS',
        paymentMethod: 'TARJETA_CREDITO'
      });

      payCardForm.reset();
      payCardModal.classList.add('hidden');
      alert(`¡Pago de ${formatCurrency(amountVal)} a tu Tarjeta de Crédito registrado con éxito!`);
    } finally {
      payCardForm.dataset.submitting = 'false';
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

// FORMULARIO DE CREAR DEUDA / OBLIGACIÓN (DEBO vs ME DEBEN)
debtForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (debtForm.dataset.submitting === 'true') return;

  const typeVal = document.getElementById('debt-type')?.value || 'debt_payable';
  const nameVal = document.getElementById('debt-name').value.trim();
  const totalVal = parseAmount(document.getElementById('debt-total').value);
  const interestVal = parseFloat(document.getElementById('debt-interest').value) || 0;
  const installmentsVal = parseInt(document.getElementById('debt-installments').value) || 1;
  const frequencyVal = document.getElementById('debt-frequency')?.value || 'mensual';
  const methodVal = document.getElementById('debt-method')?.value || 'BANCO';
  const startDateVal = document.getElementById('debt-start-date').value || getTodayStr();

  if (!totalVal) return alert('Por favor ingresa un monto válido.');

  // Prevenir duplicación inmediata por doble toque o ráfaga (<15s)
  const isDuplicate = debts.some(d => 
    d.type === typeVal &&
    (d.name || '').trim().toLowerCase() === nameVal.toLowerCase() &&
    Math.abs((d.total || 0) - totalVal) < 0.01 &&
    Math.abs(new Date(d.createdAt || 0).getTime() - Date.now()) < 15000
  );
  if (isDuplicate) return;

  debtForm.dataset.submitting = 'true';
  const submitBtn = debtForm.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const localId = 'debt_' + Date.now();
    const debtData = {
      id: localId,
      localId: localId,
      tempId: localId,
      firestoreId: localId,
      type: typeVal, // 'debt_payable' | 'debt_receivable'
      name: nameVal,
      total: totalVal,
      paid: 0,
      interest: interestVal,
      installments: installmentsVal,
      frequency: frequencyVal,
      method: methodVal,
      paymentMethod: methodVal,
      startDate: startDateVal,
      history: JSON.stringify([]),
      createdAt: new Date().toISOString()
    };

    debts.push(debtData);
    debts = deduplicateDebts(debts);
    localStorage.setItem('finances_v10_debts', JSON.stringify(debts));
    updateUI();

    const successMsg = typeVal === 'debt_receivable'
      ? `✅ Dinero por cobrar "${debtData.name}" registrado correctamente`
      : `✅ Deuda por pagar "${debtData.name}" registrada correctamente`;
    showQuickToast(successMsg);

    try {
      const debtsColl = collection(db, 'vaults', activeVaultId, 'debts');
      const docRef = await addDoc(debtsColl, {
        vaultId: activeVaultId,
        ...debtData
      });
      debtData.firestoreId = docRef.id;
      debtData.id = docRef.id;
      debts = deduplicateDebts(debts);
      localStorage.setItem('finances_v10_debts', JSON.stringify(debts));
      updateUI();
    } catch (e) {
      console.warn('Deuda guardada localmente (pendiente de sync a la nube):', e);
    }

    debtForm.reset();
    setDebtType('debt_payable');
    document.getElementById('debt-start-date').value = todayStr;
    syncClientTotalsToServer();
  } finally {
    debtForm.dataset.submitting = 'false';
    if (submitBtn) submitBtn.disabled = false;
  }
});

// FORMULARIO DE CREAR META DE AHORRO
if (goalForm) {
  goalForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (goalForm.dataset.submitting === 'true') return;

    const nameVal = document.getElementById('goal-name').value.trim();
    const targetVal = parseAmount(document.getElementById('goal-target').value);
    const initialVal = parseAmount(document.getElementById('goal-initial').value) || 0;
    const sourceAcc = document.getElementById('goal-source-account')?.value || 'EFECTIVO';
    const iconVal = document.getElementById('goal-icon')?.value || '🎯';
    const dateVal = document.getElementById('goal-date')?.value || '';

    if (!targetVal || targetVal <= 0) return alert('Ingresa un monto objetivo válido');

    // Prevenir duplicación inmediata por doble toque (<15s)
    const isDuplicate = savingsGoals.some(g => 
      (g.name || '').trim().toLowerCase() === nameVal.toLowerCase() &&
      Math.abs((g.targetAmount || 0) - targetVal) < 0.01 &&
      Math.abs(new Date(g.createdAt || 0).getTime() - Date.now()) < 15000
    );
    if (isDuplicate) return;

    goalForm.dataset.submitting = 'true';
    const submitBtn = goalForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    try {
      const localId = 'goal_' + Date.now();
      const goalData = {
        id: localId,
        localId: localId,
        tempId: localId,
        firestoreId: localId,
        name: nameVal,
        targetAmount: targetVal,
        currentAmount: initialVal,
        targetDate: dateVal,
        icon: iconVal,
        createdAt: new Date().toISOString()
      };

      savingsGoals.push(goalData);
      savingsGoals = deduplicateGoals(savingsGoals);
      localStorage.setItem('finances_v10_goals', JSON.stringify(savingsGoals));
      renderSavingsGoals();
      showQuickToast(`🎯 Meta "${goalData.name}" creada exitosamente`);

      try {
        const gColl = collection(db, 'vaults', activeVaultId, 'savingsGoals');
        const docRef = await addDoc(gColl, {
          vaultId: activeVaultId,
          ...goalData
        });
        goalData.firestoreId = docRef.id;
        goalData.id = docRef.id;
        savingsGoals = deduplicateGoals(savingsGoals);
        localStorage.setItem('finances_v10_goals', JSON.stringify(savingsGoals));
        renderSavingsGoals();
      } catch (e) {
        console.warn('Meta guardada localmente (pendiente de sync a la nube):', e);
      }

      goalForm.reset();
      document.getElementById('goal-initial').value = '0';
      if (goalIconPreview) goalIconPreview.textContent = '🎯';
      if (goalIconInput) goalIconInput.value = '🎯';
      if (goalCustomEmojiInput) goalCustomEmojiInput.value = '';
      if (goalEmojiPicker) {
        goalEmojiPicker.querySelectorAll('.goal-emoji-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.emoji === '🎯');
        });
      }
    } finally {
      goalForm.dataset.submitting = 'false';
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

// FORMULARIO DE CREAR PAGO FIJO / RECURRENTE
if (recurringForm) {
  recurringForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (recurringForm.dataset.submitting === 'true') return;

    const nameVal = document.getElementById('rec-name').value.trim();
    const typeVal = document.getElementById('rec-type').value;
    const amountVal = parseAmount(document.getElementById('rec-amount').value);
    const freqVal = document.getElementById('rec-frequency').value;
    const catVal = document.getElementById('rec-category').value;
    const methodVal = document.getElementById('rec-method').value;

    if (!amountVal || amountVal <= 0) return alert('Ingresa un monto válido');

    let dayVal = 5;
    let weekdayVal = null;
    let quincenaDaysVal = null;
    let annualMonthVal = null;

    if (freqVal === 'semanal') {
      weekdayVal = parseInt(document.getElementById('rec-weekday')?.value, 10) || 5;
      dayVal = weekdayVal + 1; // 1-7, cumple validación numérica de 1-31
    } else if (freqVal === 'quincenal') {
      const qScheme = document.getElementById('rec-quincena-scheme')?.value || '15,30';
      if (qScheme === 'custom') {
        const d1 = parseInt(document.getElementById('rec-quincena-day1')?.value, 10) || 15;
        const d2 = parseInt(document.getElementById('rec-quincena-day2')?.value, 10) || 30;
        quincenaDaysVal = `${d1},${d2}`;
        dayVal = d1;
      } else {
        quincenaDaysVal = qScheme;
        dayVal = parseInt(qScheme.split(',')[0], 10) || 15;
      }
    } else if (freqVal === 'anual') {
      annualMonthVal = parseInt(document.getElementById('rec-annual-month')?.value, 10) || 12;
      dayVal = parseInt(document.getElementById('rec-annual-day')?.value, 10) || 15;
    } else {
      // mensual
      dayVal = parseInt(document.getElementById('rec-day')?.value, 10) || 5;
    }

    // Prevenir duplicación inmediata por doble toque (<15s)
    const isDuplicate = recurringPayments.some(r => 
      r.type === typeVal &&
      (r.name || '').trim().toLowerCase() === nameVal.toLowerCase() &&
      Math.abs((r.amount || 0) - amountVal) < 0.01 &&
      Math.abs(new Date(r.createdAt || 0).getTime() - Date.now()) < 15000
    );
    if (isDuplicate) return;

    recurringForm.dataset.submitting = 'true';
    const submitBtn = recurringForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    try {
      const localId = 'rec_' + Date.now();
      const rData = {
        id: localId,
        localId: localId,
        tempId: localId,
        firestoreId: localId,
        name: nameVal,
        type: typeVal,
        amount: amountVal,
        frequency: freqVal,
        dueDay: dayVal,
        dueWeekday: weekdayVal,
        dueQuincenaDays: quincenaDaysVal,
        dueMonth: annualMonthVal,
        category: catVal,
        paymentMethod: methodVal,
        lastPaidMonth: '',
        paidPeriods: [],
        createdAt: new Date().toISOString()
      };

      recurringPayments.push(rData);
      recurringPayments = deduplicateRecurring(recurringPayments);
      localStorage.setItem('finances_v10_recurring', JSON.stringify(recurringPayments));
      renderRecurringPayments();
      showQuickToast(`✅ Registro fijo "${rData.name}" guardado`);

      try {
        const rColl = collection(db, 'vaults', activeVaultId, 'recurringPayments');
        const docRef = await addDoc(rColl, {
          vaultId: activeVaultId,
          ...rData
        });
        rData.firestoreId = docRef.id;
        rData.id = docRef.id;
        recurringPayments = deduplicateRecurring(recurringPayments);
        localStorage.setItem('finances_v10_recurring', JSON.stringify(recurringPayments));
        renderRecurringPayments();
      } catch (e) {
        console.warn('Registro fijo guardado localmente (pendiente de sync):', e);
      }

      recurringForm.reset();
      updateRecScheduleFields(false);
      setRecurringType('expense');
    } finally {
      recurringForm.dataset.submitting = 'false';
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

// RENDER METAS DE AHORRO
function renderSavingsGoals() {
  if (!goalsContainer) return;

  let totalSavedInGoals = 0;
  if (savingsGoals.length === 0) {
    goalsContainer.innerHTML = '<p style="color: var(--text-muted); font-size: 0.82rem; grid-column: 1/-1;">No tienes metas creadas aún. ¡Crea tu primer bolsillo a la izquierda!</p>';
    if (goalsSummaryBadge) goalsSummaryBadge.textContent = 'Total Ahorrado: $ 0';
    const accGoalsEl = document.getElementById('acc-goals-total');
    if (accGoalsEl) accGoalsEl.textContent = '$ 0';
    return;
  }

  goalsContainer.innerHTML = '';
  savingsGoals.forEach((g) => {
    totalSavedInGoals += (g.currentAmount || 0);
    const percent = Math.min(100, Math.round(((g.currentAmount || 0) / (g.targetAmount || 1)) * 100));
    const isCompleted = (g.currentAmount || 0) >= (g.targetAmount || 1);
    const goalIdentifier = `'${g.id}'`;

    let projectionHtml = '';
    if (isCompleted) {
      projectionHtml = '<div style="margin-top: 4px;"><span class="goal-completed-badge">🎉 ¡META CUMPLIDA! (100%)</span></div>';
    } else if (g.targetDate) {
      const today = getTodayStr();
      const diffTime = new Date(g.targetDate).getTime() - new Date(today).getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      const remainingAmt = Math.max(0, g.targetAmount - g.currentAmount);
      if (diffDays > 0) {
        const monthsLeft = Math.max(1, Math.round(diffDays / 30));
        const suggestedMonthly = Math.ceil(remainingAmt / monthsLeft);
        projectionHtml = `<div class="goal-projection">💡 Falta ${formatCurrency(remainingAmt)} (${diffDays} días). Aporte sugerido: <strong>${formatCurrency(suggestedMonthly)}/mes</strong></div>`;
      } else {
        projectionHtml = `<div class="goal-projection" style="color: var(--warning-color); background: rgba(245, 158, 11, 0.1);">⚠️ Fecha límite cumplida (${formatDateDisplay(g.targetDate)}). Falta ${formatCurrency(remainingAmt)}.</div>`;
      }
    }

    const card = document.createElement('div');
    card.className = 'goal-card';
    card.innerHTML = `
      <div class="goal-header">
        <div class="goal-title-wrap">
          <div class="goal-icon">${g.icon || '🎯'}</div>
          <div>
            <div class="goal-name">${g.name}</div>
            <div class="goal-deadline">${g.targetDate ? 'Fecha meta: ' + formatDateDisplay(g.targetDate) : 'Sin fecha límite'}</div>
          </div>
        </div>
        <button class="btn-delete" onclick="deleteSavingsGoal(${goalIdentifier})" title="Eliminar">&times;</button>
      </div>

      <div class="goal-amounts">
        <span class="goal-current">${formatCurrency(g.currentAmount)}</span>
        <span class="goal-target">de ${formatCurrency(g.targetAmount)} (${percent}%)</span>
      </div>

      <div class="goal-progress-wrap">
        <div class="goal-progress-bar">
          <div class="goal-progress-fill" style="width: ${percent}%;"></div>
        </div>
      </div>

      ${projectionHtml}

      <div class="goal-actions">
        <button class="goal-btn goal-btn-deposit" onclick="openGoalModal(${goalIdentifier}, 'deposit')">
          ➕ Depositar
        </button>
        <button class="goal-btn goal-btn-withdraw" onclick="openGoalModal(${goalIdentifier}, 'withdraw')">
          ➖ Retirar
        </button>
      </div>
    `;
    goalsContainer.appendChild(card);
  });

  if (goalsSummaryBadge) {
    goalsSummaryBadge.textContent = `Total Ahorrado: ${formatCurrency(totalSavedInGoals)}`;
  }
  const accGoalsEl = document.getElementById('acc-goals-total');
  if (accGoalsEl) {
    accGoalsEl.textContent = formatCurrency(totalSavedInGoals);
  }
}

// GESTION MODAL METAS (DEPOSITAR O RETIRAR)
window.openGoalModal = function(idOrIndex, action) {
  const strId = String(idOrIndex);
  const targetGoal = savingsGoals.find(g => String(g.id) === strId || String(g.firestoreId) === strId) || savingsGoals[parseInt(idOrIndex, 10)];
  if (!targetGoal) return;

  modalGoalId.value = targetGoal.id;
  modalGoalAction.value = action;
  modalGoalIcon.textContent = targetGoal.icon || '🎯';
  modalGoalSubtitle.textContent = `Meta: ${targetGoal.name} (Actual: ${formatCurrency(targetGoal.currentAmount)})`;
  modalGoalAmount.value = '';

  if (action === 'deposit') {
    modalGoalTitle.textContent = 'Abonar Ahorro a la Meta';
    modalGoalAmountLabel.textContent = 'Monto a Depositar ($ COP)';
    modalGoalSubmitBtn.textContent = 'Confirmar Abono';
    modalGoalSubmitBtn.className = 'btn btn-success';
  } else {
    modalGoalTitle.textContent = 'Retirar Dinero de la Meta';
    modalGoalAmountLabel.textContent = 'Monto a Retirar ($ COP)';
    modalGoalSubmitBtn.textContent = 'Confirmar Retiro';
    modalGoalSubmitBtn.className = 'btn btn-danger';
  }

  goalActionModal.classList.remove('hidden');
};

if (btnCloseGoalModal) {
  btnCloseGoalModal.addEventListener('click', () => {
    goalActionModal.classList.add('hidden');
  });
}

if (goalActionForm) {
  goalActionForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (goalActionForm.dataset.submitting === 'true') return;

    const gId = modalGoalId.value;
    const action = modalGoalAction.value;
    const amountVal = parseAmount(modalGoalAmount.value);

    if (!amountVal || amountVal <= 0) return alert('Ingresa un monto válido');

    let targetGoal = savingsGoals.find(g => String(g.id) === String(gId) || String(g.firestoreId) === String(gId));
    if (!targetGoal) return;

    if (action === 'withdraw' && amountVal > targetGoal.currentAmount) {
      return alert(`No puedes retirar más de lo que tienes ahorrado ($ ${formatCurrency(targetGoal.currentAmount)})`);
    }

    goalActionForm.dataset.submitting = 'true';
    if (modalGoalSubmitBtn) modalGoalSubmitBtn.disabled = true;

    try {
      const newAmount = action === 'deposit'
        ? targetGoal.currentAmount + amountVal
        : targetGoal.currentAmount - amountVal;

      // Actualización inmediata del ahorro en meta (sin contaminar ingresos/gastos corrientes)
      targetGoal.currentAmount = newAmount;
      savingsGoals = deduplicateGoals(savingsGoals);
      localStorage.setItem('finances_v10_goals', JSON.stringify(savingsGoals));
      renderSavingsGoals();
      updateUI();
      showQuickToast(`🎯 ${action === 'deposit' ? 'Abono a' : 'Retiro de'} "${targetGoal.name}": ${formatCurrency(amountVal)}`);

      try {
        const docId = targetGoal.firestoreId || targetGoal.id;
        await setDoc(doc(db, 'vaults', activeVaultId, 'savingsGoals', docId), {
          vaultId: activeVaultId,
          ...targetGoal,
          currentAmount: newAmount
        }, { merge: true });
      } catch (err) {
        console.warn('Error actualizando meta en Firestore:', err);
      }

      goalActionModal.classList.add('hidden');
    } finally {
      goalActionForm.dataset.submitting = 'false';
      if (modalGoalSubmitBtn) modalGoalSubmitBtn.disabled = false;
    }
  });
}

window.deleteSavingsGoal = async function(idOrIndex) {
  const strId = String(idOrIndex).trim();
  let targetGoal = savingsGoals.find(g => 
    g && (
      String(g.id) === strId ||
      String(g.firestoreId) === strId ||
      String(g.localId) === strId ||
      String(g.tempId) === strId ||
      (g.createdAt && String(g.createdAt) === strId)
    )
  );
  if (!targetGoal && !isNaN(parseInt(idOrIndex, 10)) && savingsGoals[parseInt(idOrIndex, 10)]) {
    targetGoal = savingsGoals[parseInt(idOrIndex, 10)];
  }

  const goalName = targetGoal ? targetGoal.name : 'esta meta';
  const currentAmt = targetGoal ? (targetGoal.currentAmount || 0) : 0;
  const msg = currentAmt > 0
    ? `¿Deseas eliminar la meta "${goalName}"?\nLos $ ${formatCurrency(currentAmt)} ahorrados se liberarán de esta meta.`
    : `¿Deseas eliminar la meta de ahorro "${goalName}"?`;

  const confirmed = await appConfirm(msg, {
    title: 'Eliminar Meta de Ahorro',
    icon: '🎯',
    okText: 'Eliminar Meta',
    isDanger: true
  });
  if (!confirmed) return;

  const idsToDelete = new Set();
  idsToDelete.add(strId);
  if (targetGoal) {
    if (targetGoal.id) idsToDelete.add(String(targetGoal.id));
    if (targetGoal.firestoreId) idsToDelete.add(String(targetGoal.firestoreId));
    if (targetGoal.localId) idsToDelete.add(String(targetGoal.localId));
    if (targetGoal.tempId) idsToDelete.add(String(targetGoal.tempId));
    if (targetGoal.createdAt) idsToDelete.add(String(targetGoal.createdAt));
    if (targetGoal.name) {
      idsToDelete.add(String(targetGoal.name));
      idsToDelete.add(`sig_goal_${targetGoal.name}`);
    }
  }

  idsToDelete.forEach(id => {
    recentlyDeletedGoalIds.add(id);
    saveRecentlyDeletedId('goal', id);
  });

  if (targetGoal) {
    savingsGoals = savingsGoals.filter(g => g !== targetGoal && !idsToDelete.has(String(g.id)) && !idsToDelete.has(String(g.firestoreId)) && !idsToDelete.has(String(g.localId)));
  } else {
    savingsGoals = savingsGoals.filter(g => !idsToDelete.has(String(g.id)) && !idsToDelete.has(String(g.firestoreId)) && !idsToDelete.has(String(g.localId)));
  }
  localStorage.setItem('finances_v10_goals', JSON.stringify(savingsGoals));

  // Limpiar cualquier movimiento legacy de esta meta para no duplicar datos
  if (targetGoal && targetGoal.name) {
    transactions = transactions.filter(t => !t.description || (!t.description.includes(`META: ${targetGoal.name}`) && !t.description.includes(`META ${targetGoal.name}`)));
    localStorage.setItem('finances_v10_trans', JSON.stringify(transactions));
  }

  renderSavingsGoals();
  updateUI();
  showQuickToast(`🗑️ Meta "${goalName}" eliminada`);

  for (const docId of idsToDelete) {
    if (!docId || docId.startsWith('sig_')) continue;
    try {
      await deleteDoc(doc(db, 'vaults', activeVaultId, 'savingsGoals', docId));
    } catch (e) {
      console.warn('Nota eliminando meta en Firestore:', docId, e);
    }
  }

  if (targetGoal) {
    try {
      const gColl = collection(db, 'vaults', activeVaultId, 'savingsGoals');
      const snap = await getDocs(gColl);
      for (const docSnap of snap.docs) {
        const d = docSnap.data();
        const isMatch = (targetGoal.localId && (d.localId === targetGoal.localId || d.id === targetGoal.localId)) ||
                        (targetGoal.name && d.name === targetGoal.name);
        if (isMatch) {
          recentlyDeletedGoalIds.add(docSnap.id);
          saveRecentlyDeletedId('goal', docSnap.id);
          try { await deleteDoc(docSnap.ref); } catch (delErr) {}
        }
      }
    } catch (qErr) {
      console.warn('Verificación en Firestore tras eliminar meta:', qErr);
    }
  }
  syncClientTotalsToServer();
};
window.deleteGoal = window.deleteSavingsGoal;
window.removeGoal = window.deleteSavingsGoal;

// RENDER FINANZAS FIJAS & RECURRENTES (INGRESOS Y GASTOS FIJOS)
function renderRecurringPayments() {
  if (!recurringContainer) return;

  const currentYM = getCurrentYearMonth();
  const currentYear = currentYM.substring(0, 4);
  let totalFixedExpenses = 0;
  let totalFixedIncomes = 0;

  recurringPayments.forEach(r => {
    const monthlyAmt = getRecurringMonthlyAmount(r);
    if (r.type === 'income') totalFixedIncomes += monthlyAmt;
    else totalFixedExpenses += monthlyAmt;
  });

  const netFixedFlow = totalFixedIncomes - totalFixedExpenses;
  const recTotalIncomeEl = document.getElementById('recurring-total-income');
  const recTotalExpenseEl = document.getElementById('recurring-total-expense');
  const recNetBalanceEl = document.getElementById('recurring-net-balance');

  if (recTotalIncomeEl) recTotalIncomeEl.textContent = `${formatCurrency(totalFixedIncomes)}/mes`;
  if (recTotalExpenseEl) recTotalExpenseEl.textContent = `${formatCurrency(totalFixedExpenses)}/mes`;
  if (recNetBalanceEl) {
    recNetBalanceEl.textContent = `${formatCurrency(netFixedFlow)}/mes`;
    recNetBalanceEl.className = `kpi-value ${netFixedFlow >= 0 ? 'text-primary' : 'text-danger'}`;
  }

  const filteredItems = recurringPayments.filter(r => {
    if (activeRecurringFilter === 'income') return r.type === 'income';
    if (activeRecurringFilter === 'expense') return r.type !== 'income';
    return true;
  });

  if (filteredItems.length === 0) {
    recurringContainer.innerHTML = '<p style="color: var(--text-muted); font-size: 0.82rem; grid-column: 1/-1;">No tienes finanzas fijas en esta categoría aún.</p>';
    if (recurringSummaryBadge) recurringSummaryBadge.textContent = `${recurringPayments.length} Registros`;
    return;
  }

  recurringContainer.innerHTML = '';
  filteredItems.forEach((r) => {
    const isIncome = r.type === 'income';
    const freq = (r.frequency || 'mensual').toLowerCase();
    const rIdentifier = `'${r.id}'`;

    // Obtener transacciones relacionadas a este compromiso
    const matchingTxs = transactions.filter(t => {
      if (!t.date) return false;
      if (t.recurringId && (String(t.recurringId) === String(r.id) || String(t.recurringId) === String(r.firestoreId) || String(t.recurringId) === String(r.localId))) {
        return true;
      }
      const desc = (t.description || '').toLowerCase();
      const expectedDesc = `${isIncome ? 'INGRESO FIJO' : 'PAGO FIJO'}: ${r.name}`.toLowerCase();
      return desc.startsWith(expectedDesc) || (r.name && desc.includes(r.name.toLowerCase()) && (desc.includes('fijo') || desc.includes('recurrente')));
    });

    const txsThisMonth = matchingTxs.filter(t => t.date && t.date.startsWith(currentYM));
    const txsThisYear = matchingTxs.filter(t => t.date && t.date.startsWith(currentYear));

    // Determinar estado, badge y botones de acción según la periodicidad
    let statusBadgeHtml = '';
    let actionBtnHtml = '';
    let cardClass = 'pending';

    if (freq === 'quincenal') {
      const paidCount = txsThisMonth.length;
      if (paidCount === 0) {
        cardClass = 'pending';
        statusBadgeHtml = `<span class="tag-badge text-warning">⏳ Pendiente este mes (0/2 quincenas)</span>`;
        actionBtnHtml = `
          <button class="btn-quick-pay" style="${isIncome ? 'background: var(--success-color);' : ''}" onclick="openRecurringPayModal(${rIdentifier})">
            ${isIncome ? '⚡ Cobrar 1ª Quincena' : '⚡ Pagar 1ª Quincena'}
          </button>
        `;
      } else if (paidCount === 1) {
        cardClass = 'pending';
        statusBadgeHtml = `<span class="tag-badge" style="background: rgba(10, 132, 255, 0.12); color: #0a84ff; border: 1px solid rgba(10, 132, 255, 0.25);">⚡ 1/2 Quincena registrada</span>`;
        actionBtnHtml = `
          <button class="btn-quick-pay" style="${isIncome ? 'background: var(--success-color);' : ''}" onclick="openRecurringPayModal(${rIdentifier})">
            ${isIncome ? '⚡ Cobrar 2ª Quincena' : '⚡ Pagar 2ª Quincena'}
          </button>
        `;
      } else {
        cardClass = 'paid';
        statusBadgeHtml = `<span class="tag-badge text-success">✓ Al día este mes (${paidCount}/2 quincenas)</span>`;
        actionBtnHtml = `
          <button class="btn-quick-pay" style="background: rgba(48, 209, 88, 0.14); color: var(--success-color); border: 1px solid rgba(48, 209, 88, 0.35);" onclick="openRecurringPayModal(${rIdentifier})" title="Registrar quincena adicional o extraordinaria">
            ✓ Al día (+ Registrar)
          </button>
        `;
      }
    } else if (freq === 'semanal') {
      const paidCount = txsThisMonth.length;
      if (paidCount === 0) {
        cardClass = 'pending';
        statusBadgeHtml = `<span class="tag-badge text-warning">⏳ Pendiente este mes (0 semanas)</span>`;
      } else {
        cardClass = 'paid';
        statusBadgeHtml = `<span class="tag-badge text-success">⚡ ${paidCount} ${paidCount === 1 ? 'semana registrada' : 'semanas registradas'}</span>`;
      }
      // Para semanal, el botón SIEMPRE permite cobrar/pagar más de una vez
      actionBtnHtml = `
        <button class="btn-quick-pay" style="${isIncome ? 'background: var(--success-color);' : ''}" onclick="openRecurringPayModal(${rIdentifier})">
          ${isIncome ? '⚡ Cobrar Semana' : '⚡ Pagar Semana'} (${paidCount + 1}ª)
        </button>
      `;
    } else if (freq === 'anual') {
      const isPaidYear = txsThisYear.length > 0;
      if (isPaidYear) {
        cardClass = 'paid';
        statusBadgeHtml = `<span class="tag-badge text-success">✓ Pagado año ${currentYear}</span>`;
        actionBtnHtml = `<small style="color: var(--text-muted); font-size: 0.7rem;">✓ Al día año ${currentYear}</small>`;
      } else {
        cardClass = 'pending';
        statusBadgeHtml = `<span class="tag-badge text-warning">⏳ Pendiente año ${currentYear}</span>`;
        actionBtnHtml = `
          <button class="btn-quick-pay" style="${isIncome ? 'background: var(--success-color);' : ''}" onclick="openRecurringPayModal(${rIdentifier})">
            ${isIncome ? '⚡ Cobrar Anual' : '⚡ Pagar Anual'}
          </button>
        `;
      }
    } else {
      // Mensual
      const isPaidMonth = txsThisMonth.length > 0;
      if (isPaidMonth) {
        cardClass = 'paid';
        statusBadgeHtml = `<span class="tag-badge text-success">✓ ${isIncome ? 'Cobrado este mes' : 'Pagado este mes'}</span>`;
        actionBtnHtml = `
          <button class="btn-quick-pay" style="background: rgba(120, 120, 128, 0.15); color: var(--text-muted); border: 1px solid var(--border-color); font-size: 0.7rem; padding: 4px 10px;" onclick="openRecurringPayModal(${rIdentifier})" title="Registrar otro cobro o pago de este mes">
            ✓ Pagado (+ Otro)
          </button>
        `;
      } else {
        cardClass = 'pending';
        statusBadgeHtml = `<span class="tag-badge text-warning">⏳ ${isIncome ? 'Pendiente por cobrar' : 'Pendiente este mes'}</span>`;
        actionBtnHtml = `
          <button class="btn-quick-pay" style="${isIncome ? 'background: var(--success-color);' : ''}" onclick="openRecurringPayModal(${rIdentifier})">
            ${isIncome ? '⚡ Cobrar / Registrar Ingreso' : '⚡ Pagar / Registrar Gasto'}
          </button>
        `;
      }
    }

    const scheduleLabel = formatRecurringSchedule(r);

    const card = document.createElement('div');
    card.className = `recurring-card ${cardClass}`;
    card.innerHTML = `
      <div class="recurring-top">
        <div>
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
            <span class="tag-badge ${isIncome ? 'text-success' : 'text-danger'}">
              ${isIncome ? '🟢 INGRESO FIJO (Sueldo/Entrada)' : '🔴 GASTO FIJO / SUSCRIPCIÓN'}
            </span>
          </div>
          <div class="recurring-name">${r.name}</div>
          <div class="recurring-meta" style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 4px;">
            <span>🗓️ ${scheduleLabel}</span> &bull;
            <span>${r.category}</span> &bull;
            <select class="tag-badge-select" onchange="changeRecurringMethod(${rIdentifier}, this.value)" title="Cambiar método de pago habitual">
              <option value="NEQUI" ${(r.paymentMethod||'NEQUI')==='NEQUI'?'selected':''}>🟣 Nequi</option>
              <option value="DAVIPLATA" ${(r.paymentMethod||'')==='DAVIPLATA'?'selected':''}>🔴 Daviplata</option>
              <option value="BANCO" ${(r.paymentMethod||'')==='BANCO'?'selected':''}>🏦 Banco</option>
              <option value="EFECTIVO" ${(r.paymentMethod||'')==='EFECTIVO'?'selected':''}>💵 Efectivo</option>
              <option value="TARJETA_DEBITO" ${(r.paymentMethod||'')==='TARJETA_DEBITO'?'selected':''}>💳 Débito</option>
              <option value="TARJETA_CREDITO" ${(r.paymentMethod||'')==='TARJETA_CREDITO'?'selected':''}>💳 Crédito</option>
              <option value="OTRO" ${(r.paymentMethod||'')==='OTRO'?'selected':''}>⚙️ Otro</option>
            </select> &bull;
            <select class="tag-badge-select" onchange="changeRecurringFrequency(${rIdentifier}, this.value)" title="Cambiar frecuencia">
              <option value="mensual" ${(r.frequency||'mensual').toLowerCase()==='mensual'?'selected':''}>🗓️ Mensual</option>
              <option value="quincenal" ${(r.frequency||'').toLowerCase()==='quincenal'?'selected':''}>🗓️ Quincenal</option>
              <option value="semanal" ${(r.frequency||'').toLowerCase()==='semanal'?'selected':''}>🗓️ Semanal</option>
              <option value="anual" ${(r.frequency||'').toLowerCase()==='anual'?'selected':''}>🗓️ Anual</option>
            </select>
          </div>
        </div>
        <div style="display: flex; gap: 6px; align-items: center;">
          <button class="btn-edit" onclick="openEditRecurringModal(${rIdentifier})" title="Editar finanza fija" aria-label="Editar">&#9998;</button>
          <button class="btn-delete" onclick="deleteRecurringPayment(${rIdentifier})" title="Eliminar" aria-label="Eliminar">&times;</button>
        </div>
      </div>

      <div class="recurring-amount ${isIncome ? 'text-success' : 'text-danger'}">
        ${formatCurrency(r.amount)} <small style="font-size: 0.72rem; color: var(--text-muted); font-weight: normal;">/ ${(r.frequency || 'mensual').toLowerCase()}</small>
      </div>

      <div class="recurring-footer">
        <div>
          ${statusBadgeHtml}
        </div>
        ${actionBtnHtml}
      </div>
    `;
    recurringContainer.appendChild(card);
  });

  if (recurringSummaryBadge) {
    recurringSummaryBadge.textContent = `${recurringPayments.length} Registros Activos`;
  }
}

window.quickPayRecurring = function(idOrIndex) {
  window.openRecurringPayModal(idOrIndex);
};

window.deleteRecurringPayment = async function(idOrIndex) {
  const strId = String(idOrIndex).trim();
  let targetR = recurringPayments.find(r => 
    r && (
      String(r.id) === strId ||
      String(r.firestoreId) === strId ||
      String(r.localId) === strId ||
      String(r.tempId) === strId ||
      (r.createdAt && String(r.createdAt) === strId)
    )
  );
  if (!targetR && !isNaN(parseInt(idOrIndex, 10)) && recurringPayments[parseInt(idOrIndex, 10)]) {
    targetR = recurringPayments[parseInt(idOrIndex, 10)];
  }

  const rName = targetR ? targetR.name : 'este registro';
  const confirmed = await appConfirm(`¿Deseas eliminar el compromiso recurrente "${rName}"?`, {
    title: 'Eliminar Finanza Fija',
    icon: '🔄',
    okText: 'Eliminar Registro',
    isDanger: true
  });
  if (!confirmed) return;

  const idsToDelete = new Set();
  idsToDelete.add(strId);
  if (targetR) {
    if (targetR.id) idsToDelete.add(String(targetR.id));
    if (targetR.firestoreId) idsToDelete.add(String(targetR.firestoreId));
    if (targetR.localId) idsToDelete.add(String(targetR.localId));
    if (targetR.tempId) idsToDelete.add(String(targetR.tempId));
    if (targetR.createdAt) idsToDelete.add(String(targetR.createdAt));
    if (targetR.name) idsToDelete.add(String(targetR.name));
  }

  idsToDelete.forEach(id => {
    recentlyDeletedRecurringIds.add(id);
    saveRecentlyDeletedId('recurring', id);
  });

  if (targetR) {
    recurringPayments = recurringPayments.filter(r => r !== targetR && !idsToDelete.has(String(r.id)) && !idsToDelete.has(String(r.firestoreId)) && !idsToDelete.has(String(r.localId)));
  } else {
    recurringPayments = recurringPayments.filter(r => !idsToDelete.has(String(r.id)) && !idsToDelete.has(String(r.firestoreId)) && !idsToDelete.has(String(r.localId)));
  }
  localStorage.setItem('finances_v10_recurring', JSON.stringify(recurringPayments));
  renderRecurringPayments();
  showQuickToast(`🗑️ "${rName}" eliminado`);

  for (const docId of idsToDelete) {
    if (!docId) continue;
    try {
      await deleteDoc(doc(db, 'vaults', activeVaultId, 'recurringPayments', docId));
    } catch (e) {
      console.warn('Nota eliminando compromiso fijo en Firestore:', docId, e);
    }
  }
  syncClientTotalsToServer();
};
window.deleteRecurring = window.deleteRecurringPayment;
window.removeRecurringPayment = window.deleteRecurringPayment;

// ABONAR A DEUDA (ABRE EL MODAL DE ABONO LIBRE CON MONTO Y CUENTA PERSONALIZABLES)
window.payDebt = function(idOrIndex, defaultAmount = null) {
  const strId = String(idOrIndex);
  let targetDebt = debts.find(d => String(d.id) === strId || String(d.firestoreId) === strId);
  if (!targetDebt && !isNaN(parseInt(idOrIndex, 10))) {
    targetDebt = debts[parseInt(idOrIndex, 10)];
  }

  if (!targetDebt) return;

  let amountToPass = defaultAmount;
  if (!amountToPass) {
    const inputEl = document.getElementById(`pay-input-mob-${targetDebt.id}`) || document.getElementById(`pay-input-${targetDebt.id}`) || document.getElementById(`pay-input-${strId}`);
    if (inputEl && inputEl.value) {
      amountToPass = inputEl.value;
    }
  }

  window.openDebtActionModal(targetDebt.id, amountToPass);
};

// ELIMINAR DEUDA
window.removeDebt = async function(idOrIndex) {
  const strId = String(idOrIndex).trim();
  let targetDebt = debts.find(d => 
    d && (
      String(d.id) === strId ||
      String(d.firestoreId) === strId ||
      String(d.localId) === strId ||
      String(d.tempId) === strId ||
      (d.createdAt && String(d.createdAt) === strId)
    )
  );
  if (!targetDebt && !isNaN(parseInt(idOrIndex, 10)) && debts[parseInt(idOrIndex, 10)]) {
    targetDebt = debts[parseInt(idOrIndex, 10)];
  }

  const debtName = targetDebt ? targetDebt.name : 'esta deuda';
  const confirmed = await appConfirm(`¿Deseas eliminar la deuda "${debtName}"?\n\nAl confirmar, también se eliminarán los registros de abonos asociados en gastos para no dejar gastos huérfanos en tu historial.`, {
    title: 'Eliminar Deuda / Obligación',
    icon: '🗓️',
    okText: 'Eliminar Deuda',
    isDanger: true
  });
  if (!confirmed) return;

  const idsToDelete = new Set();
  idsToDelete.add(strId);
  if (targetDebt) {
    if (targetDebt.id) idsToDelete.add(String(targetDebt.id));
    if (targetDebt.firestoreId) idsToDelete.add(String(targetDebt.firestoreId));
    if (targetDebt.localId) idsToDelete.add(String(targetDebt.localId));
    if (targetDebt.tempId) idsToDelete.add(String(targetDebt.tempId));
    if (targetDebt.createdAt) idsToDelete.add(String(targetDebt.createdAt));
  }

  idsToDelete.forEach(id => {
    recentlyDeletedDebtIds.add(id);
    saveRecentlyDeletedId('debt', id);
  });

  if (targetDebt) {
    debts = debts.filter(d => d !== targetDebt && !idsToDelete.has(String(d.id)) && !idsToDelete.has(String(d.firestoreId)) && !idsToDelete.has(String(d.localId)));
  } else {
    debts = debts.filter(d => !idsToDelete.has(String(d.id)) && !idsToDelete.has(String(d.firestoreId)) && !idsToDelete.has(String(d.localId)));
  }
  localStorage.setItem('finances_v10_debts', JSON.stringify(debts));

  // Eliminar abonos asociados registrados en gastos
  if (targetDebt && targetDebt.name) {
    const debtNameUpper = targetDebt.name.trim().toUpperCase();
    const txsToDelete = transactions.filter(t => 
      t.description && (
        t.description.toUpperCase().includes(`ABONO A ${debtNameUpper}`) ||
        t.description.toUpperCase().includes(`ABONO RECIBIDO DE: ${debtNameUpper}`) ||
        t.description.toUpperCase().includes(`COBRO DE: ${debtNameUpper}`) ||
        t.description.toUpperCase().includes(`PAGO DE DEUDA: ${debtNameUpper}`) ||
        t.description.toUpperCase().includes(`DEUDA: ${debtNameUpper}`)
      )
    );

    for (const t of txsToDelete) {
      const tIds = [t.id, t.firestoreId, t.localId, t.tempId].filter(Boolean);
      tIds.forEach(tid => {
        recentlyDeletedTxIds.add(String(tid));
        saveRecentlyDeletedId('tx', String(tid));
      });
      for (const tid of tIds) {
        try {
          await deleteDoc(doc(db, 'vaults', activeVaultId, 'transactions', String(tid)));
        } catch (e) {}
      }
    }

    transactions = transactions.filter(t => !txsToDelete.includes(t));
    localStorage.setItem('finances_v10_trans', JSON.stringify(transactions));
  }

  updateUI();
  showQuickToast(`🗑️ Deuda "${debtName}" y sus abonos eliminados`);

  for (const docId of idsToDelete) {
    if (!docId) continue;
    try {
      await deleteDoc(doc(db, 'vaults', activeVaultId, 'debts', docId));
    } catch (e) {
      console.warn('Nota eliminando deuda de Firestore:', docId, e);
    }
  }
  syncClientTotalsToServer();
};
window.deleteDebt = window.removeDebt;

function getNextDueDate(startDateStr, paymentsCount, frequency = 'mensual') {
  if (!startDateStr) return '';
  const parts = startDateStr.split('-');
  if (parts.length !== 3) return startDateStr;

  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);

  const freq = (frequency || 'mensual').toLowerCase();
  let nextDate;
  if (freq === 'semanal') {
    nextDate = new Date(Date.UTC(year, month, day + (paymentsCount * 7)));
  } else if (freq === 'quincenal') {
    nextDate = new Date(Date.UTC(year, month, day + (paymentsCount * 15)));
  } else if (freq === 'diario') {
    nextDate = new Date(Date.UTC(year, month, day + paymentsCount));
  } else if (freq === 'anual') {
    nextDate = new Date(Date.UTC(year + paymentsCount, month, day));
  } else {
    // mensual o libre por defecto
    nextDate = new Date(Date.UTC(year, month + paymentsCount, day));
  }

  const resYear = nextDate.getUTCFullYear();
  const resMonth = String(nextDate.getUTCMonth() + 1).padStart(2, '0');
  const resDay = String(nextDate.getUTCDate()).padStart(2, '0');
  return `${resYear}-${resMonth}-${resDay}`;
}

function showAlert(message, type = 'warning') {
  if (!alertsContainer) return;
  const div = document.createElement('div');
  div.className = `alert-box alert-${type}`;
  div.textContent = message;
  alertsContainer.appendChild(div);
}

function renderAccelerationSuggestions(pending) {
  if (pending <= 0) return '';
  const targetMonths = [2, 6, 8, 10];
  let cardsHtml = '';
  targetMonths.forEach(m => {
    const suggestedMonthly = Math.ceil(pending / m);
    cardsHtml += `
      <div class="acceleration-card">
        <small>EN <strong>${m} MESES</strong>:</small>
        <span>${formatCurrency(suggestedMonthly)}/MES</span>
      </div>
    `;
  });

  return `
    <details class="acceleration-details">
      <summary>PLAN DE ACELERACION (2, 6, 8 O 10 MESES)</summary>
      <div class="acceleration-grid">${cardsHtml}</div>
    </details>
  `;
}

// ACTUALIZACION GENERAL DE LA INTERFAZ
function updateUI() {
  if (!incomeList || !expenseList || !debtList) return;

  incomeList.innerHTML = '';
  expenseList.innerHTML = '';
  debtList.innerHTML = '';
  dashboardSummaryList.innerHTML = '';
  alertsContainer.innerHTML = '';

  const today = getTodayStr();

  // ORDENACION CRONOLOGICA ESTRICTA (POR FECHA DESCENDENTE)
  const sortedTransactions = [...transactions].sort((a, b) => {
    return (b.date || '').localeCompare(a.date || '');
  });

  let totalIncomePeriod = 0;
  let totalExpensePeriod = 0;
  let totalIncomeAll = 0;
  let totalExpenseAll = 0;
  let periodItemCount = 0;

  // CALCULO DE SALDOS POR CUENTA / METODO DE PAGO
  let accNequi = 0;
  let accDaviplata = 0;
  let accEfectivo = 0;
  let accBanco = 0;
  let accDebito = 0;
  let accTarjeta = 0;

  transactions.forEach(t => {
    const m = (t.paymentMethod || 'EFECTIVO').toUpperCase();
    const amt = t.amount || 0;
    if (t.type === 'income') {
      if (m === 'NEQUI') accNequi += amt;
      else if (m === 'DAVIPLATA') accDaviplata += amt;
      else if (m === 'EFECTIVO') accEfectivo += amt;
      else if (m === 'BANCO') accBanco += amt;
      else if (m === 'TARJETA_DEBITO') accDebito += amt;
      else if (m === 'TARJETA_CREDITO') accTarjeta = Math.max(0, accTarjeta - amt); // liquidación/abono
      else accBanco += amt;
    } else {
      if (m === 'NEQUI') accNequi -= amt;
      else if (m === 'DAVIPLATA') accDaviplata -= amt;
      else if (m === 'EFECTIVO') accEfectivo -= amt;
      else if (m === 'BANCO') accBanco -= amt;
      else if (m === 'TARJETA_DEBITO') accDebito -= amt;
      else if (m === 'TARJETA_CREDITO') accTarjeta += amt; // gasto acumulado
      else accBanco -= amt;
    }
  });

  let accGoalsTotal = 0;
  savingsGoals.forEach(g => {
    accGoalsTotal += (g.currentAmount || 0);
  });

  const accNequiEl = document.getElementById('acc-nequi');
  if (accNequiEl) accNequiEl.textContent = formatCurrency(accNequi);
  const accDaviplataEl = document.getElementById('acc-daviplata');
  if (accDaviplataEl) accDaviplataEl.textContent = formatCurrency(accDaviplata);
  const accEfectivoEl = document.getElementById('acc-efectivo');
  if (accEfectivoEl) accEfectivoEl.textContent = formatCurrency(accEfectivo);
  const accBancoEl = document.getElementById('acc-banco');
  if (accBancoEl) accBancoEl.textContent = formatCurrency(accBanco);
  const accDebitoEl = document.getElementById('acc-debito');
  if (accDebitoEl) accDebitoEl.textContent = formatCurrency(accDebito);
  const accTarjetaEl = document.getElementById('acc-tarjeta');
  if (accTarjetaEl) accTarjetaEl.textContent = formatCurrency(accTarjeta);
  const accGoalsTotalEl = document.getElementById('acc-goals-total');
  if (accGoalsTotalEl) accGoalsTotalEl.textContent = formatCurrency(accGoalsTotal);

  const monthNames = {
    '01': 'ENERO', '02': 'FEBRERO', '03': 'MARZO', '04': 'ABRIL',
    '05': 'MAYO', '06': 'JUNIO', '07': 'JULIO', '08': 'AGOSTO',
    '09': 'SEPTIEMBRE', '10': 'OCTUBRE', '11': 'NOVIEMBRE', '12': 'DICIEMBRE'
  };

  let lastIncomeMonthKey = null;
  let lastExpenseMonthKey = null;
  let incomeCount = 0;
  let expenseCount = 0;

  sortedTransactions.forEach((t, idx) => {
    const tYear = (t.date || '').substring(0, 4);
    const tMonth = (t.date || '').substring(5, 7);
    const tMedium = getPaymentMedium(t.paymentMethod);
    const tMethod = (t.paymentMethod || 'EFECTIVO').toUpperCase();

    if (t.type === 'income') totalIncomeAll += t.amount;
    else totalExpenseAll += t.amount;

    const matchesYear = activeYear === 'ALL' || tYear === activeYear;
    const matchesMonth = activeMonth === 'ALL' || tMonth === activeMonth;
    const matchesMedium = activeMedium === 'ALL' || tMedium === activeMedium;
    const matchesMethod = activeMethod === 'ALL' || tMethod === activeMethod;
    const inPeriod = matchesYear && matchesMonth && matchesMedium && matchesMethod;

    if (inPeriod) {
      periodItemCount++;
      if (t.type === 'income') {
        totalIncomePeriod += t.amount;
        incomeCount++;
      } else {
        totalExpensePeriod += t.amount;
        expenseCount++;
      }

      if (!t.id) t.id = 'tx_' + Math.random().toString(36).substr(2, 9);
      const deleteIdentifier = `'${t.id}'`;
      const methodDisplay = t.paymentMethod || 'EFECTIVO';
      const isTransfer = t.category === 'TRANSFERENCIA INTERNA';

      const mediumBadge = `<span class="medium-badge ${tMedium === 'FISICO' ? 'physical' : 'digital'}">${tMedium === 'FISICO' ? '💵 FÍSICO' : '📱 DIGITAL'}</span>`;
      const methodBadge = isTransfer
        ? `<span class="tag-badge" style="background: rgba(59, 130, 246, 0.15); color: var(--primary-color);">🔄 ${methodDisplay}</span>`
        : `<span class="tag-badge">${methodDisplay}</span>`;

      // Fila para tabla de historial
      const row = document.createElement('tr');
      row.className = 'history-row';
      const formattedDate = formatDateDisplay(t.date, t.time || t.createdAt);
      const isIncome = t.type === 'income';
      const amountColor = isIncome ? 'text-success' : 'text-danger';
      const signPrefix = isIncome ? '+' : '-';
      const deleteIconSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6"/></svg>`;

      row.innerHTML = `
        <td class="col-date desktop-only"><small style="color: var(--text-muted);">${formattedDate}</small></td>
        <td class="col-desc desktop-only"><strong>${t.description}</strong></td>
        <td class="col-cat desktop-only"><small style="color: var(--text-muted);">${t.category}</small></td>
        <td class="col-med desktop-only">${mediumBadge}</td>
        <td class="col-acc desktop-only">${methodBadge}</td>
        <td class="col-amt desktop-only ${amountColor}" style="font-weight: 700;">
          ${formatCurrency(t.amount)}
        </td>
        <td class="col-act desktop-only"><button class="btn-delete" title="Eliminar" onclick="removeTransaction(${deleteIdentifier})">${deleteIconSvg}</button></td>

        <!-- Celda integrada para móvil (iOS Card Row: 100% visible, sin cortes, botón eliminar táctil) -->
        <td class="mobile-only-cell" colspan="7">
          <div class="mobile-tx-card">
            <div class="mobile-tx-left">
              <div class="mobile-tx-title">${t.description}</div>
              <div class="mobile-tx-meta">
                <span class="mobile-tx-date">${formattedDate}</span>
                <span class="tag-badge mobile-tag">${t.category}</span>
                ${methodBadge}
              </div>
            </div>
            <div class="mobile-tx-right">
              <span class="mobile-tx-amount ${amountColor}">
                ${signPrefix}${formatCurrency(t.amount)}
              </span>
              <button class="btn-delete mobile-delete-btn" title="Eliminar movimiento" aria-label="Eliminar transacción" onclick="removeTransaction(${deleteIdentifier})">
                ${deleteIconSvg}
              </button>
            </div>
          </div>
        </td>
      `;

      const monthKey = `${tYear}-${tMonth}`;
      if (t.type === 'income') {
        if (activeMonth === 'ALL' && lastIncomeMonthKey !== monthKey) {
          lastIncomeMonthKey = monthKey;
          const divRow = document.createElement('tr');
          divRow.className = 'month-divider-row';
          divRow.innerHTML = `<td colspan="7">📅 ${monthNames[tMonth] || tMonth} ${tYear}</td>`;
          incomeList.appendChild(divRow);
        }
        incomeList.appendChild(row);
      } else {
        if (activeMonth === 'ALL' && lastExpenseMonthKey !== monthKey) {
          lastExpenseMonthKey = monthKey;
          const divRow = document.createElement('tr');
          divRow.className = 'month-divider-row';
          divRow.innerHTML = `<td colspan="7">📅 ${monthNames[tMonth] || tMonth} ${tYear}</td>`;
          expenseList.appendChild(divRow);
        }
        expenseList.appendChild(row);
      }

      // Fila para resumen del dashboard
      const summaryRow = document.createElement('tr');
      summaryRow.className = 'history-row';
      summaryRow.innerHTML = `
        <td class="desktop-only"><small style="color: var(--text-muted);">${formattedDate}</small></td>
        <td class="desktop-only"><span class="tag-badge ${amountColor}">${isIncome ? 'INGRESO' : 'GASTO'}</span></td>
        <td class="desktop-only"><strong>${t.description}</strong></td>
        <td class="desktop-only"><small style="color: var(--text-muted);">${t.category}</small></td>
        <td class="desktop-only">${mediumBadge}</td>
        <td class="desktop-only">${methodBadge}</td>
        <td class="desktop-only ${amountColor}" style="font-weight: 700;">${formatCurrency(t.amount)}</td>
        <td class="col-act desktop-only"><button class="btn-delete" title="Eliminar" onclick="removeTransaction(${deleteIdentifier})">${deleteIconSvg}</button></td>

        <!-- Celda integrada para móvil en dashboard -->
        <td class="mobile-only-cell" colspan="8">
          <div class="mobile-tx-card">
            <div class="mobile-tx-left">
              <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px;">
                <span class="tag-badge ${amountColor}" style="font-size: 0.65rem; padding: 2px 6px;">${isIncome ? 'INGRESO' : 'GASTO'}</span>
                <span class="mobile-tx-title">${t.description}</span>
              </div>
              <div class="mobile-tx-meta">
                <span class="mobile-tx-date">${formattedDate}</span>
                <span class="tag-badge mobile-tag">${t.category}</span>
                ${methodBadge}
              </div>
            </div>
            <div class="mobile-tx-right">
              <span class="mobile-tx-amount ${amountColor}">
                ${signPrefix}${formatCurrency(t.amount)}
              </span>
              <button class="btn-delete mobile-delete-btn" title="Eliminar movimiento" aria-label="Eliminar transacción" onclick="removeTransaction(${deleteIdentifier})">
                ${deleteIconSvg}
              </button>
            </div>
          </div>
        </td>
      `;
      dashboardSummaryList.appendChild(summaryRow);
    }
  });

  // Mensajes de lista vacía según mes seleccionado
  if (incomeCount === 0) {
    const emptyRow = document.createElement('tr');
    emptyRow.innerHTML = `
      <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 26px 12px;">
        <div style="font-size: 1.3rem; margin-bottom: 4px;">📂</div>
        <div style="font-weight: 600;">No hay ingresos registrados en ${activeMonth === 'ALL' ? 'este periodo' : (monthNames[activeMonth] || activeMonth)} ${activeYear === 'ALL' ? '' : activeYear}</div>
        <small style="color: var(--text-muted); opacity: 0.8;">Registra una entrada de dinero con el formulario superior.</small>
      </td>
    `;
    incomeList.appendChild(emptyRow);
  }

  if (expenseCount === 0) {
    const emptyRow = document.createElement('tr');
    emptyRow.innerHTML = `
      <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 26px 12px;">
        <div style="font-size: 1.3rem; margin-bottom: 4px;">📂</div>
        <div style="font-weight: 600;">No hay gastos registrados en ${activeMonth === 'ALL' ? 'este periodo' : (monthNames[activeMonth] || activeMonth)} ${activeYear === 'ALL' ? '' : activeYear}</div>
        <small style="color: var(--text-muted); opacity: 0.8;">Registra una salida de dinero con el formulario superior.</small>
      </td>
    `;
    expenseList.appendChild(emptyRow);
  }

  if (periodItemCount === 0) {
    const emptyRow = document.createElement('tr');
    emptyRow.innerHTML = `
      <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 26px 12px;">
        <div style="font-size: 1.3rem; margin-bottom: 4px;">📊</div>
        <div>No hay movimientos para ${activeMonth === 'ALL' ? 'Todos los meses' : (monthNames[activeMonth] || activeMonth)} ${activeYear === 'ALL' ? '' : activeYear}</div>
      </td>
    `;
    dashboardSummaryList.appendChild(emptyRow);
  }

  // KPIs
  totalIncomeEl.textContent = formatCurrency(totalIncomePeriod);
  totalExpenseEl.textContent = formatCurrency(totalExpensePeriod);
  const totalBalance = totalIncomeAll - totalExpenseAll;
  totalBalanceEl.textContent = formatCurrency(totalBalance);
  totalBalanceEl.className = `kpi-value ${totalBalance >= 0 ? 'text-primary' : 'text-danger'}`;

  incomePeriodTotal.textContent = formatCurrency(totalIncomePeriod);
  expensePeriodTotal.textContent = formatCurrency(totalExpensePeriod);
  summaryCountBadge.textContent = `${periodItemCount} MOVIMIENTOS`;

  if (movementsMonthSelect && movementsMonthSelect.value !== activeMonth) movementsMonthSelect.value = activeMonth;
  if (movementsYearSelect && movementsYearSelect.value !== activeYear) movementsYearSelect.value = activeYear;

  // RENDER DEUDAS SEPARADAS (DEBO vs ME DEBEN)
  let totalPayablePendingSum = 0;
  let totalReceivablePendingSum = 0;
  let countPayable = 0;
  let countReceivable = 0;

  const debtPayableList = document.getElementById('debt-payable-list');
  const debtReceivableList = document.getElementById('debt-receivable-list');
  if (debtPayableList) debtPayableList.innerHTML = '';
  if (debtReceivableList) debtReceivableList.innerHTML = '';
  if (debtList) debtList.innerHTML = '';

  const editIconSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`;
  const deleteIconSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6"/></svg>`;

  debts.forEach((d, idx) => {
    const isReceivable = d.type === 'debt_receivable';
    const interestRate = d.interest || 0;
    const totalWithInterest = d.total + (d.total * (interestRate / 100));
    const paid = d.paid || 0;
    const pending = Math.max(0, totalWithInterest - paid);
    const debtFrequency = (d.frequency || 'mensual').toLowerCase();
    const debtMethod = d.method || d.paymentMethod || 'BANCO';

    if (isReceivable) {
      totalReceivablePendingSum += pending;
      countReceivable++;
    } else {
      totalPayablePendingSum += pending;
      countPayable++;
    }

    const progressPercent = Math.min(100, Math.round((paid / totalWithInterest) * 100));

    let historyArr = [];
    try {
      historyArr = typeof d.history === 'string' ? JSON.parse(d.history) : (d.history || []);
    } catch (e) { historyArr = []; }

    const historyCount = historyArr.length;
    const totalInstallments = d.installments || 1;
    const currentQuotaNumber = Math.min(historyCount + 1, totalInstallments);
    const nextDueDateStr = getNextDueDate(d.startDate, historyCount, d.frequency);

    let dueDateStatus = '';
    if (pending > 0) {
      if (nextDueDateStr < today) {
        dueDateStatus = `<span class="tag-badge text-danger">CUOTA ${currentQuotaNumber}/${totalInstallments}: VENCIDA (${formatDateDisplay(nextDueDateStr)})</span>`;
        showAlert(`ALERTA: LA CUOTA ${currentQuotaNumber} DE ${d.name} VENCIO EL ${formatDateDisplay(nextDueDateStr)}.`, 'danger');
      } else if (nextDueDateStr === today) {
        dueDateStatus = `<span class="tag-badge text-warning">CUOTA ${currentQuotaNumber}/${totalInstallments}: VENCE HOY</span>`;
        showAlert(`RECORDATORIO: HOY VENCE LA CUOTA ${currentQuotaNumber} DE ${d.name}.`, 'warning');
      } else {
        dueDateStatus = `<span class="tag-badge">PROXIMO ${isReceivable ? 'COBRO' : 'PAGO'} (${currentQuotaNumber}/${totalInstallments}): ${formatDateDisplay(nextDueDateStr)}</span>`;
      }
    }

    let historyHtml = '';
    if (historyArr.length > 0) {
      historyHtml = `<div style="font-size: 0.72rem; margin-top: 6px; color: var(--text-muted);"><strong>${isReceivable ? 'COBROS / RECAUDOS RECIBIDOS:' : 'ABONOS REALIZADOS:'}</strong> `;
      historyArr.forEach((h, hIdx) => {
        historyHtml += `<span class="tag-badge">C${hIdx + 1} (${formatDateDisplay(h.date)}): ${formatCurrency(h.amount)}</span> `;
      });
      historyHtml += '</div>';
    }

    const suggestedQuotaAmount = Math.round(totalWithInterest / totalInstallments);
    const accelerationHtml = renderAccelerationSuggestions(pending);
    const interestBadge = interestRate > 0 ? `<span class="tag-badge text-warning">+${interestRate}% INT.</span>` : '';
    const typeBadge = isReceivable
      ? `<span class="tag-badge text-success" style="background: rgba(48, 209, 88, 0.12); border: 0.5px solid rgba(48, 209, 88, 0.3);">🟢 POR COBRAR</span>`
      : `<span class="tag-badge text-danger" style="background: rgba(255, 69, 58, 0.12); border: 0.5px solid rgba(255, 69, 58, 0.3);">🔻 POR PAGAR</span>`;

    if (!d.id) d.id = 'debt_' + Math.random().toString(36).substr(2, 9);
    const debtIdentifier = `'${d.id}'`;

    const row = document.createElement('tr');
    row.className = 'history-row debt-row';

    row.innerHTML = `
      <td class="desktop-only">
        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
          <strong>${d.name}</strong>
          ${typeBadge}
          ${interestBadge}
        </div>
        <div style="margin-top: 4px;">${dueDateStatus}</div>
      </td>
      <td class="desktop-only">
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <select class="tag-badge-select" onchange="changeDebtFrequency(${debtIdentifier}, this.value)" title="Cambiar frecuencia a placer">
            <option value="mensual" ${debtFrequency === 'mensual' ? 'selected' : ''}>🗓️ Mensual</option>
            <option value="quincenal" ${debtFrequency === 'quincenal' ? 'selected' : ''}>🗓️ Quincenal</option>
            <option value="semanal" ${debtFrequency === 'semanal' ? 'selected' : ''}>🗓️ Semanal</option>
            <option value="diario" ${debtFrequency === 'diario' ? 'selected' : ''}>🗓️ Diario</option>
            <option value="anual" ${debtFrequency === 'anual' ? 'selected' : ''}>🗓️ Anual</option>
            <option value="libre" ${debtFrequency === 'libre' ? 'selected' : ''}>🗓️ Libre</option>
          </select>
          <select class="tag-badge-select" onchange="changeDebtMethod(${debtIdentifier}, this.value)" title="Cambiar método de pago habitual">
            <option value="NEQUI" ${debtMethod === 'NEQUI' ? 'selected' : ''}>🟣 Nequi</option>
            <option value="DAVIPLATA" ${debtMethod === 'DAVIPLATA' ? 'selected' : ''}>🔴 Daviplata</option>
            <option value="BANCO" ${debtMethod === 'BANCO' ? 'selected' : ''}>🏦 Banco</option>
            <option value="EFECTIVO" ${debtMethod === 'EFECTIVO' ? 'selected' : ''}>💵 Efectivo</option>
            <option value="TARJETA_DEBITO" ${debtMethod === 'TARJETA_DEBITO' ? 'selected' : ''}>💳 Débito</option>
            <option value="TARJETA_CREDITO" ${debtMethod === 'TARJETA_CREDITO' ? 'selected' : ''}>💳 Crédito</option>
            <option value="OTRO" ${debtMethod === 'OTRO' ? 'selected' : ''}>⚙️ Otro</option>
          </select>
        </div>
      </td>
      <td class="desktop-only">
        <small style="color: var(--text-muted);">${formatCurrency(paid)} DE ${formatCurrency(totalWithInterest)} (${progressPercent}%)</small>
        <div class="progress-bar"><div class="progress-fill" style="width: ${progressPercent}%; background: ${isReceivable ? 'var(--success-color)' : 'var(--danger-color)'};"></div></div>
        ${accelerationHtml}
        ${historyHtml}
      </td>
      <td class="desktop-only ${isReceivable ? 'text-success' : 'text-danger'}" style="font-weight: 700;">${formatCurrency(pending)}</td>
      <td class="desktop-only">
        ${pending > 0 ? `
          <div style="display: flex; gap: 4px; align-items: center;">
            <input type="text" class="currency-input" id="pay-input-${d.id}" value="${new Intl.NumberFormat('es-CO').format(Math.min(pending, suggestedQuotaAmount))}" style="width: 105px; padding: 4px 6px; font-size: 0.8rem;" title="Monto libre">
            <button class="${isReceivable ? 'btn btn-success' : 'btn-pay'}" style="${isReceivable ? 'padding: 4px 10px; font-size: 0.78rem; border-radius: 8px;' : ''}" onclick="payDebt(${debtIdentifier})">${isReceivable ? 'COBRAR' : 'ABONAR'}</button>
          </div>
        ` : `<span class="text-success" style="font-weight: 700;">${isReceivable ? 'RECAUDADA' : 'LIQUIDADA'}</span>`}
      </td>
      <td class="desktop-only" style="text-align: right;">
        <div style="display: inline-flex; gap: 6px; align-items: center;">
          <button class="btn-edit" title="Editar obligación" aria-label="Editar" onclick="openEditDebtModal(${debtIdentifier})">${editIconSvg}</button>
          <button class="btn-delete" title="Eliminar obligación" aria-label="Eliminar" onclick="removeDebt(${debtIdentifier})">${deleteIconSvg}</button>
        </div>
      </td>

      <!-- Celda adaptativa para móvil (iOS Card Row: 100% visible, sin cortes) -->
      <td class="mobile-only-cell" colspan="6">
        <div class="mobile-tx-card mobile-debt-card">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; width: 100%;">
            <div style="flex: 1; min-width: 0;">
              <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                <span class="mobile-tx-title" style="font-size: 0.92rem;">${d.name}</span>
                ${typeBadge}
                ${interestBadge}
              </div>
              <div style="margin-top: 3px;">${dueDateStatus}</div>
            </div>
            <div style="display: flex; gap: 6px; align-items: center;">
              <button class="btn-edit mobile-edit-btn" title="Editar obligación" aria-label="Editar" onclick="openEditDebtModal(${debtIdentifier})">
                ${editIconSvg}
              </button>
              <button class="btn-delete mobile-delete-btn" title="Eliminar registro" aria-label="Eliminar registro" onclick="removeDebt(${debtIdentifier})">
                ${deleteIconSvg}
              </button>
            </div>
          </div>

          <!-- Selectores móviles de frecuencia y método -->
          <div style="display: flex; gap: 6px; align-items: center; margin-top: 6px; flex-wrap: wrap;">
            <select class="tag-badge-select" onchange="changeDebtFrequency(${debtIdentifier}, this.value)" title="Frecuencia">
              <option value="mensual" ${debtFrequency === 'mensual' ? 'selected' : ''}>🗓️ Mensual</option>
              <option value="quincenal" ${debtFrequency === 'quincenal' ? 'selected' : ''}>🗓️ Quincenal</option>
              <option value="semanal" ${debtFrequency === 'semanal' ? 'selected' : ''}>🗓️ Semanal</option>
              <option value="diario" ${debtFrequency === 'diario' ? 'selected' : ''}>🗓️ Diario</option>
              <option value="anual" ${debtFrequency === 'anual' ? 'selected' : ''}>🗓️ Anual</option>
              <option value="libre" ${debtFrequency === 'libre' ? 'selected' : ''}>🗓️ Libre</option>
            </select>
            <select class="tag-badge-select" onchange="changeDebtMethod(${debtIdentifier}, this.value)" title="Método">
              <option value="NEQUI" ${debtMethod === 'NEQUI' ? 'selected' : ''}>🟣 Nequi</option>
              <option value="DAVIPLATA" ${debtMethod === 'DAVIPLATA' ? 'selected' : ''}>🔴 Daviplata</option>
              <option value="BANCO" ${debtMethod === 'BANCO' ? 'selected' : ''}>🏦 Banco</option>
              <option value="EFECTIVO" ${debtMethod === 'EFECTIVO' ? 'selected' : ''}>💵 Efectivo</option>
              <option value="TARJETA_DEBITO" ${debtMethod === 'TARJETA_DEBITO' ? 'selected' : ''}>💳 Débito</option>
              <option value="TARJETA_CREDITO" ${debtMethod === 'TARJETA_CREDITO' ? 'selected' : ''}>💳 Crédito</option>
              <option value="OTRO" ${debtMethod === 'OTRO' ? 'selected' : ''}>⚙️ Otro</option>
            </select>
          </div>

          <div style="margin: 8px 0; width: 100%;">
            <small style="color: var(--text-muted);">${formatCurrency(paid)} DE ${formatCurrency(totalWithInterest)} (${progressPercent}%)</small>
            <div class="progress-bar" style="margin-top: 4px;"><div class="progress-fill" style="width: ${progressPercent}%; background: ${isReceivable ? 'var(--success-color)' : 'var(--danger-color)'};"></div></div>
            ${accelerationHtml}
            ${historyHtml}
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px; flex-wrap: wrap; gap: 8px; width: 100%;">
            <div>
              <small style="color: var(--text-muted); font-size: 0.7rem;">${isReceivable ? 'POR COBRAR:' : 'POR PAGAR:'}</small>
              <div class="${isReceivable ? 'text-success' : 'text-danger'}" style="font-weight: 700; font-size: 0.95rem;">${formatCurrency(pending)}</div>
            </div>
            <div>
              ${pending > 0 ? `
                <div style="display: flex; gap: 6px; align-items: center;">
                  <input type="text" class="currency-input" id="pay-input-mob-${d.id}" value="${new Intl.NumberFormat('es-CO').format(Math.min(pending, suggestedQuotaAmount))}" style="width: 105px; padding: 6px 8px; font-size: 0.8rem; border-radius: 8px;" title="Monto libre">
                  <button class="${isReceivable ? 'btn btn-success' : 'btn-pay'}" style="${isReceivable ? 'padding: 6px 12px; font-size: 0.8rem; border-radius: 8px;' : ''}" onclick="payDebt(${debtIdentifier})">${isReceivable ? 'COBRAR' : 'ABONAR'}</button>
                </div>
              ` : `<span class="text-success" style="font-weight: 700;">${isReceivable ? 'RECAUDADA' : 'LIQUIDADA'}</span>`}
            </div>
          </div>
        </div>
      </td>
    `;

    if (isReceivable) {
      if (debtReceivableList) debtReceivableList.appendChild(row);
    } else {
      if (debtPayableList) debtPayableList.appendChild(row);
    }
  });

  // Estados vacíos elegantes si no hay registros
  if (countPayable === 0 && debtPayableList) {
    debtPayableList.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 24px 16px; color: var(--text-muted); font-size: 0.84rem;">🎉 No tienes obligaciones por pagar registradas. ¡Excelente salud financiera!</td></tr>`;
  }
  if (countReceivable === 0 && debtReceivableList) {
    debtReceivableList.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 24px 16px; color: var(--text-muted); font-size: 0.84rem;">No tienes cuentas por cobrar pendientes en este momento.</td></tr>`;
  }

  // Habilitar máscara de moneda en inputs dinámicos de abono
  document.querySelectorAll('#debt-payable-list .currency-input, #debt-receivable-list .currency-input, #debt-list .currency-input').forEach(input => {
    input.addEventListener('input', (e) => {
      let value = e.target.value.replace(/\D/g, '');
      if (value) {
        e.target.value = new Intl.NumberFormat('es-CO').format(parseInt(value, 10));
      }
    });
  });

  // Actualizar KPIs de deudas en Dashboard y en Tab Deudas
  const totalDebtsNetBalance = totalReceivablePendingSum - totalPayablePendingSum;
  totalDebtPendingEl.textContent = formatCurrency(totalPayablePendingSum);

  const debtsPayableEl = document.getElementById('debts-total-payable');
  if (debtsPayableEl) debtsPayableEl.textContent = formatCurrency(totalPayablePendingSum);

  const debtsReceivableEl = document.getElementById('debts-total-receivable');
  if (debtsReceivableEl) debtsReceivableEl.textContent = formatCurrency(totalReceivablePendingSum);

  const debtsNetEl = document.getElementById('debts-net-balance');
  if (debtsNetEl) {
    debtsNetEl.textContent = (totalDebtsNetBalance >= 0 ? '+ ' : '') + formatCurrency(totalDebtsNetBalance);
    debtsNetEl.className = totalDebtsNetBalance >= 0 ? 'kpi-value text-success' : 'kpi-value text-danger';
  }

  const debtsNetSub = document.getElementById('debts-net-subtitle');
  if (debtsNetSub) {
    debtsNetSub.textContent = totalDebtsNetBalance >= 0
      ? 'Saldo a favor (Te deben más de lo que debes)'
      : 'Pasivo neto (Debes más de lo que te deben)';
  }

  debtsCountBadge.textContent = `${debts.length} ACTIVAS (${countPayable} por pagar, ${countReceivable} por cobrar)`;

  const debtsPayableCountBadge = document.getElementById('debts-payable-count-badge');
  if (debtsPayableCountBadge) debtsPayableCountBadge.textContent = `${countPayable} Por Pagar (${formatCurrency(totalPayablePendingSum)})`;

  const debtsReceivableCountBadge = document.getElementById('debts-receivable-count-badge');
  if (debtsReceivableCountBadge) debtsReceivableCountBadge.textContent = `${countReceivable} Por Cobrar (${formatCurrency(totalReceivablePendingSum)})`;

  const countDebtFilterAll = document.getElementById('count-debt-filter-all');
  if (countDebtFilterAll) countDebtFilterAll.textContent = debts.length;

  const countDebtFilterPayable = document.getElementById('count-debt-filter-payable');
  if (countDebtFilterPayable) countDebtFilterPayable.textContent = countPayable;

  const countDebtFilterReceivable = document.getElementById('count-debt-filter-receivable');
  if (countDebtFilterReceivable) countDebtFilterReceivable.textContent = countReceivable;

  if (typeof window.setDebtFilter === 'function') {
    window.setDebtFilter(activeDebtFilter);
  }

  renderCharts();
  renderCalendar();
  renderSavingsGoals();
  renderRecurringPayments();
}

// VISUALIZACION DE GRAFICOS MENSUALES (CHART.JS)
function renderCharts() {
  if (typeof Chart === 'undefined') return;

  const targetYear = activeYear === 'ALL' ? '2026' : activeYear;
  const monthLabels = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
  const monthlyIncomes = new Array(12).fill(0);
  const monthlyExpenses = new Array(12).fill(0);
  const categoryExpenses = {};

  let currentPeriodIncome = 0;
  let currentPeriodExpense = 0;
  const daysInPeriod = 30;

  transactions.forEach(t => {
    const tYear = (t.date || '').substring(0, 4);
    const tMonthIndex = parseInt((t.date || '').substring(5, 7), 10) - 1;

    if (tYear === targetYear && tMonthIndex >= 0 && tMonthIndex < 12) {
      if (t.type === 'income') {
        monthlyIncomes[tMonthIndex] += t.amount;
      } else {
        monthlyExpenses[tMonthIndex] += t.amount;
      }
    }

    const matchesYear = activeYear === 'ALL' || tYear === activeYear;
    const matchesMonth = activeMonth === 'ALL' || (t.date || '').substring(5, 7) === activeMonth;
    if (matchesYear && matchesMonth) {
      if (t.type === 'income') {
        currentPeriodIncome += t.amount;
      } else {
        currentPeriodExpense += t.amount;
        const cat = t.category || 'OTROS';
        categoryExpenses[cat] = (categoryExpenses[cat] || 0) + t.amount;
      }
    }
  });

  const savingsRate = currentPeriodIncome > 0
    ? Math.max(0, Math.round(((currentPeriodIncome - currentPeriodExpense) / currentPeriodIncome) * 100))
    : 0;
  document.getElementById('chart-savings-rate').textContent = `${savingsRate} %`;

  let topCat = 'NINGUNA';
  let topCatAmount = 0;
  for (const [cat, amt] of Object.entries(categoryExpenses)) {
    if (amt > topCatAmount) {
      topCatAmount = amt;
      topCat = cat;
    }
  }
  document.getElementById('chart-top-category').textContent = topCat;

  const dailyAvg = Math.round(currentPeriodExpense / daysInPeriod);
  document.getElementById('chart-daily-avg').textContent = formatCurrency(dailyAvg);

  const netSavings = currentPeriodIncome - currentPeriodExpense;
  document.getElementById('chart-net-savings').textContent = formatCurrency(netSavings);
  document.getElementById('chart-net-savings').className = `kpi-value ${netSavings >= 0 ? 'text-primary' : 'text-danger'}`;

  // 1. COMPARATIVA MENSUAL
  const barCanvas = document.getElementById('monthlyBarChart');
  if (barCanvas) {
    if (monthlyBarChart) monthlyBarChart.destroy();
    monthlyBarChart = new Chart(barCanvas, {
      type: 'bar',
      data: {
        labels: monthLabels,
        datasets: [
          {
            label: 'INGRESOS',
            data: monthlyIncomes,
            backgroundColor: '#10b981',
            borderRadius: 6
          },
          {
            label: 'GASTOS',
            data: monthlyExpenses,
            backgroundColor: '#f43f5e',
            borderRadius: 6
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top' },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${formatCurrency(ctx.parsed.y)}`
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: (val) => '$ ' + new Intl.NumberFormat('es-CO', { notation: 'compact' }).format(val)
            }
          }
        }
      }
    });
  }

  // 2. DISTRIBUCION POR CATEGORIA
  const pieCanvas = document.getElementById('categoryPieChart');
  if (pieCanvas) {
    if (categoryPieChart) categoryPieChart.destroy();
    const catLabels = Object.keys(categoryExpenses);
    const catData = Object.values(categoryExpenses);

    categoryPieChart = new Chart(pieCanvas, {
      type: 'doughnut',
      data: {
        labels: catLabels.length > 0 ? catLabels : ['SIN GASTOS REGISTRADOS'],
        datasets: [{
          data: catData.length > 0 ? catData : [1],
          backgroundColor: [
            '#f43f5e', '#3b82f6', '#10b981', '#f59e0b',
            '#a855f7', '#ec4899', '#06b6d4', '#84cc16'
          ]
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right' },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.label}: ${formatCurrency(ctx.parsed)}`
            }
          }
        }
      }
    });
  }

  // 3. TENDENCIA DEL BALANCE
  const lineCanvas = document.getElementById('balanceLineChart');
  if (lineCanvas) {
    if (balanceLineChart) balanceLineChart.destroy();
    const balanceTrend = [];
    let runningBalance = 0;
    for (let i = 0; i < 12; i++) {
      runningBalance += (monthlyIncomes[i] - monthlyExpenses[i]);
      balanceTrend.push(runningBalance);
    }

    balanceLineChart = new Chart(lineCanvas, {
      type: 'line',
      data: {
        labels: monthLabels,
        datasets: [{
          label: 'BALANCE ACUMULADO ($ COP)',
          data: balanceTrend,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.12)',
          fill: true,
          tension: 0.35,
          pointRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            ticks: {
              callback: (val) => '$ ' + new Intl.NumberFormat('es-CO', { notation: 'compact' }).format(val)
            }
          }
        }
      }
    });
  }

  // 4. MEDIO DE PAGO: FÍSICO (EFECTIVO) VS DIGITAL (APPS / TARJETAS)
  const mediumCanvas = document.getElementById('mediumDoughnutChart');
  if (mediumCanvas) {
    if (mediumDoughnutChart) mediumDoughnutChart.destroy();
    let expensePhysical = 0;
    let expenseDigital = 0;

    transactions.forEach(t => {
      const tYear = (t.date || '').substring(0, 4);
      const matchesYear = activeYear === 'ALL' || tYear === activeYear;
      const matchesMonth = activeMonth === 'ALL' || (t.date || '').substring(5, 7) === activeMonth;
      if (matchesYear && matchesMonth && t.type === 'expense') {
        const med = getPaymentMedium(t.paymentMethod);
        if (med === 'FISICO') expensePhysical += t.amount;
        else expenseDigital += t.amount;
      }
    });

    const hasData = (expensePhysical + expenseDigital) > 0;
    mediumDoughnutChart = new Chart(mediumCanvas, {
      type: 'doughnut',
      data: {
        labels: hasData ? ['💵 EFECTIVO (FÍSICO EN MANO)', '📱 DIGITAL (APPS / TARJETAS)'] : ['SIN GASTOS EN EL PERIODO'],
        datasets: [{
          data: hasData ? [expensePhysical, expenseDigital] : [1],
          backgroundColor: hasData ? ['#10b981', '#3b82f6'] : ['#374151']
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              label: (ctx) => hasData ? `${ctx.label}: ${formatCurrency(ctx.parsed)}` : 'Sin gastos'
            }
          }
        }
      }
    });
  }

  // 5. GASTOS E INGRESOS POR MÉTODO DE PAGO
  const methodsCanvas = document.getElementById('paymentMethodsBarChart');
  if (methodsCanvas) {
    if (paymentMethodsBarChart) paymentMethodsBarChart.destroy();
    const methodNames = ['EFECTIVO', 'NEQUI', 'DAVIPLATA', 'BANCO', 'TARJETA_DEBITO', 'TARJETA_CREDITO'];
    const displayLabels = ['💵 Efectivo', '📱 Nequi', '📱 Daviplata', '🏦 Banco', '💳 T. Débito', '💳 T. Crédito'];
    const methodExpenses = [0, 0, 0, 0, 0, 0];
    const methodIncomes = [0, 0, 0, 0, 0, 0];

    transactions.forEach(t => {
      const tYear = (t.date || '').substring(0, 4);
      const matchesYear = activeYear === 'ALL' || tYear === activeYear;
      const matchesMonth = activeMonth === 'ALL' || (t.date || '').substring(5, 7) === activeMonth;
      if (matchesYear && matchesMonth) {
        const m = (t.paymentMethod || 'EFECTIVO').toUpperCase();
        const mIndex = methodNames.indexOf(m);
        if (mIndex !== -1) {
          if (t.type === 'expense') methodExpenses[mIndex] += t.amount;
          else methodIncomes[mIndex] += t.amount;
        }
      }
    });

    paymentMethodsBarChart = new Chart(methodsCanvas, {
      type: 'bar',
      data: {
        labels: displayLabels,
        datasets: [
          {
            label: 'Ingresos por Cuenta ($ COP)',
            data: methodIncomes,
            backgroundColor: '#10b981',
            borderRadius: 6
          },
          {
            label: 'Gastos por Método ($ COP)',
            data: methodExpenses,
            backgroundColor: '#f43f5e',
            borderRadius: 6
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top' },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${formatCurrency(ctx.parsed.y)}`
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: (val) => '$ ' + new Intl.NumberFormat('es-CO', { notation: 'compact' }).format(val)
            }
          }
        }
      }
    });
  }
}

// CALENDARIO VISUAL DE DEUDAS
calendarPrevBtn.addEventListener('click', () => {
  calendarCurrentDate.setMonth(calendarCurrentDate.getMonth() - 1);
  renderCalendar();
});

calendarNextBtn.addEventListener('click', () => {
  calendarCurrentDate.setMonth(calendarCurrentDate.getMonth() + 1);
  renderCalendar();
});

function renderCalendar() {
  if (!calendarDaysContainer) return;

  const year = calendarCurrentDate.getFullYear();
  const month = calendarCurrentDate.getMonth();

  const monthNames = [
    'ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO',
    'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'
  ];
  calendarMonthTitle.textContent = `${monthNames[month]} ${year}`;

  calendarDaysContainer.innerHTML = '';

  const firstDayOfMonth = new Date(year, month, 1);
  const lastDayOfMonth = new Date(year, month + 1, 0);
  const daysInMonth = lastDayOfMonth.getDate();

  let startDayOfWeek = firstDayOfMonth.getDay() - 1;
  if (startDayOfWeek === -1) startDayOfWeek = 6;

  for (let i = 0; i < startDayOfWeek; i++) {
    const emptyCell = document.createElement('div');
    emptyCell.className = 'calendar-cell other-month';
    calendarDaysContainer.appendChild(emptyCell);
  }

  const today = getTodayStr();
  const duesMap = {};

  debts.forEach(d => {
    const interestRate = d.interest || 0;
    const totalWithInterest = d.total + (d.total * (interestRate / 100));
    const paid = d.paid || 0;
    const totalQuotas = d.installments || 1;
    const suggestedAmount = Math.round(totalWithInterest / totalQuotas);

    let historyArr = [];
    try {
      historyArr = typeof d.history === 'string' ? JSON.parse(d.history) : (d.history || []);
    } catch (e) { historyArr = []; }

    for (let q = 0; q < totalQuotas; q++) {
      const dueDate = getNextDueDate(d.startDate, q, d.frequency);
      const isPaid = q < historyArr.length;

      let status = 'future';
      if (isPaid) {
        status = 'paid';
      } else if (dueDate < today) {
        status = 'overdue';
      } else {
        const diffDays = (new Date(dueDate) - new Date(today)) / (1000 * 60 * 60 * 24);
        if (diffDays >= 0 && diffDays <= 7) {
          status = 'today';
        }
      }

      if (!duesMap[dueDate]) duesMap[dueDate] = [];
      duesMap[dueDate].push({
        debt: d,
        quotaNum: q + 1,
        totalQuotas,
        status,
        amount: suggestedAmount
      });
    }
  });

  for (let dayNum = 1; dayNum <= daysInMonth; dayNum++) {
    const dayCell = document.createElement('div');
    const dayStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    dayCell.className = 'calendar-cell';
    if (dayStr === today) dayCell.classList.add('is-today');

    dayCell.innerHTML = `<span class="day-number">${dayNum}</span>`;

    const dayDues = duesMap[dayStr] || [];
    dayDues.forEach(due => {
      const badge = document.createElement('div');
      badge.className = `due-badge ${due.status}`;
      const actionLabel = due.debt.type === 'debt_receivable' ? 'Cobrar' : 'Abonar';
      badge.title = `${due.debt.name} (Cuota ${due.quotaNum}/${due.totalQuotas}): ${formatCurrency(due.amount)} - Clic para ${actionLabel} monto libre`;
      badge.style.cursor = 'pointer';
      badge.innerHTML = `<strong>${due.debt.name.substring(0, 10)}</strong>: C${due.quotaNum}`;

      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        window.openDebtActionModal(due.debt.id, due.amount);
      });

      dayCell.appendChild(badge);
    });

    calendarDaysContainer.appendChild(dayCell);
  }
}

// INICIALIZACION
updateUI();
syncClientTotalsToServer();
