// --- Lógica de Pestañas (Tabs) ---
const tabButtons = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    tabButtons.forEach(b => b.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));

    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
  });
});

// --- Lógica de Tema Oscuro / Claro ---
const themeToggleBtn = document.getElementById('theme-toggle');
const themeIcon = document.getElementById('theme-icon');
const themeText = document.getElementById('theme-text');

let currentTheme = localStorage.getItem('app_theme') || 'light';
document.documentElement.setAttribute('data-theme', currentTheme);
updateThemeUI();

themeToggleBtn.addEventListener('click', () => {
  currentTheme = currentTheme === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', currentTheme);
  localStorage.setItem('app_theme', currentTheme);
  updateThemeUI();
});

function updateThemeUI() {
  if (currentTheme === 'dark') {
    themeIcon.textContent = '☀️';
    themeText.textContent = 'Modo Claro';
  } else {
    themeIcon.textContent = '🌙';
    themeText.textContent = 'Modo Oscuro';
  }
}

// --- Lógica Financiera ---
let transactions = JSON.parse(localStorage.getItem('finances_v9_trans')) || [];
let debts = JSON.parse(localStorage.getItem('finances_v9_debts')) || [];

const transForm = document.getElementById('transaction-form');
const debtForm = document.getElementById('debt-form');

const incomeList = document.getElementById('income-list');
const expenseList = document.getElementById('expense-list');
const debtList = document.getElementById('debt-list');

const totalIncomeEl = document.getElementById('total-income');
const totalExpenseEl = document.getElementById('total-expense');
const totalBalanceEl = document.getElementById('total-balance');
const totalDebtPendingEl = document.getElementById('total-debt-pending');
const alertsContainer = document.getElementById('alerts-container');

// Máscara de moneda
document.querySelectorAll('.currency-input').forEach(input => {
  input.addEventListener('input', (e) => {
    let value = e.target.value.replace(/\D/g, '');
    if (value) {
      e.target.value = new Intl.NumberFormat('es-CO').format(parseInt(value));
    }
  });
});

function formatCurrency(amount) {
  return '$ ' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(amount);
}

function parseAmount(val) {
  return parseFloat(String(val).replace(/\./g, '')) || 0;
}

function formatDateDisplay(dateObj) {
  if (!dateObj) return '';
  let d = new Date(dateObj);
  if (isNaN(d.getTime())) return dateObj;
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const year = d.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

function getTodayStr() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

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

function renderAccelerationSuggestions(pending) {
  if (pending <= 0) return '';

  const targetMonths = [2, 6, 8, 10];
  let cardsHtml = '';

  targetMonths.forEach(m => {
    const suggestedMonthly = Math.ceil(pending / m);
    cardsHtml += `
      <div class="acceleration-card">
        <small>En <strong>${m} meses</strong>:</small>
        <span>${formatCurrency(suggestedMonthly)}/mes</span>
      </div>
    `;
  });

  return `
    <details class="acceleration-details">
      <summary>Plan de Pago Adelantado (2, 6, 8 o 10 meses)</summary>
      <div class="acceleration-grid">
        ${cardsHtml}
      </div>
    </details>
  `;
}

function updateUI() {
  incomeList.innerHTML = '';
  expenseList.innerHTML = '';
  debtList.innerHTML = '';
  alertsContainer.innerHTML = '';

  let incomeSum = 0;
  let expenseSum = 0;
  const today = getTodayStr();

  // 1. Transacciones
  transactions.forEach((t, index) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><strong>${t.description}</strong></td>
      <td><small style="color: var(--text-muted);">${t.category}</small></td>
      <td style="font-weight: 600;" class="${t.type === 'income' ? 'text-success' : 'text-danger'}">
        ${formatCurrency(t.amount)}
      </td>
      <td><button class="btn-delete" onclick="removeTransaction(${index})">&times;</button></td>
    `;

    if (t.type === 'income') {
      incomeSum += t.amount;
      incomeList.appendChild(row);
    } else {
      expenseSum += t.amount;
      expenseList.appendChild(row);
    }
  });

  // 2. Deudas
  let totalDebtPendingSum = 0;
  debts.forEach((d, index) => {
    const interestRate = d.interest || 0;
    const totalWithInterest = d.total + (d.total * (interestRate / 100));
    
    const pending = totalWithInterest - d.paid;
    totalDebtPendingSum += pending;
    const progressPercent = Math.min(100, Math.round((d.paid / totalWithInterest) * 100));

    const historyCount = d.history ? d.history.length : 0;
    const totalInstallments = d.installments || 1;
    const currentQuotaNumber = Math.min(historyCount + 1, totalInstallments);
    const nextDueDateStr = getNextDueDate(d.startDate, historyCount);

    let dueDateStatus = '';
    if (pending > 0) {
      if (nextDueDateStr < today) {
        dueDateStatus = `<span class="tag-badge text-danger">⏰ Cuota ${currentQuotaNumber}/${totalInstallments}: Vencida (${formatDateDisplay(nextDueDateStr)})</span>`;
        showAlert(`Alerta: La cuota ${currentQuotaNumber} de ${d.name} venció el ${formatDateDisplay(nextDueDateStr)}.`, 'danger');
      } else if (nextDueDateStr === today) {
        dueDateStatus = `<span class="tag-badge text-warning">⏰ Cuota ${currentQuotaNumber}/${totalInstallments}: Vence hoy</span>`;
        showAlert(`Recordatorio: Hoy vence la cuota ${currentQuotaNumber} de ${d.name}.`, 'warning');
      } else {
        dueDateStatus = `<span class="tag-badge">📅 Próximo cobro (${currentQuotaNumber}/${totalInstallments}): ${formatDateDisplay(nextDueDateStr)}</span>`;
      }
    }

    let historyHtml = '';
    if (d.history && d.history.length > 0) {
      historyHtml = '<div style="font-size: 0.75rem; margin-top: 6px; color: var(--text-muted);"><strong>Abonos:</strong> ';
      d.history.forEach((h, hIdx) => {
        historyHtml += `<span class="tag-badge">Cuota ${hIdx + 1}: ${formatCurrency(h.amount)}</span> `;
      });
      historyHtml += '</div>';
    }

    const suggestedQuotaAmount = Math.round(totalWithInterest / totalInstallments);
    const accelerationHtml = renderAccelerationSuggestions(pending);
    const interestBadge = interestRate > 0 ? `<span class="tag-badge text-warning">+${interestRate}% int.</span>` : '';

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>
        <strong>${d.name}</strong> ${interestBadge}
        ${dueDateStatus}
      </td>
      <td>
        <small style="color: var(--text-muted);">${formatCurrency(d.paid)} de ${formatCurrency(totalWithInterest)} (${progressPercent}%)</small>
        <div class="progress-bar"><div class="progress-fill" style="width: ${progressPercent}%;"></div></div>
        ${accelerationHtml}
        ${historyHtml}
      </td>
      <td class="text-purple" style="font-weight: 700;">${formatCurrency(pending)}</td>
      <td>
        ${pending > 0 ? `
          <div style="display: flex; gap: 4px;">
            <input type="text" class="currency-input" id="pay-input-${index}" value="${new Intl.NumberFormat('es-CO').format(Math.min(pending, suggestedQuotaAmount))}" style="width: 100px; padding: 4px; font-size: 0.8rem;">
            <button class="btn-pay" onclick="payDebt(${index})">Abonar</button>
          </div>
        ` : '<span class="text-success" style="font-weight: 600;">Liquidada</span>'}
      </td>
      <td><button class="btn-delete" onclick="removeDebt(${index})">&times;</button></td>
    `;

    debtList.appendChild(row);
    const newInput = document.getElementById(`pay-input-${index}`);
    if (newInput) {
      newInput.addEventListener('input', (e) => {
        let val = e.target.value.replace(/\D/g, '');
        if (val) e.target.value = new Intl.NumberFormat('es-CO').format(parseInt(val));
      });
    }
  });

  const balance = incomeSum - expenseSum;

  totalIncomeEl.textContent = formatCurrency(incomeSum);
  totalExpenseEl.textContent = formatCurrency(expenseSum);
  totalBalanceEl.textContent = formatCurrency(balance);
  totalDebtPendingEl.textContent = formatCurrency(totalDebtPendingSum);

  localStorage.setItem('finances_v9_trans', JSON.stringify(transactions));
  localStorage.setItem('finances_v9_debts', JSON.stringify(debts));
}

function showAlert(message, type) {
  const alert = document.createElement('div');
  alert.className = `alert-box alert-${type}`;
  alert.innerHTML = message;
  alertsContainer.appendChild(alert);
}

transForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const type = document.getElementById('type').value;
  const description = document.getElementById('description').value;
  const amountInput = document.getElementById('amount');
  const amount = parseAmount(amountInput.value);
  const category = document.getElementById('category').value;

  if (amount <= 0) return;

  transactions.push({ id: Date.now(), type, description, amount, category });
  transForm.reset();
  updateUI();
});

debtForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('debt-name').value;
  const totalInput = document.getElementById('debt-total');
  const total = parseAmount(totalInput.value);
  const interest = parseFloat(document.getElementById('debt-interest').value) || 0;
  const installments = parseInt(document.getElementById('debt-installments').value) || 1;
  const startDate = document.getElementById('debt-start-date').value;

  if (total <= 0) return;

  debts.push({ id: Date.now(), name, total, interest, installments, startDate, paid: 0, history: [] });
  debtForm.reset();
  document.getElementById('debt-interest').value = '';
  updateUI();
});

function payDebt(index) {
  const payInput = document.getElementById(`pay-input-${index}`);
  const payAmount = parseAmount(payInput.value);

  if (payAmount <= 0) {
    alert("Ingresa un monto válido.");
    return;
  }

  const debt = debts[index];
  const totalWithInterest = debt.total + (debt.total * ((debt.interest || 0) / 100));
  const pending = totalWithInterest - debt.paid;

  if (payAmount > pending) {
    alert(`El abono supera el saldo pendiente (${formatCurrency(pending)}).`);
    return;
  }

  const todayStr = getTodayStr();
  debt.paid += payAmount;
  if (!debt.history) debt.history = [];
  
  const currentQuotaNum = debt.history.length + 1;
  debt.history.push({ date: todayStr, amount: payAmount });

  transactions.push({
    id: Date.now(),
    debtId: debt.id,
    type: 'expense',
    description: `Pago Cuota ${currentQuotaNum}/${debt.installments}: ${debt.name}`,
    amount: payAmount,
    category: 'Pago de Deudas'
  });

  updateUI();
}

function removeTransaction(index) {
  transactions.splice(index, 1);
  updateUI();
}

function removeDebt(index) {
  const debt = debts[index];
  const revertExpenses = confirm(`¿Deseas cancelar la deuda "${debt.name}"?\n\n- Presiona ACEPTAR si la borraste por error/motivo externo y quieres REVERTIR y BORRAR los pagos de la tabla de egresos.\n- Presiona CANCELAR para conservar los egresos ya registrados.`);

  if (revertExpenses) {
    transactions = transactions.filter(t => t.debtId !== debt.id && !t.description.includes(debt.name));
  }

  debts.splice(index, 1);
  updateUI();
}

updateUI();