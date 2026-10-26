import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "framer-motion";
import App from "./App";
import { IndustryProvider } from "./lib/industry";
import { DeploymentProvider } from "./lib/deployment";
import { initTheme } from "./lib/theme";
import "./index.css";

initTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <DeploymentProvider>
        <IndustryProvider>
          <App />
        </IndustryProvider>
      </DeploymentProvider>
    </MotionConfig>
  </React.StrictMode>
);
