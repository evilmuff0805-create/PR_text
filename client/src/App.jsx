import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import HomePage from './pages/HomePage.jsx';
import ResultPage from './pages/ResultPage.jsx';
import IntroPage from './pages/IntroPage.jsx';
import GuidePage from './pages/GuidePage.jsx';
import TermsPage from './pages/TermsPage.jsx';
import PrivacyPage from './pages/PrivacyPage.jsx';
import SupportPage from './pages/SupportPage.jsx';
import PaymentPage from './pages/PaymentPage.jsx';
import PaymentSuccessPage from './pages/PaymentSuccessPage.jsx';
import PaymentFailPage from './pages/PaymentFailPage.jsx';
import UsagePage from './pages/UsagePage.jsx';
import RedownloadPage from './pages/RedownloadPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import PasswordResetPage from './pages/PasswordResetPage.jsx';

function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<IntroPage />} />
        <Route path="/transcribe" element={<HomePage />} />
        <Route path="/result" element={<ResultPage />} />
        <Route path="/intro" element={<Navigate to="/" replace />} />
        <Route path="/guide" element={<GuidePage />} />
        <Route path="/payment" element={<PaymentPage />} />
        <Route path="/payment/success" element={<PaymentSuccessPage />} />
        <Route path="/payment/fail" element={<PaymentFailPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/support" element={<SupportPage />} />
        <Route path="/usage" element={<UsagePage />} />
        <Route path="/redownload" element={<RedownloadPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/auth/reset" element={<PasswordResetPage />} />
        <Route path="/reset-password" element={<PasswordResetPage />} />
      </Routes>
    </Layout>
  );
}

export default App;
