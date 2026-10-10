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

// CARGA DE CONFIGURACION DE FIREBASE
let firebaseConfig = {
  projectId: "gen-lang-client-0791489226",
  appId: "1:444846324805:web:84aae995b6c52346beb72c",
  apiKey: "AIzaSyAEAlepremteHWQAZGao8OqVJqMgJvEREA",
  authDomain: "gen-lang-client-0791489226.firebaseapp.com",
  firestoreDatabaseId: "ai-studio-ahorros-d1309347-2e5b-4342-ae0c-d494bd27f1c4"
};

try {
  const configResponse = await fetch('./firebase-applet-config.json');
  if (configResponse.ok) {
    firebaseConfig = await configResponse.json();
  }
} catch (e) {
  console.warn('Using bundled Firebase config');
}

// INICIALIZACION DE FIREBASE
const app = initializeApp(firebaseConfig);
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
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

// ORDENACION CRONOLOGICA ESTRICTA POR FECHA (MÁS RECIENTES PRIMERO)
function sortTransactionsByDate(list) {
  if (!Array.isArray(list)) return [];
  return list.sort((a, b) => {
    const da = a.date || '';
    const db = b.date || '';
    if (da !== db) return db.localeCompare(da);
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
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

// Si no hay sesión válida registrada, redirigir a la pantalla de login
if (!savedUserSession || !savedUserSession.userCode) {
  window.location.replace('login.html');
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

const btnLogout = document.getElementById('btn-logout');
if (btnLogout) {
  btnLogout.addEventListener('click', async () => {
    if (confirm('¿Deseas cerrar tu sesión? Tus finanzas permanecen seguras y sincronizadas en tu bóveda.')) {
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
let userApiKey = localStorage.getItem('ahorros_shortcut_key') || generateApiKey();
let transactions = sortTransactionsByDate(JSON.parse(localStorage.getItem('finances_v10_trans')) || []);
let debts = JSON.parse(localStorage.getItem('finances_v10_debts')) || [];
let savingsGoals = JSON.parse(localStorage.getItem('finances_v10_goals')) || [];
let recurringPayments = JSON.parse(localStorage.getItem('finances_v10_recurring')) || [];
let shortcutEvents = [];

// Sets de IDs eliminados recientemente para evitar resurrección por snapshot en tiempo real
const recentlyDeletedTxIds = new Set();
const recentlyDeletedDebtIds = new Set();
const recentlyDeletedGoalIds = new Set();
const recentlyDeletedRecurringIds = new Set();

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

function generateApiKey() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let rand = '';
  for (let i = 0; i < 6; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const key = `AHO-SC-${rand}`;
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
  return parseFloat(String(val).replace(/\./g, '').replace(/,/g, '')) || 0;
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

function formatDateDisplay(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dateStr;
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
const shortcutTesterForm = document.getElementById('shortcut-tester-form');
const testResponseBox = document.getElementById('test-response-box');
const testResponseText = document.getElementById('test-response-text');
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

function activateTab(tabId) {
  if (!tabId) return;
  const targetBtn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
  const targetMobileBtn = document.querySelector(`.mobile-nav-btn[data-tab="${tabId}"]`);
  const target = document.getElementById(tabId);
  if (!target) return;

  tabButtons.forEach(b => b.classList.remove('active'));
  mobileNavButtons.forEach(b => b.classList.remove('active'));
  tabContents.forEach(c => c.classList.remove('active'));

  if (targetBtn) targetBtn.classList.add('active');
  if (targetMobileBtn) targetMobileBtn.classList.add('active');
  target.classList.add('active');
  localStorage.setItem('ahorros_active_tab', tabId);

  // Scroll suave al inicio si es en móvil para evitar que quede descolocado
  if (window.innerWidth <= 768) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  if (tabId === 'tab-charts') renderCharts();
  else if (tabId === 'tab-debts') renderCalendar();
  else if (tabId === 'tab-savings') renderSavingsGoals();
  else if (tabId === 'tab-recurring') renderRecurringPayments();
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
    activateTab(savedTab);
  }
} catch (e) {}

// CONTROL DE ESTILOS Y TEMAS (BASE POR DEFECTO: GRAFITO CARBÓN)
const themeSelect = document.getElementById('theme-select');
let currentTheme = localStorage.getItem('app_theme');
if (!currentTheme || currentTheme === 'dark') {
  currentTheme = 'carbon';
  localStorage.setItem('app_theme', 'carbon');
}
document.documentElement.setAttribute('data-theme', currentTheme);
if (themeSelect) themeSelect.value = currentTheme;

if (themeSelect) {
  themeSelect.addEventListener('change', (e) => {
    currentTheme = e.target.value;
    document.documentElement.setAttribute('data-theme', currentTheme);
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

// URL COMPARTIDA LIMPIA
const appOrigin = window.location.origin || 'https://ahorros-sa.netlify.app';
const publicSharedOrigin = appOrigin;
if (pwaShareUrlInput) pwaShareUrlInput.value = appOrigin;
if (pwaQrImg) {
  pwaQrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(appOrigin)}`;
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
    btnPwaInstall.innerHTML = '<span>✅</span> APP INSTALADA';
    btnPwaInstall.classList.add('installed');
  }
});

// Detectar si ya corre como App nativa en standalone
const isAppStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
if (isAppStandalone && btnPwaInstall) {
  btnPwaInstall.innerHTML = '<span>✅</span> APP INSTALADA';
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
      alert('Para instalar en iPhone: pulsa el botón Compartir de Safari ⬆️ y luego "Agregar a pantalla de inicio" ➕.');
    }
  });
}

if (btnClosePwaModal) {
  btnClosePwaModal.addEventListener('click', () => {
    if (pwaInstallModal) pwaInstallModal.classList.add('hidden');
  });
}

if (pwaInstallModal) {
  pwaInstallModal.addEventListener('click', (e) => {
    if (e.target === pwaInstallModal) pwaInstallModal.classList.add('hidden');
  });
}

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
      setTimeout(() => { btnCopyVaultCode.textContent = '📋 Copiar Código'; }, 2000);
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
      setTimeout(() => { btnShareVaultLink.textContent = '🔗 Copiar Enlace Directo'; }, 2000);
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
    if (confirm('¿Deseas crear una nueva Bóveda en blanco con código independiente? Tu bóveda actual no se borrará y podrás volver a ella en cualquier momento con su código.')) {
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

// CHIPS RAPIDOS DE MONTO (METAS DE AHORRO Y TRANSFERENCIAS)
document.querySelectorAll('.amount-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const addAmt = parseInt(chip.dataset.add, 10) || 0;
    const isTransfer = chip.classList.contains('transfer-chip');
    const targetInput = isTransfer ? transferAmount : modalGoalAmount;
    if (!targetInput) return;

    const currentVal = parseAmount(targetInput.value) || 0;
    const newVal = currentVal + addAmt;
    targetInput.value = new Intl.NumberFormat('es-CO').format(newVal);
  });
});



// ESTADO Y LOCALIZACIÓN DE ATAJOS DE IPHONE
let currentShortcutMode = 'expense'; // 'expense', 'income', 'dual'
let currentShortcutLang = 'latam'; // 'latam', 'spain', 'english'

const shortcutActionDict = {
  latam: {
    getUrl: 'Obtener contenido de URL',
    askInput: 'Solicitar entrada',
    chooseMenu: 'Elegir de la lista',
    dict: 'Diccionario',
    getDictVal: 'Obtener valor de diccionario',
    showResult: 'Mostrar notificación',
    speakText: 'Hablar texto',
    expenseName: 'Registrar Gasto',
    incomeName: 'Registrar Ingreso',
    dualName: 'Finanzas Ahorros SA',
    promptAmount: '¿Cuánto fue el monto?',
    promptDesc: '¿En qué concepto o detalle?'
  },
  spain: {
    getUrl: 'Obtener contenido de la URL',
    askInput: 'Solicitar entrada',
    chooseMenu: 'Seleccionar del menú',
    dict: 'Diccionario',
    getDictVal: 'Obtener valor del diccionario',
    showResult: 'Mostrar resultado',
    speakText: 'Leer texto con la voz',
    expenseName: 'Registrar Gasto',
    incomeName: 'Registrar Ingreso',
    dualName: 'Finanzas Ahorros SA',
    promptAmount: '¿Monto del movimiento?',
    promptDesc: '¿Concepto del movimiento?'
  },
  english: {
    getUrl: 'Get Contents of URL',
    askInput: 'Ask for Input',
    chooseMenu: 'Choose from Menu',
    dict: 'Dictionary',
    getDictVal: 'Get Dictionary Value',
    showResult: 'Show Notification',
    speakText: 'Speak Text',
    expenseName: 'Log Expense',
    incomeName: 'Log Income',
    dualName: 'Log Financial Transaction',
    promptAmount: 'How much was the amount?',
    promptDesc: 'What is the concept or item?'
  }
};

const shortcutDirectUrlEl = document.getElementById('shortcut-direct-url');
const shortcutDirectLabel = document.getElementById('shortcut-direct-label');
const shortcutDirectHelp = document.getElementById('shortcut-direct-help');
const btnCopyDirectUrl = document.getElementById('btn-copy-direct-url');
const btnDownloadPdfGuide = document.getElementById('btn-download-pdf-guide');
const btnDownloadShortcutGuide = document.getElementById('btn-download-shortcut-guide');
const btnCopySampleJson = document.getElementById('btn-copy-sample-json');
const shortcutSampleJsonEl = document.getElementById('shortcut-sample-json');
const shortcutLangSelect = document.getElementById('shortcut-lang-select');

const btnModeExpense = document.getElementById('btn-mode-expense');
const btnModeIncome = document.getElementById('btn-mode-income');
const btnModeDual = document.getElementById('btn-mode-dual');

function updateShortcutCredentialsUI() {
  const webhookUrl = `${publicSharedOrigin}/api/shortcut/transaction`;
  let directUrl = '';
  const langObj = shortcutActionDict[currentShortcutLang] || shortcutActionDict.latam;

  if (currentShortcutMode === 'expense') {
    directUrl = `${publicSharedOrigin}/api/shortcut/transaction?key=${encodeURIComponent(userApiKey)}&type=gasto&amount=25000&desc=Almuerzo&category=ALIMENTACION&account=NEQUI`;
    if (shortcutDirectLabel) shortcutDirectLabel.textContent = '⚡ ENLACE DIRECTO LISTO (REGISTRAR GASTO):';
    if (shortcutDirectHelp) shortcutDirectHelp.innerHTML = `💡 Pega este enlace en la acción <em>"${langObj.getUrl}"</em> de tu iPhone. ¡Guarda tu gasto en 1 clic!`;
    if (shortcutSampleJsonEl) {
      shortcutSampleJsonEl.textContent = JSON.stringify({
        type: "expense",
        amount: 25000,
        description: "Almuerzo",
        category: "ALIMENTACION",
        paymentMethod: "NEQUI"
      }, null, 2);
    }
  } else if (currentShortcutMode === 'income') {
    directUrl = `${publicSharedOrigin}/api/shortcut/transaction?key=${encodeURIComponent(userApiKey)}&type=ingreso&amount=100000&desc=Honorarios&category=SALARIO&account=BANCO`;
    if (shortcutDirectLabel) shortcutDirectLabel.textContent = '⚡ ENLACE DIRECTO LISTO (REGISTRAR INGRESO):';
    if (shortcutDirectHelp) shortcutDirectHelp.innerHTML = `💡 Pega este enlace en la acción <em>"${langObj.getUrl}"</em> de tu iPhone. ¡Guarda tu ingreso en 1 clic!`;
    if (shortcutSampleJsonEl) {
      shortcutSampleJsonEl.textContent = JSON.stringify({
        type: "income",
        amount: 100000,
        description: "Pago de Salario / Honorarios",
        category: "SALARIO",
        paymentMethod: "BANCO"
      }, null, 2);
    }
  } else {
    // Modo Dual / Maestro
    directUrl = `${publicSharedOrigin}/api/shortcut/transaction?key=${encodeURIComponent(userApiKey)}&type=[Elegido]&amount=[Monto]&desc=[Concepto]&account=NEQUI`;
    if (shortcutDirectLabel) shortcutDirectLabel.textContent = '⚡ ENLACE DIRECTO MAESTRO (GASTO O INGRESO):';
    if (shortcutDirectHelp) shortcutDirectHelp.innerHTML = `💡 En Atajos usa <em>"${langObj.chooseMenu}"</em> para preguntar si es Gasto o Ingreso y envía el tipo en el enlace.`;
    if (shortcutSampleJsonEl) {
      shortcutSampleJsonEl.textContent = JSON.stringify({
        type: "income_o_expense",
        amount: 50000,
        description: "Detalle de movimiento",
        category: "OTROS",
        paymentMethod: "NEQUI"
      }, null, 2);
    }
  }

  if (shortcutApiKeyEl) shortcutApiKeyEl.textContent = userApiKey;
  if (shortcutWebhookUrlEl) shortcutWebhookUrlEl.textContent = webhookUrl;
  if (shortcutDirectUrlEl) shortcutDirectUrlEl.textContent = directUrl;

  // Actualizar textos de los pasos según idioma seleccionado
  const step1Desc = document.getElementById('step-1-desc');
  const step2Desc = document.getElementById('step-2-desc');
  const step3Desc = document.getElementById('step-3-desc');
  const step4Desc = document.getElementById('step-4-desc');
  const step5Desc = document.getElementById('step-5-desc');

  if (step1Desc) {
    const defaultName = currentShortcutMode === 'income' ? langObj.incomeName : currentShortcutMode === 'dual' ? langObj.dualName : langObj.expenseName;
    step1Desc.innerHTML = `Abre la app <strong>Atajos</strong> (Shortcuts), toca <strong>+</strong> y nómbralo <em>"${defaultName}"</em>.`;
  }
  if (step2Desc) {
    step2Desc.innerHTML = `Busca la acción <code class="action-tag">${langObj.askInput}</code>. Tipo: <strong>Número</strong>. Indicación: <em>"${langObj.promptAmount}"</em>.`;
  }
  if (step3Desc) {
    step3Desc.innerHTML = `Agrega otra acción <code class="action-tag">${langObj.askInput}</code>. Tipo: <strong>Texto</strong>. Indicación: <em>"${langObj.promptDesc}"</em>.`;
  }
  if (step4Desc) {
    step4Desc.innerHTML = `Agrega <code class="action-tag">${langObj.getUrl}</code>. Método: <strong>GET</strong> (con enlace directo) o <strong>POST</strong> con JSON.`;
  }
  if (step5Desc) {
    step5Desc.innerHTML = `Agrega <code class="action-tag">${langObj.speakText}</code> pasando el campo <code>speech</code> de la respuesta para que Siri te hable y confirme tu saldo.`;
  }
}
updateShortcutCredentialsUI();

// Switchers de modo Gasto / Ingreso / Dual
if (btnModeExpense) {
  btnModeExpense.addEventListener('click', () => {
    currentShortcutMode = 'expense';
    btnModeExpense.className = 'shortcut-pill-btn active';
    btnModeExpense.style.background = 'rgba(239, 68, 68, 0.18)';
    btnModeExpense.style.borderColor = 'var(--danger-color)';
    btnModeExpense.style.color = '#fca5a5';

    btnModeIncome.className = 'shortcut-pill-btn';
    btnModeIncome.style.background = 'var(--surface-secondary)';
    btnModeIncome.style.borderColor = 'var(--border-color)';
    btnModeIncome.style.color = 'var(--text-muted)';

    btnModeDual.className = 'shortcut-pill-btn';
    btnModeDual.style.background = 'var(--surface-secondary)';
    btnModeDual.style.borderColor = 'var(--border-color)';
    btnModeDual.style.color = 'var(--text-muted)';

    updateShortcutCredentialsUI();
  });
}

if (btnModeIncome) {
  btnModeIncome.addEventListener('click', () => {
    currentShortcutMode = 'income';
    btnModeIncome.className = 'shortcut-pill-btn active';
    btnModeIncome.style.background = 'rgba(34, 197, 94, 0.18)';
    btnModeIncome.style.borderColor = 'var(--success-color)';
    btnModeIncome.style.color = '#86efac';

    btnModeExpense.className = 'shortcut-pill-btn';
    btnModeExpense.style.background = 'var(--surface-secondary)';
    btnModeExpense.style.borderColor = 'var(--border-color)';
    btnModeExpense.style.color = 'var(--text-muted)';

    btnModeDual.className = 'shortcut-pill-btn';
    btnModeDual.style.background = 'var(--surface-secondary)';
    btnModeDual.style.borderColor = 'var(--border-color)';
    btnModeDual.style.color = 'var(--text-muted)';

    updateShortcutCredentialsUI();
  });
}

if (btnModeDual) {
  btnModeDual.addEventListener('click', () => {
    currentShortcutMode = 'dual';
    btnModeDual.className = 'shortcut-pill-btn active';
    btnModeDual.style.background = 'rgba(6, 182, 212, 0.18)';
    btnModeDual.style.borderColor = 'var(--primary-color)';
    btnModeDual.style.color = '#67e8f9';

    btnModeExpense.className = 'shortcut-pill-btn';
    btnModeExpense.style.background = 'var(--surface-secondary)';
    btnModeExpense.style.borderColor = 'var(--border-color)';
    btnModeExpense.style.color = 'var(--text-muted)';

    btnModeIncome.className = 'shortcut-pill-btn';
    btnModeIncome.style.background = 'var(--surface-secondary)';
    btnModeIncome.style.borderColor = 'var(--border-color)';
    btnModeIncome.style.color = 'var(--text-muted)';

    updateShortcutCredentialsUI();
  });
}

if (shortcutLangSelect) {
  shortcutLangSelect.addEventListener('change', (e) => {
    currentShortcutLang = e.target.value;
    updateShortcutCredentialsUI();
    showQuickToast(`🌐 Idioma de acciones actualizado a: ${shortcutLangSelect.options[shortcutLangSelect.selectedIndex].text}`);
  });
}

btnCopyKey.addEventListener('click', () => {
  navigator.clipboard.writeText(userApiKey).then(() => {
    btnCopyKey.textContent = '¡COPIADO!';
    setTimeout(() => { btnCopyKey.textContent = 'COPIAR CLAVE'; }, 2000);
  });
});

btnCopyUrl.addEventListener('click', () => {
  const webhookUrl = `${publicSharedOrigin}/api/shortcut/transaction`;
  navigator.clipboard.writeText(webhookUrl).then(() => {
    btnCopyUrl.textContent = '¡COPIADA!';
    setTimeout(() => { btnCopyUrl.textContent = 'COPIAR URL'; }, 2000);
  });
});

if (btnCopyDirectUrl) {
  btnCopyDirectUrl.addEventListener('click', () => {
    const currentDirect = shortcutDirectUrlEl ? shortcutDirectUrlEl.textContent : '';
    navigator.clipboard.writeText(currentDirect).then(() => {
      btnCopyDirectUrl.textContent = '✅ ¡ENLACE COPIADO!';
      showQuickToast('📋 Enlace directo con tu clave copiado al portapapeles');
      setTimeout(() => { btnCopyDirectUrl.textContent = '📋 Copiar Enlace'; }, 2000);
    });
  });
}

if (btnCopySampleJson) {
  btnCopySampleJson.addEventListener('click', () => {
    const currentSample = shortcutSampleJsonEl ? shortcutSampleJsonEl.textContent : '';
    navigator.clipboard.writeText(currentSample).then(() => {
      btnCopySampleJson.textContent = '✅ ¡JSON COPIADO!';
      showQuickToast('📋 JSON de ejemplo copiado al portapapeles');
      setTimeout(() => { btnCopySampleJson.textContent = '📋 Copiar JSON de Ejemplo'; }, 2000);
    });
  });
}

// GENERADOR DE PDF VISUAL Y ATRACTIVO (ESTILO GUIA OFICIAL FINTECH APPLE)
if (btnDownloadPdfGuide) {
  btnDownloadPdfGuide.addEventListener('click', () => {
    showQuickToast('📄 Generando Guía Visual en PDF...');

    if (typeof window.jspdf === 'undefined' || !window.jspdf.jsPDF) {
      // Fallback a ventana de impresión formateada si jsPDF no está disponible
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

      const primaryCyan = [6, 182, 212];
      const darkBg = [15, 17, 24];
      const cardBg = [24, 28, 38];
      const emeraldGreen = [16, 185, 129];
      const crimsonRed = [239, 68, 68];
      const textWhite = [255, 255, 255];
      const textMuted = [156, 163, 175];

      // Fondo general
      doc.setFillColor(...darkBg);
      doc.rect(0, 0, 210, 297, 'F');

      // Banner Header Superior
      doc.setFillColor(20, 24, 34);
      doc.roundedRect(12, 12, 186, 32, 4, 4, 'F');

      doc.setDrawColor(...primaryCyan);
      doc.setLineWidth(0.8);
      doc.roundedRect(12, 12, 186, 32, 4, 4, 'D');

      // Título
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.setTextColor(...primaryCyan);
      doc.text('AHORROS SA  |  GUIA DE ATAJOS PARA IPHONE', 20, 24);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(...textMuted);
      doc.text('SISTEMA AUTOMATICO DE CAPTURA POR VOZ CON SIRI, WIDGETS Y WEBHOOK EN LA NUBE', 20, 31);
      doc.text(`BOVEDA ACTIVA: ${activeVaultId}   |   CLAVE API: ${userApiKey}`, 20, 38);

      let curY = 50;

      // TARJETA 1: REGISTRAR GASTOS (ROJO)
      doc.setFillColor(...cardBg);
      doc.roundedRect(12, curY, 186, 48, 3, 3, 'F');
      doc.setDrawColor(...crimsonRed);
      doc.setLineWidth(0.5);
      doc.roundedRect(12, curY, 186, 48, 3, 3, 'D');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(...crimsonRed);
      doc.text('1. COMO REGISTRAR GASTOS EN 1 MINUTO (METODO RAPIDO GET)', 18, curY + 8);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...textWhite);
      doc.text('Paso A: Abre la app "Atajos" en tu iPhone y crea un atajo llamado "Registrar Gasto".', 18, curY + 16);
      doc.text('Paso B: Agrega la accion "Solicitar entrada" (Numero) -> Pregunta: "¿Cuanto gastaste?".', 18, curY + 22);
      doc.text('Paso C: Agrega la accion "Solicitar entrada" (Texto) -> Pregunta: "¿En que concepto?".', 18, curY + 28);
      doc.text('Paso D: Agrega "Obtener contenido de URL" (Metodo GET) con tu enlace directo de gastos:', 18, curY + 34);

      doc.setFont('courier', 'bold');
      doc.setFontSize(6.8);
      doc.setTextColor(...primaryCyan);
      const expenseUrl = `${publicSharedOrigin}/api/shortcut/transaction?key=${userApiKey}&type=gasto&amount=[Entrada1]&desc=[Entrada2]&category=ALIMENTACION&account=NEQUI`;
      doc.text(expenseUrl.substring(0, 100), 18, curY + 41);

      curY += 54;

      // TARJETA 2: REGISTRAR INGRESOS (VERDE)
      doc.setFillColor(...cardBg);
      doc.roundedRect(12, curY, 186, 48, 3, 3, 'F');
      doc.setDrawColor(...emeraldGreen);
      doc.setLineWidth(0.5);
      doc.roundedRect(12, curY, 186, 48, 3, 3, 'D');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(...emeraldGreen);
      doc.text('2. COMO REGISTRAR INGRESOS (SALARIOS, PAGOS, ENTRADAS)', 18, curY + 8);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...textWhite);
      doc.text('Paso A: Crea un atajo llamado "Registrar Ingreso" en la app oficial de Atajos.', 18, curY + 16);
      doc.text('Paso B: Agrega la accion "Solicitar entrada" (Numero) -> Pregunta: "¿Cuanto dinero ingresas?".', 18, curY + 22);
      doc.text('Paso C: Agrega "Solicitar entrada" (Texto) -> Pregunta: "¿Origen o cliente del ingreso?".', 18, curY + 28);
      doc.text('Paso D: Agrega "Obtener contenido de URL" (Metodo GET) con tu enlace directo de ingresos:', 18, curY + 34);

      doc.setFont('courier', 'bold');
      doc.setFontSize(6.8);
      doc.setTextColor(...emeraldGreen);
      const incomeUrl = `${publicSharedOrigin}/api/shortcut/transaction?key=${userApiKey}&type=ingreso&amount=[Entrada1]&desc=[Entrada2]&category=SALARIO&account=BANCO`;
      doc.text(incomeUrl.substring(0, 100), 18, curY + 41);

      curY += 54;

      // TARJETA 3: TABLA DE ACCIONES EN ESPAÑOL LATAM, ESPAÑA E INGLES
      doc.setFillColor(...cardBg);
      doc.roundedRect(12, curY, 186, 52, 3, 3, 'F');
      doc.setDrawColor(...primaryCyan);
      doc.setLineWidth(0.5);
      doc.roundedRect(12, curY, 186, 52, 3, 3, 'D');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      doc.setTextColor(...primaryCyan);
      doc.text('3. DICCIONARIO DE ACCIONES SEGUN EL IDIOMA DE TU IPHONE', 18, curY + 8);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(...textMuted);
      doc.text('ACCION EN IPHONE', 18, curY + 16);
      doc.text('ESPAÑOL (LATINOAMERICA)', 65, curY + 16);
      doc.text('ESPAÑOL (ESPAÑA)', 120, curY + 16);
      doc.text('ENGLISH (IOS)', 165, curY + 16);

      doc.setDrawColor(60, 65, 80);
      doc.line(16, curY + 18, 194, curY + 18);

      const tableRows = [
        ['Llamar Webhook', 'Obtener contenido de URL', 'Obtener contenido de la URL', 'Get Contents of URL'],
        ['Pedir Numero/Texto', 'Solicitar entrada', 'Solicitar entrada', 'Ask for Input'],
        ['Elegir Categoria', 'Elegir de la lista', 'Seleccionar del menú', 'Choose from Menu'],
        ['Voz de Siri', 'Hablar texto', 'Leer texto con la voz', 'Speak Text'],
        ['Notificacion', 'Mostrar notificación', 'Mostrar resultado', 'Show Notification']
      ];

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(...textWhite);

      let rowY = curY + 24;
      tableRows.forEach(r => {
        doc.text(r[0], 18, rowY);
        doc.text(r[1], 65, rowY);
        doc.text(r[2], 120, rowY);
        doc.text(r[3], 165, rowY);
        rowY += 6;
      });

      curY += 58;

      // TARJETA 4: TRUCOS CON SIRI Y DICTADO
      doc.setFillColor(...cardBg);
      doc.roundedRect(12, curY, 186, 30, 3, 3, 'F');
      doc.setDrawColor(100, 116, 139);
      doc.roundedRect(12, curY, 186, 30, 3, 3, 'D');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(245, 158, 11);
      doc.text('⚡ TRUCO PRO: ACTIVACION POR VOZ CON SIRI & APPLE WATCH', 18, curY + 8);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.8);
      doc.setTextColor(...textWhite);
      doc.text('1. Dile a tu celular: "Oye Siri, Registrar Gasto". Siri abrira el atajo y te preguntara el monto y concepto.', 18, curY + 16);
      doc.text('2. Al finalizar el webhook, Siri te dira: "Gasto registrado. Saldo disponible restante: $ 850.000 COP".', 18, curY + 22);

      // Pie de Pagina
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(...textMuted);
      doc.text('AHORROS SA - SISTEMA FINANCIERO CON PERSISTENCIA NUBE Y ATAJOS DE IPHONE', 48, 290);

      doc.save(`Guia_Visual_Atajos_iPhone_AhorrosSA_${activeVaultId}.pdf`);
      showQuickToast('✅ Guía visual en PDF descargada');
    } catch (pdfErr) {
      console.error('Error generando PDF:', pdfErr);
      showQuickToast('⚠️ Error generando PDF. Abriendo versión para imprimir...');
      window.print();
    }
  });
}

// DESCARGAR ARCHIVO DE ATAJO (.shortcut)
if (btnDownloadShortcutGuide) {
  btnDownloadShortcutGuide.addEventListener('click', () => {
    const configData = {
      name: `Ahorros SA - ${currentShortcutMode === 'income' ? 'Registrar Ingreso' : currentShortcutMode === 'dual' ? 'Atajo Maestro' : 'Registrar Gasto'}`,
      version: "1.0",
      vaultId: activeVaultId,
      apiKey: userApiKey,
      webhookUrl: `${publicSharedOrigin}/api/shortcut/transaction`,
      directUrls: {
        expense: `${publicSharedOrigin}/api/shortcut/transaction?key=${encodeURIComponent(userApiKey)}&type=gasto&amount=[NUMERO]&desc=[DETALLE]&category=ALIMENTACION&account=NEQUI`,
        income: `${publicSharedOrigin}/api/shortcut/transaction?key=${encodeURIComponent(userApiKey)}&type=ingreso&amount=[NUMERO]&desc=[DETALLE]&category=SALARIO&account=BANCO`
      },
      instructions: "Importa este archivo o copia la URL directa en tu iPhone en la acción 'Obtener contenido de URL'."
    };

    const blob = new Blob([JSON.stringify(configData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `AhorrosSA_Atajo_${currentShortcutMode}_${activeVaultId}.shortcut`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showQuickToast('📥 Archivo de atajo descargado');
  });
}

// GESTIÓN DE LA ZONA DE PELIGRO: ELIMINAR BÓVEDA DEFINITIVAMENTE
const btnDeleteActiveVault = document.getElementById('btn-delete-active-vault');
if (btnDeleteActiveVault) {
  btnDeleteActiveVault.addEventListener('click', async () => {
    const inputVal = prompt(
      `⚠️ ADVERTENCIA CRÍTICA:\nEsta acción ELIMINARÁ DEFINITIVAMENTE la Bóveda (${activeVaultId}) y TODOS sus datos (ingresos, gastos, deudas, metas y finanzas fijas) tanto de este dispositivo como de Firebase Firestore en la nube.\n\nPara confirmar, escribe en mayúsculas la palabra: ELIMINAR`
    );

    if (!inputVal || inputVal.trim() !== 'ELIMINAR') {
      return alert('Acción cancelada. La bóveda permanece segura.');
    }

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

// BOTÓN PARA PURGAR BÓVEDAS DE PRUEBA RESIDUALES
const btnPurgeTestVaults = document.getElementById('btn-purge-test-vaults');
if (btnPurgeTestVaults) {
  btnPurgeTestVaults.addEventListener('click', async () => {
    if (!confirm('¿Deseas purgar todas las bóvedas temporales de prueba que se hayan creado en el sitio? Tu bóveda actual activa NO se verá afectada.')) return;

    showQuickToast('🧹 Purgando bóvedas de prueba en la nube...');
    let purgedCount = 0;

    try {
      const vColl = collection(db, 'vaults');
      const vSnap = await getDocs(vColl);

      for (const vDoc of vSnap.docs) {
        const vId = vDoc.id;
        // Si no es la bóveda actual del usuario y tiene formato de prueba o usuario previo
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

      showQuickToast(`🧹 Se purgaron exitosamente ${purgedCount} bóvedas de prueba.`);
    } catch (err) {
      console.warn('Nota purgando bóvedas:', err);
      showQuickToast('🧹 Base de datos purgada');
    }
  });
}

btnRegenKey.addEventListener('click', async () => {
  if (confirm('¿Deseas generar una nueva clave de Atajo? Deberás actualizarla en tu iPhone.')) {
    userApiKey = generateApiKey();
    updateShortcutCredentialsUI();
    if (currentUser) {
      try {
        await updateDoc(doc(db, 'users', currentUser.uid), { apiKey: userApiKey });
      } catch (err) {
        console.error('Error saving new api key:', err);
      }
    }
    syncClientTotalsToServer();
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

// BOTON COPIAR JSON DE EJEMPLO DE ATAJO
if (btnCopySampleJson) {
  btnCopySampleJson.addEventListener('click', () => {
    const sampleObj = {
      type: "expense",
      amount: 25000,
      description: "Almuerzo",
      category: "ALIMENTACION",
      paymentMethod: "NEQUI"
    };
    navigator.clipboard.writeText(JSON.stringify(sampleObj, null, 2)).then(() => {
      btnCopySampleJson.textContent = '¡JSON Copiado!';
      setTimeout(() => { btnCopySampleJson.textContent = '📋 Copiar JSON de Ejemplo'; }, 2000);
    });
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

// SIMULADOR DE ATAJO
if (shortcutTesterForm) {
  shortcutTesterForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = document.getElementById('test-type').value;
    const amountVal = parseAmount(document.getElementById('test-amount').value);
    const description = document.getElementById('test-description').value.trim();
    const category = document.getElementById('test-category').value;
    const paymentMethod = document.getElementById('test-method').value;

    if (!amountVal) return alert('Ingresa un monto válido');

    try {
      const response = await fetch('/api/shortcut/transaction', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': userApiKey
        },
        body: JSON.stringify({
          type,
          amount: amountVal,
          description,
          category,
          paymentMethod,
          date: getTodayStr()
        })
      });

      const resData = await response.json();
      testResponseBox.classList.remove('hidden');
      testResponseText.textContent = JSON.stringify(resData, null, 2);

      if (resData.success && resData.transaction) {
        shortcutEvents.unshift(resData.transaction);
        renderShortcutEvents();
        pollPendingShortcuts();
      }
    } catch (err) {
      testResponseBox.classList.remove('hidden');
      testResponseText.textContent = 'Error: ' + err.message;
    }
  });
}

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
      <td><small style="color:var(--text-muted);">${formatDateDisplay(ev.date)}</small></td>
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
async function pollPendingShortcuts() {
  try {
    const res = await fetch(`/api/shortcut/pending?key=${encodeURIComponent(userApiKey)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.success && data.transactions && data.transactions.length > 0) {
      for (const t of data.transactions) {
        shortcutEvents.unshift(t);
        await addTransactionLocallyOrCloud(t);
      }
      renderShortcutEvents();
      updateUI();
    }
  } catch (e) {
    // Polling silencioso
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
      if (confirm('¿Cerrar sesión de Google? Tu Bóveda seguirá activa y protegida con tu código.')) {
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
    const txColl = collection(db, 'vaults', vaultId, 'transactions');
    const txSnap = await getDocs(txColl);
    if (!txSnap.empty) {
      const cloudTrans = [];
      txSnap.forEach(d => {
        if (!recentlyDeletedTxIds.has(d.id)) {
          const tData = d.data();
          // Limpiar transacciones residuales de metas que antes distorsionaban ingresos/gastos
          if (tData.description && (
            tData.description.startsWith('AHORRO EN META:') ||
            tData.description.startsWith('AHORRO INICIAL EN META:') ||
            tData.description.startsWith('RETIRO DE META:')
          )) {
            return;
          }
          cloudTrans.push({ ...tData, id: d.id, firestoreId: d.id });
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
          cloudDebts.push({ ...d.data(), id: d.id, firestoreId: d.id });
        }
      });
      debts = cloudDebts;
      localStorage.setItem('finances_v10_debts', JSON.stringify(debts));
      updateUI();
    }

    const gColl = collection(db, 'vaults', vaultId, 'savingsGoals');
    const gSnap = await getDocs(gColl);
    if (!gSnap.empty) {
      const cloudGoals = [];
      gSnap.forEach(d => {
        if (!recentlyDeletedGoalIds.has(d.id)) {
          cloudGoals.push({ ...d.data(), id: d.id, firestoreId: d.id });
        }
      });
      savingsGoals = cloudGoals;
      localStorage.setItem('finances_v10_goals', JSON.stringify(savingsGoals));
      renderSavingsGoals();
    }

    const rColl = collection(db, 'vaults', vaultId, 'recurringPayments');
    const rSnap = await getDocs(rColl);
    if (!rSnap.empty) {
      const cloudRec = [];
      rSnap.forEach(d => {
        if (!recentlyDeletedRecurringIds.has(d.id)) {
          cloudRec.push({ ...d.data(), id: d.id, firestoreId: d.id });
        }
      });
      recurringPayments = cloudRec;
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
        await addDoc(txColl, {
          vaultId,
          ...t,
          createdAt: t.createdAt || new Date().toISOString()
        });
      }
    }
  } catch (err) { console.warn('Sync transacciones a bóveda:', err); }

  try {
    const debtColl = collection(db, 'vaults', vaultId, 'debts');
    const existingDebtSnap = await getDocs(debtColl);
    if (existingDebtSnap.empty && localDebts.length > 0) {
      for (const d of localDebts) {
        await addDoc(debtColl, {
          vaultId,
          ...d,
          createdAt: d.createdAt || new Date().toISOString()
        });
      }
    }
  } catch (err) { console.warn('Sync deudas a bóveda:', err); }

  try {
    const gColl = collection(db, 'vaults', vaultId, 'savingsGoals');
    const existingGSnap = await getDocs(gColl);
    if (existingGSnap.empty && localGoals.length > 0) {
      for (const g of localGoals) {
        await addDoc(gColl, {
          vaultId,
          ...g,
          createdAt: g.createdAt || new Date().toISOString()
        });
      }
    }
  } catch (err) { console.warn('Sync metas a bóveda:', err); }

  try {
    const rColl = collection(db, 'vaults', vaultId, 'recurringPayments');
    const existingRSnap = await getDocs(rColl);
    if (existingRSnap.empty && localRecurring.length > 0) {
      for (const r of localRecurring) {
        await addDoc(rColl, {
          vaultId,
          ...r,
          createdAt: r.createdAt || new Date().toISOString()
        });
      }
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

  updateSyncStatus(true, `🟢 BÓVEDA ${vaultId}`);
  if (vaultCodeText) vaultCodeText.textContent = vaultId;

  const txColl = collection(db, 'vaults', vaultId, 'transactions');
  unsubscribeTransactions = onSnapshot(txColl, (snapshot) => {
    const cloudTrans = [];
    snapshot.forEach(docSnap => {
      if (!recentlyDeletedTxIds.has(docSnap.id)) {
        const tData = docSnap.data();
        if (tData.description && (
          tData.description.startsWith('AHORRO EN META:') ||
          tData.description.startsWith('AHORRO INICIAL EN META:') ||
          tData.description.startsWith('RETIRO DE META:')
        )) {
          return;
        }
        cloudTrans.push({ ...tData, id: docSnap.id, firestoreId: docSnap.id });
      }
    });
    // Preservar transacciones locales provisionales recién insertadas
    const localPending = transactions.filter(t => typeof t.id === 'string' && t.id.startsWith('tx_') && !recentlyDeletedTxIds.has(t.id) && !cloudTrans.some(c => c.createdAt === t.createdAt && c.amount === t.amount));
    if (cloudTrans.length > 0 || localPending.length > 0 || transactions.length === 0) {
      transactions = sortTransactionsByDate([...cloudTrans, ...localPending]);
      localStorage.setItem('finances_v10_trans', JSON.stringify(transactions));
      updateUI();
    }
  }, (error) => {
    console.warn('Nota listener transacciones:', error);
    setTimeout(() => {
      if (activeVaultId === vaultId) setupVaultCloudListeners(vaultId);
    }, 4000);
  });

  const debtsColl = collection(db, 'vaults', vaultId, 'debts');
  unsubscribeDebts = onSnapshot(debtsColl, (snapshot) => {
    const cloudDebts = [];
    snapshot.forEach(docSnap => {
      if (!recentlyDeletedDebtIds.has(docSnap.id)) {
        cloudDebts.push({ ...docSnap.data(), id: docSnap.id, firestoreId: docSnap.id });
      }
    });
    const localPending = debts.filter(d => typeof d.id === 'string' && d.id.startsWith('debt_') && !recentlyDeletedDebtIds.has(d.id) && !cloudDebts.some(c => c.name === d.name && c.total === d.total));
    if (cloudDebts.length > 0 || localPending.length > 0 || debts.length === 0) {
      debts = [...cloudDebts, ...localPending];
      localStorage.setItem('finances_v10_debts', JSON.stringify(debts));
      updateUI();
    }
  }, (error) => {
    console.warn('Nota listener deudas:', error);
    setTimeout(() => {
      if (activeVaultId === vaultId) setupVaultCloudListeners(vaultId);
    }, 4000);
  });

  const gColl = collection(db, 'vaults', vaultId, 'savingsGoals');
  unsubscribeGoals = onSnapshot(gColl, (snapshot) => {
    const cloudGoals = [];
    snapshot.forEach(docSnap => {
      if (!recentlyDeletedGoalIds.has(docSnap.id)) {
        cloudGoals.push({ ...docSnap.data(), id: docSnap.id, firestoreId: docSnap.id });
      }
    });
    const localPending = savingsGoals.filter(g => typeof g.id === 'string' && g.id.startsWith('goal_') && !recentlyDeletedGoalIds.has(g.id) && !cloudGoals.some(c => c.name === g.name && c.targetAmount === g.targetAmount));
    if (cloudGoals.length > 0 || localPending.length > 0 || savingsGoals.length === 0) {
      savingsGoals = [...cloudGoals, ...localPending];
      localStorage.setItem('finances_v10_goals', JSON.stringify(savingsGoals));
      renderSavingsGoals();
    }
  }, (error) => {
    console.warn('Nota listener metas:', error);
    setTimeout(() => {
      if (activeVaultId === vaultId) setupVaultCloudListeners(vaultId);
    }, 4000);
  });

  const rColl = collection(db, 'vaults', vaultId, 'recurringPayments');
  unsubscribeRecurring = onSnapshot(rColl, (snapshot) => {
    const cloudR = [];
    snapshot.forEach(docSnap => {
      if (!recentlyDeletedRecurringIds.has(docSnap.id)) {
        cloudR.push({ ...docSnap.data(), id: docSnap.id, firestoreId: docSnap.id });
      }
    });
    const localPending = recurringPayments.filter(r => typeof r.id === 'string' && r.id.startsWith('rec_') && !recentlyDeletedRecurringIds.has(r.id) && !cloudR.some(c => c.name === r.name && c.amount === r.amount));
    if (cloudR.length > 0 || localPending.length > 0 || recurringPayments.length === 0) {
      recurringPayments = [...cloudR, ...localPending];
      localStorage.setItem('finances_v10_recurring', JSON.stringify(recurringPayments));
      renderRecurringPayments();
    }
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
  const localId = 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  const cleanTx = {
    id: localId,
    type: txData.type,
    description: txData.description,
    amount: txData.amount,
    category: txData.category,
    paymentMethod: txData.paymentMethod || 'EFECTIVO',
    date: txData.date,
    createdAt: new Date().toISOString()
  };

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
    // Actualizar el ID provisional con el de Firestore
    cleanTx.id = docRef.id;
    cleanTx.firestoreId = docRef.id;
    localStorage.setItem('finances_v10_trans', JSON.stringify(transactions));
  } catch (e) {
    console.warn('Transacción guardada localmente (pendiente de sync en la nube):', e);
  }

  syncClientTotalsToServer();
}

// ELIMINACION DE TRANSACCION
window.removeTransaction = async function(idOrIndex) {
  if (!confirm('¿Deseas eliminar este movimiento permanentemente?')) return;
  const strId = String(idOrIndex);
  let targetTx = transactions.find(t => String(t.id) === strId || String(t.firestoreId) === strId);
  if (!targetTx && !isNaN(parseInt(idOrIndex, 10))) {
    targetTx = transactions[parseInt(idOrIndex, 10)];
  }

  const idToDelete = targetTx ? targetTx.id : strId;
  const firestoreIdToDelete = targetTx && targetTx.firestoreId ? targetTx.firestoreId : strId;

  recentlyDeletedTxIds.add(String(idToDelete));
  recentlyDeletedTxIds.add(String(firestoreIdToDelete));

  if (targetTx) {
    transactions = transactions.filter(t => t !== targetTx);
  } else {
    transactions = transactions.filter(t => String(t.id) !== strId && String(t.firestoreId) !== strId);
  }

  localStorage.setItem('finances_v10_trans', JSON.stringify(transactions));
  updateUI();
  showQuickToast('🗑️ Movimiento eliminado');

  // Sincronización automática con Compromisos Fijos / Recurrentes:
  // Si el movimiento provenía de un PAGO FIJO o INGRESO FIJO, volver a ponerlo como pendiente
  if (targetTx) {
    const isFixed = targetTx.recurringId ||
      (targetTx.description && (targetTx.description.startsWith('PAGO FIJO:') || targetTx.description.startsWith('INGRESO FIJO:')));

    if (isFixed) {
      const fixedName = targetTx.recurringName || targetTx.description.replace(/^(PAGO FIJO:|INGRESO FIJO:)\s*/i, '').trim();
      const recItem = recurringPayments.find(r =>
        (targetTx.recurringId && (String(r.id) === String(targetTx.recurringId) || String(r.firestoreId) === String(targetTx.recurringId))) ||
        (r.name && r.name.toLowerCase() === fixedName.toLowerCase())
      );
      if (recItem) {
        recItem.lastPaidMonth = null;
        localStorage.setItem('finances_v10_recurring', JSON.stringify(recurringPayments));
        try {
          await setDoc(doc(db, 'vaults', activeVaultId, 'recurringPayments', recItem.id), {
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
    // Si el movimiento era un abono a deuda, descontar el monto pagado para mantener sincronía
    const isAbono = targetTx.debtId || (targetTx.description && targetTx.description.toUpperCase().includes('ABONO A '));
    if (isAbono) {
      const debtItem = debts.find(d =>
        (targetTx.debtId && (String(d.id) === String(targetTx.debtId) || String(d.firestoreId) === String(targetTx.debtId))) ||
        (d.name && targetTx.description.toUpperCase().includes(d.name.toUpperCase()))
      );
      if (debtItem) {
        debtItem.paid = Math.max(0, (debtItem.paid || 0) - (targetTx.amount || 0));
        localStorage.setItem('finances_v10_debts', JSON.stringify(debts));
        try {
          await setDoc(doc(db, 'vaults', activeVaultId, 'debts', debtItem.id), {
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

  try {
    await deleteDoc(doc(db, 'vaults', activeVaultId, 'transactions', idToDelete));
    if (firestoreIdToDelete !== idToDelete) {
      await deleteDoc(doc(db, 'vaults', activeVaultId, 'transactions', firestoreIdToDelete));
    }
  } catch (e) {
    console.warn('Error eliminando de Firestore:', e);
  }
  syncClientTotalsToServer();
};

// FORMULARIO DE INGRESO
incomeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
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
});

// FORMULARIO DE GASTO
expenseForm.addEventListener('submit', async (e) => {
  e.preventDefault();
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
    const from = transferFrom.value;
    const to = transferTo.value;
    const amountVal = parseAmount(transferAmount.value);
    const conceptVal = transferConcept.value.trim() || 'Movimiento entre cuentas';
    const dateVal = transferDate.value || getTodayStr();

    if (!amountVal || amountVal <= 0) return alert('Ingresa un monto válido a mover');
    if (from === to) return alert('La cuenta de origen y de destino no pueden ser la misma');

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
    const amountVal = parseAmount(payCardAmount.value);
    const sourceAcc = payCardSource.value;
    const dateVal = payCardDate.value || getTodayStr();

    if (!amountVal || amountVal <= 0) return alert('Ingresa un monto válido a pagar');

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
  });
}

// FORMULARIO DE CREAR DEUDA
debtForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const nameVal = document.getElementById('debt-name').value.trim();
  const totalVal = parseAmount(document.getElementById('debt-total').value);
  const interestVal = parseFloat(document.getElementById('debt-interest').value) || 0;
  const installmentsVal = parseInt(document.getElementById('debt-installments').value) || 1;
  const startDateVal = document.getElementById('debt-start-date').value || getTodayStr();

  if (!totalVal) return alert('Por favor ingresa un monto de deuda válido.');

  const localId = 'debt_' + Date.now();
  const debtData = {
    id: localId,
    name: nameVal,
    total: totalVal,
    paid: 0,
    interest: interestVal,
    installments: installmentsVal,
    startDate: startDateVal,
    history: JSON.stringify([]),
    createdAt: new Date().toISOString()
  };

  debts.push(debtData);
  localStorage.setItem('finances_v10_debts', JSON.stringify(debts));
  updateUI();
  showQuickToast(`✅ Deuda "${debtData.name}" registrada`);

  try {
    const debtsColl = collection(db, 'vaults', activeVaultId, 'debts');
    const docRef = await addDoc(debtsColl, {
      vaultId: activeVaultId,
      ...debtData
    });
    debtData.id = docRef.id;
    localStorage.setItem('finances_v10_debts', JSON.stringify(debts));
  } catch (e) {
    console.warn('Deuda guardada localmente (pendiente de sync a la nube):', e);
  }

  debtForm.reset();
  document.getElementById('debt-start-date').value = todayStr;
  syncClientTotalsToServer();
});

// FORMULARIO DE CREAR META DE AHORRO
if (goalForm) {
  goalForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nameVal = document.getElementById('goal-name').value.trim();
    const targetVal = parseAmount(document.getElementById('goal-target').value);
    const initialVal = parseAmount(document.getElementById('goal-initial').value) || 0;
    const sourceAcc = document.getElementById('goal-source-account')?.value || 'EFECTIVO';
    const iconVal = document.getElementById('goal-icon')?.value || '🎯';
    const dateVal = document.getElementById('goal-date')?.value || '';

    if (!targetVal || targetVal <= 0) return alert('Ingresa un monto objetivo válido');

    const localId = 'goal_' + Date.now();
    const goalData = {
      id: localId,
      name: nameVal,
      targetAmount: targetVal,
      currentAmount: initialVal,
      targetDate: dateVal,
      icon: iconVal,
      createdAt: new Date().toISOString()
    };

    savingsGoals.push(goalData);
    localStorage.setItem('finances_v10_goals', JSON.stringify(savingsGoals));
    renderSavingsGoals();
    showQuickToast(`🎯 Meta "${goalData.name}" creada exitosamente`);

    try {
      const gColl = collection(db, 'vaults', activeVaultId, 'savingsGoals');
      const docRef = await addDoc(gColl, {
        vaultId: activeVaultId,
        ...goalData
      });
      goalData.id = docRef.id;
      goalData.firestoreId = docRef.id;
      localStorage.setItem('finances_v10_goals', JSON.stringify(savingsGoals));
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
  });
}

// FORMULARIO DE CREAR PAGO FIJO / RECURRENTE
if (recurringForm) {
  recurringForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nameVal = document.getElementById('rec-name').value.trim();
    const typeVal = document.getElementById('rec-type').value;
    const amountVal = parseAmount(document.getElementById('rec-amount').value);
    const freqVal = document.getElementById('rec-frequency').value;
    const dayVal = parseInt(document.getElementById('rec-day').value) || 1;
    const catVal = document.getElementById('rec-category').value;
    const methodVal = document.getElementById('rec-method').value;

    if (!amountVal || amountVal <= 0) return alert('Ingresa un monto válido');

    const localId = 'rec_' + Date.now();
    const rData = {
      id: localId,
      name: nameVal,
      type: typeVal,
      amount: amountVal,
      frequency: freqVal,
      dueDay: dayVal,
      category: catVal,
      paymentMethod: methodVal,
      lastPaidMonth: '',
      createdAt: new Date().toISOString()
    };

    recurringPayments.push(rData);
    localStorage.setItem('finances_v10_recurring', JSON.stringify(recurringPayments));
    renderRecurringPayments();
    showQuickToast(`✅ Registro fijo "${rData.name}" guardado`);

    try {
      const rColl = collection(db, 'vaults', activeVaultId, 'recurringPayments');
      const docRef = await addDoc(rColl, {
        vaultId: activeVaultId,
        ...rData
      });
      rData.id = docRef.id;
      localStorage.setItem('finances_v10_recurring', JSON.stringify(recurringPayments));
    } catch (e) {
      console.warn('Registro fijo guardado localmente (pendiente de sync):', e);
    }

    recurringForm.reset();
    setRecurringType('expense');
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
    const gId = modalGoalId.value;
    const action = modalGoalAction.value;
    const amountVal = parseAmount(modalGoalAmount.value);

    if (!amountVal || amountVal <= 0) return alert('Ingresa un monto válido');

    let targetGoal = savingsGoals.find(g => String(g.id) === String(gId) || String(g.firestoreId) === String(gId));
    if (!targetGoal) return;

    if (action === 'withdraw' && amountVal > targetGoal.currentAmount) {
      return alert(`No puedes retirar más de lo que tienes ahorrado ($ ${formatCurrency(targetGoal.currentAmount)})`);
    }

    const newAmount = action === 'deposit'
      ? targetGoal.currentAmount + amountVal
      : targetGoal.currentAmount - amountVal;

    // Actualización inmediata del ahorro en meta (sin contaminar ingresos/gastos corrientes)
    targetGoal.currentAmount = newAmount;
    localStorage.setItem('finances_v10_goals', JSON.stringify(savingsGoals));
    renderSavingsGoals();
    updateUI();
    showQuickToast(`🎯 ${action === 'deposit' ? 'Abono a' : 'Retiro de'} "${targetGoal.name}": ${formatCurrency(amountVal)}`);

    try {
      await setDoc(doc(db, 'vaults', activeVaultId, 'savingsGoals', targetGoal.id), {
        vaultId: activeVaultId,
        ...targetGoal,
        currentAmount: newAmount
      }, { merge: true });
    } catch (err) {
      console.warn('Error actualizando meta en Firestore:', err);
    }

    goalActionModal.classList.add('hidden');
  });
}

window.deleteSavingsGoal = async function(idOrIndex) {
  const strId = String(idOrIndex);
  let targetGoal = savingsGoals.find(g => String(g.id) === strId || String(g.firestoreId) === strId);
  if (!targetGoal && !isNaN(parseInt(idOrIndex, 10))) {
    targetGoal = savingsGoals[parseInt(idOrIndex, 10)];
  }
  if (!targetGoal) return;

  const currentAmt = targetGoal.currentAmount || 0;
  const msg = currentAmt > 0
    ? `¿Deseas eliminar la meta "${targetGoal.name}"?\nLos $ ${formatCurrency(currentAmt)} ahorrados se liberarán de esta meta.`
    : `¿Deseas eliminar la meta de ahorro "${targetGoal.name}"?`;

  if (!confirm(msg)) return;

  const idToDelete = targetGoal.id;
  const firestoreIdToDelete = targetGoal.firestoreId || idToDelete;

  recentlyDeletedGoalIds.add(String(idToDelete));
  recentlyDeletedGoalIds.add(String(firestoreIdToDelete));

  savingsGoals = savingsGoals.filter(g => g !== targetGoal);
  localStorage.setItem('finances_v10_goals', JSON.stringify(savingsGoals));

  // Limpiar cualquier movimiento legacy de esta meta para no duplicar datos
  transactions = transactions.filter(t => !t.description || (!t.description.includes(`META: ${targetGoal.name}`) && !t.description.includes(`META ${targetGoal.name}`)));
  localStorage.setItem('finances_v10_trans', JSON.stringify(transactions));

  renderSavingsGoals();
  updateUI();
  showQuickToast(`🗑️ Meta "${targetGoal.name}" eliminada`);

  try {
    await deleteDoc(doc(db, 'vaults', activeVaultId, 'savingsGoals', idToDelete));
    if (firestoreIdToDelete !== idToDelete) {
      await deleteDoc(doc(db, 'vaults', activeVaultId, 'savingsGoals', firestoreIdToDelete));
    }
  } catch (e) {
    console.warn('Error eliminando meta de Firestore:', e);
  }
  syncClientTotalsToServer();
};

// RENDER FINANZAS FIJAS & RECURRENTES (INGRESOS Y GASTOS FIJOS)
function renderRecurringPayments() {
  if (!recurringContainer) return;

  const currentYM = getCurrentYearMonth();
  let totalFixedExpenses = 0;
  let totalFixedIncomes = 0;

  recurringPayments.forEach(r => {
    if (r.type === 'income') totalFixedIncomes += (r.amount || 0);
    else totalFixedExpenses += (r.amount || 0);
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
    // Determinar si fue saldado este mes verificando la marca o la presencia de la transacción activa en el mes
    const hasMatchingTxThisMonth = transactions.some(t => {
      if (!t.date || !t.date.startsWith(currentYM)) return false;
      if (t.recurringId && (String(t.recurringId) === String(r.id) || String(t.recurringId) === String(r.firestoreId))) return true;
      const expectedDesc = `${isIncome ? 'INGRESO FIJO' : 'PAGO FIJO'}: ${r.name}`.toLowerCase();
      return (t.description || '').toLowerCase() === expectedDesc;
    });
    const isPaidThisMonth = (r.lastPaidMonth === currentYM) || hasMatchingTxThisMonth;
    const rIdentifier = `'${r.id}'`;

    const card = document.createElement('div');
    card.className = `recurring-card ${isPaidThisMonth ? 'paid' : 'pending'}`;
    card.innerHTML = `
      <div class="recurring-top">
        <div>
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
            <span class="tag-badge ${isIncome ? 'text-success' : 'text-danger'}">
              ${isIncome ? '🟢 INGRESO FIJO (Sueldo/Entrada)' : '🔴 GASTO FIJO / SUSCRIPCIÓN'}
            </span>
          </div>
          <div class="recurring-name">${r.name}</div>
          <div class="recurring-meta">
            <span>Día ${r.dueDay} de cada mes</span> &bull;
            <span>${r.category}</span> &bull;
            <span>${r.paymentMethod || 'NEQUI'}</span>
          </div>
        </div>
        <button class="btn-delete" onclick="deleteRecurringPayment(${rIdentifier})" title="Eliminar">&times;</button>
      </div>

      <div class="recurring-amount ${isIncome ? 'text-success' : 'text-danger'}">
        ${formatCurrency(r.amount)} <small style="font-size: 0.72rem; color: var(--text-muted); font-weight: normal;">/ ${(r.frequency || 'mensual').toLowerCase()}</small>
      </div>

      <div class="recurring-footer">
        <div>
          ${isPaidThisMonth
            ? `<span class="tag-badge text-success">✓ ${isIncome ? 'Cobrado este mes' : 'Pagado este mes'}</span>`
            : `<span class="tag-badge text-warning">⏳ ${isIncome ? 'Pendiente por cobrar' : 'Pendiente este mes'}</span>`
          }
        </div>
        ${!isPaidThisMonth ? `
          <button class="btn-quick-pay" style="${isIncome ? 'background: var(--success-color);' : ''}" onclick="quickPayRecurring(${rIdentifier})">
            ${isIncome ? '⚡ Cobrar / Registrar Ingreso' : '⚡ Pagar / Registrar Gasto'}
          </button>
        ` : `
          <small style="color: var(--text-muted); font-size: 0.7rem;">Registrado en movimientos</small>
        `}
      </div>
    `;
    recurringContainer.appendChild(card);
  });

  if (recurringSummaryBadge) {
    recurringSummaryBadge.textContent = `${recurringPayments.length} Registros Activos`;
  }
}

window.quickPayRecurring = async function(idOrIndex) {
  const strId = String(idOrIndex);
  let targetR = recurringPayments.find(r => String(r.id) === strId || String(r.firestoreId) === strId);
  if (!targetR && !isNaN(parseInt(idOrIndex, 10))) {
    targetR = recurringPayments[parseInt(idOrIndex, 10)];
  }
  if (!targetR) return;

  const currentYM = getCurrentYearMonth();
  const isIncome = targetR.type === 'income';

  // Registrar en movimientos con identificadores enlazados para sincronización bidireccional
  await addTransactionLocallyOrCloud({
    type: isIncome ? 'income' : 'expense',
    description: `${isIncome ? 'INGRESO FIJO' : 'PAGO FIJO'}: ${targetR.name}`,
    recurringId: targetR.id,
    recurringName: targetR.name,
    amount: targetR.amount,
    category: targetR.category,
    paymentMethod: targetR.paymentMethod || 'NEQUI',
    date: getTodayStr()
  });

  // Marcar como pagado / cobrado este mes de forma permanente
  targetR.lastPaidMonth = currentYM;
  localStorage.setItem('finances_v10_recurring', JSON.stringify(recurringPayments));
  renderRecurringPayments();

  try {
    const rRef = doc(db, 'vaults', activeVaultId, 'recurringPayments', targetR.id);
    await setDoc(rRef, {
      vaultId: activeVaultId,
      ...targetR,
      lastPaidMonth: currentYM
    }, { merge: true });
  } catch (e) {
    console.warn('Error actualizando compromiso recurrente en Firestore:', e);
  }

  showQuickToast(`⚡ ${isIncome ? 'Ingreso de' : 'Pago de'} "${targetR.name}" registrado`);
};

window.deleteRecurringPayment = async function(idOrIndex) {
  const strId = String(idOrIndex);
  let targetR = recurringPayments.find(r => String(r.id) === strId || String(r.firestoreId) === strId);
  if (!targetR && !isNaN(parseInt(idOrIndex, 10))) {
    targetR = recurringPayments[parseInt(idOrIndex, 10)];
  }
  if (!targetR) return;

  if (!confirm(`¿Deseas eliminar el compromiso recurrente "${targetR.name}"?`)) return;

  const idToDelete = targetR.id;
  const firestoreIdToDelete = targetR.firestoreId || idToDelete;

  recentlyDeletedRecurringIds.add(String(idToDelete));
  recentlyDeletedRecurringIds.add(String(firestoreIdToDelete));

  recurringPayments = recurringPayments.filter(r => r !== targetR);
  localStorage.setItem('finances_v10_recurring', JSON.stringify(recurringPayments));
  renderRecurringPayments();
  showQuickToast(`🗑️ "${targetR.name}" eliminado`);

  try {
    await deleteDoc(doc(db, 'vaults', activeVaultId, 'recurringPayments', idToDelete));
    if (firestoreIdToDelete !== idToDelete) {
      await deleteDoc(doc(db, 'vaults', activeVaultId, 'recurringPayments', firestoreIdToDelete));
    }
  } catch (e) {
    console.warn('Error eliminando pago recurrente de Firestore:', e);
  }
  syncClientTotalsToServer();
};

// ABONAR A DEUDA
window.payDebt = async function(idOrIndex) {
  const strId = String(idOrIndex);
  let targetDebt = debts.find(d => String(d.id) === strId || String(d.firestoreId) === strId);
  if (!targetDebt && !isNaN(parseInt(idOrIndex, 10))) {
    targetDebt = debts[parseInt(idOrIndex, 10)];
  }

  if (!targetDebt) return;

  const inputEl = document.getElementById(`pay-input-${targetDebt.id}`) || document.getElementById(`pay-input-${strId}`);
  if (!inputEl) return;
  const payAmount = parseAmount(inputEl.value);

  if (!payAmount || payAmount <= 0) return alert('Ingresa un monto de abono válido');

  const interestRate = targetDebt.interest || 0;
  const totalWithInterest = targetDebt.total + (targetDebt.total * (interestRate / 100));
  const currentPaid = targetDebt.paid || 0;
  const pending = Math.max(0, totalWithInterest - currentPaid);

  if (payAmount > pending) {
    if (!confirm(`El monto ($ ${formatCurrency(payAmount)}) supera el saldo pendiente ($ ${formatCurrency(pending)}). ¿Deseas liquidar la deuda por el saldo exacto?`)) {
      return;
    }
  }

  const finalAbono = Math.min(payAmount, pending);
  const newPaid = currentPaid + finalAbono;

  let historyArr = [];
  try {
    historyArr = typeof targetDebt.history === 'string' ? JSON.parse(targetDebt.history) : (targetDebt.history || []);
  } catch (e) { historyArr = []; }

  historyArr.push({
    date: getTodayStr(),
    amount: finalAbono
  });

  targetDebt.paid = newPaid;
  targetDebt.history = JSON.stringify(historyArr);
  localStorage.setItem('finances_v10_debts', JSON.stringify(debts));
  updateUI();

  await addTransactionLocallyOrCloud({
    type: 'expense',
    date: getTodayStr(),
    description: `ABONO A ${targetDebt.name}`,
    amount: finalAbono,
    category: 'PAGO DE DEUDAS',
    paymentMethod: 'BANCO'
  });

  try {
    const dRef = doc(db, 'vaults', activeVaultId, 'debts', targetDebt.id);
    await setDoc(dRef, {
      vaultId: activeVaultId,
      ...targetDebt,
      paid: newPaid,
      history: JSON.stringify(historyArr)
    }, { merge: true });
  } catch (e) {
    console.warn('Error actualizando deuda en Firestore:', e);
  }

  syncClientTotalsToServer();
};

// ELIMINAR DEUDA
window.removeDebt = async function(idOrIndex) {
  const strId = String(idOrIndex);
  let targetDebt = debts.find(d => String(d.id) === strId || String(d.firestoreId) === strId);
  if (!targetDebt && !isNaN(parseInt(idOrIndex, 10))) {
    targetDebt = debts[parseInt(idOrIndex, 10)];
  }
  if (!targetDebt) return;

  if (!confirm(`¿Deseas eliminar la deuda "${targetDebt.name}"?\n\nAl confirmar, también se eliminarán los registros de abonos asociados en gastos para no dejar gastos huérfanos en tu historial.`)) {
    return;
  }

  const idToDelete = targetDebt.id;
  const firestoreIdToDelete = targetDebt.firestoreId || idToDelete;

  recentlyDeletedDebtIds.add(String(idToDelete));
  recentlyDeletedDebtIds.add(String(firestoreIdToDelete));

  debts = debts.filter(d => d !== targetDebt);
  localStorage.setItem('finances_v10_debts', JSON.stringify(debts));

  // Eliminar abonos asociados registrados en gastos
  const debtNameUpper = targetDebt.name.trim().toUpperCase();
  const txsToDelete = transactions.filter(t => 
    t.description && (
      t.description.toUpperCase().includes(`ABONO A ${debtNameUpper}`) ||
      t.description.toUpperCase().includes(`PAGO DE DEUDA: ${debtNameUpper}`) ||
      t.description.toUpperCase().includes(`DEUDA: ${debtNameUpper}`)
    )
  );

  for (const t of txsToDelete) {
    recentlyDeletedTxIds.add(String(t.id));
    if (t.firestoreId) recentlyDeletedTxIds.add(String(t.firestoreId));
    try {
      await deleteDoc(doc(db, 'vaults', activeVaultId, 'transactions', t.id));
    } catch (e) {}
  }

  transactions = transactions.filter(t => !txsToDelete.includes(t));
  localStorage.setItem('finances_v10_trans', JSON.stringify(transactions));

  updateUI();
  showQuickToast(`🗑️ Deuda "${targetDebt.name}" y sus abonos eliminados`);

  try {
    await deleteDoc(doc(db, 'vaults', activeVaultId, 'debts', idToDelete));
    if (firestoreIdToDelete !== idToDelete) {
      await deleteDoc(doc(db, 'vaults', activeVaultId, 'debts', firestoreIdToDelete));
    }
  } catch (e) {
    console.warn('Error eliminando deuda de Firestore:', e);
  }
  syncClientTotalsToServer();
};

function getNextDueDate(startDateStr, paymentsCount) {
  if (!startDateStr) return '';
  const parts = startDateStr.split('-');
  if (parts.length !== 3) return startDateStr;

  const year = parseInt(parts[0]);
  const month = parseInt(parts[1]) - 1;
  const day = parseInt(parts[2]);

  const nextDate = new Date(Date.UTC(year, month + paymentsCount, day));
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
      row.innerHTML = `
        <td><small style="color: var(--text-muted);">${formatDateDisplay(t.date)}</small></td>
        <td><strong>${t.description}</strong></td>
        <td><small style="color: var(--text-muted);">${t.category}</small></td>
        <td>${mediumBadge}</td>
        <td>${methodBadge}</td>
        <td style="font-weight: 700;" class="${t.type === 'income' ? 'text-success' : 'text-danger'}">
          ${formatCurrency(t.amount)}
        </td>
        <td><button class="btn-delete" onclick="removeTransaction(${deleteIdentifier})">X</button></td>
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
      summaryRow.innerHTML = `
        <td><small style="color: var(--text-muted);">${formatDateDisplay(t.date)}</small></td>
        <td><span class="tag-badge ${t.type === 'income' ? 'text-success' : 'text-danger'}">${t.type === 'income' ? 'INGRESO' : 'GASTO'}</span></td>
        <td><strong>${t.description}</strong></td>
        <td><small style="color: var(--text-muted);">${t.category}</small></td>
        <td>${mediumBadge}</td>
        <td>${methodBadge}</td>
        <td style="font-weight: 700;" class="${t.type === 'income' ? 'text-success' : 'text-danger'}">${formatCurrency(t.amount)}</td>
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

  // RENDER DEUDAS
  let totalDebtPendingSum = 0;
  debts.forEach((d, idx) => {
    const interestRate = d.interest || 0;
    const totalWithInterest = d.total + (d.total * (interestRate / 100));
    const paid = d.paid || 0;
    const pending = Math.max(0, totalWithInterest - paid);
    totalDebtPendingSum += pending;

    const progressPercent = Math.min(100, Math.round((paid / totalWithInterest) * 100));

    let historyArr = [];
    try {
      historyArr = typeof d.history === 'string' ? JSON.parse(d.history) : (d.history || []);
    } catch (e) { historyArr = []; }

    const historyCount = historyArr.length;
    const totalInstallments = d.installments || 1;
    const currentQuotaNumber = Math.min(historyCount + 1, totalInstallments);
    const nextDueDateStr = getNextDueDate(d.startDate, historyCount);

    let dueDateStatus = '';
    if (pending > 0) {
      if (nextDueDateStr < today) {
        dueDateStatus = `<span class="tag-badge text-danger">CUOTA ${currentQuotaNumber}/${totalInstallments}: VENCIDA (${formatDateDisplay(nextDueDateStr)})</span>`;
        showAlert(`ALERTA: LA CUOTA ${currentQuotaNumber} DE ${d.name} VENCIO EL ${formatDateDisplay(nextDueDateStr)}.`, 'danger');
      } else if (nextDueDateStr === today) {
        dueDateStatus = `<span class="tag-badge text-warning">CUOTA ${currentQuotaNumber}/${totalInstallments}: VENCE HOY</span>`;
        showAlert(`RECORDATORIO: HOY VENCE LA CUOTA ${currentQuotaNumber} DE ${d.name}.`, 'warning');
      } else {
        dueDateStatus = `<span class="tag-badge">PROXIMO PAGO (${currentQuotaNumber}/${totalInstallments}): ${formatDateDisplay(nextDueDateStr)}</span>`;
      }
    }

    let historyHtml = '';
    if (historyArr.length > 0) {
      historyHtml = '<div style="font-size: 0.72rem; margin-top: 6px; color: var(--text-muted);"><strong>ABONOS REALIZADOS:</strong> ';
      historyArr.forEach((h, hIdx) => {
        historyHtml += `<span class="tag-badge">CUOTA ${hIdx + 1} (${formatDateDisplay(h.date)}): ${formatCurrency(h.amount)}</span> `;
      });
      historyHtml += '</div>';
    }

    const suggestedQuotaAmount = Math.round(totalWithInterest / totalInstallments);
    const accelerationHtml = renderAccelerationSuggestions(pending);
    const interestBadge = interestRate > 0 ? `<span class="tag-badge text-warning">+${interestRate}% INT.</span>` : '';
    if (!d.id) d.id = 'debt_' + Math.random().toString(36).substr(2, 9);
    const debtIdentifier = `'${d.id}'`;

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>
        <strong>${d.name}</strong> ${interestBadge}
        <div>${dueDateStatus}</div>
      </td>
      <td>
        <small style="color: var(--text-muted);">${formatCurrency(paid)} DE ${formatCurrency(totalWithInterest)} (${progressPercent}%)</small>
        <div class="progress-bar"><div class="progress-fill" style="width: ${progressPercent}%;"></div></div>
        ${accelerationHtml}
        ${historyHtml}
      </td>
      <td class="text-purple" style="font-weight: 700;">${formatCurrency(pending)}</td>
      <td>
        ${pending > 0 ? `
          <div style="display: flex; gap: 4px; align-items: center;">
            <input type="text" class="currency-input" id="pay-input-${d.id}" value="${new Intl.NumberFormat('es-CO').format(Math.min(pending, suggestedQuotaAmount))}" style="width: 110px; padding: 4px 6px; font-size: 0.8rem;">
            <button class="btn-pay" onclick="payDebt(${debtIdentifier})">ABONAR</button>
          </div>
        ` : '<span class="text-success" style="font-weight: 700;">LIQUIDADA</span>'}
      </td>
      <td><button class="btn-delete" onclick="removeDebt(${debtIdentifier})">X</button></td>
    `;
    debtList.appendChild(row);
  });

  totalDebtPendingEl.textContent = formatCurrency(totalDebtPendingSum);
  debtsCountBadge.textContent = `${debts.length} ACTIVAS`;

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
      const dueDate = getNextDueDate(d.startDate, q);
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
      badge.title = `${due.debt.name} (Cuota ${due.quotaNum}/${due.totalQuotas}): ${formatCurrency(due.amount)}`;
      badge.innerHTML = `<strong>${due.debt.name.substring(0, 10)}</strong>: C${due.quotaNum}`;

      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        alert(`OBLIGACION: ${due.debt.name}\nCUOTA: ${due.quotaNum} de ${due.totalQuotas}\nFECHA: ${formatDateDisplay(dayStr)}\nMONTO ESTIMADO: ${formatCurrency(due.amount)}\nESTADO: ${due.status.toUpperCase()}`);
      });

      dayCell.appendChild(badge);
    });

    calendarDaysContainer.appendChild(dayCell);
  }
}

// INICIALIZACION
updateUI();
syncClientTotalsToServer();
