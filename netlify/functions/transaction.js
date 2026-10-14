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

  // Responder a peticiones de chequeo de pendientes
  const pathStr = String(event.path || '').toLowerCase();
  if (pathStr.endsWith('/pending') || (event.queryStringParameters && event.queryStringParameters.pending !== undefined)) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, count: 0, transactions: [] })
    };
  }

  if (event.httpMethod === 'DELETE') {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: 'Operación DELETE procesada' })
    };
  }

  try {
    let queryParams = event.queryStringParameters || {};
    let bodyParams = {};
    if (event.body) {
      try {
        bodyParams = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      } catch (e) {
        bodyParams = {};
      }
    }
    // Combinar parámetros de URL y cuerpo para máxima compatibilidad
    const payload = { ...queryParams, ...bodyParams };

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
    let rawAmount = payload.amount !== undefined ? payload.amount : (payload.monto !== undefined ? payload.monto : (payload.valor !== undefined ? payload.valor : payload.value));
    let rawDesc = payload.description || payload.desc || payload.concepto || payload.detalle || payload.title || payload.item || '';
    let rawCategory = payload.category || payload.categoria || payload.cat || '';
    let rawMethod = payload.paymentMethod || payload.account || payload.metodo || payload.cuenta || payload.banco || 'NEQUI';
    const rawDate = payload.date || payload.fecha || '';

    // Normalizar tipo
    const normType = String(rawType || '').toLowerCase().trim();
    const isIncome = ['income', 'ingreso', 'entrada'].includes(normType);
    const cleanType = isIncome ? 'income' : 'expense';

    // Limpieza de marcadores de posición no reemplazados en iOS Shortcuts
    const isPlaceholder = (val) => {
      if (!val) return false;
      const s = String(val).trim();
      return s.includes('[Variable_') || s.includes('[Monto]') || s.includes('[Metodo]') || s.includes('[Categoria]') || s.includes('[Detalle]') || s.includes('[Cuenta]') || s.includes('[Tipo]');
    };

    const hasAmountPlaceholder = isPlaceholder(rawAmount);

    // Si rawAmount vino como texto de placeholder, intentar buscar si el usuario ingresó el monto en la descripción
    let numAmount = 0;
    if (!hasAmountPlaceholder && typeof rawAmount === 'number') {
      numAmount = Math.abs(rawAmount);
    } else if (!hasAmountPlaceholder && rawAmount) {
      let s = String(rawAmount).replace(/[^\d.,]/g, '').trim();
      if (s.includes('.') && s.includes(',')) {
        if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
          s = s.replace(/\./g, '').replace(',', '.');
        } else {
          s = s.replace(/,/g, '');
        }
      } else if (s.includes('.')) {
        const parts = s.split('.');
        if (parts.length > 2 || (parts[1] && parts[1].length === 3)) {
          s = s.replace(/\./g, '');
        }
      } else if (s.includes(',')) {
        const parts = s.split(',');
        if (parts.length > 2 || (parts[1] && parts[1].length === 3)) {
          s = s.replace(/,/g, '');
        } else {
          s = parts[0] + '.' + parts[1];
        }
      }
      numAmount = Math.abs(parseFloat(s) || 0);
    }

    // Rescate inteligente: si numAmount no se pudo leer pero rawDesc contiene números (ej: "35000 almuerzo" o "50000")
    if ((!numAmount || numAmount <= 0) && rawDesc && !isPlaceholder(rawDesc)) {
      const match = String(rawDesc).match(/\b\d{3,9}\b/);
      if (match) {
        numAmount = parseInt(match[0], 10);
        // Limpiar el número de la descripción para que quede solo el concepto
        rawDesc = String(rawDesc).replace(match[0], '').replace(/\$|\bCOP\b/gi, '').trim();
      }
    }

    if (!numAmount || numAmount <= 0) {
      if (hasAmountPlaceholder) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            success: false,
            error: 'En tu iPhone dejaste el texto [Variable_Monto] en vez de la variable azul. En la app Atajos, toca donde dice [Variable_Monto], bórralo y selecciona la burbuja azul "¿Cuánto gastaste?" que aparece directamente arriba de tu teclado.',
            speech: 'Atención: En tu iPhone debes vincular la variable azul ¿Cuánto gastaste? sobre el teclado en lugar del texto escrito Variable Monto.'
          })
        };
      }
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

    // Sanitizar concepto, categoría y método si llegaron como placeholders
    let cleanDesc = isPlaceholder(rawDesc) || !rawDesc ? (isIncome ? 'INGRESO DESDE ATAJO' : 'GASTO DESDE ATAJO') : String(rawDesc).trim().toUpperCase();
    let cleanCat = isPlaceholder(rawCategory) || !rawCategory ? '' : String(rawCategory).trim().toUpperCase();
    let cleanMethod = isPlaceholder(rawMethod) || !rawMethod ? 'NEQUI' : String(rawMethod).trim().toUpperCase();

    // Auto-detección inteligente de categoría si vino vacía o por defecto
    const descLower = cleanDesc.toLowerCase();
    if (!cleanCat || cleanCat === 'ALIMENTACION' || cleanCat === 'OTROS') {
      if (descLower.includes('uber') || descLower.includes('didi') || descLower.includes('taxi') || descLower.includes('gasolina') || descLower.includes('pasaje') || descLower.includes('bus')) {
        cleanCat = 'TRANSPORTE';
      } else if (descLower.includes('arriendo') || descLower.includes('luz') || descLower.includes('agua') || descLower.includes('gas') || descLower.includes('internet') || descLower.includes('servicios')) {
        cleanCat = 'VIVIENDA Y SERVICIOS';
      } else if (descLower.includes('medico') || descLower.includes('farmacia') || descLower.includes('drogueria') || descLower.includes('salud')) {
        cleanCat = 'SALUD Y BIENESTAR';
      } else if (descLower.includes('cine') || descLower.includes('cerveza') || descLower.includes('fiesta') || descLower.includes('bar')) {
        cleanCat = 'ENTRETENIMIENTO Y OCIO';
      } else if (descLower.includes('salario') || descLower.includes('sueldo') || descLower.includes('nomina') || descLower.includes('honorarios')) {
        cleanCat = 'SALARIO / TRABAJO';
      } else if (!cleanCat) {
        cleanCat = isIncome ? 'SALARIO / TRABAJO' : 'ALIMENTACION';
      }
    }

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

    const now = new Date();
    const nowIso = now.toISOString();

    // CONTROL DE IDEMPOTENCIA Y DEDUPLICACIÓN EN FIRESTORE
    // Consultar las transacciones recientes para prevenir registros dobles causados por reintentos de red o envíos dobles en <60s
    try {
      const recentRes = await fetch(`https://firestore.googleapis.com/v1/projects/ahorros-sa/databases/(default)/documents/vaults/${encodeURIComponent(targetVaultId)}/transactions?pageSize=15`);
      if (recentRes.ok) {
        const recentData = await recentRes.json();
        const docs = recentData.documents || [];
        const isDuplicate = docs.some(d => {
          const f = d.fields || {};
          const fAmt = f.amount ? (f.amount.doubleValue || f.amount.integerValue || 0) : 0;
          const fType = f.type ? f.type.stringValue : '';
          const fDesc = f.description ? f.description.stringValue : '';
          const fDate = f.date ? f.date.stringValue : '';
          const fCreated = f.createdAt ? f.createdAt.stringValue : '';

          if (Math.abs(fAmt - numAmount) > 0.01) return false;
          if (fType !== cleanType) return false;
          if (fDesc !== cleanDesc) return false;
          if (fDate && cleanDate && fDate !== cleanDate) return false;

          if (fCreated) {
            const ageMs = Math.abs(now.getTime() - new Date(fCreated).getTime());
            return ageMs < 60000; // Recibido en los últimos 60 segundos
          }
          return false;
        });

        if (isDuplicate) {
          console.log(`[NETLIFY DEDUPLICATION] Duplicado evitado dentro de 60s en bóveda ${targetVaultId}`);
          const formattedAmount = '$ ' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(numAmount);
          const typeLabel = isIncome ? 'Ingreso' : 'Gasto';
          const methodLabel = cleanMethod === 'EFECTIVO' ? 'en Efectivo físico' : `con ${cleanMethod}`;
          const speechText = `${typeLabel} de ${formattedAmount} ${methodLabel} registrado en ${cleanCat}. Tu saldo ha sido actualizado en la nube.`;

          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              success: true,
              deduplicated: true,
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
        }
      }
    } catch (dedupErr) {
      console.warn('Advertencia en comprobación de duplicados:', dedupErr);
    }

    const txId = 'tx_sc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

    // Guardar directamente en Google Cloud Firestore con identificador único
    const firestoreBody = {
      fields: {
        id: { stringValue: txId },
        localId: { stringValue: txId },
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

    const fsRes = await fetch(`https://firestore.googleapis.com/v1/projects/ahorros-sa/databases/(default)/documents/vaults/${encodeURIComponent(targetVaultId)}/transactions?documentId=${encodeURIComponent(txId)}`, {
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
          id: txId,
          localId: txId,
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
