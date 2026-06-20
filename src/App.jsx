import { useState, useEffect, useRef, useCallback } from "react";

// ── CONSTANTS ──────────────────────────────────────────────────────────────
const SYMBOLS = {
  "Boom 300":  { id: "BOOM300N",  dir: "boom",  spikePct: 0.3, maxTicks: 300 },
  "Boom 500":  { id: "BOOM500N",  dir: "boom",  spikePct: 0.25, maxTicks: 500 },
  "Crash 300": { id: "CRASH300N", dir: "crash", spikePct: 0.3, maxTicks: 300 },
  "Crash 500": { id: "CRASH500N", dir: "crash", spikePct: 0.25, maxTicks: 500 },
};

const DERIV_WS = "wss://ws.binaryws.com/websockets/v3?app_id=1089";

// ── MATH HELPERS ──────────────────────────────────────────────────────────
function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(prices, period = 7) {
  if (prices.length < period + 1) return null;
  const deltas = prices.slice(-period - 1).map((p, i, a) => i > 0 ? p - a[i - 1] : 0).slice(1);
  const gains = deltas.map(d => d > 0 ? d : 0);
  const losses = deltas.map(d => d < 0 ? -d : 0);
  const avgGain = gains.reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcBollinger(prices, period = 20, mult = 2) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.map(p => (p - mid) ** 2).reduce((a, b) => a + b, 0) / period);
  return { upper: mid + mult * std, mid, lower: mid - mult * std };
}

// Simulated MFI: uses tick-to-tick price movement magnitude as a proxy for "volume"
// since synthetic indices have no real volume data
function calcMFI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  const slice = prices.slice(-period - 1);
  let positiveFlow = 0;
  let negativeFlow = 0;
  for (let i = 1; i < slice.length; i++) {
    const change = slice[i] - slice[i - 1];
    const magnitude = Math.abs(change) * slice[i]; // price * movement size as proxy "money flow"
    if (change > 0) positiveFlow += magnitude;
    else if (change < 0) negativeFlow += magnitude;
  }
  if (negativeFlow === 0) return 100;
  const moneyRatio = positiveFlow / negativeFlow;
  return 100 - 100 / (1 + moneyRatio);
}

// ADX: measures trend strength regardless of direction
function calcADX(prices, period = 14) {
  if (prices.length < period * 2 + 1) return null;
  const slice = prices.slice(-(period * 2 + 1));
  const plusDM = [];
  const minusDM = [];
  const tr = [];
  for (let i = 1; i < slice.length; i++) {
    const up = slice[i] - slice[i - 1];
    const down = slice[i - 1] - slice[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.abs(slice[i] - slice[i - 1]) || 0.0001);
  }
  const smooth = (arr, p) => {
    let sum = arr.slice(0, p).reduce((a, b) => a + b, 0);
    const out = [sum];
    for (let i = p; i < arr.length; i++) {
      sum = sum - sum / p + arr[i];
      out.push(sum);
    }
    return out;
  };
  const smoothPlusDM = smooth(plusDM, period);
  const smoothMinusDM = smooth(minusDM, period);
  const smoothTR = smooth(tr, period);
  const dxValues = [];
  for (let i = 0; i < smoothTR.length; i++) {
    const plusDI = (smoothPlusDM[i] / smoothTR[i]) * 100;
    const minusDI = (smoothMinusDM[i] / smoothTR[i]) * 100;
    const dx = (Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1)) * 100;
    dxValues.push(dx);
  }
  const adx = dxValues.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, dxValues.length);
  return adx;
}

// Market structure: detect Higher-Highs/Higher-Lows (uptrend) or Lower-Highs/Lower-Lows (downtrend)
// using simple pivot detection over a recent window
function calcMarketStructure(prices, window = 40) {
  if (prices.length < window) return null;
  const slice = prices.slice(-window);
  const pivots = [];
  for (let i = 2; i < slice.length - 2; i++) {
    const isHigh = slice[i] > slice[i-1] && slice[i] > slice[i-2] && slice[i] > slice[i+1] && slice[i] > slice[i+2];
    const isLow = slice[i] < slice[i-1] && slice[i] < slice[i-2] && slice[i] < slice[i+1] && slice[i] < slice[i+2];
    if (isHigh) pivots.push({ type: "high", value: slice[i], idx: i });
    if (isLow) pivots.push({ type: "low", value: slice[i], idx: i });
  }
  const highs = pivots.filter(p => p.type === "high");
  const lows = pivots.filter(p => p.type === "low");
  if (highs.length < 2 || lows.length < 2) return "undefined";
  const higherHighs = highs[highs.length - 1].value > highs[highs.length - 2].value;
  const higherLows = lows[lows.length - 1].value > lows[lows.length - 2].value;
  const lowerHighs = highs[highs.length - 1].value < highs[highs.length - 2].value;
  const lowerLows = lows[lows.length - 1].value < lows[lows.length - 2].value;
  if (higherHighs && higherLows) return "uptrend";
  if (lowerHighs && lowerLows) return "downtrend";
  return "ranging";
}

// Candle pattern: engulfing detection on last 2 "candles" built from consecutive tick pairs
function calcCandlePattern(prices) {
  if (prices.length < 6) return null;
  const c2Open = prices[prices.length - 4];
  const c2Close = prices[prices.length - 3];
  const c1Open = prices[prices.length - 2];
  const c1Close = prices[prices.length - 1];
  const prevBullish = c2Close > c2Open;
  const prevBearish = c2Close < c2Open;
  const currBullish = c1Close > c1Open;
  const currBearish = c1Close < c1Open;
  const currBody = Math.abs(c1Close - c1Open);
  const prevBody = Math.abs(c2Close - c2Open);
  // Bullish engulfing: prev bearish, curr bullish and bigger body
  if (prevBearish && currBullish && currBody > prevBody) return "bullish_engulfing";
  // Bearish engulfing: prev bullish, curr bearish and bigger body
  if (prevBullish && currBearish && currBody > prevBody) return "bearish_engulfing";
  return "none";
}

// Fibonacci retracement: find recent swing high/low, return key levels and where price sits
function calcFibonacci(prices, window = 60) {
  if (prices.length < window) return null;
  const slice = prices.slice(-window);
  const swingHigh = Math.max(...slice);
  const swingLow = Math.min(...slice);
  const range = swingHigh - swingLow;
  if (range === 0) return null;
  const price = prices[prices.length - 1];
  const levels = {
    l236: swingHigh - range * 0.236,
    l382: swingHigh - range * 0.382,
    l50:  swingHigh - range * 0.5,
    l618: swingHigh - range * 0.618,
    l786: swingHigh - range * 0.786,
  };
  // Extension projections (beyond the move, for TP reference)
  const ext1272 = swingLow - range * 0.272;
  const ext1618 = swingLow - range * 0.618;
  // is price currently inside the "golden zone" 38.2%-61.8%?
  const inGoldenZone = price <= levels.l382 && price >= levels.l618;
  return { swingHigh, swingLow, levels, inGoldenZone, ext1272, ext1618 };
}

// RSI/Price divergence: compares last two swing points
function calcDivergence(prices, period = 7, window = 30) {
  if (prices.length < window + period) return null;
  const slice = prices.slice(-window);
  let maxIdx = 0, minIdx = 0;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i] > slice[maxIdx]) maxIdx = i;
    if (slice[i] < slice[minIdx]) minIdx = i;
  }
  // simplistic: compare RSI at first half vs second half peak/trough
  const firstHalf = prices.slice(-window, -Math.floor(window / 2));
  const secondHalf = prices.slice(-Math.floor(window / 2));
  const rsiFirst = calcRSI(firstHalf, period);
  const rsiSecond = calcRSI(secondHalf, period);
  if (rsiFirst === null || rsiSecond === null) return null;
  const priceFirst = Math.max(...firstHalf);
  const priceSecond = Math.max(...secondHalf);
  const priceLowFirst = Math.min(...firstHalf);
  const priceLowSecond = Math.min(...secondHalf);
  // Bearish divergence: price higher high, RSI lower high
  const bearishDiv = priceSecond > priceFirst && rsiSecond < rsiFirst;
  // Bullish divergence: price lower low, RSI higher low
  const bullishDiv = priceLowSecond < priceLowFirst && rsiSecond > rsiFirst;
  if (bearishDiv) return "bearish";
  if (bullishDiv) return "bullish";
  return "none";
}

// Multi-timeframe simulated: compares short-term EMA trend (8/21) vs longer "macro" trend (50/100)
function calcMultiTimeframe(prices) {
  if (prices.length < 100) return null;
  const emaShort8 = calcEMA(prices, 8);
  const emaShort21 = calcEMA(prices, 21);
  const emaLong50 = calcEMA(prices, 50);
  const emaLong100 = calcEMA(prices, 100);
  if (!emaShort8 || !emaShort21 || !emaLong50 || !emaLong100) return null;
  const shortUp = emaShort8 > emaShort21;
  const longUp = emaLong50 > emaLong100;
  if (shortUp && longUp) return "aligned_up";
  if (!shortUp && !longUp) return "aligned_down";
  return "conflict";
}

// Bollinger width trend: are bands expanding (volatility increasing) or contracting
function calcBBWidthTrend(prices, period = 20) {
  if (prices.length < period + 10) return null;
  const bbNow = calcBollinger(prices, period);
  const bbPrev = calcBollinger(prices.slice(0, -10), period);
  if (!bbNow || !bbPrev) return null;
  const widthNow = bbNow.upper - bbNow.lower;
  const widthPrev = bbPrev.upper - bbPrev.lower;
  return widthNow > widthPrev ? "expanding" : "contracting";
}

// Builds a list of "watch levels" — specific price points worth monitoring,
// rather than reacting to every single tick. Combines Fibonacci, structure
// pivots, and the last spike price.
function calcWatchLevels(prices, lastSpike, isBoom) {
  if (prices.length < 60) return [];
  const fib = calcFibonacci(prices, 60);
  const levels = [];

  if (fib) {
    levels.push({
      price: fib.levels.l382,
      label: "Fibonacci 38.2%",
      type: "fib",
    });
    levels.push({
      price: fib.levels.l50,
      label: "Fibonacci 50%",
      type: "fib",
    });
    levels.push({
      price: fib.levels.l618,
      label: "Fibonacci 61.8%",
      type: "fib",
    });
  }

  // Structure pivot: most recent significant high/low in the last 40 ticks
  const slice = prices.slice(-40);
  for (let i = 2; i < slice.length - 2; i++) {
    const isHigh = slice[i] > slice[i-1] && slice[i] > slice[i-2] && slice[i] > slice[i+1] && slice[i] > slice[i+2];
    const isLow = slice[i] < slice[i-1] && slice[i] < slice[i-2] && slice[i] < slice[i+1] && slice[i] < slice[i+2];
    if (isHigh && i === slice.length - 3) {
      levels.push({ price: slice[i], label: "Resistencia (pivote reciente)", type: "structure" });
    }
    if (isLow && i === slice.length - 3) {
      levels.push({ price: slice[i], label: "Soporte (pivote reciente)", type: "structure" });
    }
  }

  // Last spike price as a psychological reference level
  if (lastSpike) {
    levels.push({ price: lastSpike.price, label: "Nivel del último spike", type: "spike" });
  }

  return levels;
}

// Checks if current price is touching any watch level within tolerance
function checkLevelTouch(price, levels, tolerancePct = 0.05) {
  for (const lvl of levels) {
    const distance = Math.abs((price - lvl.price) / lvl.price) * 100;
    if (distance <= tolerancePct) {
      return lvl;
    }
  }
  return null;
}

function detectSpike(prices, pct = 0.3) {
  if (prices.length < 3) return false;
  const last = prices[prices.length - 1];
  const prev = prices[prices.length - 2];
  const prev2 = prices[prices.length - 3];
  // Check single-tick jump
  const change1 = Math.abs((last - prev) / prev) * 100;
  if (change1 > pct) return true;
  // Check 2-tick cumulative move (catches spikes that happen over 2-3 ticks)
  const change2 = Math.abs((last - prev2) / prev2) * 100;
  if (change2 > pct * 1.4) return true;
  return false;
}

// ── SIGNAL ENGINE ────────────────────────────────────────────────────────
function computeSignal({ prices, ticksSinceSpike, symbol }) {
  if (prices.length < 100) return null;
  const sym = SYMBOLS[symbol];
  const isBoom = sym.dir === "boom";
  const maxT = sym.maxTicks;

  const ema8  = calcEMA(prices, 8);
  const ema21 = calcEMA(prices, 21);
  const ema50 = calcEMA(prices, 50);
  const rsi   = calcRSI(prices, 7);
  const bb    = calcBollinger(prices, 20);
  const mfi   = calcMFI(prices, 14);
  const adx   = calcADX(prices, 14);
  const structure = calcMarketStructure(prices, 40);
  const candlePattern = calcCandlePattern(prices);
  const fib = calcFibonacci(prices, 60);
  const divergence = calcDivergence(prices, 7, 30);
  const mtf = calcMultiTimeframe(prices);
  const bbWidthTrend = calcBBWidthTrend(prices, 20);
  const price = prices[prices.length - 1];

  if (!ema8 || !ema21 || !ema50 || !rsi || !bb) return null;

  const haColors = [];
  for (let i = prices.length - 3; i < prices.length; i++) {
    if (i < 1) continue;
    const haClose = (prices[i - 1] + prices[i]) / 2;
    const haOpen  = (prices[i - 1] + prices[i - 1]) / 2;
    haColors.push(haClose > haOpen ? "green" : "red");
  }
  const ha3Aligned = isBoom
    ? haColors.every(c => c === "green")
    : haColors.every(c => c === "red");

  const dangerZone = ticksSinceSpike >= maxT * 0.85;
  const sweetSpot  = ticksSinceSpike >= maxT * 0.5 && ticksSinceSpike < maxT * 0.85;

  // ── 13-CATEGORY VOTING SYSTEM ──
  // Each category casts at most 1 vote, regardless of how many sub-checks it has.
  // This avoids redundant indicators inflating the score artificially.
  const categories = [];

  // 1. Tendencia (EMAs)
  categories.push({
    name: "Tendencia (EMAs)",
    vote: isBoom ? (ema8 > ema21 && ema21 > ema50) : (ema8 < ema21 && ema21 < ema50),
    detail: "EMAs alineadas",
  });

  // 2. Momentum (RSI + MFI combined into one vote)
  const rsiFav = isBoom ? (rsi > 30 && rsi < 65) : (rsi > 35 && rsi < 70);
  const mfiFav = mfi !== null ? (isBoom ? mfi > 50 : mfi < 50) : false;
  categories.push({
    name: "Momentum (RSI+MFI)",
    vote: rsiFav && mfiFav,
    detail: `RSI ${rsi.toFixed(0)} / MFI ${mfi !== null ? mfi.toFixed(0) : "—"}`,
  });

  // 3. Fuerza de tendencia (ADX)
  categories.push({
    name: "Fuerza (ADX)",
    vote: adx !== null && adx > 25,
    detail: `ADX ${adx !== null ? adx.toFixed(0) : "—"}`,
  });

  // 4. Posición en Bollinger
  categories.push({
    name: "Posición BB",
    vote: isBoom ? (price <= bb.mid && price >= bb.lower) : (price >= bb.mid && price <= bb.upper),
    detail: "Precio en zona favorable de BB",
  });

  // 5. Estructura de mercado
  categories.push({
    name: "Estructura",
    vote: structure === (isBoom ? "uptrend" : "downtrend"),
    detail: `Estructura: ${structure || "—"}`,
  });

  // 6. Patrón de vela
  categories.push({
    name: "Patrón vela",
    vote: candlePattern === (isBoom ? "bullish_engulfing" : "bearish_engulfing"),
    detail: `Patrón: ${candlePattern || "—"}`,
  });

  // 7. Fibonacci retroceso (golden zone)
  categories.push({
    name: "Fibonacci retroceso",
    vote: fib ? fib.inGoldenZone : false,
    detail: "Precio en zona dorada (38.2%-61.8%)",
  });

  // 8. Heiken Ashi
  categories.push({
    name: "Heiken Ashi",
    vote: ha3Aligned,
    detail: "3 velas HA alineadas",
  });

  // 9. Distancia al spike (zona óptima)
  categories.push({
    name: "Zona de ticks",
    vote: sweetSpot,
    detail: `${ticksSinceSpike} ticks desde spike`,
  });

  // 10. Ancho de Bollinger (expansión favorece movimiento)
  categories.push({
    name: "Ancho BB",
    vote: bbWidthTrend === "expanding",
    detail: `Bandas ${bbWidthTrend || "—"}`,
  });

  // 11. Divergencia RSI/Precio
  categories.push({
    name: "Divergencia",
    vote: divergence === (isBoom ? "bullish" : "bearish"),
    detail: `Divergencia: ${divergence || "—"}`,
  });

  // 12. Multi-timeframe simulado
  categories.push({
    name: "Multi-timeframe",
    vote: mtf === (isBoom ? "aligned_up" : "aligned_down"),
    detail: `MTF: ${mtf || "—"}`,
  });

  // 13. Fibonacci extensión (informativo para TP, también vota si hay espacio para extender)
  const fibExtRoom = fib ? (isBoom ? price < fib.swingHigh : price > fib.swingLow) : false;
  categories.push({
    name: "Fibonacci extensión",
    vote: fibExtRoom,
    detail: "Espacio para extensión de Fibonacci",
  });

  const votesInFavor = categories.filter(c => c.vote).length;
  const totalCategories = categories.length;
  const reasons = categories.filter(c => c.vote).map(c => c.detail);
  const score = Math.round((votesInFavor / totalCategories) * 100);

  // Threshold: 8 of 13 categories required for confirmed signal (≈62%, "balanced" tier)
  const CONFIRM_THRESHOLD = 8;
  const POSSIBLE_THRESHOLD = 6;

  let signal = "ESPERAR";
  if (votesInFavor >= CONFIRM_THRESHOLD) signal = isBoom ? "BUY" : "SELL";
  else if (votesInFavor >= POSSIBLE_THRESHOLD) signal = "POSIBLE";

  const slDist = Math.abs(price - ema50) * 1.1;
  const sl = isBoom ? price - slDist : price + slDist;
  const tp = isBoom ? price + slDist * 2 : price - slDist * 2;

  return {
    signal, score, reasons, dangerZone, sweetSpot,
    price, ema8, ema21, ema50, rsi, bb, mfi, adx,
    structure, candlePattern, fib, divergence, mtf, bbWidthTrend,
    votesInFavor, totalCategories, categories,
    sl: sl.toFixed(2), tp: tp.toFixed(2),
    ticksSinceSpike,
  };
}

// ── SOUND ────────────────────────────────────────────────────────────────
function playBeep(type = "alert") {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    if (type === "entry") {
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.start(); osc.stop(ctx.currentTime + 0.4);
    } else {
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      osc.start(); osc.stop(ctx.currentTime + 0.2);
    }
  } catch (_) {}
}

// ── MINI SPARKLINE ────────────────────────────────────────────────────────
function Sparkline({ prices, color = "#00ff9d", height = 48, width = 180 }) {
  if (!prices || prices.length < 2) return <div style={{ width, height, background: "#0d1117", borderRadius: 3 }} />;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const pts = prices.map((p, i) => {
    const x = (i / (prices.length - 1)) * width;
    const y = height - ((p - min) / range) * height;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={parseFloat(pts.split(" ").pop().split(",")[0])} cy={parseFloat(pts.split(" ").pop().split(",")[1])} r={3} fill={color} />
    </svg>
  );
}

// ── TICK PROGRESS BAR ─────────────────────────────────────────────────────
function TickBar({ ticks, max }) {
  const pct = Math.min((ticks / max) * 100, 100);
  const danger = pct >= 85;
  const sweet  = pct >= 50 && pct < 85;
  const color  = danger ? "#ff3860" : sweet ? "#f5c518" : "#555";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontFamily: "monospace", fontSize: 10, color: "#555", letterSpacing: 1 }}>TICKS DESDE SPIKE</span>
        <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color }}>
          {ticks} / ~{max} {danger ? "⚠ PELIGRO" : sweet ? "✦ ZONA" : ""}
        </span>
      </div>
      <div style={{ background: "#1e1e2e", borderRadius: 2, height: 5, overflow: "hidden" }}>
        <div style={{
          width: `${pct}%`, height: "100%", borderRadius: 2,
          background: danger ? "#ff3860" : sweet ? "linear-gradient(90deg,#f5c518,#ff9d00)" : "#333",
          boxShadow: danger ? "0 0 8px #ff3860" : sweet ? "0 0 8px #f5c518" : "none",
          transition: "width 0.3s ease",
        }} />
      </div>
    </div>
  );
}

// ── INDICATOR CHIP ────────────────────────────────────────────────────────
function Chip({ label, value, ok }) {
  return (
    <div style={{
      background: ok === true ? "#00ff9d11" : ok === false ? "#ff386011" : "#ffffff08",
      border: `1px solid ${ok === true ? "#00ff9d33" : ok === false ? "#ff386033" : "#2a2a3e"}`,
      borderRadius: 4, padding: "6px 10px",
    }}>
      <div style={{ fontSize: 9, color: "#555", fontFamily: "monospace", letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 13, fontFamily: "monospace", fontWeight: 700, color: ok === true ? "#00ff9d" : ok === false ? "#ff3860" : "#888", marginTop: 2 }}>{value ?? "—"}</div>
    </div>
  );
}

// ── MAIN APP ──────────────────────────────────────────────────────────────
export default function App() {
  const [activeSymbol, setActiveSymbol] = useState("Boom 300");
  const [status, setStatus]     = useState("idle");
  const [prices, setPrices]     = useState([]);
  const [tickCount, setTickCount] = useState(0);
  const [ticksSinceSpike, setTicksSinceSpike] = useState(0);
  const [lastSpike, setLastSpike] = useState(null);
  const [signalData, setSignalData] = useState(null);
  const [alerts, setAlerts]     = useState([]);
  const [soundOn, setSoundOn]   = useState(true);
  const [watchLevels, setWatchLevels] = useState([]);
  const [touchedLevel, setTouchedLevel] = useState(null);

  const wsRef        = useRef(null);
  const pricesRef    = useRef([]);
  const tssRef       = useRef(0);
  const prevSignalRef = useRef(null);
  const lastSpikeRef  = useRef(null);
  const levelsRef     = useRef([]);
  const touchedLevelRef = useRef(null);

  const sym = SYMBOLS[activeSymbol];

  const connect = useCallback(() => {
    if (wsRef.current) { wsRef.current.close(); }
    setStatus("connecting");
    setPrices([]); setTickCount(0); setTicksSinceSpike(0);
    setSignalData(null); setAlerts([]); setLastSpike(null);
    setWatchLevels([]); setTouchedLevel(null);
    pricesRef.current = []; tssRef.current = 0;
    lastSpikeRef.current = null; levelsRef.current = []; touchedLevelRef.current = null;

    const ws = new WebSocket(DERIV_WS);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("live");
      ws.send(JSON.stringify({ ticks: sym.id, subscribe: 1 }));
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.error) { setStatus("error"); return; }
      if (msg.tick) {
        const price = parseFloat(msg.tick.quote);
        pricesRef.current = [...pricesRef.current.slice(-199), price];
        tssRef.current += 1;

        const isSpike = detectSpike(pricesRef.current, sym.spikePct);
        if (isSpike) {
          tssRef.current = 0;
          const spikeData = { price, time: new Date().toLocaleTimeString("es-CO") };
          lastSpikeRef.current = spikeData;
          setLastSpike(spikeData);
          touchedLevelRef.current = null;
          setTouchedLevel(null);
          if (soundOn) playBeep("alert");
          setAlerts(a => [{
            type: "spike",
            msg: `⚡ SPIKE detectado en ${price.toFixed(2)}`,
            time: new Date().toLocaleTimeString("es-CO"),
          }, ...a.slice(0, 9)]);
        }

        const tss = tssRef.current;
        setPrices([...pricesRef.current]);
        setTickCount(tc => tc + 1);
        setTicksSinceSpike(tss);

        // Recalculate watch levels every 20 ticks (levels shouldn't jump every tick)
        if (pricesRef.current.length % 20 === 0 || levelsRef.current.length === 0) {
          const lvls = calcWatchLevels(pricesRef.current, lastSpikeRef.current, sym.dir === "boom");
          levelsRef.current = lvls;
          setWatchLevels(lvls);
        }

        if (pricesRef.current.length % 5 === 0) {
          const sig = computeSignal({ prices: pricesRef.current, ticksSinceSpike: tss, symbol: activeSymbol });
          setSignalData(sig);

          // Check if price is touching a watch level right now
          const touched = checkLevelTouch(price, levelsRef.current, 0.05);
          if (touched && touchedLevelRef.current?.price !== touched.price) {
            touchedLevelRef.current = touched;
            setTouchedLevel(touched);
            if (soundOn) playBeep("alert");
            const strongConfirm = sig && sig.votesInFavor >= 8;
            const alertMsg = strongConfirm
              ? `🎯 PRECIO TOCÓ ${touched.label} (${touched.price.toFixed(2)}) — ${sig.votesInFavor}/13 categorías a favor. Considera ${sig.signal === "BUY" ? "COMPRAR" : "VENDER"} aquí.`
              : `📍 Precio tocó ${touched.label} (${touched.price.toFixed(2)}) — solo ${sig ? sig.votesInFavor : 0}/13 categorías a favor, confirmación débil.`;
            setAlerts(a => [{ type: strongConfirm ? "signal" : "level", msg: alertMsg, time: new Date().toLocaleTimeString("es-CO") }, ...a.slice(0, 9)]);
          } else if (!touched) {
            touchedLevelRef.current = null;
          }

          if (sig && sig.signal !== prevSignalRef.current) {
            if (sig.signal === "BUY" || sig.signal === "SELL") {
              if (soundOn) playBeep("entry");
              const alertMsg = `🎯 SEÑAL ${sig.signal} — ${sig.votesInFavor}/13 categorías — Entrada: ${sig.price.toFixed(2)} SL: ${sig.sl} TP: ${sig.tp}`;
              setAlerts(a => [{ type: "signal", msg: alertMsg, time: new Date().toLocaleTimeString("es-CO") }, ...a.slice(0, 9)]);
            }
            prevSignalRef.current = sig.signal;
          }
        }
      }
    };

    ws.onerror = () => setStatus("error");
    ws.onclose = () => { if (status !== "idle") setStatus("idle"); };
  }, [activeSymbol, soundOn]);

  const disconnect = () => {
    if (wsRef.current) wsRef.current.close();
    setStatus("idle");
  };

  useEffect(() => () => { if (wsRef.current) wsRef.current.close(); }, []);

  const isBoom = sym.dir === "boom";
  const signalColor = (s) => s === "BUY" ? "#00ff9d" : s === "SELL" ? "#ff3860" : s === "POSIBLE" ? "#f5c518" : "#555";
  const currentPrice = prices[prices.length - 1];

  const statusDot = { idle: "#555", connecting: "#f5c518", live: "#00ff9d", error: "#ff3860" };

  const ema8ok  = signalData ? (isBoom ? signalData.ema8 > signalData.ema21 : signalData.ema8 < signalData.ema21) : null;
  const ema21ok = signalData ? (isBoom ? signalData.ema21 > signalData.ema50 : signalData.ema21 < signalData.ema50) : null;
  const rsiOk   = signalData ? (isBoom ? signalData.rsi > 30 && signalData.rsi < 65 : signalData.rsi > 35 && signalData.rsi < 70) : null;
  const bbOk    = signalData && signalData.bb ? (isBoom ? currentPrice <= signalData.bb.mid : currentPrice >= signalData.bb.mid) : null;
  const mfiOk   = signalData && signalData.mfi !== null && signalData.mfi !== undefined ? (isBoom ? signalData.mfi > 50 : signalData.mfi < 50) : null;
  const adxOk   = signalData && signalData.adx !== null && signalData.adx !== undefined ? signalData.adx > 25 : null;

  return (
    <div style={{ minHeight: "100vh", background: "#07090f", color: "#c9d1d9", fontFamily: "'Inter', sans-serif", fontSize: 14 }}>

      <div style={{ background: "#0a0d1a", borderBottom: "1px solid #1a1a2e", padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 3, height: 28, background: "#00ff9d", borderRadius: 2, boxShadow: "0 0 8px #00ff9d" }} />
          <div>
            <div style={{ fontFamily: "monospace", fontWeight: 900, fontSize: 14, letterSpacing: 4, color: "#fff" }}>DERIV PRO</div>
            <div style={{ fontSize: 9, color: "#333", letterSpacing: 2 }}>BOOM · CRASH · LIVE SIGNALS</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => setSoundOn(s => !s)} style={{ background: "none", border: "none", color: soundOn ? "#00ff9d" : "#333", fontSize: 16, cursor: "pointer" }}>
            {soundOn ? "🔊" : "🔇"}
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: statusDot[status], boxShadow: status === "live" ? "0 0 6px #00ff9d" : "none" }} />
            <span style={{ fontFamily: "monospace", fontSize: 11, color: statusDot[status], letterSpacing: 1 }}>
              {status === "idle" ? "DESCONECTADO" : status === "connecting" ? "CONECTANDO..." : status === "live" ? "EN VIVO" : "ERROR"}
            </span>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #1a1a2e" }}>
        {Object.keys(SYMBOLS).map(s => {
          const active = s === activeSymbol;
          const boom = s.startsWith("Boom");
          return (
            <button key={s} onClick={() => { setActiveSymbol(s); if (status === "live") setTimeout(connect, 100); }} style={{
              flex: 1, padding: "10px 4px",
              background: active ? (boom ? "#00ff9d11" : "#ff386011") : "transparent",
              border: "none",
              borderBottom: active ? `2px solid ${boom ? "#00ff9d" : "#ff3860"}` : "2px solid transparent",
              color: active ? (boom ? "#00ff9d" : "#ff3860") : "#333",
              fontFamily: "monospace", fontWeight: active ? 700 : 400,
              fontSize: 11, letterSpacing: 1, cursor: "pointer", transition: "all 0.15s",
            }}>
              {s.toUpperCase()}
            </button>
          );
        })}
      </div>

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "16px 16px 40px" }}>

        <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
          <button onClick={connect} disabled={status === "live" || status === "connecting"} style={{
            flex: 1, padding: "12px 0",
            background: status === "live" ? "#1a1a2e" : "linear-gradient(135deg,#00ff9d,#00b36b)",
            border: "none", borderRadius: 4,
            color: status === "live" ? "#333" : "#001a0e",
            fontFamily: "monospace", fontWeight: 800, fontSize: 13, letterSpacing: 3,
            cursor: status === "live" ? "not-allowed" : "pointer",
          }}>
            {status === "connecting" ? "CONECTANDO..." : status === "live" ? "✓ EN VIVO" : "▶ CONECTAR"}
          </button>
          <button onClick={disconnect} disabled={status !== "live"} style={{
            padding: "12px 20px", background: "#0d1117", border: "1px solid #2a2a3e",
            borderRadius: 4, color: status === "live" ? "#ff3860" : "#333",
            fontFamily: "monospace", fontSize: 12, cursor: status === "live" ? "pointer" : "not-allowed",
          }}>PARAR</button>
        </div>

        {status === "error" && (
          <div style={{ background: "#ff386022", border: "1px solid #ff386055", borderRadius: 4, padding: 12, color: "#ff3860", fontFamily: "monospace", fontSize: 12, marginBottom: 12 }}>
            ⚠ No se pudo conectar con Deriv. Verifica tu conexión a internet e intenta de nuevo.
          </div>
        )}

        {prices.length > 0 && (
          <div style={{ background: "#0a0d1a", border: "1px solid #1a1a2e", borderRadius: 6, padding: "14px 18px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 9, color: "#555", fontFamily: "monospace", letterSpacing: 2, marginBottom: 4 }}>PRECIO ACTUAL</div>
              <div style={{ fontFamily: "monospace", fontWeight: 900, fontSize: 26, color: "#fff", letterSpacing: 2 }}>
                {currentPrice?.toFixed(2)}
              </div>
              <div style={{ fontSize: 10, color: "#555", fontFamily: "monospace", marginTop: 4 }}>
                TICKS RECIBIDOS: {tickCount}
              </div>
            </div>
            <Sparkline prices={prices.slice(-60)} color={isBoom ? "#00ff9d" : "#ff3860"} width={160} height={52} />
          </div>
        )}

        {status === "live" && (
          <div style={{ background: "#0a0d1a", border: "1px solid #1a1a2e", borderRadius: 6, padding: "12px 18px", marginBottom: 14 }}>
            <TickBar ticks={ticksSinceSpike} max={sym.maxTicks} />
            {lastSpike && (
              <div style={{ marginTop: 8, fontSize: 10, color: "#555", fontFamily: "monospace" }}>
                Último spike: {lastSpike.price.toFixed(2)} @ {lastSpike.time}
              </div>
            )}
          </div>
        )}

        {watchLevels.length > 0 && (
          <div style={{ background: "#0a0d1a", border: "1px solid #1a1a2e", borderRadius: 6, padding: "12px 18px", marginBottom: 14 }}>
            <div style={{ fontSize: 9, color: "#555", fontFamily: "monospace", letterSpacing: 2, marginBottom: 10 }}>
              📍 NIVELES DE VIGILANCIA — esperando que el precio llegue aquí
            </div>
            {watchLevels.map((lvl, i) => {
              const dist = currentPrice ? ((currentPrice - lvl.price) / lvl.price * 100) : 0;
              const isTouched = touchedLevel && Math.abs(touchedLevel.price - lvl.price) < 0.001;
              const typeColor = lvl.type === "fib" ? "#f5c518" : lvl.type === "spike" ? "#ff3860" : "#00b3ff";
              return (
                <div key={i} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "6px 10px", marginBottom: 4, borderRadius: 3,
                  background: isTouched ? `${typeColor}22` : "#ffffff05",
                  border: `1px solid ${isTouched ? typeColor : "#1e1e2e"}`,
                }}>
                  <div>
                    <span style={{ color: typeColor, fontFamily: "monospace", fontSize: 11, fontWeight: 700 }}>{lvl.label}</span>
                    <span style={{ color: "#555", fontFamily: "monospace", fontSize: 10, marginLeft: 8 }}>{lvl.price.toFixed(2)}</span>
                  </div>
                  <span style={{ fontFamily: "monospace", fontSize: 10, color: Math.abs(dist) < 0.05 ? "#00ff9d" : "#444" }}>
                    {isTouched ? "✓ TOCADO" : `${dist > 0 ? "+" : ""}${dist.toFixed(2)}%`}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {signalData && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 14 }}>
            <Chip label="EMA 8/21" value={signalData.ema8?.toFixed(2)} ok={ema8ok} />
            <Chip label="EMA 21/50" value={signalData.ema21?.toFixed(2)} ok={ema21ok} />
            <Chip label="RSI 7" value={signalData.rsi?.toFixed(1)} ok={rsiOk} />
            <Chip label="BB MID" value={signalData.bb?.mid?.toFixed(2)} ok={bbOk} />
            <Chip label="MFI 14" value={signalData.mfi?.toFixed(1) ?? "—"} ok={mfiOk} />
            <Chip label="ADX 14" value={signalData.adx?.toFixed(1) ?? "—"} ok={adxOk} />
          </div>
        )}

        {signalData && (
          <div style={{ background: "#0a0d1a", border: `1px solid ${signalColor(signalData.signal)}33`, borderRadius: 6, overflow: "hidden", marginBottom: 14 }}>
            <div style={{ padding: "16px 18px", borderBottom: "1px solid #1a1a2e", textAlign: "center" }}>
              <div style={{
                display: "inline-block",
                background: `${signalColor(signalData.signal)}22`,
                color: signalColor(signalData.signal),
                fontFamily: "monospace", fontWeight: 900, fontSize: 22, letterSpacing: 6,
                padding: "12px 32px", borderRadius: 4,
                boxShadow: `0 0 24px ${signalColor(signalData.signal)}44`,
                animation: (signalData.signal === "BUY" || signalData.signal === "SELL") ? "pulse 1.5s infinite" : "none",
              }}>
                {signalData.signal === "BUY" ? "▲ COMPRAR" : signalData.signal === "SELL" ? "▼ VENDER" : signalData.signal === "POSIBLE" ? "◈ POSIBLE" : "⏸ ESPERAR"}
              </div>
              <div style={{ marginTop: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontFamily: "monospace", fontSize: 10, color: "#555", letterSpacing: 1 }}>CATEGORÍAS A FAVOR</span>
                  <span style={{ fontFamily: "monospace", fontWeight: 700, color: signalColor(signalData.signal), fontSize: 12 }}>{signalData.votesInFavor}/{signalData.totalCategories} ({signalData.score}%)</span>
                </div>
                <div style={{ background: "#1e1e2e", borderRadius: 2, height: 5 }}>
                  <div style={{ width: `${signalData.score}%`, height: "100%", borderRadius: 2, background: signalColor(signalData.signal), transition: "width 0.5s ease" }} />
                </div>
              </div>
            </div>
            {signalData.categories && (
              <div style={{ padding: "0 18px 8px", display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 4 }}>
                {signalData.categories.map((c, i) => (
                  <div key={i} style={{
                    fontSize: 9, fontFamily: "monospace", padding: "3px 6px", borderRadius: 3,
                    background: c.vote ? "#00ff9d11" : "#ffffff05",
                    color: c.vote ? "#00ff9d" : "#444",
                    border: `1px solid ${c.vote ? "#00ff9d22" : "#1e1e2e"}`,
                  }}>
                    {c.vote ? "✓" : "○"} {c.name}
                  </div>
                ))}
              </div>
            )}
            <div style={{ padding: "12px 18px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 9, color: "#555", fontFamily: "monospace", letterSpacing: 1 }}>ENTRADA</div>
                <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 13, color: "#fff", marginTop: 3 }}>{currentPrice?.toFixed(2)}</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 9, color: "#555", fontFamily: "monospace", letterSpacing: 1 }}>STOP LOSS</div>
                <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 13, color: "#ff3860", marginTop: 3 }}>{signalData.sl}</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 9, color: "#555", fontFamily: "monospace", letterSpacing: 1 }}>TAKE PROFIT</div>
                <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 13, color: "#00ff9d", marginTop: 3 }}>{signalData.tp}</div>
              </div>
            </div>
            {signalData.reasons.length > 0 && (
              <div style={{ padding: "0 18px 14px", display: "flex", flexWrap: "wrap", gap: 6 }}>
                {signalData.reasons.map((r, i) => (
                  <span key={i} style={{ background: "#ffffff08", border: "1px solid #2a2a3e", borderRadius: 3, padding: "3px 8px", fontSize: 10, fontFamily: "monospace", color: "#888" }}>✓ {r}</span>
                ))}
              </div>
            )}
            {signalData.dangerZone && (
              <div style={{ background: "#ff386022", borderTop: "1px solid #ff386033", padding: "8px 18px", fontSize: 11, color: "#ff3860", fontFamily: "monospace" }}>
                ⚠ Muchos ticks sin spike — mayor probabilidad de spike inminente. Opera con precaución.
              </div>
            )}
          </div>
        )}

        {alerts.length > 0 && (
          <div style={{ background: "#0a0d1a", border: "1px solid #1a1a2e", borderRadius: 6, overflow: "hidden" }}>
            <div style={{ padding: "8px 14px", borderBottom: "1px solid #1a1a2e", fontSize: 9, color: "#555", fontFamily: "monospace", letterSpacing: 2 }}>LOG DE ALERTAS</div>
            {alerts.map((a, i) => (
              <div key={i} style={{ padding: "8px 14px", borderBottom: i < alerts.length - 1 ? "1px solid #111" : "none", display: "flex", gap: 12, alignItems: "flex-start" }}>
                <span style={{ fontFamily: "monospace", fontSize: 10, color: "#333", minWidth: 52 }}>{a.time}</span>
                <span style={{ fontFamily: "monospace", fontSize: 11, color: a.type === "signal" ? "#00ff9d" : "#f5c518" }}>{a.msg}</span>
              </div>
            ))}
          </div>
        )}

        {status === "idle" && prices.length === 0 && (
          <div style={{ textAlign: "center", padding: "48px 0", color: "#333", fontFamily: "monospace" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📡</div>
            <div style={{ letterSpacing: 2, fontSize: 12 }}>Presiona CONECTAR para recibir ticks en vivo de {activeSymbol}</div>
          </div>
        )}

        <div style={{ marginTop: 24, textAlign: "center", fontSize: 9, color: "#222", fontFamily: "monospace", letterSpacing: 1 }}>
          HERRAMIENTA EDUCATIVA · NO ES ASESORÍA FINANCIERA · OPERA BAJO TU PROPIO RIESGO
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
        }
      `}</style>
    </div>
  );
}
