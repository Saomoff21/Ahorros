// AHORROS SA - SISTEMA DE GESTION FINANCIERA & ATAJOS DE IPHONE
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut,
  signInAnonymously
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
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
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

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
    authInfo: {
      userId: auth.currentUser?.uid || null,
      email: auth.currentUser?.email || null,
      emailVerified: auth.currentUser?.emailVerified || null,
      isAnonymous: auth.currentUser?.isAnonymous || null,
      tenantId: auth.currentUser?.tenantId || null,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
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

// ESTADO GLOBAL DE LA APLICACION
let currentUser = null;
let userApiKey = localStorage.getItem('ahorros_shortcut_key') || generateApiKey();
let transactions = JSON.parse(localStorage.getItem('finances_v10_trans')) || [];
let debts = JSON.parse(localStorage.getItem('finances_v10_debts')) || [];
let savingsGoals = JSON.parse(localStorage.getItem('finances_v10_goals')) || [];
let recurringPayments = JSON.parse(localStorage.getItem('finances_v10_recurring')) || [];
let shortcutEvents = [];

let activeYear = '2026';
let activeMonth = 'ALL';
let activeMedium = 'ALL'; // 'ALL', 'FISICO', 'DIGITAL'
let activeMethod = 'ALL'; // 'ALL', 'EFECTIVO', 'NEQUI', 'DAVIPLATA', 'BANCO', 'TARJETA_DEBITO', 'TARJETA_CREDITO', 'OTRO'
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
  const key = 'ahorros_' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
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

// CONTROL DE PESTAÑAS
const tabButtons = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    tabButtons.forEach(b => b.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));

    btn.classList.add('active');
    const target = document.getElementById(btn.dataset.tab);
    if (target) {
      target.classList.add('active');
      if (btn.dataset.tab === 'tab-charts') renderCharts();
      else if (btn.dataset.tab === 'tab-debts') renderCalendar();
      else if (btn.dataset.tab === 'tab-savings') renderSavingsGoals();
      else if (btn.dataset.tab === 'tab-recurring') renderRecurringPayments();
    }
  });
});

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
const vaultLinkCodeInput = document.getElementById('vault-link-code-input');
const btnLinkVault = document.getElementById('btn-link-vault');
const vaultGoogleEmail = document.getElementById('vault-google-email');
const vaultGoogleNote = document.getElementById('vault-google-note');
const btnVaultGoogleLogin = document.getElementById('btn-vault-google-login');

// URL COMPARTIDA LIMPIA
const appOrigin = window.location.origin || 'https://gen-lang-client-0791489226.web.app';
const publicSharedOrigin = appOrigin;
if (pwaShareUrlInput) pwaShareUrlInput.value = appOrigin;
if (pwaQrImg) {
  pwaQrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(appOrigin)}`;
}

// MODAL DE FIREBASE HOSTING (SITIO INDEPENDIENTE)
const btnFirebaseHosting = document.getElementById('btn-firebase-hosting');
const firebaseHostingModal = document.getElementById('firebase-hosting-modal');
const btnCloseFirebaseModal = document.getElementById('btn-close-firebase-modal');
const btnCopyFirebaseDomain = document.getElementById('btn-copy-firebase-domain');
const firebaseDomainUrlEl = document.getElementById('firebase-domain-url');

if (btnFirebaseHosting && firebaseHostingModal) {
  btnFirebaseHosting.addEventListener('click', () => {
    firebaseHostingModal.classList.remove('hidden');
  });
}

if (btnCloseFirebaseModal && firebaseHostingModal) {
  btnCloseFirebaseModal.addEventListener('click', () => {
    firebaseHostingModal.classList.add('hidden');
  });
}

if (firebaseHostingModal) {
  firebaseHostingModal.addEventListener('click', (e) => {
    if (e.target === firebaseHostingModal) firebaseHostingModal.classList.add('hidden');
  });
}

if (btnCopyFirebaseDomain && firebaseDomainUrlEl) {
  btnCopyFirebaseDomain.addEventListener('click', () => {
    navigator.clipboard.writeText(firebaseDomainUrlEl.textContent.trim()).then(() => {
      btnCopyFirebaseDomain.textContent = '¡Copiado!';
      setTimeout(() => { btnCopyFirebaseDomain.textContent = 'Copiar'; }, 2000);
    });
  });
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
    navigator.clipboard.writeText(vaultCodeText.textContent).then(() => {
      btnCopyVaultCode.textContent = '¡Copiado!';
      setTimeout(() => { btnCopyVaultCode.textContent = 'Copiar Código'; }, 2000);
    });
  });
}

if (btnLinkVault && vaultLinkCodeInput) {
  btnLinkVault.addEventListener('click', () => {
    const code = vaultLinkCodeInput.value.trim().toUpperCase();
    if (!code) return alert('Por favor ingresa un código de Bóveda válido.');
    localStorage.setItem('ahorros_boveda_code', code);
    if (vaultCodeText) vaultCodeText.textContent = code;
    alert(`¡Bóveda ${code} vinculada! Tus dispositivos ahora sincronizan sobre la misma bóveda.`);
    if (vaultModal) vaultModal.classList.add('hidden');
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

// INICIALIZACION DE CREDENCIALES DE ATAJOS
function updateShortcutCredentialsUI() {
  const webhookUrl = `${publicSharedOrigin}/api/shortcut/transaction`;
  if (shortcutApiKeyEl) shortcutApiKeyEl.textContent = userApiKey;
  if (shortcutWebhookUrlEl) shortcutWebhookUrlEl.textContent = webhookUrl;
}
updateShortcutCredentialsUI();

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

// GESTION DE SESION Y BÓVEDA EN LA NUBE (ZERO FRICCIÓN DE LOGINS)
if (btnVaultGoogleLogin) {
  btnVaultGoogleLogin.addEventListener('click', async () => {
    if (currentUser && !currentUser.isAnonymous) {
      if (confirm('¿Cerrar sesión de Google? Continuarás con tu Bóveda local y en la nube.')) {
        await signOut(auth);
      }
    } else {
      try {
        const result = await signInWithPopup(auth, googleProvider);
        console.log('Cuenta de Google vinculada:', result.user.email);
        alert(`¡Cuenta vinculada con éxito a ${result.user.email}!`);
      } catch (error) {
        console.error('Error al vincular con Google:', error);
        alert('No se pudo vincular con Google. Tu Bóveda sigue activa y sincronizada anónimamente.');
      }
    }
  });
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    // Si no hay usuario, iniciar sesión anónima automáticamente sin pedir contraseña
    try {
      await signInAnonymously(auth);
      return;
    } catch (e) {
      console.warn('Fallo al iniciar sesión anónima:', e);
      authBtnText.textContent = '🔐 MI BÓVEDA';
      updateSyncStatus(false, 'MODO LOCAL');
      return;
    }
  }

  currentUser = user;
  const isAnon = user.isAnonymous;
  const vaultCode = localStorage.getItem('ahorros_boveda_code') || ('AHORROS-' + user.uid.substring(0, 6).toUpperCase());
  localStorage.setItem('ahorros_boveda_code', vaultCode);

  if (vaultCodeText) vaultCodeText.textContent = vaultCode;
  if (vaultGoogleEmail) {
    vaultGoogleEmail.textContent = isAnon ? 'No vinculado (Bóveda sin correo)' : (user.email || 'Vinculado');
  }
  if (vaultGoogleNote) {
    vaultGoogleNote.textContent = isAnon ? 'Tus finanzas se sincronizan en la nube sin claves' : 'Sincronizado con tu cuenta de Google';
  }
  if (btnVaultGoogleLogin) {
    btnVaultGoogleLogin.textContent = isAnon ? 'Vincular Google' : 'Desvincular Google';
  }

  authBtnText.textContent = isAnon ? '🔐 MI BÓVEDA' : `MI CUENTA (${(user.email || 'USER').split('@')[0].toUpperCase()})`;
  updateSyncStatus(true, isAnon ? '🟢 NUBE ACTIVA' : `NUBE: ${user.email}`);

  try {
    const userRef = doc(db, 'users', user.uid);
    const userDoc = await getDoc(userRef);
    if (userDoc.exists()) {
      const uData = userDoc.data();
      if (uData.apiKey) {
        userApiKey = uData.apiKey;
        localStorage.setItem('ahorros_shortcut_key', userApiKey);
        updateShortcutCredentialsUI();
      }
    } else {
      await setDoc(userRef, {
        uid: user.uid,
        email: user.email || null,
        isAnonymous: isAnon,
        bovedaCode: vaultCode,
        apiKey: userApiKey,
        createdAt: new Date().toISOString()
      });
    }
  } catch (e) {
    handleFirestoreError(e, OperationType.WRITE, `users/${user.uid}`);
  }

  await migrateLocalDataToCloud(user.uid);
  setupCloudListeners(user.uid);
});

// MIGRACION AUTOMATICA DE DATOS LOCALES A FIRESTORE
async function migrateLocalDataToCloud(userId) {
  const localTrans = JSON.parse(localStorage.getItem('finances_v10_trans')) || [];
  const localDebts = JSON.parse(localStorage.getItem('finances_v10_debts')) || [];
  const localGoals = JSON.parse(localStorage.getItem('finances_v10_goals')) || [];
  const localRecurring = JSON.parse(localStorage.getItem('finances_v10_recurring')) || [];

  if (localTrans.length > 0) {
    try {
      const txColl = collection(db, 'users', userId, 'transactions');
      const existingSnap = await getDocs(txColl);
      if (existingSnap.empty) {
        for (const t of localTrans) {
          await addDoc(txColl, {
            ...t,
            userId,
            createdAt: t.createdAt || new Date().toISOString()
          });
        }
      }
    } catch (err) { console.warn('Error al migrar transacciones:', err); }
  }

  if (localDebts.length > 0) {
    try {
      const debtColl = collection(db, 'users', userId, 'debts');
      const existingDebtSnap = await getDocs(debtColl);
      if (existingDebtSnap.empty) {
        for (const d of localDebts) {
          await addDoc(debtColl, {
            ...d,
            userId,
            createdAt: d.createdAt || new Date().toISOString()
          });
        }
      }
    } catch (err) { console.warn('Error al migrar deudas:', err); }
  }

  if (localGoals.length > 0) {
    try {
      const gColl = collection(db, 'users', userId, 'savingsGoals');
      const existingGSnap = await getDocs(gColl);
      if (existingGSnap.empty) {
        for (const g of localGoals) {
          await addDoc(gColl, {
            ...g,
            userId,
            createdAt: g.createdAt || new Date().toISOString()
          });
        }
      }
    } catch (err) { console.warn('Error al migrar metas:', err); }
  }

  if (localRecurring.length > 0) {
    try {
      const rColl = collection(db, 'users', userId, 'recurringPayments');
      const existingRSnap = await getDocs(rColl);
      if (existingRSnap.empty) {
        for (const r of localRecurring) {
          await addDoc(rColl, {
            ...r,
            userId,
            createdAt: r.createdAt || new Date().toISOString()
          });
        }
      }
    } catch (err) { console.warn('Error al migrar pagos fijos:', err); }
  }
}

// ESCUCHAS EN TIEMPO REAL CON ONSNAPSHOT
function setupCloudListeners(userId) {
  if (unsubscribeTransactions) unsubscribeTransactions();
  if (unsubscribeDebts) unsubscribeDebts();
  if (unsubscribeGoals) unsubscribeGoals();
  if (unsubscribeRecurring) unsubscribeRecurring();

  const txColl = collection(db, 'users', userId, 'transactions');
  unsubscribeTransactions = onSnapshot(txColl, (snapshot) => {
    const cloudTrans = [];
    snapshot.forEach(docSnap => {
      cloudTrans.push({ id: docSnap.id, ...docSnap.data() });
    });
    transactions = cloudTrans;
    localStorage.setItem('finances_v10_trans', JSON.stringify(transactions));
    updateUI();
  }, (error) => {
    handleFirestoreError(error, OperationType.GET, `users/${userId}/transactions`);
  });

  const debtsColl = collection(db, 'users', userId, 'debts');
  unsubscribeDebts = onSnapshot(debtsColl, (snapshot) => {
    const cloudDebts = [];
    snapshot.forEach(docSnap => {
      cloudDebts.push({ id: docSnap.id, ...docSnap.data() });
    });
    debts = cloudDebts;
    localStorage.setItem('finances_v10_debts', JSON.stringify(debts));
    updateUI();
  }, (error) => {
    handleFirestoreError(error, OperationType.GET, `users/${userId}/debts`);
  });

  const gColl = collection(db, 'users', userId, 'savingsGoals');
  unsubscribeGoals = onSnapshot(gColl, (snapshot) => {
    const cloudGoals = [];
    snapshot.forEach(docSnap => {
      cloudGoals.push({ id: docSnap.id, ...docSnap.data() });
    });
    savingsGoals = cloudGoals;
    localStorage.setItem('finances_v10_goals', JSON.stringify(savingsGoals));
    renderSavingsGoals();
  }, (error) => {
    handleFirestoreError(error, OperationType.GET, `users/${userId}/savingsGoals`);
  });

  const rColl = collection(db, 'users', userId, 'recurringPayments');
  unsubscribeRecurring = onSnapshot(rColl, (snapshot) => {
    const cloudR = [];
    snapshot.forEach(docSnap => {
      cloudR.push({ id: docSnap.id, ...docSnap.data() });
    });
    recurringPayments = cloudR;
    localStorage.setItem('finances_v10_recurring', JSON.stringify(recurringPayments));
    renderRecurringPayments();
  }, (error) => {
    handleFirestoreError(error, OperationType.GET, `users/${userId}/recurringPayments`);
  });
}

// FILTRADO GLOBAL POR AÑO, MES, MEDIO Y MÉTODO
globalFilterYear.addEventListener('change', () => {
  activeYear = globalFilterYear.value;
  updateActivePeriodLabel();
  updateUI();
});

globalFilterMonth.addEventListener('change', () => {
  activeMonth = globalFilterMonth.value;
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
  const cleanTx = {
    type: txData.type,
    description: txData.description,
    amount: txData.amount,
    category: txData.category,
    paymentMethod: txData.paymentMethod || 'EFECTIVO',
    date: txData.date,
    createdAt: new Date().toISOString()
  };

  if (currentUser) {
    try {
      const txColl = collection(db, 'users', currentUser.uid, 'transactions');
      await addDoc(txColl, {
        userId: currentUser.uid,
        ...cleanTx
      });
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, `users/${currentUser.uid}/transactions`);
    }
  } else {
    cleanTx.id = 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    transactions.push(cleanTx);
    localStorage.setItem('finances_v10_trans', JSON.stringify(transactions));
    updateUI();
  }
  syncClientTotalsToServer();
}

// ELIMINACION DE TRANSACCION
window.removeTransaction = async function(idOrIndex) {
  if (!confirm('¿Deseas eliminar esta transacción?')) return;
  if (currentUser && typeof idOrIndex === 'string') {
    try {
      await deleteDoc(doc(db, 'users', currentUser.uid, 'transactions', idOrIndex));
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, `users/${currentUser.uid}/transactions/${idOrIndex}`);
    }
  } else {
    const idx = parseInt(idOrIndex);
    transactions.splice(idx, 1);
    localStorage.setItem('finances_v10_trans', JSON.stringify(transactions));
    updateUI();
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

  const debtData = {
    name: nameVal,
    total: totalVal,
    paid: 0,
    interest: interestVal,
    installments: installmentsVal,
    startDate: startDateVal,
    history: JSON.stringify([]),
    createdAt: new Date().toISOString()
  };

  if (currentUser) {
    try {
      const debtsColl = collection(db, 'users', currentUser.uid, 'debts');
      await addDoc(debtsColl, {
        userId: currentUser.uid,
        ...debtData
      });
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, `users/${currentUser.uid}/debts`);
    }
  } else {
    debtData.id = 'debt_' + Date.now();
    debts.push(debtData);
    localStorage.setItem('finances_v10_debts', JSON.stringify(debts));
    updateUI();
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
    const iconVal = document.getElementById('goal-icon').value || '🎯';
    const dateVal = document.getElementById('goal-date').value || '';

    if (!targetVal || targetVal <= 0) return alert('Ingresa un monto objetivo válido');

    const goalData = {
      name: nameVal,
      targetAmount: targetVal,
      currentAmount: initialVal,
      targetDate: dateVal,
      icon: iconVal,
      createdAt: new Date().toISOString()
    };

    // Si hubo ahorro inicial, registrar la salida correlativa de la cuenta seleccionada
    if (initialVal > 0) {
      await addTransactionLocallyOrCloud({
        type: 'expense',
        date: getTodayStr(),
        description: `AHORRO INICIAL EN META: ${nameVal}`,
        amount: initialVal,
        category: 'OTROS',
        paymentMethod: sourceAcc
      });
    }

    if (currentUser) {
      try {
        const gColl = collection(db, 'users', currentUser.uid, 'savingsGoals');
        await addDoc(gColl, {
          userId: currentUser.uid,
          ...goalData
        });
      } catch (e) {
        handleFirestoreError(e, OperationType.CREATE, `users/${currentUser.uid}/savingsGoals`);
      }
    } else {
      goalData.id = 'goal_' + Date.now();
      savingsGoals.push(goalData);
      localStorage.setItem('finances_v10_goals', JSON.stringify(savingsGoals));
      renderSavingsGoals();
    }

    goalForm.reset();
    document.getElementById('goal-initial').value = '0';
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

    const rData = {
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

    if (currentUser) {
      try {
        const rColl = collection(db, 'users', currentUser.uid, 'recurringPayments');
        await addDoc(rColl, {
          userId: currentUser.uid,
          ...rData
        });
      } catch (e) {
        handleFirestoreError(e, OperationType.CREATE, `users/${currentUser.uid}/recurringPayments`);
      }
    } else {
      rData.id = 'rec_' + Date.now();
      recurringPayments.push(rData);
      localStorage.setItem('finances_v10_recurring', JSON.stringify(recurringPayments));
      renderRecurringPayments();
    }

    recurringForm.reset();
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
  savingsGoals.forEach((g, idx) => {
    totalSavedInGoals += (g.currentAmount || 0);
    const percent = Math.min(100, Math.round(((g.currentAmount || 0) / (g.targetAmount || 1)) * 100));
    const isCompleted = (g.currentAmount || 0) >= (g.targetAmount || 1);
    const goalIdentifier = currentUser ? `'${g.id}'` : idx;

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
  let targetGoal = null;
  if (currentUser) targetGoal = savingsGoals.find(g => g.id === idOrIndex);
  else targetGoal = savingsGoals[idOrIndex];

  if (!targetGoal) return;

  modalGoalId.value = currentUser ? targetGoal.id : idOrIndex;
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
    const accountVal = modalGoalAccount.value;

    if (!amountVal || amountVal <= 0) return alert('Ingresa un monto válido');

    let targetGoal = null;
    if (currentUser) targetGoal = savingsGoals.find(g => g.id === gId);
    else targetGoal = savingsGoals[parseInt(gId)];

    if (!targetGoal) return;

    if (action === 'withdraw' && amountVal > targetGoal.currentAmount) {
      return alert(`No puedes retirar más de lo que tienes ahorrado ($ ${formatCurrency(targetGoal.currentAmount)})`);
    }

    const newAmount = action === 'deposit'
      ? targetGoal.currentAmount + amountVal
      : targetGoal.currentAmount - amountVal;

    // Registrar movimiento correlativo en transacciones
    if (action === 'deposit') {
      await addTransactionLocallyOrCloud({
        type: 'expense',
        description: `AHORRO EN META: ${targetGoal.name}`,
        amount: amountVal,
        category: 'OTROS',
        paymentMethod: accountVal,
        date: getTodayStr()
      });
    } else {
      await addTransactionLocallyOrCloud({
        type: 'income',
        description: `RETIRO DE META: ${targetGoal.name}`,
        amount: amountVal,
        category: 'OTROS',
        paymentMethod: accountVal,
        date: getTodayStr()
      });
    }

    if (currentUser) {
      try {
        await updateDoc(doc(db, 'users', currentUser.uid, 'savingsGoals', targetGoal.id), {
          currentAmount: newAmount
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${currentUser.uid}/savingsGoals/${targetGoal.id}`);
      }
    } else {
      targetGoal.currentAmount = newAmount;
      localStorage.setItem('finances_v10_goals', JSON.stringify(savingsGoals));
      renderSavingsGoals();
    }

    goalActionModal.classList.add('hidden');
  });
}

window.deleteSavingsGoal = async function(idOrIndex) {
  if (!confirm('¿Deseas eliminar esta meta de ahorro?')) return;
  if (currentUser) {
    try {
      await deleteDoc(doc(db, 'users', currentUser.uid, 'savingsGoals', idOrIndex));
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, `users/${currentUser.uid}/savingsGoals/${idOrIndex}`);
    }
  } else {
    savingsGoals.splice(parseInt(idOrIndex), 1);
    localStorage.setItem('finances_v10_goals', JSON.stringify(savingsGoals));
    renderSavingsGoals();
  }
};

// RENDER PAGOS FIJOS Y SUSCRIPCIONES
function renderRecurringPayments() {
  if (!recurringContainer) return;

  const currentYM = getCurrentYearMonth();
  let totalFixedExpenses = 0;

  if (recurringPayments.length === 0) {
    recurringContainer.innerHTML = '<p style="color: var(--text-muted); font-size: 0.82rem; grid-column: 1/-1;">No tienes pagos fijos registrados aún.</p>';
    if (recurringSummaryBadge) recurringSummaryBadge.textContent = 'Total Fijo: $ 0/mes';
    return;
  }

  recurringContainer.innerHTML = '';
  recurringPayments.forEach((r, idx) => {
    if (r.type === 'expense') totalFixedExpenses += r.amount;
    const isPaidThisMonth = r.lastPaidMonth === currentYM;
    const rIdentifier = currentUser ? `'${r.id}'` : idx;

    const card = document.createElement('div');
    card.className = `recurring-card ${isPaidThisMonth ? 'paid' : 'pending'}`;
    card.innerHTML = `
      <div class="recurring-top">
        <div>
          <div class="recurring-name">${r.name}</div>
          <div class="recurring-meta">
            <span>Día ${r.dueDay} de cada mes</span> &bull;
            <span>${r.category}</span> &bull;
            <span>${r.paymentMethod || 'NEQUI'}</span>
          </div>
        </div>
        <button class="btn-delete" onclick="deleteRecurringPayment(${rIdentifier})" title="Eliminar">&times;</button>
      </div>

      <div class="recurring-amount ${r.type === 'income' ? 'text-success' : 'text-danger'}">
        ${formatCurrency(r.amount)} <small style="font-size: 0.72rem; color: var(--text-muted); font-weight: normal;">/ ${r.frequency.toLowerCase()}</small>
      </div>

      <div class="recurring-footer">
        <div>
          ${isPaidThisMonth
            ? '<span class="tag-badge text-success">✓ Pagado este mes</span>'
            : '<span class="tag-badge text-warning">⏳ Pendiente este mes</span>'
          }
        </div>
        ${!isPaidThisMonth ? `
          <button class="btn-quick-pay" onclick="quickPayRecurring(${rIdentifier})">
            ⚡ Pagar / Registrar
          </button>
        ` : `
          <small style="color: var(--text-muted); font-size: 0.7rem;">Registrado en movimientos</small>
        `}
      </div>
    `;
    recurringContainer.appendChild(card);
  });

  if (recurringSummaryBadge) {
    recurringSummaryBadge.textContent = `Total Fijo: ${formatCurrency(totalFixedExpenses)}/mes`;
  }
}

window.quickPayRecurring = async function(idOrIndex) {
  let targetR = null;
  if (currentUser) targetR = recurringPayments.find(r => r.id === idOrIndex);
  else targetR = recurringPayments[idOrIndex];

  if (!targetR) return;

  const currentYM = getCurrentYearMonth();

  // Registrar en movimientos
  await addTransactionLocallyOrCloud({
    type: targetR.type,
    description: `PAGO FIJO: ${targetR.name}`,
    amount: targetR.amount,
    category: targetR.category,
    paymentMethod: targetR.paymentMethod || 'NEQUI',
    date: getTodayStr()
  });

  // Marcar como pagado este mes
  if (currentUser) {
    try {
      await updateDoc(doc(db, 'users', currentUser.uid, 'recurringPayments', targetR.id), {
        lastPaidMonth: currentYM
      });
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `users/${currentUser.uid}/recurringPayments/${targetR.id}`);
    }
  } else {
    targetR.lastPaidMonth = currentYM;
    localStorage.setItem('finances_v10_recurring', JSON.stringify(recurringPayments));
    renderRecurringPayments();
  }

  alert(`¡Pago de "${targetR.name}" registrado en tus movimientos exitosamente!`);
};

window.deleteRecurringPayment = async function(idOrIndex) {
  if (!confirm('¿Deseas eliminar este compromiso recurrente?')) return;
  if (currentUser) {
    try {
      await deleteDoc(doc(db, 'users', currentUser.uid, 'recurringPayments', idOrIndex));
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, `users/${currentUser.uid}/recurringPayments/${idOrIndex}`);
    }
  } else {
    recurringPayments.splice(parseInt(idOrIndex), 1);
    localStorage.setItem('finances_v10_recurring', JSON.stringify(recurringPayments));
    renderRecurringPayments();
  }
};

// ABONAR A DEUDA
window.payDebt = async function(idOrIndex) {
  let targetDebt = null;
  let debtId = null;

  if (currentUser) {
    targetDebt = debts.find(d => d.id === idOrIndex);
    debtId = idOrIndex;
  } else {
    targetDebt = debts[idOrIndex];
    debtId = idOrIndex;
  }

  if (!targetDebt) return;

  const inputEl = document.getElementById(`pay-input-${debtId}`);
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

  await addTransactionLocallyOrCloud({
    type: 'expense',
    date: getTodayStr(),
    description: `ABONO A ${targetDebt.name}`,
    amount: finalAbono,
    category: 'PAGO DE DEUDAS',
    paymentMethod: 'BANCO'
  });

  if (currentUser) {
    try {
      await updateDoc(doc(db, 'users', currentUser.uid, 'debts', targetDebt.id), {
        paid: newPaid,
        history: JSON.stringify(historyArr)
      });
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `users/${currentUser.uid}/debts/${targetDebt.id}`);
    }
  } else {
    targetDebt.paid = newPaid;
    targetDebt.history = JSON.stringify(historyArr);
    localStorage.setItem('finances_v10_debts', JSON.stringify(debts));
    updateUI();
  }

  syncClientTotalsToServer();
};

// ELIMINAR DEUDA
window.removeDebt = async function(idOrIndex) {
  if (!confirm('¿Deseas eliminar esta obligación de deuda?')) return;
  if (currentUser) {
    try {
      await deleteDoc(doc(db, 'users', currentUser.uid, 'debts', idOrIndex));
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, `users/${currentUser.uid}/debts/${idOrIndex}`);
    }
  } else {
    debts.splice(idOrIndex, 1);
    localStorage.setItem('finances_v10_debts', JSON.stringify(debts));
    updateUI();
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
      if (t.type === 'income') totalIncomePeriod += t.amount;
      else totalExpensePeriod += t.amount;

      const deleteIdentifier = currentUser ? `'${t.id}'` : idx;
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

      if (t.type === 'income') incomeList.appendChild(row);
      else expenseList.appendChild(row);

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

  // KPIs
  totalIncomeEl.textContent = formatCurrency(totalIncomePeriod);
  totalExpenseEl.textContent = formatCurrency(totalExpensePeriod);
  const totalBalance = totalIncomeAll - totalExpenseAll;
  totalBalanceEl.textContent = formatCurrency(totalBalance);
  totalBalanceEl.className = `kpi-value ${totalBalance >= 0 ? 'text-primary' : 'text-danger'}`;

  incomePeriodTotal.textContent = formatCurrency(totalIncomePeriod);
  expensePeriodTotal.textContent = formatCurrency(totalExpensePeriod);
  summaryCountBadge.textContent = `${periodItemCount} MOVIMIENTOS`;

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
    const debtIdentifier = currentUser ? `'${d.id}'` : idx;

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
            <input type="text" class="currency-input" id="pay-input-${currentUser ? d.id : idx}" value="${new Intl.NumberFormat('es-CO').format(Math.min(pending, suggestedQuotaAmount))}" style="width: 110px; padding: 4px 6px; font-size: 0.8rem;">
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
