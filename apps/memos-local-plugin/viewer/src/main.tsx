/**
 * Entry point for the MemOS Local viewer.
 *
 * Renders a single `<App />` root; all state is held in signals
 * (`@preact/signals`) rather than React context or class components,
 * giving us precise reactivity with zero boilerplate. Routing is a
 * hash-router in `router.ts` so we don't need a server-side rewrite
 * for client-side paths.
 */

import "./styles/tokens.css";
import "./styles/layout.css";
import "./styles/components.css";

import { render } from "preact";
import { App } from "./components/App";

const root = document.getElementById("app");
if (!root) throw new Error("#app root element missing from index.html");
render(<App />, root);
