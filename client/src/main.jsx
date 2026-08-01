import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { AuthProvider } from './contexts/AuthContext.jsx';
import { TranscriptionProvider } from './contexts/TranscriptionContext.jsx';
import './global.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <TranscriptionProvider>
          <App />
        </TranscriptionProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
