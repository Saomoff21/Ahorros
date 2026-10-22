<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# AHORROS SA - Sistema de Gestión Financiera

Sistema integral de gestión de finanzas personales con soporte para Atajos de iPhone (Siri / iOS Shortcuts), metas de ahorro, compromisos fijos, múltiples métodos de pago, sincronización en la nube con Firebase Firestore y control de deudas.

## Características Principales

- **Gestión de Ingresos y Gastos:** Registro detallado con cuentas digitales (Nequi, Daviplata, Bancos, Efectivo, Tarjeta de Crédito).
- **Finanzas Fijas:** Soporte para periodicidades semanales, quincenales, mensuales y anuales con registro de cuotas múltiples sin bloqueos.
- **Control de Deudas:** Separación clara entre deudas por pagar y cuentas por cobrar con historial de abonos.
- **Metas de Ahorro:** Bolsillos con cálculo de progreso y aportes mensuales sugeridos.
- **Integración con Atajos de iOS:** Webhook REST compatible con Siri y Atajos de iPhone (`/api/shortcut/transaction`).
- **Sincronización en la Nube:** Bóvedas multi-dispositivo con Firebase Firestore y modo offline.
- **PWA (Progressive Web App):** Instalable en teléfonos y computadores con soporte de Service Worker.

## Ejecución Local

**Requisitos:** Node.js (v18+)

1. Instalar dependencias:
   ```bash
   npm install
   ```

2. Iniciar el servidor de desarrollo:
   ```bash
   npm run dev
   ```

3. Abrir en el navegador:
   `http://localhost:3000`
