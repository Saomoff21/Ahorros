// CONTROL DE PESTAÑAS
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

// CONTROL DE TEMA OSCURO / CLARO
const themeToggleBtn = document.getElementById('theme-toggle');
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
  themeText.textContent = currentTheme === 'dark' ? 'MODO CLARO' : 'MODO OSCURO';
}

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

// LOGICA DE FINANZAS
let transactions = JSON.parse(localStorage.getItem('finances_v10_trans')) || [];
let debts = JSON.parse(localStorage.getItem('finances_v10_debts')) || [];

const incomeForm = document.getElementById('income-form');
const expenseForm = document.getElementById('expense-form');
const debtForm = document.getElementById('debt-form');

const incomeList = document.getElementById('income-list');
const expenseList = document.getElementById('expense-list');
const debtList = document.getElementById('debt-list');
const dashboardSummaryList = document.getElementById('dashboard-summary-list');

const totalIncomeEl = document.getElementById('total-income');
const totalExpenseEl = document.getElementById('total-expense');
const totalBalanceEl = document.getElementById('total-balance');
const totalDebtPendingEl = document.getElementById('total-debt-pending');
const alertsContainer = document.getElementById('alerts-container');

// MASCARA DE MONEDA
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

function getTodayStr() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateDisplay(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dateStr;
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
        <small>EN <strong>${m} MESES</strong>:</small>
        <span>${formatCurrency(suggestedMonthly)}/MES</span>
      </div>
    `;
  });

  return `
    <details class="acceleration-details">
      <summary>PLAN DE ACELERACION (2, 6, 8 O 10 MESES)</summary>
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
  dashboardSummaryList.innerHTML = '';
  alertsContainer.innerHTML = '';

  let incomeSum = 0;
  let expenseSum = 0;
  const today = getTodayStr();

  // RENDER TRANSACCIONES
  transactions.forEach((t, index) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><small style="color: var(--text-muted);">${formatDateDisplay(t.date)}</small></td>
      <td><strong>${t.description}</strong></td>
      <td><small style="color: var(--text-muted);">${t.category}</small></td>
      <td style="font-weight: 700;" class="${t.type === 'income' ? 'text-success' : 'text-danger'}">
        ${formatCurrency(t.amount)}
      </td>
      <td><button class="btn-delete" onclick="removeTransaction(${index})">X</button></td>
    `;

    if (t.type === 'income') {
      incomeSum += t.amount;
      incomeList.appendChild(row);
    } else {
      expenseSum += t.amount;
      expenseList.appendChild(row);
    }

    const summaryRow = document.createElement('tr');
    summaryRow.innerHTML = `
      <td><small style="color: var(--text-muted);">${formatDateDisplay(t.date)}</small></td>
      <td><span class="tag-badge ${t.type === 'income' ? 'text-success' : 'text-danger'}">${t.type === 'income' ? 'INGRESO' : 'GASTO'}</span></td>
      <td><strong>${t.description}</strong></td>
      <td><small style="color: var(--text-muted);">${t.category}</small></td>
      <td style="font-weight: 700;" class="${t.type === 'income' ? 'text-success' : 'text-danger'}">${formatCurrency(t.amount)}</td>
    `;
    dashboardSummaryList.appendChild(summaryRow);
  });

  // RENDER DEUDAS
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
        dueDateStatus = `<span class="tag-badge text-danger">CUOTA ${currentQuotaNumber}/${totalInstallments}: VENCIDA (${formatDateDisplay(nextDueDateStr)})</span>`;
        showAlert(`ALERTA: LA CUOTA ${currentQuotaNumber} DE ${d.name} VENCIO EL ${formatDateDisplay(nextDueDateStr)}.`, 'danger');
      } else if (nextDueDateStr === today) {
        dueDateStatus = `<span class="tag-badge text-warning">CUOTA ${currentQuotaNumber}/${totalInstallments}: VENCE HOY</span>`;
        showAlert(`RECORDATORIO: HOY VENCE LA CUOTA ${currentQuotaNumber} DE ${d.name}.`, 'warning');
      } else {
        dueDateStatus = `<span class="tag-badge">PROXIMO COBRO (${currentQuotaNumber}/${totalInstallments}): ${formatDateDisplay(nextDueDateStr)}</span>`;
      }
    }

    let historyHtml = '';
    if (d.history && d.history.length > 0) {
      historyHtml = '<div style="font-size: 0.72rem; margin-top: 6px; color: var(--text-muted);"><strong>ABONOS:</strong> ';
      d.history.forEach((h, hIdx) => {
        historyHtml += `<span class="tag-badge">CUOTA ${hIdx + 1} (${formatDateDisplay(h.date)}): ${formatCurrency(h.amount)}</span> `;
      });
      historyHtml += '</div>';
    }

    const suggestedQuotaAmount = Math.round(totalWithInterest / totalInstallments);
    const accelerationHtml = renderAccelerationSuggestions(pending);
    const interestBadge = interestRate > 0 ? `<span class="tag-badge text-warning">+${interestRate}% INT.</span>` : '';

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>
        <strong>${d.name}</strong> ${interestBadge}
        ${dueDateStatus}
      </td>
      <td>
        <small style="color: var(--text-muted);">${formatCurrency(d.paid)} DE ${formatCurrency(totalWithInterest)} (${progressPercent}%)</small>
        <div class="progress-bar"><div class="progress-fill" style="width: ${progressPercent}%;"></div></div>
        ${accelerationHtml}
        ${historyHtml}
      </td>
      <td class="text-purple" style="font-weight: 700;">${formatCurrency(pending)}</td>
      <td>
        ${pending > 0 ? `
          <div style="display: flex; gap: 4px;">
            <input type="text" class="currency-input" id="pay-input-${index}" value="${new Intl.NumberFormat('es-CO').format(Math.min(pending, suggestedQuotaAmount))}" style="width: 100px; padding: 4px; font-size: 0.8rem;">
            <button class="btn-pay" onclick="payDebt(${index})">ABONAR</button>
          </div>
        ` : '<span class="text-success" style="font-weight: 700;">LIQUIDADA</span>'}
      </td>
      <td><button class="btn-delete" onclick="removeDebt(${index})">X</button></td>
    `;

    debtList.appendChild(row);
    const newInput = document.getElementById(`pay-input-${index}`);
    if (newInput) {
      newInput.addEventListener('input', (e) => {
        let val = e.target.value.replace(/\D/g, '');
        if (val) e.target.value = new Intl.NumberFormat('es-CO').format(parseInt(val));
      });
    }

    if (pending > 0) {
      const summaryRow = document.createElement('tr');
      summaryRow.innerHTML = `
        <td><small style="color: var(--text-muted);">${formatDateDisplay(nextDueDateStr)}</small></td>
        <td><span class="tag-badge text-purple">DEUDA</span></td>
        <td><strong>${d.name}</strong></td>
        <td><small style="color: var(--text-muted);">${historyCount}/${totalInstallments} CUOTAS</small></td>
        <td style="font-weight: 700;" class="text-purple">${formatCurrency(pending)}</td>
      `;
      dashboardSummaryList.appendChild(summaryRow);
    }
  });

  if (transactions.length === 0 && debts.length === 0) {
    dashboardSummaryList.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">NO HAY REGISTROS INGRESADOS AUN.</td></tr>';
  }

  const balance = incomeSum - expenseSum;

  totalIncomeEl.textContent = formatCurrency(incomeSum);
  totalExpenseEl.textContent = formatCurrency(expenseSum);
  totalBalanceEl.textContent = formatCurrency(balance);
  totalDebtPendingEl.textContent = formatCurrency(totalDebtPendingSum);

  localStorage.setItem('finances_v10_trans', JSON.stringify(transactions));
  localStorage.setItem('finances_v10_debts', JSON.stringify(debts));
}

function showAlert(message, type) {
  const alert = document.createElement('div');
  alert.className = `alert-box alert-${type}`;
  alert.innerHTML = message;
  alertsContainer.appendChild(alert);
}

// FORMULARIO INGRESOS
incomeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const dateInput = document.getElementById('income-date').value;
  const date = dateInput ? dateInput : getTodayStr();
  const description = document.getElementById('income-description').value.toUpperCase();
  const amount = parseAmount(document.getElementById('income-amount').value);
  
  let category = document.getElementById('income-category').value;
  if (category === 'OTROS') {
    const otherDetail = document.getElementById('income-other-detail').value.toUpperCase();
    category = otherDetail ? `OTROS (${otherDetail})` : 'OTROS';
  }

  if (amount <= 0) return;

  transactions.push({ id: Date.now(), type: 'income', date, description, amount, category });
  incomeForm.reset();
  document.getElementById('income-other-group').classList.add('hidden');
  updateUI();
});

// FORMULARIO GASTOS
expenseForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const dateInput = document.getElementById('expense-date').value;
  const date = dateInput ? dateInput : getTodayStr();
  const description = document.getElementById('expense-description').value.toUpperCase();
  const amount = parseAmount(document.getElementById('expense-amount').value);
  
  let category = document.getElementById('expense-category').value;
  if (category === 'OTROS') {
    const otherDetail = document.getElementById('expense-other-detail').value.toUpperCase();
    category = otherDetail ? `OTROS (${otherDetail})` : 'OTROS';
  }

  if (amount <= 0) return;

  transactions.push({ id: Date.now(), type: 'expense', date, description, amount, category });
  expenseForm.reset();
  document.getElementById('expense-other-group').classList.add('hidden');
  updateUI();
});

// FORMULARIO DEUDAS
debtForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('debt-name').value.toUpperCase();
  const total = parseAmount(document.getElementById('debt-total').value);
  const interest = parseFloat(document.getElementById('debt-interest').value) || 0;
  const installments = parseInt(document.getElementById('debt-installments').value) || 1;
  const startDate = document.getElementById('debt-start-date').value || getTodayStr();

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
    alert("INGRESA UN MONTO VALIDO.");
    return;
  }

  const debt = debts[index];
  const totalWithInterest = debt.total + (debt.total * ((debt.interest || 0) / 100));
  const pending = totalWithInterest - debt.paid;

  if (payAmount > pending) {
    alert(`EL ABONO SUPERA EL SALDO PENDIENTE (${formatCurrency(pending)}).`);
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
    date: todayStr,
    description: `PAGO CUOTA ${currentQuotaNum}/${debt.installments}: ${debt.name}`,
    amount: payAmount,
    category: 'PAGO DE DEUDAS'
  });

  updateUI();
}

function removeTransaction(index) {
  transactions.splice(index, 1);
  updateUI();
}

function removeDebt(index) {
  const debt = debts[index];
  const revertExpenses = confirm(`¿DESEAS CANCELAR LA DEUDA "${debt.name}"?\n\n- PRESIONA ACEPTAR PARA REVERTIR Y BORRAR LOS PAGOS DE LA TABLA DE EGRESOS.\n- PRESIONA CANCELAR PARA CONSERVAR LOS EGRESOS.`);

  if (revertExpenses) {
    transactions = transactions.filter(t => t.debtId !== debt.id && !t.description.includes(debt.name));
  }

  debts.splice(index, 1);
  updateUI();
}

updateUI();
