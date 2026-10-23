import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';

const AsciiPage = lazy(() => import('./routes/AsciiPage.tsx'));
const EditorialPage = lazy(() => import('./routes/EditorialPage.tsx'));
const PerformancePage = lazy(() => import('./routes/PerformancePage.tsx'));

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('The React root element is missing');

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <Suspense
        fallback={
          <div className="boot" role="status">
            <span className="spinner" aria-hidden="true" />
            <p>Loading the demo…</p>
          </div>
        }
      >
        <Routes>
          <Route index element={<AsciiPage />} />
          <Route path="editorial" element={<EditorialPage />} />
          <Route path="performance" element={<PerformancePage />} />
          <Route path="*" element={<Navigate replace to="/" />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </StrictMode>,
);
