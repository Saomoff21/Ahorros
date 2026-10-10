import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// Ensure data directory exists
const DATA_DIR = join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const SHORTCUTS_FILE = join(DATA_DIR, 'shortcuts.json');
if (!fs.existsSync(SHORTCUTS_FILE)) {
  fs.writeFileSync(SHORTCUTS_FILE, JSON.stringify({ users: {}, transactions: [] }, null, 2));
}

function loadData() {
  try {
    const raw = fs.readFileSync(SHORTCUTS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading shortcuts data:', err);
    return { users: {}, transactions: [] };
  }
}

function saveData(data) {
  try {
    fs.writeFileSync(SHORTCUTS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error saving shortcuts data:', err);
  }
}

// Format COP currency
function formatCurrency(amount) {
  return '$ ' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(amount);
}

// CORS & Parsing Middlewares
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper to extract API key or Vault Code from request
function extractApiKey(req) {
  const headerKey = req.headers['x-api-key'] || req.headers['x-vault-id'];
  if (headerKey) return String(headerKey).trim();

  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.replace('Bearer ', '').trim();
  }

  const queryKey = req.query.key || req.query.apiKey || req.query.token || req.query.clave || req.query.vaultId || req.query.vault || req.query.boveda;
  if (queryKey) return String(queryKey).trim();

  const bodyKey = req.body && (req.body.key || req.body.apiKey || req.body.token || req.body.clave || req.body.vaultId || req.body.vault || req.body.boveda);
  if (bodyKey) return String(bodyKey).trim();

  return null;
}

// Resilient currency & number parser supporting both Latin American and US notations
function parseNumericAmount(raw) {
  if (typeof raw === 'number') {
    return isNaN(raw) ? 0 : Math.abs(raw);
  }
  if (!raw) return 0;
  let s = String(raw).trim();
  // Eliminar signos monetarios y letras
  s = s.replace(/[^\d.,]/g, '');
  if (!s) return 0;

  // Si contiene ambos '.' y ','
  if (s.includes('.') && s.includes(',')) {
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastComma > lastDot) {
      // Formato Latinoamericano: 1.500.000,50 -> punto miles, coma decimal
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // Formato US: 1,500,000.50 -> coma miles, punto decimal
      s = s.replace(/,/g, '');
    }
    return Math.abs(parseFloat(s) || 0);
  }

  // Si solo contiene '.'
  if (s.includes('.')) {
    const parts = s.split('.');
    if (parts.length > 2) {
      // Múltiples puntos: 1.500.000 -> todos son separadores de miles
      s = s.replace(/\./g, '');
    } else {
      // Un solo punto: si tiene exactamente 3 dígitos después, casi siempre es miles (ej: 25.000 COP)
      if (parts[1].length === 3 && parseInt(parts[0], 10) > 0) {
        s = parts[0] + parts[1];
      } else {
        // Es decimal: 25.5
      }
    }
    return Math.abs(parseFloat(s) || 0);
  }

  // Si solo contiene ','
  if (s.includes(',')) {
    const parts = s.split(',');
    if (parts.length > 2) {
      s = s.replace(/,/g, '');
    } else {
      if (parts[1].length === 3 && parseInt(parts[0], 10) > 0) {
        s = parts[0] + parts[1];
      } else {
        s = parts[0] + '.' + parts[1];
      }
    }
    return Math.abs(parseFloat(s) || 0);
  }

  return Math.abs(parseFloat(s) || 0);
}

// --- API DE ATAJOS DE IPHONE (iOS SHORTCUTS) ---

/**
 * GET /api/shortcut/health
 * Verificación rápida de estado de conexión desde iPhone / navegador
 */
app.get('/api/shortcut/health', (req, res) => {
  res.json({
    success: true,
    status: 'online',
    timestamp: new Date().toISOString(),
    message: 'Servidor de Atajos de iPhone funcionando correctamente'
  });
});

/**
 * ALL /api/shortcut/transaction
 * Endpoint principal que llama el atajo de iOS "Obtener contenido de URL" (acepta GET y POST)
 */
app.all('/api/shortcut/transaction', (req, res) => {
  const apiKey = extractApiKey(req);
  if (!apiKey) {
    return res.status(401).json({
      success: false,
      error: 'Clave de Atajo requerida. Incluye el parámetro key=TU_CLAVE o clave=TU_CLAVE.',
      speech: 'Error: Clave de atajo no proporcionada. Por favor verifica la configuración de tu atajo.'
    });
  }

  const payload = req.method === 'GET' ? req.query : (req.body || {});
  
  // Parámetros flexibles para tolerar cualquier nombre usado en la app de Atajos de iOS
  const rawType = payload.type || payload.tipo || '';
  const rawAmount = payload.amount !== undefined ? payload.amount : (payload.monto !== undefined ? payload.monto : (payload.valor !== undefined ? payload.valor : payload.value));
  const rawDescription = payload.description || payload.desc || payload.concepto || payload.detalle || payload.title || payload.item || '';
  const rawCategory = payload.category || payload.categoria || payload.cat || '';
  const rawDate = payload.date || payload.fecha || '';
  const rawMethod = payload.paymentMethod || payload.account || payload.metodo || payload.cuenta || payload.metodoPago || payload.banco || '';

  // Normalizar y validar tipo (gasto vs ingreso)
  const normalizedType = String(rawType || '').trim().toLowerCase();
  const validTypes = ['gasto', 'expense', 'egreso', 'salida', 'ingreso', 'income', 'entrada'];
  if (!validTypes.includes(normalizedType)) {
    return res.status(400).json({
      success: false,
      error: "Tipo inválido. Usa type=gasto o type=ingreso (o en inglés type=expense / type=income).",
      speech: 'Error: Tipo de movimiento inválido. Especifica si es gasto o ingreso.'
    });
  }

  const isIncome = ['income', 'ingreso', 'entrada'].includes(normalizedType);
  const cleanType = isIncome ? 'income' : 'expense';

  // Normalizar monto
  const numericAmount = parseNumericAmount(rawAmount);
  if (!numericAmount || numericAmount <= 0) {
    return res.status(400).json({
      success: false,
      error: 'El monto debe ser un número mayor a 0.',
      speech: 'Error: El monto ingresado no es válido o está vacío.'
    });
  }

  // Normalizar concepto y categoría
  const cleanDescription = (String(rawDescription || (isIncome ? 'INGRESO DESDE ATAJO' : 'GASTO DESDE ATAJO')))
    .trim()
    .toUpperCase();
  const cleanCategory = (String(rawCategory || (isIncome ? 'SALARIO / TRABAJO' : 'ALIMENTACION')))
    .trim()
    .toUpperCase();

  // Fecha (YYYY-MM-DD)
  let cleanDate = String(rawDate || '').trim();
  if (!cleanDate || !/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
    const now = new Date();
    cleanDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  const cleanPaymentMethod = (String(rawMethod || 'NEQUI'))
    .trim()
    .toUpperCase();

  const newTx = {
    id: 'tx_sc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
    apiKey,
    type: cleanType,
    amount: numericAmount,
    description: cleanDescription,
    category: cleanCategory,
    paymentMethod: cleanPaymentMethod,
    date: cleanDate,
    createdAt: new Date().toISOString(),
    source: 'iphone_shortcut',
    syncedToCloud: false
  };

  const data = loadData();
  data.transactions.push(newTx);

  // Actualizar métricas del usuario en caché
  if (!data.users[apiKey]) {
    data.users[apiKey] = {
      apiKey,
      balance: 0,
      totalIncome: 0,
      totalExpense: 0,
      lastUpdated: new Date().toISOString()
    };
  }

  const userStats = data.users[apiKey];
  if (cleanType === 'income') {
    userStats.totalIncome = (userStats.totalIncome || 0) + numericAmount;
    userStats.balance = (userStats.balance || 0) + numericAmount;
  } else {
    userStats.totalExpense = (userStats.totalExpense || 0) + numericAmount;
    userStats.balance = (userStats.balance || 0) - numericAmount;
  }
  userStats.lastUpdated = new Date().toISOString();

  saveData(data);

  const formattedAmount = formatCurrency(numericAmount);
  const typeLabel = isIncome ? 'Ingreso' : 'Gasto';
  const methodLabel = cleanPaymentMethod === 'EFECTIVO' ? 'en Efectivo físico' : `con ${cleanPaymentMethod}`;
  const speechText = `${typeLabel} de ${formattedAmount} ${methodLabel} registrado en ${cleanCategory}. Tu saldo estimado es de ${formatCurrency(userStats.balance)}.`;

  return res.json({
    success: true,
    message: speechText,
    speech: speechText,
    transaction: newTx,
    userBalance: userStats.balance,
    formattedBalance: formatCurrency(userStats.balance)
  });
});

/**
 * GET /api/shortcut/pending
 * Obtiene transacciones creadas desde Atajos pendientes de guardar en Firestore
 */
app.get('/api/shortcut/pending', (req, res) => {
  const apiKey = extractApiKey(req);
  const vaultId = String(req.query.vault || req.query.vaultId || req.query.boveda || '').trim();

  if (!apiKey && !vaultId) {
    return res.status(401).json({ success: false, error: 'API key o Vault ID requeridos' });
  }

  const data = loadData();
  const pending = data.transactions.filter(t => {
    if (t.syncedToCloud) return false;
    if (apiKey && t.apiKey === apiKey) return true;
    if (vaultId && (t.apiKey === vaultId || t.vaultId === vaultId)) return true;
    return false;
  });

  // Marcar como sincronizadas
  data.transactions = data.transactions.map(t => {
    const isTarget = (apiKey && t.apiKey === apiKey) || (vaultId && (t.apiKey === vaultId || t.vaultId === vaultId));
    if (isTarget && !t.syncedToCloud) {
      return { ...t, syncedToCloud: true };
    }
    return t;
  });
  saveData(data);

  res.json({
    success: true,
    count: pending.length,
    transactions: pending
  });
});

/**
 * POST /api/shortcut/sync-client
 * El cliente web sincroniza sus totales para que Siri/Atajos tengan el saldo exacto
 */
app.post('/api/shortcut/sync-client', (req, res) => {
  const apiKey = extractApiKey(req);
  if (!apiKey) {
    return res.status(401).json({ success: false, error: 'API key requerida' });
  }

  const { balance, totalIncome, totalExpense, pendingDebts } = req.body;
  const data = loadData();

  data.users[apiKey] = {
    apiKey,
    balance: Number(balance) || 0,
    totalIncome: Number(totalIncome) || 0,
    totalExpense: Number(totalExpense) || 0,
    pendingDebts: Number(pendingDebts) || 0,
    lastUpdated: new Date().toISOString()
  };

  saveData(data);
  res.json({ success: true, message: 'Estado del usuario actualizado en el servidor' });
});

/**
 * GET /api/shortcut/summary
 * Consulta rápida de saldo para Siri o widgets de Atajos
 */
app.get('/api/shortcut/summary', (req, res) => {
  const apiKey = extractApiKey(req);
  if (!apiKey) {
    return res.status(401).json({
      success: false,
      speech: 'Por favor proporciona tu clave de Atajo de Ahorros SA.'
    });
  }

  const data = loadData();
  const userStats = data.users[apiKey] || { balance: 0, totalIncome: 0, totalExpense: 0, pendingDebts: 0 };

  const speech = `Tu saldo disponible es de ${formatCurrency(userStats.balance)}. Ingresos totales: ${formatCurrency(userStats.totalIncome)}. Gastos totales: ${formatCurrency(userStats.totalExpense)}.`;

  res.json({
    success: true,
    balance: userStats.balance,
    formattedBalance: formatCurrency(userStats.balance),
    totalIncome: userStats.totalIncome,
    totalExpense: userStats.totalExpense,
    pendingDebts: userStats.pendingDebts || 0,
    speech
  });
});

// Endpoint para descargar el proyecto completo empaquetado en ZIP
app.get('/api/download-zip', async (req, res) => {
  try {
    const { execSync } = await import('child_process');
    const pyScript = `import zipfile, os
files = ['index.html', 'login.html', 'script.js', 'styles.css', 'manifest.json', 'sw.js', 'icon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'firebase-applet-config.json', 'firestore.rules']
with zipfile.ZipFile('ahorros-sa-web.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        if os.path.exists(f):
            z.write(f)
`;
    execSync(`python3 -c "${pyScript.replace(/\n/g, '; ')}"`);
  } catch (err) {
    console.error('Error creating zip:', err);
  }
  const zipPath = join(__dirname, 'ahorros-sa-web.zip');
  if (fs.existsSync(zipPath)) {
    res.setHeader('Content-Disposition', 'attachment; filename="ahorros-sa-web.zip"');
    res.setHeader('Content-Type', 'application/zip');
    res.download(zipPath, 'ahorros-sa-web.zip');
  } else {
    res.status(500).json({ error: 'No se pudo generar el archivo ZIP' });
  }
});

// Serve static assets from project root
app.use(express.static(__dirname));

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
