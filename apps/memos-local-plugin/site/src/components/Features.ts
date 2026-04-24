interface Feature {
  icon: string;
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    icon: "L1",
    title: "L1 traces, captured once",
    body: "Every turn becomes a verbatim, immutable L1 trace with tool-call ordering preserved. Replayable, auditable, never deleted.",
  },
  {
    icon: "L2",
    title: "L2 policies, induced automatically",
    body: "Multiple supportive traces crystallize into reusable policies with reflection-weighted value backprop and softmax-derived priorities.",
  },
  {
    icon: "L3",
    title: "L3 world models, cross-task",
    body: "Policies roll up into structural world models that the agent can cite to defuse repeated classes of mistakes across sessions.",
  },
  {
    icon: "★",
    title: "Callable Skills",
    body: "High-value policies graduate into first-class Skills: named, invocable via Tier-1 retrieval, and retirable from the viewer with one click.",
  },
  {
    icon: "↻",
    title: "Decision Repair",
    body: "Failed tool calls and negative feedback auto-trigger targeted retrieval that injects corrective guidance on the next turn.",
  },
  {
    icon: "⌂",
    title: "Fully local",
    body: "Everything lives in ~/.memos-plugin/<agent>/: config.yaml, SQLite DB, logs, embeddings. No cloud dependency unless you configure one.",
  },
];

function renderCard(f: Feature): string {
  return `
    <article class="card">
      <div class="card__icon" aria-hidden="true">${f.icon}</div>
      <h3 class="card__title">${f.title}</h3>
      <p class="card__body">${f.body}</p>
    </article>
  `;
}

export function renderFeatures(): string {
  return `
    <section id="features" class="site-section">
      <div class="site-section__inner">
        <h2>Memory, layered the way agents actually think.</h2>
        <p style="max-width: 65ch; color: var(--site-mute); margin-bottom: 40px;">
          Each layer is independent, addressable, and re-ranked.
          Together they give your agent context that sharpens over
          time without bloating the prompt.
        </p>
        <div class="feature-grid">
          ${FEATURES.map(renderCard).join("")}
        </div>
      </div>
    </section>
  `;
}
