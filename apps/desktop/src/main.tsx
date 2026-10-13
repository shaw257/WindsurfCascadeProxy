import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

function showStartupError(error: unknown) {
  const root = document.getElementById("root");
  const message = error instanceof Error ? `${error.message}\n\n${error.stack || ""}` : String(error);
  if (root) {
    root.innerHTML = "";
    const box = document.createElement("pre");
    box.style.cssText = "white-space:pre-wrap;margin:24px;padding:18px;border:1px solid #e6b8bb;border-radius:6px;color:#8a1f28;background:#fff4f4;font:14px/1.6 Consolas,Microsoft YaHei UI,sans-serif;";
    box.textContent = `前端启动失败：\n${message}`;
    root.appendChild(box);
  }
}

window.addEventListener("error", event => showStartupError(event.error || event.message));
window.addEventListener("unhandledrejection", event => showStartupError(event.reason));

let resizeEndTimer: number | undefined;
window.addEventListener("resize", () => {
  const root = document.documentElement;
  if (!root.classList.contains("is-window-resizing")) {
    root.classList.add("is-window-resizing");
  }
  if (resizeEndTimer) window.clearTimeout(resizeEndTimer);
  resizeEndTimer = window.setTimeout(() => {
    root.classList.remove("is-window-resizing");
    resizeEndTimer = undefined;
  }, 180);
}, { passive: true });

try {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
} catch (error) {
  showStartupError(error);
}
