/* Per-environment settings. Edit this file (or mount your own at deploy time) instead of editing index.html.
   apiBase:        origin of the backend API. Leave '' when nginx proxies /api and /socket.io (recommended).
   googleClientId: OAuth 2.0 Web client ID from Google Cloud Console. Must list this site's origin under
                   "Authorized JavaScript origins". Leave '' to disable Google sign-in.
   demoLogin:      keep false in production. */
window.DASHBOARD_CONFIG = {
  apiBase: '',
  googleClientId: '565347180356-r1kvodun6hf9d3v8g1i0m4b8do5jv1sj.apps.googleusercontent.com',
  demoLogin: false
};
