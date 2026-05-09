/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TURN_URL?: string;
  readonly VITE_TURN_USER?: string;
  readonly VITE_TURN_PASS?: string;
  readonly VITE_MATCHMAKE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
