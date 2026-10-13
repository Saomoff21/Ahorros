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
  
  // Decodificador seguro para tolerar acentos y caracteres especiales de iOS Shortcuts
  const safeDecode = (val) => {
    if (!val) return '';
    const s = String(val).trim();
    try {
      return decodeURIComponent(s.replace(/\+/g, ' '));
    } catch(e) {
      return s;
    }
  };

  // Parámetros flexibles para tolerar cualquier nombre usado en la app de Atajos de iOS
  const rawType = safeDecode(payload.type || payload.tipo || req.forcedType || '');
  let rawAmount = payload.amount !== undefined ? payload.amount : (payload.monto !== undefined ? payload.monto : (payload.valor !== undefined ? payload.valor : (payload.precio !== undefined ? payload.precio : (payload.total !== undefined ? payload.total : payload.value))));
  let rawDescription = safeDecode(payload.description || payload.desc || payload.concepto || payload.detalle || payload.title || payload.item || payload.nombre || payload.motivo || payload.nota || '');
  let rawCategory = safeDecode(payload.category || payload.categoria || payload.cat || payload.rubro || '');
  const rawDate = safeDecode(payload.date || payload.fecha || '');
  let rawMethod = safeDecode(payload.paymentMethod || payload.account || payload.metodo || payload.cuenta || payload.metodoPago || payload.banco || payload.medio || payload.formaPago || '');
  const returnFormat = String(payload.format || payload.modo || (payload.text ? 'text' : '')).toLowerCase();

  // Limpieza de marcadores de posición no reemplazados en iOS Shortcuts
  const isPlaceholder = (val) => {
    if (!val) return false;
    const s = String(val).trim();
    return s.includes('[Variable_') || s.includes('[Monto]') || s.includes('[Metodo]') || s.includes('[Categoria]') || s.includes('[Detalle]') || s.includes('[Cuenta]') || s.includes('[Tipo]');
  };

  const hasAmountPlaceholder = isPlaceholder(rawAmount);

  // Normalizar y validar tipo (si no se especifica, por defecto es 'gasto')
  let normalizedType = String(rawType || '').trim().toLowerCase();
  if (!normalizedType || isPlaceholder(normalizedType)) {
    normalizedType = 'gasto';
  }
  
  const isIncome = ['income', 'ingreso', 'entrada', 'sueldo', 'cobro'].includes(normalizedType);
  const cleanType = isIncome ? 'income' : 'expense';

  // Normalizar monto
  let numericAmount = hasAmountPlaceholder ? 0 : parseNumericAmount(rawAmount);

  // Rescate inteligente: si numericAmount es 0 pero rawDescription contiene un número (ej: "35000 almuerzo" o "50000")
  if ((!numericAmount || numericAmount <= 0) && rawDescription && !isPlaceholder(rawDescription)) {
    const match = String(rawDescription).match(/\b\d{3,9}\b/);
    if (match) {
      numericAmount = parseInt(match[0], 10);
      rawDescription = String(rawDescription).replace(match[0], '').replace(/\$|\bCOP\b/gi, '').trim();
    }
  }

  if (!numericAmount || numericAmount <= 0) {
    if (hasAmountPlaceholder) {
      const errorMsg = 'En tu iPhone dejaste el texto [Monto] en vez de la variable azul. En la app Atajos, toca donde dice [Monto], bórralo y selecciona la burbuja azul "¿Cuánto gastaste?" que aparece directamente arriba de tu teclado.';
      if (returnFormat === 'text') return res.status(200).type('text/plain').send('Atención: ' + errorMsg);
      return res.status(400).json({
        success: false,
        error: errorMsg,
        speech: 'Atención: En tu iPhone debes vincular la variable azul ¿Cuánto gastaste? sobre el teclado en lugar del texto escrito Monto.'
      });
    }

    const errorMsg = 'El monto debe ser un número mayor a 0.';
    if (returnFormat === 'text') return res.status(200).type('text/plain').send('Atención: ' + errorMsg);
    return res.status(400).json({
      success: false,
      error: errorMsg,
      speech: 'Error: El monto ingresado no es válido o está vacío.'
    });
  }

  // Quitar acentos a strings para normalización interna
  const removeAccents = (str) => String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Normalizar descripción preliminar
  let cleanDescription = String(rawDescription || '').trim();
  if (isPlaceholder(cleanDescription) || ['UNDEFINED', 'NULL', '[ENTRADA]', '[ENTRADA2]', '[DETALLE]', '[CONCEPTO]'].includes(cleanDescription.toUpperCase())) {
    cleanDescription = '';
  }

  // Normalizar categoría
  let cleanCategory = removeAccents(rawCategory || '').trim().toUpperCase();
  if (isPlaceholder(cleanCategory)) {
    cleanCategory = '';
  }

  // Auto-detección inteligente de categoría basada en concepto si no viene o viene por defecto
  const descLower = cleanDescription.toLowerCase();
  if (!cleanCategory || cleanCategory === 'ALIMENTACION' || cleanCategory === 'OTROS') {
    if (descLower.includes('uber') || descLower.includes('didi') || descLower.includes('taxi') || descLower.includes('gasolina') || descLower.includes('transmilenio') || descLower.includes('pasaje') || descLower.includes('bus') || descLower.includes('peaje')) {
      cleanCategory = 'TRANSPORTE';
    } else if (descLower.includes('arriendo') || descLower.includes('alquiler') || descLower.includes('luz') || descLower.includes('agua') || descLower.includes('gas') || descLower.includes('internet') || descLower.includes('claro') || descLower.includes('tigo') || descLower.includes('servicios') || descLower.includes('condominio')) {
      cleanCategory = 'VIVIENDA Y SERVICIOS';
    } else if (descLower.includes('medico') || descLower.includes('medicina') || descLower.includes('farmacia') || descLower.includes('drogueria') || descLower.includes('salud') || descLower.includes('cita') || descLower.includes('doctor')) {
      cleanCategory = 'SALUD Y BIENESTAR';
    } else if (descLower.includes('cine') || descLower.includes('concierto') || descLower.includes('fiesta') || descLower.includes('bar') || descLower.includes('cerveza') || descLower.includes('videojuego') || descLower.includes('ocio')) {
      cleanCategory = 'ENTRETENIMIENTO Y OCIO';
    } else if (descLower.includes('salario') || descLower.includes('sueldo') || descLower.includes('nomina') || descLower.includes('honorarios') || descLower.includes('quincena') || descLower.includes('trabajo')) {
      cleanCategory = 'SALARIO / TRABAJO';
    } else if (descLower.includes('almuerzo') || descLower.includes('cena') || descLower.includes('desayuno') || descLower.includes('mercado') || descLower.includes('restaurante') || descLower.includes('hamburguesa') || descLower.includes('comida')) {
      cleanCategory = 'ALIMENTACION';
    } else if (!cleanCategory) {
      cleanCategory = isIncome ? 'SALARIO / TRABAJO' : 'ALIMENTACION';
    }
  }

  // Si no se proporcionó concepto pero sí categoría, usar la categoría como concepto
  if (!cleanDescription) {
    cleanDescription = cleanCategory;
  }

  // Fecha (YYYY-MM-DD) y hora exacta
  const now = new Date();
  let cleanDate = String(rawDate || '').trim();
  if (!cleanDate || !/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
    cleanDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
  const cleanTime = now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

  // Normalizar método de pago
  let rawMUpper = removeAccents(rawMethod).trim().toUpperCase();
  let cleanPaymentMethod = 'NEQUI';
  if (rawMUpper.includes('EFECT') || rawMUpper.includes('CASH') || rawMUpper.includes('MANO') || rawMUpper.includes('FISIC')) {
    cleanPaymentMethod = 'EFECTIVO';
  } else if (rawMUpper.includes('DAVI')) {
    cleanPaymentMethod = 'DAVIPLATA';
  } else if (rawMUpper.includes('BANCOLOMBIA') || rawMUpper.includes('BANCO') || rawMUpper.includes('PSE') || rawMUpper.includes('AHORRO')) {
    cleanPaymentMethod = 'BANCO';
  } else if (rawMUpper.includes('CREDIT')) {
    cleanPaymentMethod = 'TARJETA_CREDITO';
  } else if (rawMUpper.includes('DEBIT')) {
    cleanPaymentMethod = 'TARJETA_DEBITO';
  } else if (rawMUpper.includes('NEQUI')) {
    cleanPaymentMethod = 'NEQUI';
  } else if (rawMUpper.includes('OTRO')) {
    cleanPaymentMethod = 'OTRO';
  } else if (rawMUpper) {
    cleanPaymentMethod = rawMUpper;
  } else {
    cleanPaymentMethod = isIncome ? 'BANCO' : 'NEQUI';
  }

  const newTx = {
    id: 'tx_sc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
    apiKey,
    vaultId: String(payload.vaultId || payload.vault || payload.boveda || '').trim(),
    type: cleanType,
    amount: numericAmount,
    description: cleanDescription,
    category: cleanCategory,
    paymentMethod: cleanPaymentMethod,
    date: cleanDate,
    time: cleanTime,
    createdAt: now.toISOString(),
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
  console.log(`[SHORTCUT SUCCESS] ${typeLabel} $${numericAmount} "${cleanDescription}" via ${cleanPaymentMethod} (${apiKey})`);

  // Soporte para respuestas de texto plano directo para Atajos de iOS
  if (returnFormat === 'text' || req.headers.accept === 'text/plain') {
    return res.type('text/plain').send(speechText);
  }

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
 * Endpoints dedicados directos (alias para atajos de iOS)
 */
app.all('/api/shortcut/gasto', (req, res, next) => {
  req.forcedType = 'gasto';
  req.url = '/api/shortcut/transaction';
  return app._router.handle(req, res, next);
});

app.all('/api/shortcut/ingreso', (req, res, next) => {
  req.forcedType = 'ingreso';
  req.url = '/api/shortcut/transaction';
  return app._router.handle(req, res, next);
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
