import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import HomePage from './pages/HomePage.jsx';
import ResultPage from './pages/ResultPage.jsx';
import IntroPage from './pages/IntroPage.jsx';
import GuidePage from './pages/GuidePage.jsx';
import TermsPage from './pages/TermsPage.jsx';
import SupportPage from './pages/SupportPage.jsx';
import PaymentPage from './pages/PaymentPage.jsx';
import PaymentSuccessPage from './pages/PaymentSuccessPage.jsx';
import UsagePage from './pages/UsagePage.jsx';

function HomeOrIntro() {
  return localStorage.getItem('visited') ? <HomePage /> : <Navigate to="/intro" replace />;
}

function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<HomeOrIntro />} />
        <Route path="/result" element={<ResultPage />} />
        <Route path="/intro" element={<IntroPage />} />
        <Route path="/guide" element={<GuidePage />} />
        <Route path="/payment" element={<PaymentPage />} />
        <Route path="/payment/success" element={<PaymentSuccessPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/support" element={<SupportPage />} />
        <Route path="/usage" element={<UsagePage />} />
      </Routes>
    </Layout>
  );
}

export default App;
