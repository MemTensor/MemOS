export const AVATAR_KEYS = ["default", "blue", "red", "green"]; // lightweight presets

export function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

export function pct(n) {
  return clamp(Number(n) || 0, 0, 100);
}

export function statClass(v) {
  if (v <= 25) return "danger";
  if (v <= 55) return "warn";
  return "ok";
}

export function avatarUrl(role) {
  const key = role?.avatar_key || "default";
  return `./assets/avatars/ava_${key}.svg`;
}

export function makeRole(name, persona) {
  const id = `r_${Math.random().toString(16).slice(2, 10)}`;
  const avatar_key = AVATAR_KEYS[Math.floor(Math.random() * AVATAR_KEYS.length)];
  return {
    role_id: id,
    name,
    avatar_key,
    persona: (persona && String(persona).trim())
      ? String(persona).trim()
      : `${name}：像素风徒步者。谨慎但乐观。`,
    attrs: { stamina: 70, mood: 60, experience: 10, risk_tolerance: 50 },
  };
}
