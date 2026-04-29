import { describe, expect, it } from "vitest";

import { createCaptureEventBus } from "../../../core/capture/events.js";
import { createFeedbackEventBus } from "../../../core/feedback/events.js";
import { createL2EventBus } from "../../../core/memory/l2/events.js";
import { createL3EventBus } from "../../../core/memory/l3/events.js";
import { bridgeToCoreEvents } from "../../../core/pipeline/event-bridge.js";
import type { PipelineBuses } from "../../../core/pipeline/types.js";
import { createRetrievalEventBus } from "../../../core/retrieval/events.js";
import { createRewardEventBus } from "../../../core/reward/events.js";
import { createSessionEventBus } from "../../../core/session/events.js";
import { createSkillEventBus } from "../../../core/skill/events.js";
import { rootLogger } from "../../../core/logger/index.js";
import type { CoreEvent } from "../../../agent-contract/events.js";

function makeBuses(): PipelineBuses {
  return {
    session: createSessionEventBus(),
    capture: createCaptureEventBus(),
    reward: createRewardEventBus(),
    l2: createL2EventBus(),
    l3: createL3EventBus(),
    skill: createSkillEventBus(),
    feedback: createFeedbackEventBus(),
    retrieval: createRetrievalEventBus(),
  };
}

describe("pipeline/event-bridge", () => {
  it("surfaces skill crystallization model refusals as system errors", () => {
    const buses = makeBuses();
    const events: CoreEvent[] = [];
    const bridge = bridgeToCoreEvents({
      buses,
      agent: "openclaw",
      log: rootLogger.child({ channel: "test.event-bridge" }),
      emit: (evt) => events.push(evt),
    });

    buses.skill.emit({
      kind: "skill.failed",
      at: 1,
      policyId: "po_refused",
      stage: "crystallize",
      reason: "llm-refusal",
      modelRefusal: {
        provider: "anthropic",
        model: "claude-test",
        servedBy: "anthropic",
        matchedPrefix: "I am Claude",
        content: "I am Claude, made by Anthropic. I cannot process this request.",
      },
    });

    bridge.dispose();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "system.error",
      correlationId: "po_refused",
      payload: {
        kind: "skill.model_refusal",
        policyId: "po_refused",
        modelRefusal: {
          model: "claude-test",
          content: expect.stringContaining("I cannot process this request"),
        },
      },
    });
  });
});
