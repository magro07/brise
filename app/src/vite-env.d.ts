/// <reference types="vite/client" />

declare module "virtual:model-runtime" {
  /** Gebündelte Laufzeit für `model.js` (siehe vite.config.ts). */
  const code: string;
  export default code;
}
