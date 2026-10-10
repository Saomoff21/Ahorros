// Netlify Serverless Function for iOS Shortcuts Webhook
// Compatible with both Netlify and external HTTPS invocations

export async function handler(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    let payload = {};
    if (event.httpMethod === 'GET') {
      payload = event.queryStringParameters || {};
    } else {
      try {
        payload = JSON.parse(event.body || '{}');
      } catch (e) {
        payload = event.queryStringParameters || {};
      }
    }

    // Extraer clave o código de bóveda
    const headerKey = (event.headers && (event.headers['x-api-key'] || event.headers['X-Api-Key'])) || '';
    const key = (headerKey || payload.key || payload.apiKey || payload.token || payload.clave || payload.vaultId || payload.vault || payload.boveda || '').trim();

    if (!key) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'Clave de atajo requerida. Incluye el parámetro key=TU_CLAVE o vault=TU_BOVEDA.',
          speech: 'Error: Clave de atajo no proporcionada. Por favor verifica la configuración de tu atajo.'
        })
      };
    }

    // Parámetros flexibles
    const rawType = payload.type || payload.tipo || 'expense';
    const rawAmount = payload.amount !== undefined ? payload.amount : (payload.monto !== undefined ? payload.monto : (payload.valor !== undefined ? payload.valor : payload.value));
    const rawDesc = payload.description || payload.desc || payload.concepto || payload.detalle || payload.title || payload.item || '';
    const rawCategory = payload.category || payload.categoria || payload.cat || '';
    const rawMethod = payload.paymentMethod || payload.account || payload.metodo || payload.cuenta || payload.banco || 'NEQUI';
    const rawDate = payload.date || payload.fecha || '';

    // Normalizar tipo
    const normType = String(rawType || '').toLowerCase().trim();
    const isIncome = ['income', 'ingreso', 'entrada'].includes(normType);
    const cleanType = isIncome ? 'income' : 'expense';

    // Normalizar monto
    let numAmount = 0;
    if (typeof rawAmount === 'number') {
      numAmount = Math.abs(rawAmount);
    } else if (rawAmount) {
      let s = String(rawAmount).replace(/[^\d.,]/g, '').trim();
      if (s.includes('.') && s.includes(',')) {
        if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
          s = s.replace(/\./g, '').replace(',', '.');
        } else {
          s = s.replace(/,/g, '');
        }
      } else if (s.includes('.')) {
        const parts = s.split('.');
        if (parts.length > 2 || parts[1].length === 3) {
          s = s.replace(/\./g, '');
        }
      } else if (s.includes(',')) {
        const parts = s.split(',');
        if (parts.length > 2 || parts[1].length === 3) {
          s = s.replace(/,/g, '');
        } else {
          s = parts[0] + '.' + parts[1];
        }
      }
      numAmount = Math.abs(parseFloat(s) || 0);
    }

    if (!numAmount || numAmount <= 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'El monto ingresado debe ser mayor a 0.',
          speech: 'Error: El monto ingresado no es válido o está vacío.'
        })
      };
    }

    const cleanDesc = (String(rawDesc || (isIncome ? 'INGRESO DESDE ATAJO' : 'GASTO DESDE ATAJO'))).trim().toUpperCase();
    const cleanCat = (String(rawCategory || (isIncome ? 'SALARIO / TRABAJO' : 'ALIMENTACION'))).trim().toUpperCase();
    const cleanMethod = (String(rawMethod || 'NEQUI')).trim().toUpperCase();

    let cleanDate = String(rawDate || '').trim();
    if (!cleanDate || !/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
      const now = new Date();
      cleanDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }

    // Resolver ID de la Bóveda en Firestore
    let targetVaultId = key;
    // Si la clave es un token AHO-SC-..., buscar en shortcut_keys qué bóveda le corresponde
    try {
      const lookupRes = await fetch(`https://firestore.googleapis.com/v1/projects/ahorros-sa/databases/(default)/documents/shortcut_keys/${encodeURIComponent(key)}`);
      if (lookupRes.ok) {
        const lookupData = await lookupRes.json();
        if (lookupData.fields && lookupData.fields.vaultId && lookupData.fields.vaultId.stringValue) {
          targetVaultId = lookupData.fields.vaultId.stringValue;
        }
      }
    } catch (e) {
      console.warn('Lookup key warning:', e);
    }

    const nowIso = new Date().toISOString();

    // Guardar directamente en Google Cloud Firestore
    const firestoreBody = {
      fields: {
        type: { stringValue: cleanType },
        amount: { doubleValue: numAmount },
        description: { stringValue: cleanDesc },
        category: { stringValue: cleanCat },
        paymentMethod: { stringValue: cleanMethod },
        date: { stringValue: cleanDate },
        createdAt: { stringValue: nowIso },
        source: { stringValue: 'iphone_shortcut' },
        apiKey: { stringValue: key },
        vaultId: { stringValue: targetVaultId }
      }
    };

    const fsRes = await fetch(`https://firestore.googleapis.com/v1/projects/ahorros-sa/databases/(default)/documents/vaults/${encodeURIComponent(targetVaultId)}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(firestoreBody)
    });

    const formattedAmount = '$ ' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(numAmount);
    const typeLabel = isIncome ? 'Ingreso' : 'Gasto';
    const methodLabel = cleanMethod === 'EFECTIVO' ? 'en Efectivo físico' : `con ${cleanMethod}`;
    const speechText = `${typeLabel} de ${formattedAmount} ${methodLabel} registrado en ${cleanCat}. Tu saldo ha sido actualizado en la nube.`;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: speechText,
        speech: speechText,
        transaction: {
          type: cleanType,
          amount: numAmount,
          description: cleanDesc,
          category: cleanCat,
          paymentMethod: cleanMethod,
          date: cleanDate,
          vaultId: targetVaultId,
          createdAt: nowIso
        }
      })
    };

  } catch (err) {
    console.error('Error in shortcut handler:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: err.message,
        speech: 'Ocurrió un error al procesar el atajo.'
      })
    };
  }
}
