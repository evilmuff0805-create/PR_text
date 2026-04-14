import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import HomePage from './pages/HomePage.jsx';
import ResultPage from './pages/ResultPage.jsx';
import IntroPage from './pages/IntroPage.jsx';
import GuidePage from './pages/GuidePage.jsx';
import TermsPage from './pages/TermsPage.jsx';
import SupportPage from './pages/SupportPage.jsx';
import PaymentPage from './pages/PaymentPage.jsx';
import UsagePage from './pages/UsagePage.jsx';

function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/result" element={<ResultPage />} />
        <Route path="/intro" element={<IntroPage />} />
        <Route path="/guide" element={<GuidePage />} />
        <Route path="/payment" element={<PaymentPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/support" element={<SupportPage />} />
        <Route path="/usage" element={<UsagePage />} />
      </Routes>
    </Layout>
  );
}

export default App;
