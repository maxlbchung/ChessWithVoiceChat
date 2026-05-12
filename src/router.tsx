import { createHashRouter } from 'react-router-dom';
import { Home } from './pages/Home';
import { GameRoute } from './pages/GameRoute';
import { Profile } from './pages/Profile';
import { Join } from './pages/Join';
import { Settings } from './pages/Settings';
import { Layout } from './components/Layout';

export const router = createHashRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: 'play/:gameId', element: <GameRoute /> },
      { path: 'join/:hostPeerId', element: <Join /> },
      { path: 'profile', element: <Profile /> },
      { path: 'settings', element: <Settings /> },
    ],
  },
]);
