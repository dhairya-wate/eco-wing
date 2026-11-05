// EcoWing Command Center Dashboard Configuration
window.DASHBOARD_CONFIG = Object.assign({
  apiBase: (typeof window !== 'undefined' && window.location && window.location.hostname.includes('vercel.app'))
    ? ''
    : ((typeof window !== 'undefined' && window.location && window.location.port === '3000')
        ? window.location.origin
        : 'http://localhost:3000'),
  demoLogin: true,
  demoAccounts: {
    admin: { password: 'password123', name: 'Fleet Administrator', role: 'admin' },
    operator: { password: 'password123', name: 'Flight Operator', role: 'operator' }
  },
  googleClientId: ''
}, window.DASHBOARD_CONFIG || {});
