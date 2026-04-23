interface ArchColumn {
  title: string;
  items: string[];
}

const COLUMNS: ArchColumn[] = [
  {
    title: "Adapters",
    items: [
      "OpenClaw plugin (TypeScript)",
      "Hermes provider (Python over JSON-RPC)",
      "bridge.cts (stdio dispatcher)",
    ],
  },
  {
    title: "Algorithm core",
    items: [
      "Capture → L1 trace",
      "Reward → reflection-weighted backprop",
      "L2 policy induction + retention",
      "L3 world-model abstraction",
      "Skill crystallization & lifecycle",
      "Decision repair loop",
      "3-tier retrieval (Skill / Episode / World)",
    ],
  },
  {
    title: "Local runtime",
    items: [
      "SQLite + vector embeddings",
      "YAML config + secrets redaction",
      "Structured logs (audit · llm · perf · events)",
      "HTTP REST + SSE server",
      "Vite viewer + product site",
    ],
  },
];

export function renderArchitecture(): string {
  return `
    <section id="architecture" class="site-section" style="background: var(--site-surface-2);">
      <div class="site-section__inner">
        <h2>Agent-agnostic core, adapter-driven edges.</h2>
        <p style="max-width: 65ch; color: var(--site-mute);">
          A single algorithm implementation feeds multiple agents via
          narrow contracts. The core has no dependency on any agent's
          SDK — adapters translate their events into DTOs and route
          retrieval results back.
        </p>
        <div class="arch-diagram" aria-label="Architecture overview">
          ${COLUMNS.map(
            (col) => `
            <div class="arch-diagram__col">
              <h4>${col.title}</h4>
              ${col.items
                .map((i) => `<div class="arch-diagram__card">${i}</div>`)
                .join("")}
            </div>`,
          ).join("")}
        </div>
      </div>
    </section>
  `;
}
