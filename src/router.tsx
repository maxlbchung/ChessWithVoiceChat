import { lazy, Suspense } from 'react';
import { createHashRouter, Navigate } from 'react-router-dom';
import { Home } from './pages/Home';
import { GameRoute } from './pages/GameRoute';
import { Profile } from './pages/Profile';
import { Join } from './pages/Join';
import { Settings } from './pages/Settings';
import { Sandbox } from './pages/Sandbox';
import { Review } from './pages/Review';
import { Layout } from './components/Layout';

// DEV-only video editor. Gating the lazy() behind the statically-false
// `import.meta.env.DEV` lets Rollup constant-fold it to null in production and
// drop the dynamic import entirely — so neither the page nor its heavy
// react-dom/server dependency ship in the prod build.
const VideoEditor = import.meta.env.DEV
  ? lazy(() => import('./pages/VideoEditor').then((m) => ({ default: m.VideoEditor })))
  : null;

const devRoutes = VideoEditor
  ? [
      {
        path: 'video',
        element: (
          <Suspense fallback={<div className="page muted">Loading editor…</div>}>
            <VideoEditor />
          </Suspense>
        ),
      },
    ]
  : [];

export const router = createHashRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: 'play/:gameId', element: <GameRoute /> },
      { path: 'join/:hostPeerId', element: <Join /> },
      { path: 'sandbox', element: <Sandbox /> },
      { path: 'review', element: <Review /> },
      { path: 'profile', element: <Profile /> },
      { path: 'settings', element: <Settings /> },
      ...devRoutes,
      // Unknown routes (including retired ones, e.g. the old /civilization
      // game) fall back to Home instead of react-router's error screen.
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);
