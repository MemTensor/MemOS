export function renderHero(): string {
  return `
    <section class="site-hero">
      <div class="site-section__inner">
        <span class="site-hero__eyebrow">Reflect2Evolve · V7</span>
        <h1>Local-first memory that grows with your agent.</h1>
        <p class="site-hero__tagline">
          MemOS Local turns every coding session into layered memory —
          traces, policies, world models, and callable skills —
          running on your machine. Decision-repair, reflection-weighted
          backprop, and three-tier retrieval, wired into whichever
          agent you're using.
        </p>
        <div class="site-hero__cta">
          <a class="btn btn--primary" href="/ui/">Open viewer →</a>
          <a class="btn btn--ghost" href="#features">See what it does</a>
        </div>
      </div>
    </section>
  `;
}
