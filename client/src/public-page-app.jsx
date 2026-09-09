import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import IntroPage from './pages/IntroPage.jsx';
import GuidePage from './pages/GuidePage.jsx';
import PaymentPage from './pages/PaymentPage.jsx';
import SupportPage from './pages/SupportPage.jsx';
import TermsPage from './pages/TermsPage.jsx';
import PrivacyPage from './pages/PrivacyPage.jsx';

export default function PublicPageApp() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<IntroPage />} />
        <Route path="/guide" element={<GuidePage />} />
        <Route path="/payment" element={<PaymentPage />} />
        <Route path="/support" element={<SupportPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
      </Routes>
    </Layout>
  );
}