export type JarvisMode = 'object' | 'map' | 'overview' | 'brand' | 'content' | 'analytics' | 'scene';

export type JarvisCommandType =
  | 'load_object'
  | 'summarize_object'
  | 'explode_part'
  | 'assemble_part'
  | 'power_on'
  | 'power_off'
  | 'highlight_part'
  | 'rotate_view'
  | 'switch_to_map'
  | 'annotate_map'
  | 'explain_scene'
  | 'switch_to_brand'
  | 'switch_to_content'
  | 'switch_to_analytics'
  | 'create_scene';

export interface JarvisCommand {
  intent: JarvisCommandType;
  target?: string;
  query?: string;
  mode?: JarvisMode;
  direction?: 'left' | 'right' | 'up' | 'down';
  speed?: number;
  zoom?: number;
  raw: string;
}

export interface JarvisSceneState {
  mode: JarvisMode;
  activeTarget: string;
  summary: string;
  powerOn: boolean;
  exploded: boolean;
  highlightedPart?: string;
  mapFocus?: string;
  rotationSpeed: number;
  cameraDistance: number;
}

export interface JarvisTranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: string;
}
