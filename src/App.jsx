import { useState, useEffect, useRef, useCallback } from "react";

const SYMBOLS = {
  "Boom 300":  { id: "BOOM300N",  dir: "boom",  spikePct: 0.8, maxTicks: 300 },
  "Boom 500":  { id: "BOOM500N",  dir: "boom",  spikePct: 0.8, maxTicks: 500 },
  "Crash 300": { id: "CRASH300N", dir: "crash", spikePct: 0.8, maxTicks: 300 },
  "Crash 500": { id: "CRASH500N", dir: "crash", spikePct: 0.8, maxTicks: 500 },
};

const DERIV_WS = "wss://ws.binaryws.com/websockets/v3?app_id=1089";

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

function detectSpike(prices, pct = 0.8) {
  if (prices.length < 2) return false;
  const last = prices[prices.length - 1];
  const prev = prices[prices.length - 2];
  const change = Math.abs((last - prev) / prev) * 100;
  return change > pct;
}

function computeSignal({ prices, ticksSinceSpike, symbol }) {
  if (prices.length < 52) return null;
  const sym = SYMBOLS[symbol];
  const isBoom = sym.dir === "boom";
  const maxT = sym.maxTicks;

  const ema8  = calcEMA(prices, 8);
  const ema21 = calcEMA(prices, 21);
  const ema50 = calcEMA(prices, 50);
  const rsi   = calcRSI(prices, 7);
  const bb    = calcBollinger(prices, 20);
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

  let score = 0;
  const reasons = [];

  if (isBoom) {
    if (ema8 > ema21 && ema21 > ema50) { score += 30; reasons.push("EMAs alcistas alineadas"); }
    if (rsi > 35 && rsi < 60)           { score += 20; reasons.push(`RSI ${rsi.toFixed(0)} en zona de compra`); }
    if (price <= bb.mid && price >= bb.lower) { score += 20; reasons.push("Precio en zona baja de BB"); }
    if (sweetSpot)                       { score += 20; reasons.push(`${ticksSinceSpike} ticks — zona óptima`); }
    if (ha3Aligned)                      { score += 10; reasons.push("3 Heiken Ashi verdes"); }
  } else {
    if (ema8 < ema21 && ema21 < ema50) { score += 30; reasons.push("EMAs bajistas alineadas"); }
    if (rsi > 40 && rsi < 65)           { score += 20; reasons.push(`RSI ${rsi.toFixed(0)} en zona de venta`); }
    if (price >= bb.mid && price <= bb.upper) { score += 20; reasons.push("Precio en zona alta de BB"); }
    if (sweetSpot)                       { score += 20; reasons.push(`${ticksSinceSpike} ticks — zona óptima`); }
    if (ha3Aligned)                      { score += 10; reasons.push("3 Heiken Ashi rojas"); }
  }

  let signal = "ESPERAR";
  if (score >= 70 && !dangerZone) signal = isBoom ? "BUY" : "SELL";
  else if (score >= 45 && !dangerZone) signal = "POSIBLE";

  const slDist = Math.abs(price - ema50) * 1.1;
  const sl = isBoom ? price - slDist : price + slDist;
  const tp = isBoom ? price + slDist * 2 : price - slDist * 2;

  return {
    signal, score, reasons, dangerZone, sweetSpot,
    price, ema8, ema21, ema50, rsi, bb,
    sl: sl.toFixed(2), tp: tp.toFixed(2),
    ticksSinceSpike,
  };
}

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

  const wsRef        = useRef(null);
  const pricesRef    = useRef([]);
  const tssRef       = useRef(0);
  const prevSignalRef = useRef(null);

  const sym = SYMBOLS[activeSymbol];

  const connect = useCallback(() => {
    if (wsRef.current) { wsRef.current.close(); }
    setStatus("connecting");
    setPrices([]); setTickCount(0); setTicksSinceSpike(0);
    setSignalData(null); setAlerts([]); setLastSpike(null);
    pricesRef.current = []; tssRef.current = 0;

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
          setLastSpike({ price, time: new Date().toLocaleTimeString("es-CO") });
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

        if (pricesRef.current.length % 5 === 0) {
          const sig = computeSignal({ prices: pricesRef.current, ticksSinceSpike: tss, symbol: activeSymbol });
          setSignalData(sig);

          if (sig && sig.signal !== prevSignalRef.current) {
            if (sig.signal === "BUY" || sig.signal === "SELL") {
              if (soundOn) playBeep("entry");
              const alertMsg = `🎯 SEÑAL ${sig.signal} — Score ${sig.score}/100 — Entrada: ${sig.price.toFixed(2)} SL: ${sig.sl} TP: ${sig.tp}`;
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
  const rsiOk   = signalData ? (isBoom ? signalData.rsi > 35 && signalData.rsi < 60 : signalData.rsi > 40 && signalData.rsi < 65) : null;
  const bbOk    = signalData && signalData.bb ? (isBoom ? currentPrice <= signalData.bb.mid : currentPrice >= signalData.bb.mid) : null;

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

        {signalData && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginBottom: 14 }}>
            <Chip label="EMA 8/21" value={signalData.ema8?.toFixed(2)} ok={ema8ok} />
            <Chip label="EMA 21/50" value={signalData.ema21?.toFixed(2)} ok={ema21ok} />
            <Chip label="RSI 7" value={signalData.rsi?.toFixed(1)} ok={rsiOk} />
            <Chip label="BB MID" value={signalData.bb?.mid?.toFixed(2)} ok={bbOk} />
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
                  <span style={{ fontFamily: "monospace", fontSize: 10, color: "#555", letterSpacing: 1 }}>SCORE</span>
                  <span style={{ fontFamily: "monospace", fontWeight: 700, color: signalColor(signalData.signal), fontSize: 12 }}>{signalData.score}/100</span>
                </div>
                <div style={{ background: "#1e1e2e", borderRadius: 2, height: 5 }}>
                  <div style={{ width: `${signalData.score}%`, height: "100%", borderRadius: 2, background: signalColor(signalData.signal), transition: "width 0.5s ease" }} />
                </div>
              </div>
            </div>
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
                ⚠ ZONA DE PELIGRO — Spike inminente. No abrir posiciones {isBoom ? "short" : "long"}.
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
