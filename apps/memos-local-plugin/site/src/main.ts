/**
 * Entry point for the local product site (`site/`).
 *
 * The site is intentionally framework-free — it's a static multi-
 * page-feel single HTML document rendered by vanilla TypeScript that
 * mounts declaratively from content loaded via `import.meta.glob`.
 */

import "./styles/base.css";
import "./styles/theme.css";
import "./styles/layout.css";
import "./styles/components.css";

import { renderApp } from "./app";

const root = document.getElementById("app");
if (!root) throw new Error("#app missing from index.html");

renderApp(root);
