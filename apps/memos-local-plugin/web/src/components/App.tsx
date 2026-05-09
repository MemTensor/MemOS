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
import { ModelSetupBanner } from "./ModelSetupBanner";
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
        {/*
         * Banner row sits between the topbar and the sidebar/main row
         * (see `.shell` grid in `styles/layout.css`). The banner
         * collapses to zero height when the operator has dismissed it
         * or when all model slots are healthy, so the row simply
         * disappears with no layout shift.
         */}
        <ModelSetupBanner />
        <Sidebar />
        <main class="main">
          <ContentRouter />
        </main>
      </div>
      <RestartOverlay />
    </AuthGate>
  );
}
