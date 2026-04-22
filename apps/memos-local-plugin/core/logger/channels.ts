/**
 * Canonical business channel registry.
 *
 * This file is just a list. We don't enforce membership at compile time
 * (channels are strings) so adapters and 3rd parties can introduce new ones,
 * but anything in here is documented in `docs/LOGGING.md` and supported by
 * the viewer's *Logs* filter dropdown.
 */

export const CHANNELS = [
  // ─── core algorithm ───
  "core.session",
  "core.session.intent",
  "core.capture",
  "core.capture.extractor",
  "core.capture.reflection",
  "core.capture.alpha",
  "core.capture.embed",
  "core.reward",
  "core.reward.task-summary",
  "core.reward.r-human",
  "core.reward.alpha",
  "core.reward.backprop",
  "core.reward.priority",
  "core.memory.l1",
  "core.memory.l2",
  "core.memory.l2.associate",
  "core.memory.l2.candidate",
  "core.memory.l2.induce",
  "core.memory.l2.gain",
  "core.memory.l2.events",
  "core.memory.l2.incremental",
  "core.memory.l2.cross-task",
  "core.memory.l2.revisor",
  "core.memory.l3",
  "core.memory.l3.abstract",
  "core.memory.l3.cluster",
  "core.memory.l3.confidence",
  "core.memory.l3.events",
  "core.memory.l3.feedback",
  "core.memory.l3.merge",
  "core.episode",
  "core.feedback",
  "core.feedback.signals",
  "core.feedback.evidence",
  "core.feedback.synthesize",
  "core.feedback.subscriber",
  "core.feedback.events",
  "core.skill",
  "core.skill.crystallize",
  "core.skill.verifier",
  "core.skill.lifecycle",
  "core.skill.eta",
  "core.skill.packager",
  "core.retrieval",
  "core.retrieval.tier1",
  "core.retrieval.tier2",
  "core.retrieval.tier3",
  "core.retrieval.ranker",
  "core.retrieval.injector",
  "core.retrieval.events",
  "core.pipeline",
  "core.pipeline.orchestrator",
  "core.pipeline.events",
  "core.hub",
  "core.hub.server",
  "core.hub.client",
  "core.hub.sync",
  "core.telemetry",
  "core.update-check",

  // ─── shared infra ───
  "config",
  "logger",
  "logger.transport",
  "logger.sink",
  "storage",
  "storage.migration",
  "storage.repos",
  "storage.vector",
  "embedding",
  "embedding.local",
  "embedding.cache",
  "embedding.openai_compatible",
  "embedding.gemini",
  "embedding.cohere",
  "embedding.voyage",
  "embedding.mistral",
  "llm",
  "llm.openai_compatible",
  "llm.anthropic",
  "llm.gemini",
  "llm.bedrock",
  "llm.local_only",
  "llm.host",
  "llm.json",
  "llm.prompts",

  // ─── runtime services ───
  "server",
  "server.http",
  "server.sse",
  "server.routes",
  "bridge",
  "bridge.transport",
  "bridge.methods",

  // ─── adapters ───
  "adapter.openclaw",
  "adapter.hermes",

  // ─── system ───
  "system",
  "system.startup",
  "system.shutdown",
  "system.self-check",
] as const;

export type CanonicalChannel = (typeof CHANNELS)[number];

export function isCanonicalChannel(s: string): s is CanonicalChannel {
  return (CHANNELS as readonly string[]).includes(s);
}
