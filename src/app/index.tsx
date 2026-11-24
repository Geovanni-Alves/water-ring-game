import { Accelerometer } from "expo-sensors";
import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, {
  Circle,
  ClipPath,
  Defs,
  Ellipse,
  LinearGradient,
  Path,
  Rect,
  Stop,
} from "react-native-svg";

// Quantidade de água
const WATER_LEVEL = 0.85;

// Física da inclinação
const SPRING = 0.012;
const DAMPING = 0.9;

// Física das ondas
const WAVE_STRENGTH = 14;
const WAVE_DAMPING = 0.975;
const WAVE_SPEED = 0.13;
const MAX_WAVE = 18;
const JET_FORCE = 0.85;
const JET_WIDTH = 65;
const JET_REACH = 350;

const JET_LEFT_X = 0.25;
const JET_RIGHT_X = 0.75;

// Bicos discretos no fundo, sem tubos visíveis.
const NOZZLE_BOTTOM_OFFSET = 15;
const FLOOR_EDGE_OFFSET = 36;
const FLOOR_LOW_OFFSET = 12;

// Duas depressões suaves: as argolas escorregam em direção aos bicos.
function floorY(x: number, width: number, height: number): number {
  const left = width * JET_LEFT_X;
  const right = width * JET_RIGHT_X;
  const points = [
    { x: 0, y: height - FLOOR_EDGE_OFFSET },
    { x: left, y: height - FLOOR_LOW_OFFSET },
    { x: width / 2, y: height - FLOOR_EDGE_OFFSET },
    { x: right, y: height - FLOOR_LOW_OFFSET },
    { x: width, y: height - FLOOR_EDGE_OFFSET },
  ];
  const px = Math.max(0, Math.min(width, x));
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (px <= b.x) {
      const t = (px - a.x) / Math.max(1, b.x - a.x);
      return a.y + (b.y - a.y) * t;
    }
  }
  return height - FLOOR_EDGE_OFFSET;
}

function floorPath(width: number, height: number): string {
  const left = width * JET_LEFT_X;
  const right = width * JET_RIGHT_X;
  return `M 0 ${height - FLOOR_EDGE_OFFSET}
    L ${left} ${height - FLOOR_LOW_OFFSET}
    L ${width / 2} ${height - FLOOR_EDGE_OFFSET}
    L ${right} ${height - FLOOR_LOW_OFFSET}
    L ${width} ${height - FLOOR_EDGE_OFFSET}
    L ${width} ${height} L 0 ${height} Z`;
}

type Point = {
  x: number;
  y: number;
  intersection?: boolean;
};

type Gravity = {
  x: number;
  y: number;
};

type Ring = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;

  angle: number;
  angularVelocity: number;
  angleX: number;
  angularVelocityX: number;
};

type Bubble = {
  source: "left" | "right";
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  phase: number;
};

const RING_COLORS = ["#FF5252", "#FFCA28", "#66BB6A", "#AB47BC", "#FF8A65"];

const RING_RADIUS = 15;

// Física das argolas
const RING_GRAVITY = 0.22;
const RING_DRAG = 0.985;
const RING_BOUNCE = 0.35;
const RING_MAX_SPEED = 5;

const RING_SPIN_DRAG = 0.94;
const RING_MAX_SPIN = 0.12;
const RING_SPIN_FROM_JET = 0.035;
const RING_SPIN_STOP = 0.002;

const BUBBLE_RISE_SPEED = 0.65;
const BUBBLE_DRAG = 0.97;
const BUBBLE_SWAY = 0.025;
const MAX_BUBBLES_PER_JET = 35;
const BUBBLES_PER_PULSE = 3;

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

// Calcula a área do polígono
function polygonArea(points: Point[]) {
  if (points.length < 3) return 0;

  let total = 0;

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];

    total += a.x * b.y - b.x * a.y;
  }

  return Math.abs(total) / 2;
}

// Recorta a água de acordo com a gravidade
function clipPolygon(
  polygon: Point[],
  gx: number,
  gy: number,
  level: number,
  cx: number,
  cy: number,
): Point[] {
  const result: Point[] = [];

  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];

    const da = (a.x - cx) * gx + (a.y - cy) * gy - level;

    const db = (b.x - cx) * gx + (b.y - cy) * gy - level;

    if (da >= 0) {
      result.push(a);
    }

    if (da >= 0 !== db >= 0) {
      const t = da / (da - db);

      result.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        intersection: true,
      });
    }
  }

  return result;
}

// Cria a água com ondas na superfície
function createWaterPath(
  width: number,
  height: number,
  gx: number,
  gy: number,
  waveAmplitude: number,
  wavePhase: number,
) {
  const margin = 4;
  const cx = width / 2;
  const cy = height / 2;

  const corners: Point[] = [
    { x: margin, y: margin },
    { x: width - margin, y: margin },
    { x: width - margin, y: height - margin },
    { x: margin, y: height - margin },
  ];

  const magnitude = Math.hypot(gx, gy) || 1;

  gx /= magnitude;
  gy /= magnitude;

  // Calcula o nível para conservar 85% de água
  const projections = corners.map((p) => (p.x - cx) * gx + (p.y - cy) * gy);

  let low = Math.min(...projections) - 1;
  let high = Math.max(...projections) + 1;

  const targetArea = polygonArea(corners) * WATER_LEVEL;

  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;

    const polygon = clipPolygon(corners, gx, gy, mid, cx, cy);

    if (polygonArea(polygon) > targetArea) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const polygon = clipPolygon(corners, gx, gy, (low + high) / 2, cx, cy);

  if (polygon.length === 0) return "";

  let path = `M ${polygon[0].x} ${polygon[0].y}`;

  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];

    // A superfície livre fica entre
    // as duas interseções do recorte.
    if (a.intersection && b.intersection) {
      const steps = 48;

      for (let j = 1; j <= steps; j++) {
        const t = j / steps;

        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;

        // Ondas suaves que desaparecem
        // nas extremidades do recipiente
        const envelope = Math.sin(Math.PI * t);

        const wave1 = Math.sin(t * Math.PI * 4 + wavePhase) * waveAmplitude;

        const wave2 =
          Math.sin(t * Math.PI * 7 - wavePhase * 0.65) * waveAmplitude * 0.25;

        const displacement = (wave1 + wave2) * envelope;

        // Desloca a onda perpendicularmente
        // à superfície, na direção da gravidade
        const wx = x + gx * displacement;
        const wy = y + gy * displacement;

        path += ` L ${wx} ${wy}`;
      }
    } else {
      path += ` L ${b.x} ${b.y}`;
    }
  }

  return path + " Z";
}

function createRings(width: number, height: number): Ring[] {
  const centerX = width / 2;

  // A água começa depois dos primeiros 15% da tela
  const waterSurface = height * (1 - WATER_LEVEL);

  return RING_COLORS.map((color, index) => ({
    id: index,

    // Distribuição horizontal das argolas
    x: centerX + (index - 2) * 35,

    // Começam próximas à superfície, em alturas diferentes
    y: waterSurface + RING_RADIUS + 12 + index * 8,

    vx: 0,
    vy: 0,
    radius: RING_RADIUS,
    angle: Math.random() * Math.PI * 2,
    angularVelocity: 0,
    angleX: Math.random() * Math.PI * 2,
    angularVelocityX: 0,
    color,
  }));
}

function updateRings(
  rings: Ring[],
  gx: number,
  gy: number,
  width: number,
  height: number,
) {
  const margin = 8;
  const minX = margin;
  const maxX = width - margin;
  const minY = margin;
  const maxY = height - margin;

  // 1. Gravidade, resistência e paredes
  for (const ring of rings) {
    ring.vx += gx * RING_GRAVITY;
    ring.vy += gy * RING_GRAVITY;

    // Resistência da água
    ring.vx *= RING_DRAG;
    ring.vy *= RING_DRAG;

    // Resistência da água nos dois eixos
    ring.angularVelocity *= RING_SPIN_DRAG;
    ring.angularVelocityX *= RING_SPIN_DRAG;

    // Para completamente quando a rotação
    // fica muito pequena
    if (Math.abs(ring.angularVelocity) < RING_SPIN_STOP) {
      ring.angularVelocity = 0;
    }

    if (Math.abs(ring.angularVelocityX) < RING_SPIN_STOP) {
      ring.angularVelocityX = 0;
    }

    // Limita a velocidade do giro
    ring.angularVelocity = clamp(
      ring.angularVelocity,
      -RING_MAX_SPIN,
      RING_MAX_SPIN,
    );

    ring.angularVelocityX = clamp(
      ring.angularVelocityX,
      -RING_MAX_SPIN,
      RING_MAX_SPIN,
    );

    // Atualiza os dois ângulos
    ring.angle =
      (ring.angle + ring.angularVelocity + Math.PI * 2) % (Math.PI * 2);

    ring.angleX =
      (ring.angleX + ring.angularVelocityX + Math.PI * 2) % (Math.PI * 2);

    // Limite de velocidade angular
    ring.angularVelocity = clamp(
      ring.angularVelocity,
      -RING_MAX_SPIN,
      RING_MAX_SPIN,
    );

    // Atualiza a rotação em 360 graus
    ring.angle =
      (ring.angle + ring.angularVelocity + Math.PI * 2) % (Math.PI * 2);

    // Giro para frente e para trás (eixo X)

    // Resistência da água
    ring.angularVelocityX *= RING_SPIN_DRAG;

    // Limitar a velocidade
    ring.angularVelocityX = clamp(
      ring.angularVelocityX,
      -RING_MAX_SPIN,
      RING_MAX_SPIN,
    );

    // Completar voltas de 360 graus
    ring.angleX =
      (ring.angleX + ring.angularVelocityX + Math.PI * 2) % (Math.PI * 2);

    // A velocidade lateral influencia a rotação

    // Limita a velocidade
    const speed = Math.hypot(ring.vx, ring.vy);

    if (speed > RING_MAX_SPEED) {
      const scale = RING_MAX_SPEED / speed;
      ring.vx *= scale;
      ring.vy *= scale;
    }

    ring.x += ring.vx;
    ring.y += ring.vy;

    // Parede esquerda
    if (ring.x - ring.radius < minX) {
      ring.x = minX + ring.radius;
      if (ring.vx < 0) {
        ring.vx *= -RING_BOUNCE;
      }
    }

    // Parede direita
    if (ring.x + ring.radius > maxX) {
      ring.x = maxX - ring.radius;
      if (ring.vx > 0) {
        ring.vx *= -RING_BOUNCE;
      }
    }

    // Teto
    if (ring.y - ring.radius < minY) {
      ring.y = minY + ring.radius;
      if (ring.vy < 0) {
        ring.vy *= -RING_BOUNCE;
      }
    }

    // Fundo inclinado: pequenas depressões levam as argolas aos bicos.
    const bottom = floorY(ring.x, width, height);
    if (ring.y + ring.radius >= bottom - 3 && gy > 0) {
      const incline =
        floorY(ring.x + 2, width, height) - floorY(ring.x - 2, width, height);
      ring.vx += incline * 0.035 * Math.min(1, gy);
    }
    if (ring.y + ring.radius > bottom) {
      ring.y = bottom - ring.radius;
      if (ring.vy > 0) ring.vy *= -RING_BOUNCE;
    }
  }

  // 2. Colisões entre argolas
  for (let i = 0; i < rings.length; i++) {
    for (let j = i + 1; j < rings.length; j++) {
      const a = rings[i];
      const b = rings[j];

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy);
      const minDistance = a.radius + b.radius;

      if (distance >= minDistance) continue;

      // Normal da colisão
      const nx = distance > 0.0001 ? dx / distance : 1;
      const ny = distance > 0.0001 ? dy / distance : 0;

      // Separa as argolas sobrepostas
      const overlap = minDistance - distance;

      a.x -= nx * overlap * 0.5;
      a.y -= ny * overlap * 0.5;

      b.x += nx * overlap * 0.5;
      b.y += ny * overlap * 0.5;

      // Velocidade relativa na direção da colisão
      const relativeVelocity = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;

      // Só aplica impulso se estiverem se aproximando
      if (relativeVelocity < 0) {
        const impulse = (-(1 + RING_BOUNCE) * relativeVelocity) / 2;

        a.vx -= impulse * nx;
        a.vy -= impulse * ny;

        b.vx += impulse * nx;
        b.vy += impulse * ny;
      }
    }
  }

  // 3. Garante que nenhuma argola termine fora
  for (const ring of rings) {
    ring.x = clamp(ring.x, minX + ring.radius, maxX - ring.radius);

    ring.y = clamp(
      ring.y,
      minY + ring.radius,
      Math.min(maxY, floorY(ring.x, width, height)) - ring.radius,
    );
  }
}

// function createBubble(id: number, width: number, height: number): Bubble {
//   const radius = 3 + Math.random() * 6;

//   return {
//     id,
//     x: 20 + Math.random() * (width - 40),
//     y: height - 25 - radius,
//     vx: (Math.random() - 0.5) * 0.3,
//     vy: -Math.random() * 0.4,
//     radius,
//     phase: Math.random() * Math.PI * 2,
//   };
// }

function updateBubbles(
  bubbles: Bubble[],
  width: number,
  height: number,
  gx: number,
  gy: number,
): Bubble[] {
  const magnitude = Math.hypot(gx, gy) || 1;
  gx /= magnitude;
  gy /= magnitude;

  const cx = width / 2;
  const cy = height / 2;

  const corners: Point[] = [
    { x: 4, y: 4 },
    { x: width - 4, y: 4 },
    { x: width - 4, y: height - 4 },
    { x: 4, y: height - 4 },
  ];

  const projections = corners.map((p) => (p.x - cx) * gx + (p.y - cy) * gy);

  let low = Math.min(...projections) - 1;
  let high = Math.max(...projections) + 1;

  const targetArea = polygonArea(corners) * WATER_LEVEL;

  for (let i = 0; i < 22; i++) {
    const mid = (low + high) / 2;

    const polygon = clipPolygon(corners, gx, gy, mid, cx, cy);

    if (polygonArea(polygon) > targetArea) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const surfaceLevel = (low + high) / 2;

  for (const bubble of bubbles) {
    // O ar sobe no sentido contrário à gravidade
    bubble.vx -= gx * 0.07;
    bubble.vy -= gy * 0.07;

    // Resistência da água
    bubble.vx *= BUBBLE_DRAG;
    bubble.vy *= BUBBLE_DRAG;

    // Oscilação suave, perpendicular à gravidade
    bubble.phase += 0.055;
    const sway = Math.sin(bubble.phase) * BUBBLE_SWAY;

    bubble.vx += -gy * sway;
    bubble.vy += gx * sway;

    // Limita a velocidade
    const speed = Math.hypot(bubble.vx, bubble.vy);
    const maxSpeed = BUBBLE_RISE_SPEED * 3;

    if (speed > maxSpeed) {
      bubble.vx *= maxSpeed / speed;
      bubble.vy *= maxSpeed / speed;
    }

    bubble.x += bubble.vx;
    bubble.y += bubble.vy;

    bubble.x = clamp(bubble.x, bubble.radius + 8, width - bubble.radius - 8);

    bubble.y = clamp(bubble.y, bubble.radius + 8, height - bubble.radius - 8);
  }

  // Remove as bolhas que alcançam a superfície
  return bubbles.filter((bubble) => {
    const projection = (bubble.x - cx) * gx + (bubble.y - cy) * gy;

    return projection - bubble.radius > surfaceLevel;
  });
}

function applyWaterJets(
  rings: Ring[],
  width: number,
  height: number,
  leftActive: boolean,
  rightActive: boolean,
) {
  const jets = [
    { x: width * JET_LEFT_X, active: leftActive },
    { x: width * JET_RIGHT_X, active: rightActive },
  ];

  const nozzleY = height - NOZZLE_BOTTOM_OFFSET;

  for (const jet of jets) {
    if (!jet.active) continue;

    for (const ring of rings) {
      const dx = ring.x - jet.x;
      const dy = nozzleY - ring.y;

      // Só afeta argolas acima do jato
      if (dy < 0 || dy > JET_REACH) continue;

      const horizontalDistance = Math.abs(dx);

      // O jato perde força longe do centro
      if (horizontalDistance > JET_WIDTH) continue;

      const horizontalFactor = 1 - horizontalDistance / JET_WIDTH;

      const verticalFactor = 1 - dy / JET_REACH;

      const force = JET_FORCE * horizontalFactor * verticalFactor;

      // Impulso para cima
      ring.vy -= force;
      // O jato aplica torque na argola
      const spinDirection =
        Math.abs(dx) < 1 ? (ring.id % 2 === 0 ? 1 : -1) : Math.sign(dx);

      ring.angularVelocity += spinDirection * force * RING_SPIN_FROM_JET;
      // Impulso para girar no eixo X
      ring.angularVelocityX += force * RING_SPIN_FROM_JET * 0.45;

      // Pequeno movimento lateral
      ring.vx += (dx / JET_WIDTH) * force * 0.12;
    }
  }
}

function createJetBubble(
  id: number,
  x: number,
  height: number,
  source: "left" | "right",
): Bubble {
  return {
    id,
    source,
    x: x + (Math.random() - 0.5) * 18,
    y: height - NOZZLE_BOTTOM_OFFSET,
    vx: (Math.random() - 0.5) * 0.7,
    vy: -1.5 - Math.random() * 1.5,
    radius: 2 + Math.random() * 4,
    phase: Math.random() * Math.PI * 2,
  };
}

export default function WaterGame() {
  const [size, setSize] = useState({
    width: 320,
    height: 600,
  });

  const [surface, setSurface] = useState("");

  const targetGravity = useRef<Gravity>({
    x: 0,
    y: 1,
  });

  const gravity = useRef<Gravity>({
    x: 0,
    y: 1,
  });

  const velocity = useRef<Gravity>({
    x: 0,
    y: 0,
  });

  const waveEnergy = useRef(0);
  const wavePhase = useRef(0);
  const ringsRef = useRef<Ring[]>([]);
  const [rings, setRings] = useState<Ring[]>([]);
  const ringsInitialized = useRef(false);
  const isPhoneFlat = useRef(false);
  const bubblesRef = useRef<Bubble[]>([]);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const leftPressed = useRef(false);
  const rightPressed = useRef(false);

  const [leftActive, setLeftActive] = useState(false);
  const [rightActive, setRightActive] = useState(false);

  const jetBubbleCounter = useRef(0);

  const nextBubbleId = useRef(0);

  useEffect(() => {
    Accelerometer.setUpdateInterval(33);

    const subscription = Accelerometer.addListener(({ x, y, z }) => {
      const gx = x;
      const gy = -y;

      const magnitude = Math.hypot(gx, gy);

      // Detecta quando o celular está quase deitado
      const isFlat = Math.abs(z) > 0.85;
      isPhoneFlat.current = isFlat;

      if (isFlat) {
        // Mantém a água no fundo da tela
        targetGravity.current = {
          x: 0,
          y: 1,
        };

        return;
      }

      // Ignora leituras instáveis
      if (magnitude > 0.15) {
        targetGravity.current = {
          x: gx / magnitude,
          y: gy / magnitude,
        };
      }
    });

    const timer = setInterval(() => {
      const g = gravity.current;
      const v = velocity.current;
      const target = targetGravity.current;

      // Movimento com mola e resistência
      v.x += (target.x - g.x) * SPRING;
      v.y += (target.y - g.y) * SPRING;

      v.x *= DAMPING;
      v.y *= DAMPING;

      g.x += v.x;
      g.y += v.y;

      // Detecta a velocidade da mudança
      // de direção da água
      const movement = Math.hypot(v.x, v.y);

      // Transfere parte do movimento às ondas
      waveEnergy.current += movement * WAVE_STRENGTH;

      waveEnergy.current *= isPhoneFlat.current ? 0.88 : WAVE_DAMPING;

      waveEnergy.current = clamp(waveEnergy.current, 0, MAX_WAVE);

      // Avança a oscilação
      wavePhase.current += WAVE_SPEED;

      setSurface(
        createWaterPath(
          size.width,
          size.height,
          g.x,
          g.y,
          waveEnergy.current,
          wavePhase.current,
        ),
      );
      if (ringsInitialized.current) {
        // Empurra as argolas que estiverem nos jatos
        applyWaterJets(
          ringsRef.current,
          size.width,
          size.height,
          leftPressed.current,
          rightPressed.current,
        );

        // Continua calculando gravidade e colisões
        updateRings(ringsRef.current, g.x, g.y, size.width, size.height);

        setRings(ringsRef.current.map((ring) => ({ ...ring })));
      }

      jetBubbleCounter.current++;

      if (jetBubbleCounter.current >= 2) {
        jetBubbleCounter.current = 0;

        const spawnFromJet = (source: "left" | "right", x: number) => {
          const currentCount = bubblesRef.current.filter(
            (bubble) => bubble.source === source,
          ).length;

          const available = MAX_BUBBLES_PER_JET - currentCount;

          const amount = Math.min(BUBBLES_PER_PULSE, available);

          for (let i = 0; i < amount; i++) {
            bubblesRef.current.push(
              createJetBubble(nextBubbleId.current++, x, size.height, source),
            );
          }
        };

        // Botão esquerdo controla apenas seu jato
        if (leftPressed.current) {
          spawnFromJet("left", size.width * JET_LEFT_X);
        }

        // Botão direito controla apenas seu jato
        if (rightPressed.current) {
          spawnFromJet("right", size.width * JET_RIGHT_X);
        }
      }

      // Atualiza a física das bolhas
      bubblesRef.current = updateBubbles(
        bubblesRef.current,
        size.width,
        size.height,
        g.x,
        g.y,
      );

      // Atualiza a renderização
      setBubbles(bubblesRef.current.map((bubble) => ({ ...bubble })));
    }, 33);

    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, [size.width, size.height]);

  return (
    <View style={styles.container}>
      {/* Tanque de água */}
      <View
        style={styles.tank}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;

          if (width !== size.width || height !== size.height) {
            setSize({ width, height });
          }

          if (!ringsInitialized.current && width > 100 && height > 100) {
            const initialRings = createRings(width, height);

            ringsRef.current = initialRings;
            setRings(initialRings.map((r) => ({ ...r })));
            ringsInitialized.current = true;
          }
        }}
      >
        <Svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${size.width} ${size.height}`}
        >
          <Defs>
            <ClipPath id="waterClip">
              <Rect
                x={4}
                y={4}
                width={Math.max(0, size.width - 8)}
                height={Math.max(0, size.height - 8)}
                rx={20}
              />
            </ClipPath>
            <LinearGradient id="waterGradient" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#72E6FA" />
              <Stop offset="0.5" stopColor="#31BCEB" />
              <Stop offset="1" stopColor="#087DB8" />
            </LinearGradient>
          </Defs>

          {/* Fundo do tanque e água */}
          <Rect width={size.width} height={size.height} fill="#E8FAFF" />
          <Path
            d={surface}
            fill="url(#waterGradient)"
            clipPath="url(#waterClip)"
          />

          {/* Base inclinada, sem tubos visíveis */}
          <Path
            d={floorPath(size.width, size.height)}
            fill="#9AC7D7"
            stroke="#D4F3FB"
            strokeWidth={3}
          />

          {/* Duas saídas discretas ao lado dos botões */}
          {[size.width * JET_LEFT_X, size.width * JET_RIGHT_X].map(
            (x, index) => (
              <Ellipse
                key={`nozzle-${index}`}
                cx={x}
                cy={size.height - NOZZLE_BOTTOM_OFFSET}
                rx={9}
                ry={3}
                fill="#256D91"
                stroke="#D2F7FF"
                strokeWidth={1.5}
              />
            ),
          )}

          {/* Bolhas e reflexos */}
          {bubbles.map((bubble) => (
            <React.Fragment key={`bubble-${bubble.id}`}>
              <Circle
                cx={bubble.x}
                cy={bubble.y}
                r={bubble.radius}
                fill="#DDF9FF"
                fillOpacity={0.12}
                stroke="#FFFFFF"
                strokeWidth={1.3}
                strokeOpacity={0.7}
              />
              <Circle
                cx={bubble.x - bubble.radius * 0.3}
                cy={bubble.y - bubble.radius * 0.3}
                r={Math.max(1, bubble.radius * 0.2)}
                fill="#FFFFFF"
                opacity={0.85}
              />
            </React.Fragment>
          ))}

          {/* Argolas com rotação 360° simulada */}
          {rings.map((ring) => {
            const angle = ring.angle;
            const cosine = Math.cos(angle);

            const widthScale = Math.max(0.1, Math.abs(Math.cos(ring.angle)));

            const heightScale = Math.max(0.1, Math.abs(Math.cos(ring.angleX)));

            // Frente ou verso
            const isFront = cosine >= 0;

            // Espessura visual da argola
            const ringWidth = 7;

            return (
              <React.Fragment key={ring.id}>
                {/* Sombra do plástico */}
                <Ellipse
                  cx={ring.x + 1}
                  cy={ring.y + 1}
                  rx={ring.radius * widthScale}
                  ry={ring.radius * heightScale}
                  fill="none"
                  stroke="#16435B"
                  strokeWidth={ringWidth + 2}
                  opacity={0.35}
                />

                {/* Corpo colorido */}
                <Ellipse
                  cx={ring.x}
                  cy={ring.y}
                  rx={ring.radius * widthScale}
                  ry={ring.radius * heightScale}
                  fill="none"
                  stroke={ring.color}
                  strokeWidth={ringWidth}
                />

                {/* Reflexo que muda entre frente e verso */}
                <Ellipse
                  cx={ring.x}
                  cy={ring.y}
                  rx={ring.radius * widthScale}
                  ry={ring.radius * heightScale}
                  fill="none"
                  stroke={isFront ? "#FFFFFF" : "#203D52"}
                  strokeWidth={2}
                  opacity={isFront ? 0.75 : 0.4}
                />

                {/* Marca para visualizar os dois eixos */}
                <Circle
                  cx={ring.x + Math.cos(ring.angle) * ring.radius * 0.7}
                  cy={ring.y - Math.cos(ring.angleX) * ring.radius * 0.45}
                  r={2.8}
                  fill="#FFFFFF"
                  opacity={isFront ? 0.95 : 0.25}
                />
              </React.Fragment>
            );
          })}

          {/* Reflexo e moldura do recipiente */}
          <Rect
            x={18}
            y={18}
            width={8}
            height={Math.max(0, size.height - 36)}
            rx={4}
            fill="#FFFFFF"
            opacity={0.25}
          />
          <Rect
            x={3}
            y={3}
            width={Math.max(0, size.width - 6)}
            height={Math.max(0, size.height - 6)}
            rx={22}
            fill="none"
            stroke="#A8D8E7"
            strokeWidth={6}
          />
        </Svg>
      </View>

      {/* Base externa dos botões */}
      <View style={styles.controlPanel}>
        <Pressable
          style={[styles.waterButton, leftActive && styles.buttonPressed]}
          onPressIn={() => {
            leftPressed.current = true;
            setLeftActive(true);
          }}
          onPressOut={() => {
            leftPressed.current = false;
            setLeftActive(false);
          }}
        >
          <View style={styles.buttonInner} />
        </Pressable>

        <Pressable
          style={[styles.waterButton, rightActive && styles.buttonPressed]}
          onPressIn={() => {
            rightPressed.current = true;
            setRightActive(true);
          }}
          onPressOut={() => {
            rightPressed.current = false;
            setRightActive(false);
          }}
        >
          <View style={styles.buttonInner} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#E8FAFF",
  },

  tank: {
    flex: 1,
    overflow: "hidden",
  },

  controlPanel: {
    height: 115,
    backgroundColor: "#B8D6E2",
    borderTopWidth: 5,
    borderTopColor: "#8BAAB9",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingBottom: 8,
  },

  waterButton: {
    width: 78,
    height: 78,
    borderRadius: 39,
    backgroundColor: "#E53935",
    borderWidth: 6,
    borderColor: "#B71C1C",
    alignItems: "center",
    justifyContent: "center",
    elevation: 6,
  },

  buttonInner: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#FF6659",
    borderWidth: 2,
    borderColor: "#FFB4AC",
  },

  buttonPressed: {
    backgroundColor: "#C62828",
    transform: [{ scale: 0.92 }],
  },
});
