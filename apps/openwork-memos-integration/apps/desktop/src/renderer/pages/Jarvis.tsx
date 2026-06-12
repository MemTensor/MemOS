'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  ArrowRight,
  BarChart2,
  Bot,
  Box,
  Clipboard,
  Compass,
  FileText,
  Hash,
  Mail,
  Mic,
  Palette,
  RadioTower,
  RotateCw,
  Sparkles,
  Telescope,
  TrendingUp,
  Wand2,
  Zap,
} from 'lucide-react';
import type { JarvisCommand, JarvisSceneState, JarvisTranscriptEntry } from '@accomplish/shared';
import {
  applyJarvisCommand,
  createInitialJarvisState,
  describeJarvisCommand,
  parseJarvisCommand,
} from '@/lib/jarvis/command-parser';
import { getAccomplish, isRunningInElectron } from '@/lib/accomplish';

type JarvisChip = { label: string; prompt: string; icon: React.ElementType; action?: () => void };

const OBJECT_FACTS: Record<string, { title: string; summary: string; bullets: string[] }> = {
  'reactor core': {
    title: 'Reactor Core',
    summary: 'Layered containment assembly — bright central emitter, concentric rings, and service modules.',
    bullets: ['Containment rings', 'Central emitter', 'Service pods'],
  },
  'engine block': {
    title: 'Engine Block',
    summary: 'Structural power unit with layered housings and visible subassemblies.',
    bullets: ['Cylinder bank', 'Cooling loops', 'Access panels'],
  },
  'city map': {
    title: 'City Map',
    summary: 'Navigational surface with route overlays, markers, and district labels.',
    bullets: ['Route line', 'Marker pins', 'District labels'],
  },
  'brand system': {
    title: 'Brand System',
    summary: 'Visual identity in 3D — brand mark, color palette swatches, and type hierarchy.',
    bullets: ['Brand mark', 'Color palette', 'Type scale'],
  },
  'content stack': {
    title: 'Content Stack',
    summary: 'Social and digital content cards floating in a depth-layered composition.',
    bullets: ['Social cards', 'Post previews', 'Content grid'],
  },
  'analytics view': {
    title: 'Analytics View',
    summary: 'Performance metrics as a 3D bar chart with trend line overlay and KPI baseline.',
    bullets: ['Bar chart', 'Trend line', 'KPI baseline'],
  },
  'custom scene': {
    title: 'Generated Scene',
    summary: 'AI-generated 3D composition rendered from your description via local LLM.',
    bullets: ['Custom objects', 'AI-composed', 'Live render'],
  },
};

function getFactForTarget(target: string) {
  const key = target.toLowerCase();
  if (key.includes('reactor')) return OBJECT_FACTS['reactor core'];
  if (key.includes('engine')) return OBJECT_FACTS['engine block'];
  if (key.includes('map') || key.includes('city') || key.includes('route')) return OBJECT_FACTS['city map'];
  if (key.includes('brand') || key.includes('identity') || key.includes('palette')) return OBJECT_FACTS['brand system'];
  if (key.includes('content') || key.includes('social') || key.includes('card')) return OBJECT_FACTS['content stack'];
  if (key.includes('analytics') || key.includes('metrics') || key.includes('chart')) return OBJECT_FACTS['analytics view'];
  if (key.includes('scene') || key.includes('generated') || key.includes('custom')) return OBJECT_FACTS['custom scene'];
  return {
    title: target,
    summary: `Interactive 3D object: ${target}. Supports load, inspect, explode, assemble, annotate.`,
    bullets: ['Load', 'Inspect', 'Animate'],
  };
}

function makeTranscriptId() {
  return `jarvis_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function callAnthropicHaiku(apiKey: string, userText: string): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 220,
      system:
        'You are JARVIS, a creative HUD assistant with two modes. For 3D visual commands (explode, power on, load, rotate, switch to map/brand/content/analytics mode, etc.): 1-2 crisp sentences narrating the action — precise, slightly technical. For marketing or creative requests (write copy, taglines, headlines, hooks, captions, social posts, ad copy, email subject lines, product descriptions): respond with the requested content directly — no preamble, no attribution, punchy and commercial-grade. No markdown, no em-dashes.',
      messages: [{ role: 'user', content: userText }],
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  const text: string | undefined = data.content?.[0]?.text;
  if (!text) throw new Error('empty response');
  return text;
}

// ─── Scene generation (local LLM via Ollama) ─────────────────────────────────

interface SceneObject {
  type: 'sphere' | 'box' | 'torus' | 'cylinder' | 'cone' | 'icosahedron' | 'ring' | 'plane';
  size?: number | [number, number, number];
  color?: string;
  emissive?: string;
  emissiveIntensity?: number;
  metalness?: number;
  roughness?: number;
  transparent?: boolean;
  opacity?: number;
  position?: [number, number, number];
  rotation?: [number, number, number];
  wireframe?: boolean;
}

interface SceneDescriptor {
  objects?: SceneObject[];
}

const SCENE_GEN_SYSTEM = `You are a Three.js 3D scene generator. Given a description, return ONLY a valid JSON object — no markdown, no code fences, no explanation. Structure:
{"objects":[{"type":"sphere|box|torus|cylinder|cone|icosahedron|ring|plane","size":1.0,"color":"#6366f1","emissive":"#4f46e5","emissiveIntensity":0.5,"metalness":0.3,"roughness":0.3,"position":[0,0,0],"rotation":[0,0,0],"transparent":false,"opacity":1.0,"wireframe":false}]}
Rules: 3-8 objects. Use emissiveIntensity 0.3-0.8 for glowing effects. Size 0.3-3.5. Position -3.5 to 3.5 on each axis. Combine shapes creatively (e.g. icosahedron core with orbiting ring shells). Use harmonious hex color palettes. Return ONLY the JSON object.`;

async function callLocalLLMForScene(prompt: string): Promise<SceneDescriptor> {
  const response = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'llama3.2',
      messages: [
        { role: 'system', content: SCENE_GEN_SYSTEM },
        { role: 'user', content: prompt },
      ],
      stream: false,
    }),
  });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
  const data = await response.json();
  const text: string = (data.message?.content ?? data.response ?? '').trim();
  const jsonMatch = text.replace(/```json\n?|\n?```|```\n?/g, '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response');
  return JSON.parse(jsonMatch[0]) as SceneDescriptor;
}

function buildSceneFromDescriptor(descriptor: SceneDescriptor, group: THREE.Group): void {
  [...group.children].forEach((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else (mat as THREE.Material).dispose();
    }
    group.remove(child);
  });

  (descriptor.objects ?? []).forEach((obj) => {
    try {
      const raw = Array.isArray(obj.size) ? obj.size : [obj.size ?? 1, obj.size ?? 1, obj.size ?? 1];
      const [sw, sh, sd] = raw.map((v) => Math.max(v, 0.1));

      let geo: THREE.BufferGeometry;
      switch (obj.type) {
        case 'box':         geo = new THREE.BoxGeometry(sw, sh, sd); break;
        case 'sphere':      geo = new THREE.SphereGeometry(sw * 0.5, 32, 32); break;
        case 'torus':       geo = new THREE.TorusGeometry(sw * 0.65, Math.max(sw * 0.08, 0.04), 14, 80); break;
        case 'cylinder':    geo = new THREE.CylinderGeometry(sw * 0.4, sw * 0.4, sh, 32); break;
        case 'cone':        geo = new THREE.ConeGeometry(sw * 0.5, sh, 32); break;
        case 'icosahedron': geo = new THREE.IcosahedronGeometry(sw * 0.5, 1); break;
        case 'ring':        geo = new THREE.TorusGeometry(sw * 0.65, sw * 0.03, 8, 80); break;
        case 'plane':       geo = new THREE.PlaneGeometry(sw, sh); break;
        default:            geo = new THREE.SphereGeometry(0.5, 32, 32);
      }

      const opacity = obj.opacity ?? 1;
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(obj.color ?? '#7dd3fc'),
        emissive: new THREE.Color(obj.emissive ?? obj.color ?? '#000000'),
        emissiveIntensity: obj.emissiveIntensity ?? 0,
        metalness: obj.metalness ?? 0.2,
        roughness: obj.roughness ?? 0.5,
        transparent: obj.transparent ?? opacity < 1,
        opacity,
        wireframe: obj.wireframe ?? false,
      });

      const mesh = new THREE.Mesh(geo, mat);
      if (obj.position) mesh.position.set(...(obj.position as [number, number, number]));
      if (obj.rotation) {
        const [rx, ry, rz] = obj.rotation;
        mesh.rotation.set(
          THREE.MathUtils.degToRad(rx),
          THREE.MathUtils.degToRad(ry),
          THREE.MathUtils.degToRad(rz)
        );
      }
      group.add(mesh);
    } catch (e) {
      console.warn('Scene object build error:', e);
    }
  });
}

// ─── Viewport ────────────────────────────────────────────────────────────────

function JarvisViewport({
  state,
  isThinking,
  modelUrl,
  sceneDescriptor,
}: {
  state: JarvisSceneState;
  isThinking: boolean;
  modelUrl?: string;
  sceneDescriptor?: SceneDescriptor;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef(state);
  const thinkingRef = useRef(isThinking);
  const speakingUntilRef = useRef(0);
  const prevThinkingRef = useRef(isThinking);
  const objectGroupRef = useRef<THREE.Group | null>(null);
  const sceneGroupRef = useRef<THREE.Group | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (!isThinking && prevThinkingRef.current) {
      speakingUntilRef.current = performance.now() + 1100;
    }
    prevThinkingRef.current = isThinking;
    thinkingRef.current = isThinking;
  }, [isThinking]);

  useEffect(() => {
    if (!modelUrl || !objectGroupRef.current) return;
    const group = objectGroupRef.current;
    const loader = new GLTFLoader();
    loader.load(
      modelUrl,
      (gltf) => {
        while (group.children.length > 0) group.remove(group.children[0]);
        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3()).length();
        const center = box.getCenter(new THREE.Vector3());
        const scale = 2.4 / Math.max(size, 0.001);
        model.scale.setScalar(scale);
        model.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
        group.add(model);
      },
      undefined,
      (err) => console.error('GLTFLoader:', err)
    );
  }, [modelUrl]);

  useEffect(() => {
    const group = sceneGroupRef.current;
    if (!group || !sceneDescriptor) return;
    buildSceneFromDescriptor(sceneDescriptor, group);
  }, [sceneDescriptor]);

  useEffect(() => {
    if (!mountRef.current) return;

    const mount = mountRef.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#040816');
    scene.fog = new THREE.Fog('#040816', 12, 28);

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 1.55, 6.1);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setClearColor(0x040816, 1);
    mount.appendChild(renderer.domElement);

    const resizeObserver = new ResizeObserver(() => {
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    });
    resizeObserver.observe(mount);

    const ambient = new THREE.AmbientLight(0x7ad8ff, 0.25);
    scene.add(ambient);
    const keyLight = new THREE.DirectionalLight(0x9ee7ff, 1.3);
    keyLight.position.set(6, 8, 8);
    scene.add(keyLight);
    const fillLight = new THREE.PointLight(0x00d5ff, 2.5, 22);
    fillLight.position.set(-4, 2, 4);
    scene.add(fillLight);
    const rimLight = new THREE.PointLight(0x7c3aed, 1.4, 18);
    rimLight.position.set(4, 1, -5);
    scene.add(rimLight);

    const starGeometry = new THREE.BufferGeometry();
    const starCount = 220;
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i += 1) {
      const radius = 12 + Math.random() * 12;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(THREE.MathUtils.randFloatSpread(2));
      starPositions[i * 3] = Math.cos(theta) * Math.sin(phi) * radius;
      starPositions[i * 3 + 1] = THREE.MathUtils.randFloatSpread(10) + 1.5;
      starPositions[i * 3 + 2] = Math.sin(theta) * Math.sin(phi) * radius - 4;
    }
    starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const starMaterial = new THREE.PointsMaterial({
      color: 0x8be9ff,
      size: 0.045,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });
    const stars = new THREE.Points(starGeometry, starMaterial);
    scene.add(stars);

    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(3.35, 0.06, 10, 120),
      new THREE.MeshBasicMaterial({ color: 0x2dd4bf, transparent: true, opacity: 0.14 })
    );
    halo.rotation.x = Math.PI / 2;
    halo.position.set(0, 0.7, -1.4);
    scene.add(halo);

    const objectGroup = new THREE.Group();
    objectGroup.position.y = 0.85;
    objectGroup.scale.setScalar(1.18);
    scene.add(objectGroup);
    objectGroupRef.current = objectGroup;

    const mapGroup = new THREE.Group();
    mapGroup.visible = false;
    scene.add(mapGroup);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(7.8, 64),
      new THREE.MeshStandardMaterial({
        color: 0x091225,
        metalness: 0.15,
        roughness: 0.75,
        transparent: true,
        opacity: 0.9,
      })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -2.1;
    scene.add(ground);

    const grid = new THREE.GridHelper(18, 36, 0x2bd9ff, 0x16314f);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    grid.position.y = -2.08;
    scene.add(grid);

    const centralCore = new THREE.Mesh(
      new THREE.SphereGeometry(0.78, 40, 40),
      new THREE.MeshStandardMaterial({
        color: 0x0ff0ff,
        emissive: 0x19d9ff,
        emissiveIntensity: 0.8,
        metalness: 0.45,
        roughness: 0.25,
      })
    );
    objectGroup.add(centralCore);

    const emitterRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.28, 0.08, 12, 80),
      new THREE.MeshStandardMaterial({
        color: 0x61dbfb,
        emissive: 0x0ea5e9,
        emissiveIntensity: 0.75,
        transparent: true,
        opacity: 0.95,
      })
    );
    emitterRing.rotation.x = Math.PI / 2;
    objectGroup.add(emitterRing);

    const shellRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.9, 0.06, 12, 90),
      new THREE.MeshStandardMaterial({
        color: 0x8b5cf6,
        emissive: 0x7c3aed,
        emissiveIntensity: 0.35,
        transparent: true,
        opacity: 0.8,
      })
    );
    shellRing.rotation.x = Math.PI / 2;
    shellRing.rotation.z = Math.PI / 7;
    objectGroup.add(shellRing);

    const moduleMaterial = new THREE.MeshStandardMaterial({
      color: 0x14294b,
      metalness: 0.65,
      roughness: 0.28,
      emissive: 0x081422,
      emissiveIntensity: 0.25,
    });
    const accentMaterial = new THREE.MeshStandardMaterial({
      color: 0x1ca9ff,
      metalness: 0.3,
      roughness: 0.3,
      emissive: 0x19d9ff,
      emissiveIntensity: 0.45,
    });

    type PartDef = { mesh: THREE.Mesh; direction: THREE.Vector3; basePosition: THREE.Vector3 };
    const partDefs: PartDef[] = [];
    const directions = [
      new THREE.Vector3(1, 0.18, 0.1),
      new THREE.Vector3(-1, 0.08, 0.15),
      new THREE.Vector3(0.1, 0.28, 1),
      new THREE.Vector3(-0.12, -0.14, -1),
      new THREE.Vector3(0.85, -0.2, -0.5),
      new THREE.Vector3(-0.8, 0.25, 0.55),
    ];

    directions.forEach((direction, index) => {
      const module = new THREE.Mesh(
        new THREE.BoxGeometry(0.78, 0.35, 0.78),
        index % 2 === 0 ? moduleMaterial.clone() : accentMaterial.clone()
      );
      module.position.copy(direction.clone().multiplyScalar(1.7));
      module.scale.setScalar(index === 2 ? 1.05 : 1);
      objectGroup.add(module);

      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.18, 0.9, 24),
        new THREE.MeshStandardMaterial({
          color: 0x8be9ff,
          emissive: 0x2bd9ff,
          emissiveIntensity: 0.5,
          metalness: 0.7,
          roughness: 0.2,
        })
      );
      cap.rotation.z = Math.PI / 2;
      cap.position.copy(direction.clone().multiplyScalar(1.7)).add(new THREE.Vector3(0, 0.24, 0));
      objectGroup.add(cap);

      partDefs.push({ mesh: module, direction, basePosition: module.position.clone() });
      partDefs.push({ mesh: cap, direction, basePosition: cap.position.clone() });
    });

    const orbitRings = [1.1, 1.65, 2.35].map((radius, index) => {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius, 0.03, 12, 96),
        new THREE.MeshBasicMaterial({
          color: index === 0 ? 0x61dbfb : index === 1 ? 0x8b5cf6 : 0x16a34a,
          transparent: true,
          opacity: 0.45,
        })
      );
      ring.rotation.x = Math.PI / (2 + index * 0.45);
      ring.rotation.y = index * 0.65;
      objectGroup.add(ring);
      return ring;
    });

    const mapSurface = new THREE.Mesh(
      new THREE.CircleGeometry(4.2, 64),
      new THREE.MeshStandardMaterial({
        color: 0x08111f,
        emissive: 0x08111f,
        metalness: 0.15,
        roughness: 0.82,
        transparent: true,
        opacity: 0.96,
      })
    );
    mapSurface.rotation.x = -Math.PI / 2;
    mapGroup.add(mapSurface);

    const mapGrid = new THREE.GridHelper(9, 18, 0x38bdf8, 0x13324d);
    (mapGrid.material as THREE.Material).transparent = true;
    (mapGrid.material as THREE.Material).opacity = 0.3;
    mapGrid.position.y = 0.02;
    mapGroup.add(mapGrid);

    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 24, 24),
      new THREE.MeshStandardMaterial({
        color: 0xffd166,
        emissive: 0xffb703,
        emissiveIntensity: 0.85,
        metalness: 0.2,
        roughness: 0.3,
      })
    );
    marker.position.set(0.7, 0.3, -0.1);
    mapGroup.add(marker);

    const route = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, 5.8, 12),
      new THREE.MeshStandardMaterial({
        color: 0x22c55e,
        emissive: 0x22c55e,
        emissiveIntensity: 0.45,
      })
    );
    route.position.set(-0.8, 0.18, -0.1);
    route.rotation.z = Math.PI / 2.5;
    route.rotation.y = Math.PI / 6;
    mapGroup.add(route);

    const pulseRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.1, 0.06, 8, 80),
      new THREE.MeshBasicMaterial({ color: 0x2dd4bf, transparent: true, opacity: 0.55 })
    );
    pulseRing.rotation.x = Math.PI / 2;
    mapGroup.add(pulseRing);

    // ── Generated scene group (scene mode) ────────────────────────────────────
    const sceneGroup = new THREE.Group();
    sceneGroup.visible = false;
    scene.add(sceneGroup);
    sceneGroupRef.current = sceneGroup;

    // ── Neural Graph (brand / content / analytics modes) ──────────────────────
    const neuralGroup = new THREE.Group();
    neuralGroup.visible = false;
    scene.add(neuralGroup);

    const NODE_COUNT = 52;
    const nodePosData = new Float32Array(NODE_COUNT * 3);
    const nodeVelData = new Float32Array(NODE_COUNT * 3);
    const nodePhase = new Float32Array(NODE_COUNT);

    // Node 0 = center hub; rest scattered in a flat-ish ellipsoid
    nodePosData[0] = 0; nodePosData[1] = 0; nodePosData[2] = 0;
    nodeVelData[0] = 0; nodeVelData[1] = 0; nodeVelData[2] = 0;
    for (let i = 1; i < NODE_COUNT; i++) {
      const r = 0.9 + Math.random() * 3.6;
      const theta = Math.random() * Math.PI * 2;
      nodePosData[i * 3]     = r * Math.cos(theta);
      nodePosData[i * 3 + 1] = (Math.random() - 0.5) * 2.6;
      nodePosData[i * 3 + 2] = r * Math.sin(theta) * 0.28;
      nodeVelData[i * 3]     = (Math.random() - 0.5) * 0.0045;
      nodeVelData[i * 3 + 1] = (Math.random() - 0.5) * 0.003;
      nodeVelData[i * 3 + 2] = (Math.random() - 0.5) * 0.001;
      nodePhase[i] = Math.random() * Math.PI * 2;
    }

    const nodeGeo = new THREE.BufferGeometry();
    const nodePosAttr = new THREE.BufferAttribute(nodePosData, 3);
    nodeGeo.setAttribute('position', nodePosAttr);
    const nodeMat = new THREE.PointsMaterial({
      color: 0x7dd3fc,
      size: 0.07,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      sizeAttenuation: true,
    });
    neuralGroup.add(new THREE.Points(nodeGeo, nodeMat));

    // Build edges connecting nearby nodes
    const edgePairs: number[][] = [];
    const rawEdgePos: number[] = [];
    const CONNECT_DIST = 2.4;
    for (let i = 0; i < NODE_COUNT; i++) {
      for (let j = i + 1; j < NODE_COUNT; j++) {
        const dx = nodePosData[i * 3]     - nodePosData[j * 3];
        const dy = nodePosData[i * 3 + 1] - nodePosData[j * 3 + 1];
        const dz = nodePosData[i * 3 + 2] - nodePosData[j * 3 + 2];
        if (dx * dx + dy * dy + dz * dz < CONNECT_DIST * CONNECT_DIST) {
          edgePairs.push([i, j]);
          rawEdgePos.push(
            nodePosData[i * 3], nodePosData[i * 3 + 1], nodePosData[i * 3 + 2],
            nodePosData[j * 3], nodePosData[j * 3 + 1], nodePosData[j * 3 + 2]
          );
        }
      }
    }
    const edgeGeo = new THREE.BufferGeometry();
    const edgePosAttr = new THREE.BufferAttribute(new Float32Array(rawEdgePos), 3);
    edgePosAttr.setUsage(THREE.DynamicDrawUsage);
    edgeGeo.setAttribute('position', edgePosAttr);
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x1e3a5f, transparent: true, opacity: 0.38 });
    neuralGroup.add(new THREE.LineSegments(edgeGeo, edgeMat));

    // Signal particles — dots that travel along edges when firing
    const SIGNAL_COUNT = 14;
    const sigData: { edgeIdx: number; t: number; speed: number; active: boolean }[] =
      Array.from({ length: SIGNAL_COUNT }, () => ({ edgeIdx: 0, t: 0, speed: 0.5, active: false }));
    const sigPosArr = new Float32Array(SIGNAL_COUNT * 3);
    const sigGeo = new THREE.BufferGeometry();
    const sigPosAttr = new THREE.BufferAttribute(sigPosArr, 3);
    sigPosAttr.setUsage(THREE.DynamicDrawUsage);
    sigGeo.setAttribute('position', sigPosAttr);
    const sigMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.11,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      sizeAttenuation: true,
    });
    neuralGroup.add(new THREE.Points(sigGeo, sigMat));

    const clock = new THREE.Clock();
    let frameId = 0;

    const animate = () => {
      frameId = window.requestAnimationFrame(animate);
      const delta = Math.min(clock.getDelta(), 0.05);
      const elapsed = clock.elapsedTime;
      const current = stateRef.current;
      const firing = thinkingRef.current;

      const isObjectMode = current.mode === 'object' || current.mode === 'overview';
      const isNeuralMode = current.mode === 'brand' || current.mode === 'content' || current.mode === 'analytics';
      const isSceneMode = current.mode === 'scene';
      objectGroup.visible = isObjectMode;
      mapGroup.visible = current.mode === 'map';
      neuralGroup.visible = isNeuralMode;
      sceneGroup.visible = isSceneMode;
      grid.visible = isObjectMode;
      ground.visible = isObjectMode;
      halo.visible = isObjectMode;

      if (isSceneMode) {
        sceneGroup.rotation.y += 0.004;
        sceneGroup.children.forEach((child, i) => {
          child.position.y += Math.sin(elapsed * 0.55 + i * 1.4) * 0.001;
        });
      }

      const explodeTarget = current.exploded ? 1 : 0;
      const powerTarget = current.powerOn ? 1 : 0;
      const camZTarget = isNeuralMode ? 7.2 : isSceneMode ? 6.5 : (current.cameraDistance || 6.2);
      const camY = current.mode === 'map' ? 2.1 : isNeuralMode ? 0.2 : isSceneMode ? 1.2 : 2.4;
      const lookY = current.mode === 'map' ? 0.2 : isNeuralMode ? 0.0 : isSceneMode ? 0.2 : 0.85;

      camera.position.z += (camZTarget - camera.position.z) * 0.04;
      camera.position.y += (camY - camera.position.y) * 0.04;
      camera.lookAt(0, lookY, 0);

      objectGroup.rotation.y += current.rotationSpeed;
      objectGroup.rotation.x = Math.sin(elapsed * 0.25) * 0.03;
      mapGroup.rotation.y = Math.sin(elapsed * 0.2) * 0.05;
      stars.rotation.y += 0.0006;
      stars.rotation.x = Math.sin(elapsed * 0.08) * 0.01;
      if (isObjectMode) halo.rotation.z += 0.0015;

      if (isNeuralMode) {
        // Drift nodes
        for (let i = 1; i < NODE_COUNT; i++) {
          nodePosData[i * 3]     += nodeVelData[i * 3];
          nodePosData[i * 3 + 1] += nodeVelData[i * 3 + 1];
          nodePosData[i * 3 + 2] += nodeVelData[i * 3 + 2];
          if (Math.abs(nodePosData[i * 3])     > 5.0) nodeVelData[i * 3]     *= -1;
          if (Math.abs(nodePosData[i * 3 + 1]) > 2.8) nodeVelData[i * 3 + 1] *= -1;
          if (Math.abs(nodePosData[i * 3 + 2]) > 1.3) nodeVelData[i * 3 + 2] *= -1;
        }
        nodePosAttr.needsUpdate = true;

        // Sync edge endpoints to drifted nodes
        const edgeArr = edgePosAttr.array as Float32Array;
        for (let i = 0; i < edgePairs.length; i++) {
          const a = edgePairs[i][0]; const b = edgePairs[i][1];
          edgeArr[i * 6]     = nodePosData[a * 3];     edgeArr[i * 6 + 1] = nodePosData[a * 3 + 1]; edgeArr[i * 6 + 2] = nodePosData[a * 3 + 2];
          edgeArr[i * 6 + 3] = nodePosData[b * 3];     edgeArr[i * 6 + 4] = nodePosData[b * 3 + 1]; edgeArr[i * 6 + 5] = nodePosData[b * 3 + 2];
        }
        edgePosAttr.needsUpdate = true;

        // Visual state — calm, firing (thinking), or speaking burst
        const speaking = performance.now() < speakingUntilRef.current;
        const active = firing || speaking;
        const freq = active ? (firing ? 3.2 : 5.5) : 0.55;
        nodeMat.opacity = Math.min(0.98, 0.55 + Math.sin(elapsed * freq + 0.5) * 0.18 + (active ? 0.22 : 0));
        edgeMat.opacity = Math.min(0.85, 0.22 + (active ? 0.32 : 0) + Math.sin(elapsed * (active ? 2.8 : 0.7)) * 0.07);

        const nodeIdleColor  = current.mode === 'brand' ? 0x818cf8 : current.mode === 'content' ? 0xe879f9 : 0x7dd3fc;
        const nodeFireColor  = current.mode === 'brand' ? 0xa78bfa : current.mode === 'content' ? 0xf472b6 : 0x22d3ee;
        const edgeIdleColor  = current.mode === 'brand' ? 0x312e81 : current.mode === 'content' ? 0x4a044e : 0x1e3a5f;
        const edgeFireColor  = current.mode === 'brand' ? 0x7c3aed : current.mode === 'content' ? 0xbe185d : 0x3b82f6;
        nodeMat.color.setHex(active ? nodeFireColor : nodeIdleColor);
        edgeMat.color.setHex(active ? edgeFireColor : edgeIdleColor);

        // Signal particles travel along edges
        const spawnRate = firing ? 0.07 : speaking ? 0.04 : 0.005;
        for (let si = 0; si < SIGNAL_COUNT; si++) {
          const sig = sigData[si];
          if (!sig.active && edgePairs.length > 0 && Math.random() < spawnRate) {
            sig.active = true;
            sig.edgeIdx = Math.floor(Math.random() * edgePairs.length);
            sig.t = 0;
            sig.speed = (active ? 1.3 : 0.4) + Math.random() * 0.6;
          }
          if (sig.active) {
            sig.t += sig.speed * delta;
            if (sig.t >= 1) { sig.active = false; }
            const a = edgePairs[sig.edgeIdx][0]; const b = edgePairs[sig.edgeIdx][1];
            sigPosArr[si * 3]     = nodePosData[a * 3]     + (nodePosData[b * 3]     - nodePosData[a * 3])     * sig.t;
            sigPosArr[si * 3 + 1] = nodePosData[a * 3 + 1] + (nodePosData[b * 3 + 1] - nodePosData[a * 3 + 1]) * sig.t;
            sigPosArr[si * 3 + 2] = nodePosData[a * 3 + 2] + (nodePosData[b * 3 + 2] - nodePosData[a * 3 + 2]) * sig.t;
          } else {
            sigPosArr[si * 3 + 1] = -1000;
          }
        }
        sigPosAttr.needsUpdate = true;
      }

      partDefs.forEach(({ mesh, direction, basePosition }) => {
        const offset = direction.clone().multiplyScalar(2.1 * explodeTarget);
        mesh.position.lerpVectors(basePosition, basePosition.clone().add(offset), 0.15);
        const material = mesh.material as THREE.MeshStandardMaterial;
        material.emissiveIntensity = 0.18 + powerTarget * 0.7;
      });

      centralCore.scale.setScalar(1 + powerTarget * 0.12 + Math.sin(elapsed * 2.4) * 0.02);
      emitterRing.scale.setScalar(1 + powerTarget * 0.08 + Math.sin(elapsed * 1.5) * 0.01);
      shellRing.rotation.z += 0.003 + powerTarget * 0.005;

      orbitRings.forEach((ring, index) => {
        ring.rotation.x += 0.0012 + index * 0.0003;
        ring.rotation.y += 0.001 + index * 0.00035;
      });

      mapSurface.scale.setScalar(1 + Math.sin(elapsed * 2) * 0.015);
      pulseRing.scale.setScalar(1 + Math.sin(elapsed * 2.8) * 0.08);
      marker.position.y = 0.28 + Math.sin(elapsed * 3.1) * 0.08;
      route.rotation.y += 0.002;
      fillLight.intensity = 1.9 + powerTarget * 1.25;
      rimLight.intensity = 1.1 + powerTarget * 0.75;

      renderer.render(scene, camera);
    };

    animate();

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      sceneGroupRef.current = null;
      starGeometry.dispose();
      starMaterial.dispose();
      halo.geometry.dispose();
      (halo.material as THREE.Material).dispose();
      nodeGeo.dispose();
      nodeMat.dispose();
      edgeGeo.dispose();
      edgeMat.dispose();
      sigGeo.dispose();
      sigMat.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div className="relative h-full overflow-hidden bg-[#040816]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.18),transparent_38%),linear-gradient(to_bottom,rgba(15,23,42,0.16),rgba(2,6,23,0.92))]" />
      <div className="pointer-events-none absolute inset-0 opacity-45">
        <div className="absolute inset-4 rounded-[1.75rem] border border-cyan-400/10" />
        <div className="absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-300/25" />
        <div className="absolute left-1/2 top-1/2 h-px w-64 -translate-x-1/2 -translate-y-1/2 bg-cyan-300/30" />
        <div className="absolute left-1/2 top-1/2 h-64 w-px -translate-x-1/2 -translate-y-1/2 bg-cyan-300/30" />
        <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent,rgba(34,211,238,0.06),transparent)] bg-[length:100%_160px]" />
      </div>
      <div ref={mountRef} className="absolute inset-0" />
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function JarvisPage() {
  const [input, setInput] = useState('');
  const [sceneState, setSceneState] = useState<JarvisSceneState>(() => createInitialJarvisState());
  const [transcript, setTranscript] = useState<JarvisTranscriptEntry[]>(() => [
    {
      id: makeTranscriptId(),
      role: 'system',
      text: 'HUD initialized. Issue a command or tap a chip.',
      timestamp: new Date().toISOString(),
    },
  ]);
  const [isThinking, setIsThinking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [modelUrl, setModelUrl] = useState<string | undefined>(undefined);
  const [sceneDescriptor, setSceneDescriptor] = useState<SceneDescriptor | undefined>(undefined);
  const recognitionRef = useRef<any>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const apiKeyRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const fact = useMemo(() => getFactForTarget(sceneState.activeTarget), [sceneState.activeTarget]);

  useEffect(() => {
    if (!isRunningInElectron()) return;
    getAccomplish().getApiKey()
      .then((key) => { apiKeyRef.current = key; })
      .catch(() => {});
  }, []);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  const executeCommand = useCallback(
    async (rawInput: string) => {
      const trimmed = rawInput.trim();
      if (!trimmed || isThinking) return;

      const command = parseJarvisCommand(trimmed);
      const nextState = applyJarvisCommand(sceneState, command);
      const localReply = describeJarvisCommand(command, nextState);

      setSceneState(nextState);
      setInput('');

      const ts = new Date().toISOString();
      const userEntry: JarvisTranscriptEntry = { id: makeTranscriptId(), role: 'user', text: trimmed, timestamp: ts };
      const apiKey = apiKeyRef.current;

      // 3D scene generation — calls local Ollama, no API key required
      if (command.intent === 'create_scene') {
        const assistantId = makeTranscriptId();
        setTranscript((prev) => [
          ...prev,
          userEntry,
          { id: assistantId, role: 'assistant', text: 'Generating scene via local LLM...', timestamp: ts },
        ]);
        setIsThinking(true);
        try {
          const descriptor = await callLocalLLMForScene(trimmed);
          setSceneDescriptor(descriptor);
          const n = descriptor.objects?.length ?? 0;
          setTranscript((prev) =>
            prev.map((e) => (e.id === assistantId ? { ...e, text: `Scene rendered — ${n} objects composed.` } : e))
          );
        } catch (err) {
          const msg = err instanceof Error && err.message.includes('Ollama')
            ? 'Ollama not running. Start Ollama and try again.'
            : 'Scene generation failed. Make sure Ollama is running with llama3.2.';
          setTranscript((prev) =>
            prev.map((e) => (e.id === assistantId ? { ...e, text: msg } : e))
          );
        }
        setIsThinking(false);
        return;
      }

      if (!apiKey) {
        setTranscript((prev) => [
          ...prev,
          userEntry,
          { id: makeTranscriptId(), role: 'assistant', text: localReply, timestamp: ts },
        ]);
        return;
      }

      const assistantId = makeTranscriptId();
      setTranscript((prev) => [
        ...prev,
        userEntry,
        { id: assistantId, role: 'assistant', text: '...', timestamp: ts },
      ]);
      setIsThinking(true);

      let finalReply = localReply;
      try {
        finalReply = await callAnthropicHaiku(apiKey, trimmed);
      } catch {
        // fall back to local reply
      }

      setTranscript((prev) =>
        prev.map((e) => (e.id === assistantId ? { ...e, text: finalReply } : e))
      );
      setIsThinking(false);
    },
    [sceneState, isThinking]
  );

  const onSubmit = useCallback(() => {
    void executeCommand(input);
  }, [executeCommand, input]);

  const onPreset = useCallback(
    (prompt: string) => {
      setInput(prompt);
      void executeCommand(prompt);
    },
    [executeCommand]
  );

  const toggleListening = useCallback(() => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onresult = (event: any) => {
      const heard: string = event.results[0][0].transcript;
      setInput(heard);
      void executeCommand(heard);
    };
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => setIsListening(false);

    recognition.start();
    recognitionRef.current = recognition;
    setIsListening(true);
  }, [isListening, executeCommand]);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const prev = modelUrl;
      const url = URL.createObjectURL(file);
      setModelUrl(url);
      void executeCommand(`Load ${file.name.replace(/\.[^.]+$/, '')}`);
      e.target.value = '';
      if (prev) URL.revokeObjectURL(prev);
    },
    [modelUrl, executeCommand]
  );

  const stateChips = useMemo(
    () =>
      [
        sceneState.powerOn ? { label: 'Powered', color: 'text-emerald-400' } : null,
        sceneState.exploded ? { label: 'Exploded', color: 'text-amber-400' } : null,
        sceneState.mode === 'map' ? { label: 'Map', color: 'text-sky-400' } : null,
        sceneState.mode === 'brand' ? { label: 'Brand', color: 'text-violet-400' } : null,
        sceneState.mode === 'content' ? { label: 'Content', color: 'text-pink-400' } : null,
        sceneState.mode === 'analytics' ? { label: 'Analytics', color: 'text-cyan-400' } : null,
        sceneState.mode === 'scene' ? { label: 'Scene', color: 'text-emerald-400' } : null,
      ].filter(Boolean) as { label: string; color: string }[],
    [sceneState]
  );

  const commandChips = useMemo<JarvisChip[]>(() => {
    const m = sceneState.mode;
    if (m === 'brand') return [
      { label: 'Tagline', prompt: 'Write 3 sharp taglines for a bold digital brand', icon: Sparkles },
      { label: 'Value prop', prompt: 'Write a one-sentence value proposition for a SaaS product', icon: Zap },
      { label: 'Brand voice', prompt: 'Describe a brand voice that is bold, minimal, and modern', icon: Palette },
      { label: 'Ad copy', prompt: 'Write 3 short ad copy lines for a digital product launch', icon: TrendingUp },
      { label: 'Switch scene', prompt: 'Load reactor core', icon: Box },
    ];
    if (m === 'content') return [
      { label: 'IG caption', prompt: 'Write an Instagram caption with a strong hook for a digital product launch', icon: Hash },
      { label: 'Email subject', prompt: 'Write 5 email subject lines for a product launch campaign', icon: Mail },
      { label: 'Twitter thread', prompt: 'Write the first 3 tweets of a thread about building a successful digital product', icon: Sparkles },
      { label: 'Blog hook', prompt: 'Write a compelling opening paragraph for a blog post about digital products', icon: FileText },
      { label: 'Switch scene', prompt: 'Load reactor core', icon: Box },
    ];
    if (m === 'analytics') return [
      { label: 'KPI summary', prompt: 'Write a concise KPI performance summary for a growing digital product', icon: BarChart2 },
      { label: 'Growth post', prompt: 'Write a LinkedIn post announcing strong user growth this quarter', icon: TrendingUp },
      { label: 'Investor update', prompt: 'Write a one-paragraph investor update highlighting strong monthly metrics', icon: Zap },
      { label: 'Data insight', prompt: 'Write 3 data-driven insights for a SaaS product with strong retention', icon: Sparkles },
      { label: 'Switch scene', prompt: 'Load reactor core', icon: Box },
    ];
    // scene mode
    if (m === 'scene') return [
      { label: 'Create new', prompt: 'Create a glowing icosahedron with orbiting rings in deep violet and cyan', icon: Wand2 },
      { label: 'Brand 3D', prompt: 'Create a bold geometric logo shape with hexagonal rings and brand violet glow', icon: Palette },
      { label: 'Product 3D', prompt: 'Create a sleek product box with a glowing edge and floating spheres around it', icon: Box },
      { label: 'Brand mode', prompt: 'Switch to brand mode', icon: Sparkles },
      { label: 'Load model', prompt: '', icon: Box, action: () => fileInputRef.current?.click() },
    ];
    return [
      { label: 'Load 3D', prompt: '', icon: Box, action: () => fileInputRef.current?.click() },
      { label: 'Create 3D', prompt: 'Create a glowing orb surrounded by orbiting violet rings and cyan signal particles', icon: Wand2 },
      { label: 'Brand', prompt: 'Switch to brand mode', icon: Palette },
      { label: 'Content', prompt: 'Switch to content mode', icon: FileText },
      { label: 'Analytics', prompt: 'Switch to analytics mode', icon: BarChart2 },
    ];
  }, [sceneState.mode]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="relative h-full overflow-hidden bg-[#040816]"
    >
      {/* ── Full-bleed 3D viewport ── */}
      <div className="absolute inset-0">
        <JarvisViewport state={sceneState} isThinking={isThinking} modelUrl={modelUrl} sceneDescriptor={sceneDescriptor} />
      </div>

      {/* ── Top HUD bar ── */}
      <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <Badge className="border border-cyan-500/30 bg-slate-950/75 px-2.5 py-1 text-[11px] text-cyan-400 backdrop-blur-md hover:bg-slate-950/75">
            <RadioTower className="mr-1.5 h-3 w-3" />
            HUD online
          </Badge>
          <Badge
            variant="outline"
            className="border-cyan-500/20 bg-slate-950/60 px-2.5 py-1 text-[11px] text-slate-400 backdrop-blur-md"
          >
            <Compass className="mr-1.5 h-3 w-3" />
            {sceneState.mode === 'map' ? 'Map' : sceneState.mode === 'brand' ? 'Brand' : sceneState.mode === 'content' ? 'Content' : sceneState.mode === 'analytics' ? 'Analytics' : sceneState.mode === 'scene' ? 'Scene' : 'Object'}
          </Badge>
          {stateChips.map((chip) => (
            <Badge
              key={chip.label}
              variant="outline"
              className={`border-white/10 bg-slate-950/60 px-2.5 py-1 text-[11px] backdrop-blur-md ${chip.color}`}
            >
              {chip.label}
            </Badge>
          ))}
          {isThinking && (
            <Badge
              variant="outline"
              className="border-violet-500/30 bg-slate-950/60 px-2.5 py-1 text-[11px] text-violet-400 backdrop-blur-md"
            >
              <RotateCw className="mr-1.5 h-3 w-3 animate-spin" />
              Processing
            </Badge>
          )}
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-[0.3em] text-slate-600">Module</p>
          <p className="text-sm font-medium text-slate-200">{fact.title}</p>
        </div>
      </div>

      {/* ── Right panel: scene brief + transcript ── */}
      <div className="absolute right-3 top-14 z-20 flex w-72 flex-col overflow-hidden rounded-2xl border border-cyan-500/15 bg-slate-950/85 backdrop-blur-xl">
        {/* Scene brief */}
        <div className="border-b border-cyan-500/10 px-3.5 py-3">
          <div className="mb-1.5 flex items-center gap-1.5">
            <Bot className="h-3.5 w-3.5 text-cyan-500/70" />
            <span className="text-[10px] uppercase tracking-[0.28em] text-slate-500">Scene brief</span>
          </div>
          <p className="text-[13px] leading-5 text-slate-300">{fact.summary}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {fact.bullets.map((b) => (
              <span
                key={b}
                className="rounded-md border border-cyan-500/15 bg-slate-900/80 px-1.5 py-0.5 text-[10px] text-cyan-400/80"
              >
                {b}
              </span>
            ))}
          </div>
        </div>

        {/* Transcript feed */}
        <div className="flex items-center justify-between border-b border-cyan-500/10 px-3.5 py-2">
          <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.28em] text-slate-500">
            <Telescope className="h-3 w-3" />
            Comms
          </span>
          <span
            className={`h-1.5 w-1.5 rounded-full transition-colors ${
              isListening ? 'bg-red-400 animate-pulse' : isThinking ? 'bg-cyan-400 animate-pulse' : 'bg-slate-700'
            }`}
          />
        </div>
        <ScrollArea className="h-52">
          <div className="space-y-2 px-3 py-2.5">
            {transcript.map((entry) => (
              <div key={entry.id} className="group relative text-[13px] leading-5">
                {entry.role === 'user' && (
                  <p className="text-cyan-300">
                    <span className="mr-1 text-[10px] opacity-50">&gt;</span>
                    {entry.text}
                  </p>
                )}
                {entry.role === 'assistant' && (
                  <div className={`text-slate-300 ${entry.text === '...' ? 'animate-pulse' : ''}`}>
                    <span className="mr-1 text-[10px] text-violet-500/60">//</span>
                    {entry.text}
                    {entry.text !== '...' && (
                      <button
                        type="button"
                        title="Copy"
                        onClick={() => void navigator.clipboard.writeText(entry.text)}
                        className="ml-1.5 inline-flex cursor-pointer items-center opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
                      >
                        <Clipboard className="h-2.5 w-2.5 text-slate-500" />
                      </button>
                    )}
                  </div>
                )}
                {entry.role === 'system' && (
                  <p className="text-slate-600">{entry.text}</p>
                )}
              </div>
            ))}
            <div ref={transcriptEndRef} />
          </div>
        </ScrollArea>
      </div>

      {/* ── Bottom command bar ── */}
      <div className="absolute inset-x-0 bottom-0 z-20 border-t border-cyan-500/10 bg-slate-950/92 backdrop-blur-xl">
        {/* Quick chips */}
        <div className="flex gap-1.5 overflow-x-auto px-3 pt-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {commandChips.map((chip) => {
            const Icon = chip.icon;
            return (
              <button
                key={chip.label}
                type="button"
                onClick={() => chip.action ? chip.action() : onPreset(chip.prompt)}
                disabled={isThinking && !chip.action}
                className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-cyan-500/20 bg-slate-900/80 px-2.5 py-1.5 text-[11px] text-cyan-400 transition-colors hover:border-cyan-400/40 hover:bg-slate-800/80 hover:text-cyan-300 disabled:pointer-events-none disabled:opacity-40"
              >
                <Icon className="h-3 w-3" aria-hidden="true" />
                {chip.label}
              </button>
            );
          })}
        </div>

        {/* Input row */}
        <div className="flex gap-2 px-3 py-2.5">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={toggleListening}
            className={`shrink-0 border transition-colors ${
              isListening
                ? 'border-red-500/40 bg-red-950/60 text-red-400 hover:bg-red-950/80'
                : 'border-cyan-500/20 bg-slate-900/80 text-slate-500 hover:border-cyan-500/40 hover:text-cyan-400'
            }`}
            title={isListening ? 'Stop listening' : 'Voice input'}
          >
            <Mic className="h-4 w-4" />
          </Button>
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onSubmit();
              }
            }}
            placeholder="Brand mode · analytics · write 3 Instagram hooks for..."
            className="border-cyan-500/20 bg-slate-900/80 text-cyan-50 placeholder:text-slate-600 focus-visible:ring-cyan-500/30 focus-visible:border-cyan-500/40"
          />
          <Button
            onClick={onSubmit}
            disabled={isThinking || !input.trim()}
            className="shrink-0 gap-1.5 bg-cyan-500 text-slate-950 hover:bg-cyan-400 disabled:opacity-40"
          >
            {isThinking ? (
              <RotateCw className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowRight className="h-4 w-4" />
            )}
            Run
          </Button>
        </div>
      </div>

      {/* Hidden 3D file picker */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".glb,.gltf"
        className="hidden"
        onChange={handleFileSelect}
      />
    </motion.div>
  );
}
