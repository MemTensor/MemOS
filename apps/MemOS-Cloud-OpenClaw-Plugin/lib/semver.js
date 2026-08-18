const SEMVER_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const CORE_NUMBER_RE = /^(0|[1-9]\d*)$/;
const NUMERIC_IDENTIFIER_RE = /^\d+$/;

function compareString(a, b) {
  if (a > b) return 1;
  if (a < b) return -1;
  return 0;
}

function parseIdentifierList(raw, { rejectLeadingZeroNumeric }) {
  if (!raw) return [];

  const identifiers = raw.split(".");
  for (const identifier of identifiers) {
    if (!identifier) return null;
    if (rejectLeadingZeroNumeric && NUMERIC_IDENTIFIER_RE.test(identifier) && !CORE_NUMBER_RE.test(identifier)) {
      return null;
    }
  }
  return identifiers;
}

export function cleanVersion(raw) {
  const value = String(raw || "").trim();
  return value.startsWith("v") || value.startsWith("V") ? value.slice(1) : value;
}

export function parseSemver(version) {
  const cleaned = cleanVersion(version);
  const match = cleaned.match(SEMVER_RE);
  if (!match) return null;
  if (![match[1], match[2], match[3]].every((part) => CORE_NUMBER_RE.test(part))) return null;

  const prerelease = parseIdentifierList(match[4] || "", { rejectLeadingZeroNumeric: true });
  const build = parseIdentifierList(match[5] || "", { rejectLeadingZeroNumeric: false });
  if (!prerelease || !build) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    build,
  };
}

function comparePrereleaseIdentifier(a, b) {
  const aNumeric = NUMERIC_IDENTIFIER_RE.test(a);
  const bNumeric = NUMERIC_IDENTIFIER_RE.test(b);

  if (aNumeric && bNumeric) {
    const ai = BigInt(a);
    const bi = BigInt(b);
    if (ai > bi) return 1;
    if (ai < bi) return -1;
    return 0;
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return compareString(a, b);
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const result = comparePrereleaseIdentifier(a[i], b[i]);
    if (result !== 0) return result;
  }
  return 0;
}

export function compareSemver(a, b) {
  const av = parseSemver(a);
  const bv = parseSemver(b);
  if (!av || !bv) return compareString(String(a), String(b));

  for (const key of ["major", "minor", "patch"]) {
    if (av[key] > bv[key]) return 1;
    if (av[key] < bv[key]) return -1;
  }

  return comparePrerelease(av.prerelease, bv.prerelease);
}
