// EcoWing Command Center Dashboard Configuration
window.DASHBOARD_CONFIG = Object.assign({
  apiBase: (typeof window !== 'undefined' && window.location && window.location.hostname.includes('vercel.app'))
    ? 'https://ecowing-detection-system.onrender.com'
    : ((typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : 'https://ecowing-detection-system.onrender.com'),
  demoLogin: true,
  demoAccounts: {
    admin: { password: 'password123', name: 'Fleet Administrator', role: 'admin' },
    operator: { password: 'password123', name: 'Flight Operator', role: 'operator' }
  },
  googleClientId: ''
}, window.DASHBOARD_CONFIG || {});
