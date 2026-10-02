export type InkBounds = { minX: number; minY: number; maxX: number; maxY: number };

type Command = "M" | "L" | "C" | "Z";
type Point = readonly [number, number];
type Token = Command | number;

/** Only the absolute commands emitted by the pinned slogan renderer are accepted. */
function pathTokens(d: string): Token[] {
  const tokens: Token[] = [];
  const number = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
  let comma = false;
  for (let offset = 0; offset < d.length;) {
    const character = d[offset]!;
    if (/[ \t\r\n\f]/.test(character)) {
      offset += 1;
      continue;
    }
    if (character === ",") {
      if (comma || typeof tokens[tokens.length - 1] !== "number") {
        throw new Error("Invalid SVG path separator");
      }
      comma = true;
      offset += 1;
      continue;
    }
    if (/[MLCZ]/.test(character)) {
      if (comma) throw new Error("Invalid SVG path separator");
      tokens.push(character as Command);
      offset += 1;
      continue;
    }
    number.lastIndex = offset;
    const match = number.exec(d);
    if (!match) throw new Error(`Unsupported or invalid SVG path syntax at ${offset}`);
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error("Non-finite SVG path coordinate");
    tokens.push(value);
    comma = false;
    offset = number.lastIndex;
  }
  if (comma) throw new Error("Invalid SVG path separator");
  return tokens;
}

/** Solve a cubic's derivative, including the quadratic-to-linear degeneracy. */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  if (a === 0) return b === 0 ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  if (discriminant === 0) return [-b / (2 * a)];
  // This form avoids cancellation when one derivative root is near zero.
  const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(discriminant));
  return [q / a, c / q];
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Exact geometric bounds of the filled-outline path, rather than its control hull. */
export function pathInkBounds(d: string): InkBounds {
  const tokens = pathTokens(d);
  if (tokens[0] !== "M") throw new Error("SVG path must start with an absolute moveto");
  let index = 0;
  let command: Command | undefined;
  let current: Point | undefined;
  let subpathStart: Point | undefined;
  let bounds: InkBounds | undefined;

  const include = ([x, y]: Point): void => {
    if (!bounds) bounds = { minX: x, minY: y, maxX: x, maxY: y };
    else {
      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
  };
  const point = (): Point => {
    const x = tokens[index++];
    const y = tokens[index++];
    if (typeof x !== "number" || typeof y !== "number") {
      throw new Error("Incomplete SVG path coordinates");
    }
    return [x, y];
  };

  while (index < tokens.length) {
    if (typeof tokens[index] === "string") command = tokens[index++] as Command;
    if (!command) throw new Error("SVG path coordinates require a command");
    if (command === "Z") {
      if (!current || !subpathStart) throw new Error("Closepath requires a subpath");
      include(current);
      include(subpathStart);
      current = subpathStart;
      command = undefined;
      continue;
    }
    if (command === "M") {
      current = subpathStart = point();
      // Additional coordinate pairs after M are implicit absolute lineto commands.
      command = "L";
      continue;
    }
    if (!current) throw new Error("Drawing command requires a current point");
    include(current);
    if (command === "L") {
      current = point();
      include(current);
      continue;
    }
    const control1 = point();
    const control2 = point();
    const end = point();
    include(end);
    for (const t of [
      ...cubicExtrema(current[0], control1[0], control2[0], end[0]),
      ...cubicExtrema(current[1], control1[1], control2[1], end[1]),
    ]) {
      if (t > 0 && t < 1) include([
        cubicAt(current[0], control1[0], control2[0], end[0], t),
        cubicAt(current[1], control1[1], control2[1], end[1], t),
      ]);
    }
    current = end;
  }
  if (!bounds) throw new Error("SVG path has no drawable segments");
  return bounds;
}

export function unionInkBounds(bounds: readonly InkBounds[]): InkBounds {
  if (!bounds.length) throw new Error("Cannot bound an empty collection");
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const item of bounds) {
    if (![item.minX, item.minY, item.maxX, item.maxY].every(Number.isFinite)
      || item.minX > item.maxX || item.minY > item.maxY) {
      throw new Error("Invalid ink bounds");
    }
    minX = Math.min(minX, item.minX);
    minY = Math.min(minY, item.minY);
    maxX = Math.max(maxX, item.maxX);
    maxY = Math.max(maxY, item.maxY);
  }
  return { minX, minY, maxX, maxY };
}
