import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import './styles.css';

// iOS Safari ignores `user-scalable=no` in the viewport meta, so page
// pinch-zoom is blocked via its proprietary gesture events instead (they
// never fire elsewhere, so this is a no-op on other browsers). Double-tap
// zoom is covered by `touch-action: manipulation` in styles.css.
for (const evt of ['gesturestart', 'gesturechange'] as const) {
  document.addEventListener(evt, (e: Event) => e.preventDefault(), { passive: false });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
