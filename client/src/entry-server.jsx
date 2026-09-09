import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import PublicPageApp from './public-page-app.jsx';
import { AuthContext } from './contexts/AuthContext.jsx';

const anonymousAuth = Object.freeze({
  user: null, token: null, login: async () => {}, signup: async () => {}, loginWithGoogle: () => {},
  logout: async () => {}, clearSession: () => {}, updateCredits: () => {}, replaceToken: () => {},
  getToken: () => null, recoverySession: null, recoveryError: '', completePasswordRecovery: async () => {},
});

export function renderPublicPage(url) {
  return renderToString(<StaticRouter location={url}><AuthContext.Provider value={anonymousAuth}><PublicPageApp /></AuthContext.Provider></StaticRouter>);
}