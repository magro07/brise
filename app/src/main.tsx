import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { startUsageTracking } from "./components/usage/usage";
import { useStore } from "./lib/store";
import { useDesign } from "./components/design/designStore";
(window as any).__brise = { useStore, useDesign };

startUsageTracking();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
