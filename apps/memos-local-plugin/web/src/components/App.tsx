/**
 * Top-level viewer app shell. Wires:
 *   - Topbar (brand + search + notifications)
 *   - Sidebar (primary nav + theme / language controls)
 *   - Main content area (routed views)
 *
 * State subscriptions (health polling, theme) mount here so they run
 * once per page load.
 */
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { ContentRouter } from "./ContentRouter";
import { AuthGate } from "./AuthGate";
import { RestartOverlay } from "./RestartOverlay";
import { useEffect } from "preact/hooks";
import { startHealthPolling } from "../stores/health";

export function App() {
  useEffect(() => {
    startHealthPolling();
  }, []);

  return (
    <AuthGate>
      <div class="shell">
        <Header />
        <Sidebar />
        <main class="main">
          <ContentRouter />
        </main>
      </div>
      <RestartOverlay />
    </AuthGate>
  );
}
