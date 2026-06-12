import type { JarvisCommand, JarvisSceneState } from '@accomplish/shared';

const DEFAULT_OBJECT = 'reactor core';

function normalize(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toLowerCase();
}

function stripCommandPrefix(text: string): string {
  return text
    .replace(/^(please\s+)?(show me|load|render|summarize|summarise|explain|inspect|highlight|rotate|turn on|power on|assemble|explode|switch to|go to|open)\s+/i, '')
    .trim();
}

function extractTarget(input: string): string | undefined {
  const cleaned = stripCommandPrefix(input);
  if (!cleaned) return undefined;

  const blocked = new Set(['it', 'that', 'this', 'the', 'scene', 'view']);
  if (blocked.has(cleaned.toLowerCase())) return undefined;

  return cleaned.replace(/^the\s+/i, '').trim();
}

function extractDirection(input: string): JarvisCommand['direction'] {
  if (/\bleft\b/i.test(input)) return 'left';
  if (/\bright\b/i.test(input)) return 'right';
  if (/\bup\b/i.test(input)) return 'up';
  if (/\bdown\b/i.test(input)) return 'down';
  return undefined;
}

export function parseJarvisCommand(raw: string): JarvisCommand {
  const input = normalize(raw);
  const target = extractTarget(raw);

  if (!input) {
    return {
      intent: 'explain_scene',
      target: DEFAULT_OBJECT,
      raw,
    };
  }

  if (/\b(create|generate|make me|build)\b.{0,30}\b(3d|scene|model|sphere|cube|box|torus|ring|orb|shape|object|structure|render me)\b/i.test(input)) {
    return {
      intent: 'create_scene',
      target: target ?? 'custom scene',
      query: raw.trim(),
      raw,
    };
  }

  if (/\b(brand|identity|palette|logo|visual identity|brand kit)\b/.test(input)) {
    return {
      intent: 'switch_to_brand',
      target: target ?? DEFAULT_OBJECT,
      mode: 'brand',
      raw,
    };
  }

  if (/\b(content|social|post|cards|feed|media)\b/.test(input)) {
    return {
      intent: 'switch_to_content',
      target: target ?? DEFAULT_OBJECT,
      mode: 'content',
      raw,
    };
  }

  if (/\b(analytics|metrics|data|chart|stats|kpi|numbers)\b/.test(input)) {
    return {
      intent: 'switch_to_analytics',
      target: target ?? DEFAULT_OBJECT,
      mode: 'analytics',
      raw,
    };
  }

  if (/\b(map|route|terrain|location|locations|nav|navigate)\b/.test(input)) {
    return {
      intent: 'switch_to_map',
      target: target ?? DEFAULT_OBJECT,
      mode: 'map',
      raw,
    };
  }

  if (/\bexplode|exploded\b/.test(input)) {
    return {
      intent: 'explode_part',
      target: target ?? DEFAULT_OBJECT,
      raw,
    };
  }

  if (/\bassemble|assembled|rebuild|collapse\b/.test(input)) {
    return {
      intent: 'assemble_part',
      target: target ?? DEFAULT_OBJECT,
      raw,
    };
  }

  if (/\b(turn on|power on|enable|activate|ignite|start)\b/.test(input)) {
    return {
      intent: 'power_on',
      target: target ?? DEFAULT_OBJECT,
      raw,
    };
  }

  if (/\b(turn off|power off|disable|deactivate|shutdown|shut down|stop)\b/.test(input)) {
    return {
      intent: 'power_off',
      target: target ?? DEFAULT_OBJECT,
      raw,
    };
  }

  if (/\bhighlight|label|tag\b/.test(input)) {
    return {
      intent: 'highlight_part',
      target: target ?? DEFAULT_OBJECT,
      raw,
    };
  }

  if (/\brotate|spin|orbit\b/.test(input)) {
    return {
      intent: 'rotate_view',
      target: target ?? DEFAULT_OBJECT,
      direction: extractDirection(raw),
      raw,
    };
  }

  if (/\b(summarize|summarise|what is|what's this|explain|describe|inspect)\b/.test(input)) {
    return {
      intent: 'summarize_object',
      target: target ?? DEFAULT_OBJECT,
      raw,
    };
  }

  if (/\b(load|show me|render|open)\b/.test(input)) {
    return {
      intent: 'load_object',
      target: target ?? DEFAULT_OBJECT,
      raw,
    };
  }

  return {
    intent: 'explain_scene',
    target: target ?? DEFAULT_OBJECT,
    query: raw.trim(),
    raw,
  };
}

function catalogSummary(target: string): string {
  const lookup = target.toLowerCase();

  if (lookup.includes('reactor')) {
    return 'High-energy core assembly with concentric containment rings, a bright central emitter, and service modules that can be exploded or reassembled on command.';
  }

  if (lookup.includes('engine')) {
    return 'Mechanical power unit with layered housings, visible support geometry, and a state model that supports inspection, explosion, and reassembly.';
  }

  if (lookup.includes('map') || lookup.includes('city') || lookup.includes('route')) {
    return 'Navigational surface with markers, route overlays, and contextual labels for quick orientation.';
  }

  return `Interactive 3D object for ${target}, ready for labels, state changes, and HUD-style annotations.`;
}

export function applyJarvisCommand(state: JarvisSceneState, command: JarvisCommand): JarvisSceneState {
  const target = command.target?.trim() || state.activeTarget || DEFAULT_OBJECT;

  switch (command.intent) {
    case 'load_object':
      return {
        ...state,
        mode: 'object',
        activeTarget: target,
        summary: catalogSummary(target),
        exploded: false,
        powerOn: false,
        highlightedPart: undefined,
        mapFocus: undefined,
      };
    case 'summarize_object':
      return {
        ...state,
        mode: 'object',
        activeTarget: target,
        summary: catalogSummary(target),
      };
    case 'explode_part':
      return {
        ...state,
        mode: 'object',
        activeTarget: target,
        summary: catalogSummary(target),
        exploded: true,
        cameraDistance: 8.5,
      };
    case 'assemble_part':
      return {
        ...state,
        mode: 'object',
        activeTarget: target,
        summary: catalogSummary(target),
        exploded: false,
        cameraDistance: 6.2,
      };
    case 'power_on':
      return {
        ...state,
        mode: 'object',
        activeTarget: target,
        summary: catalogSummary(target),
        powerOn: true,
      };
    case 'power_off':
      return {
        ...state,
        mode: 'object',
        activeTarget: target,
        summary: catalogSummary(target),
        powerOn: false,
      };
    case 'highlight_part':
      return {
        ...state,
        mode: 'object',
        activeTarget: target,
        summary: catalogSummary(target),
        highlightedPart: target,
      };
    case 'rotate_view':
      return {
        ...state,
        activeTarget: target,
        rotationSpeed: command.direction === 'left' ? -0.015 : command.direction === 'right' ? 0.015 : state.rotationSpeed,
        cameraDistance: typeof command.zoom === 'number' ? command.zoom : state.cameraDistance,
      };
    case 'switch_to_brand':
      return {
        ...state,
        mode: 'brand',
        activeTarget: 'brand system',
        summary: 'Visual identity elements — mark, palette, and type scale — rendered in 3D space.',
        exploded: false,
      };
    case 'switch_to_content':
      return {
        ...state,
        mode: 'content',
        activeTarget: 'content stack',
        summary: 'Social and digital content cards layered in a depth composition.',
        exploded: false,
      };
    case 'switch_to_analytics':
      return {
        ...state,
        mode: 'analytics',
        activeTarget: 'analytics view',
        summary: 'Performance metrics visualized as a 3D bar chart with trend line overlay.',
        exploded: false,
      };
    case 'create_scene':
      return {
        ...state,
        mode: 'scene',
        activeTarget: target || 'custom scene',
        summary: 'AI-generated 3D composition — objects rendered from your description.',
        exploded: false,
      };
    case 'switch_to_map':
      return {
        ...state,
        mode: 'map',
        activeTarget: target,
        summary: `Map mode focused on ${target}. Use annotate and route commands to refine the view.`,
        mapFocus: target,
        exploded: false,
      };
    case 'annotate_map':
      return {
        ...state,
        mode: 'map',
        activeTarget: target,
        mapFocus: target,
      };
    case 'explain_scene':
    default:
      return {
        ...state,
        activeTarget: target,
        summary: catalogSummary(target),
      };
  }
}

export function createInitialJarvisState(): JarvisSceneState {
  return {
    mode: 'object',
    activeTarget: DEFAULT_OBJECT,
    summary: catalogSummary(DEFAULT_OBJECT),
    powerOn: false,
    exploded: false,
    rotationSpeed: 0.01,
    cameraDistance: 6.2,
  };
}

export function describeJarvisCommand(command: JarvisCommand, nextState: JarvisSceneState): string {
  switch (command.intent) {
    case 'load_object':
      return `Loaded ${nextState.activeTarget}. ${nextState.summary}`;
    case 'summarize_object':
      return `${nextState.activeTarget}: ${nextState.summary}`;
    case 'explode_part':
      return `Exploding ${nextState.activeTarget}. Bringing the assembly into separated layers.`;
    case 'assemble_part':
      return `Assembling ${nextState.activeTarget}. Returning all layers to the compact state.`;
    case 'power_on':
      return `Powering on ${nextState.activeTarget}. Emissive state and energy effects are active.`;
    case 'power_off':
      return `Shutting down ${nextState.activeTarget}. All emissive output and energy effects offline.`;
    case 'highlight_part':
      return `Highlighting ${nextState.highlightedPart ?? nextState.activeTarget}.`;
    case 'rotate_view':
      return `Rotating the view${command.direction ? ` ${command.direction}` : ''}.`;
    case 'create_scene':
      return `Generating 3D scene for ${nextState.activeTarget}. Rendering objects from your description...`;
    case 'switch_to_brand':
      return 'Brand system loaded. Mark, palette, and type hierarchy are live.';
    case 'switch_to_content':
      return 'Content stack loaded. Social and digital card formats are in view.';
    case 'switch_to_analytics':
      return 'Analytics view loaded. Performance metrics and trend line active.';
    case 'switch_to_map':
      return `Switched to map mode for ${nextState.mapFocus ?? nextState.activeTarget}.`;
    case 'annotate_map':
      return `Annotating the map around ${nextState.mapFocus ?? nextState.activeTarget}.`;
    case 'explain_scene':
    default:
      return nextState.summary;
  }
}
