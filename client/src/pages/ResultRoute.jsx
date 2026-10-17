import { useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import ResultPage from './ResultPage.jsx';
import BatchResultPage from './BatchResultPage.jsx';

export default function ResultRoute() {
  const location = useLocation();
  const { user } = useAuth();
  return new URLSearchParams(location.search).has('batch')
    ? <BatchResultPage key={user?.id || 'anonymous'} /> : <ResultPage />;
}
