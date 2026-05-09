import { createHashRouter } from 'react-router-dom';
import { Home } from './pages/Home';
import { Game } from './pages/Game';
import { Profile } from './pages/Profile';
import { Join } from './pages/Join';
import { Layout } from './components/Layout';

export const router = createHashRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: 'play/:gameId', element: <Game /> },
      { path: 'join/:hostPeerId', element: <Join /> },
      { path: 'profile', element: <Profile /> },
    ],
  },
]);
