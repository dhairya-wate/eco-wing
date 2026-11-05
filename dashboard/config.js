// EcoWing Command Center Dashboard Configuration
window.DASHBOARD_CONFIG = Object.assign({
  apiBase: (typeof window !== 'undefined' && window.location && window.location.hostname.includes('vercel.app'))
    ? ''
    : ((typeof window !== 'undefined' && window.location && window.location.port === '3000')
        ? window.location.origin
        : 'http://localhost:3000'),
  demoLogin: true,
  demoAccounts: {
    admin: { password: ['password123', 'ecowing123'], name: 'Fleet Administrator', role: 'admin', email: 'admin@ecowing.local' },
    operator: { password: ['password123', 'ecowing123'], name: 'Flight Operator', role: 'operator', email: 'operator@ecowing.local' },
    sarah_pilot: { password: 'pilotpassword123', name: 'Capt. Sarah Jenkins', role: 'pilot', email: 'sarah.jenkins@ecowing.local' },
    david_analyst: { password: 'analystpass123', name: 'David Chen', role: 'analyst', email: 'david.chen@ecowing.local' }
  },
  googleClientId: ''
}, window.DASHBOARD_CONFIG || {});
