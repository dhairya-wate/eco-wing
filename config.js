// EcoWing Command Center Dashboard Configuration
window.DASHBOARD_CONFIG = Object.assign({
  apiBase: 'https://detection-system-flax.vercel.app',
  demoLogin: true,
  demoAccounts: {
    admin: { password: 'password123', name: 'Fleet Administrator', role: 'admin' },
    operator: { password: 'password123', name: 'Flight Operator', role: 'operator' }
  },
  googleClientId: ''
}, window.DASHBOARD_CONFIG || {});
