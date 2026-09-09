import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { AuthProvider } from './contexts/AuthContext.jsx';
import { TranscriptionProvider } from './contexts/TranscriptionContext.jsx';
import './global.css';

const rootElement = document.getElementById('root');
const wasPrerendered = document.documentElement.dataset.prerendered === 'true';
const app = (
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider initialLoading={!wasPrerendered}>
        <TranscriptionProvider><App /></TranscriptionProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);

if (wasPrerendered) ReactDOM.hydrateRoot(rootElement, app);
else ReactDOM.createRoot(rootElement).render(app);