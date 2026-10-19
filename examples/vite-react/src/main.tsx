import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
} from 'react-router-dom';
import './styles.css';

const DirectPage = lazy(() => import('./routes/DirectPage.tsx'));
const WorkerPage = lazy(() => import('./routes/WorkerPage.tsx'));
const ChartsPage = lazy(() => import('./routes/ChartsPage.tsx'));

function LoadingPage() {
  return (
    <div className="boot-shell" role="status">
      <div className="boot-mark">T</div>
      <div>
        <p className="eyebrow">Typfolio workspace</p>
        <h1>Loading the example</h1>
        <p>Preparing the selected compiler route…</p>
      </div>
      <span className="spinner" aria-hidden="true" />
    </div>
  );
}

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('The React root element is missing');

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <Suspense fallback={<LoadingPage />}>
        <Routes>
          <Route index element={<DirectPage />} />
          <Route path="workers" element={<WorkerPage />} />
          <Route path="charts" element={<ChartsPage />} />
          <Route path="*" element={<Navigate replace to="/" />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </StrictMode>,
);
