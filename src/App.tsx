import { useMemo, useState, useRef, useEffect } from 'react';

// ---------------- WAV ENCODER HELPERS (fuori dal componente) ----------------

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const samples = buffer.length * numChannels;
  const blockAlign = (numChannels * bitDepth) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples * (bitDepth / 8);
  const bufferSize = 44 + dataSize;

  const arrayBuffer = new ArrayBuffer(bufferSize);
  const view = new DataView(arrayBuffer);

  // RIFF chunk
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, format, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // PCM interleaved
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < numChannels; c++) {
      let sample = buffer.getChannelData(c)[i];
      sample = Math.max(-1, Math.min(1, sample));
      const s = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, s, true);
      offset += 2;
    }
  }

  return arrayBuffer;
}

// MK2-style UI + audio engine with Play/Pause (resume), RPM origine/ri-produzione, e Tap Tempo
// - Slider verticale (cross-browser)
// - RPM di origine (disco) e RPM di riproduzione (piatto)
// - Pitch ±8% sopra il rapporto RPM
// - TAP tempo per stimare BPM e impostarlo come BPM originale

export default function PitchFaderMK2UI() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [pitch, setPitch] = useState(0);
  const [rpmOrigin, setRpmOrigin] = useState<33 | 45>(33);
  const [rpmPlay, setRpmPlay] = useState<33 | 45>(33);
  const [playing, setPlaying] = useState(false);
  const [originalBpm, setOriginalBpm] = useState<string>('');
  const [loaded, setLoaded] = useState(false);

  const ctxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);

  // Timeline per pausa/riprendi
  const pausedAtRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);
  const rateRef = useRef(1);

  // TAP tempo
  const [_tapTimes, setTapTimes] = useState<number[]>([]);
  const [tapBpm, setTapBpm] = useState<string>('—');

  const detent = Math.abs(pitch) < 0.05;

  const displayPitch = useMemo(() => pitch.toFixed(1), [pitch]);
  const baseMultiplier = useMemo(() => {
    const toHz = (r: 33 | 45) => (r === 33 ? 33.333 : 45);
    return toHz(rpmPlay) / toHz(rpmOrigin);
  }, [rpmOrigin, rpmPlay]);
  const effectiveRate = useMemo(
    () => (1 + pitch / 100) * baseMultiplier,
    [pitch, baseMultiplier]
  );

  const computedBpm = useMemo(() => {
    const orig = parseFloat(originalBpm);
    if (isNaN(orig)) return '—';
    return (orig * effectiveRate).toFixed(1);
  }, [originalBpm, effectiveRate]);

  const ensureAudio = async () => {
    if (!ctxRef.current) {
      const Ctx =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      ctxRef.current = new Ctx();
    }
    if (!gainRef.current && ctxRef.current) {
      gainRef.current = ctxRef.current.createGain();
      gainRef.current.connect(ctxRef.current.destination);
    }
  };

  const getPositionSeconds = () => {
    const ctx = ctxRef.current;
    if (!ctx || startedAtRef.current == null) return pausedAtRef.current;
    const dt = ctx.currentTime - startedAtRef.current;
    return Math.min(
      bufferRef.current?.duration ?? Infinity,
      pausedAtRef.current + dt * rateRef.current
    );
  };

  const startFromPaused = () => {
    const ctx = ctxRef.current;
    const buffer = bufferRef.current;
    if (!ctx || !buffer || !gainRef.current) return;

    if (sourceRef.current) {
      try {
        sourceRef.current.stop();
      } catch {}
      try {
        sourceRef.current.disconnect();
      } catch {}
      sourceRef.current = null;
    }

    const offset = Math.max(0, Math.min(pausedAtRef.current, buffer.duration - 0.001));
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = effectiveRate;
    src.connect(gainRef.current);
    src.onended = () => {
      setPlaying(false);
      sourceRef.current = null;
      if (offset >= buffer.duration - 0.001) {
        pausedAtRef.current = 0;
        startedAtRef.current = null;
      }
    };
    src.start(0, offset);
    sourceRef.current = src;
    startedAtRef.current = ctx.currentTime;
    rateRef.current = effectiveRate;
    setPlaying(true);
  };

  // Aggiorna rate “a caldo” mantenendo la posizione quando cambiano pitch o RPM
  useEffect(() => {
    const ctx = ctxRef.current;
    const src = sourceRef.current;
    if (ctx && src && playing) {
      pausedAtRef.current = getPositionSeconds();
      startedAtRef.current = ctx.currentTime;
      try {
        src.playbackRate.setValueAtTime(effectiveRate, ctx.currentTime);
      } catch {}
      rateRef.current = effectiveRate;
    }
  }, [effectiveRate, playing]);

  const handleFile = async (file?: File) => {
    if (!file) return;
    setFileName(file.name);
    const arrayBuf = await file.arrayBuffer();
    const Ctx =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    const ctx: AudioContext = ctxRef.current ?? new Ctx();
    const audioBuffer = await ctx.decodeAudioData(arrayBuf.slice(0));
    bufferRef.current = audioBuffer;
    setLoaded(true);
    if (!ctxRef.current) {
      ctxRef.current = ctx;
      gainRef.current = ctx.createGain();
      gainRef.current.connect(ctx.destination);
    }
    pausedAtRef.current = 0;
    startedAtRef.current = null;
  };

  const togglePause = async () => {
    if (!bufferRef.current) return;
    await ensureAudio();
    if (!playing) {
      if (ctxRef.current?.state === 'suspended') await ctxRef.current.resume();
      startFromPaused();
    } else {
      const ctx = ctxRef.current;
      if (ctx) pausedAtRef.current = getPositionSeconds();
      if (sourceRef.current) {
        try {
          sourceRef.current.stop();
        } catch {}
        try {
          sourceRef.current.disconnect();
        } catch {}
        sourceRef.current = null;
      }
      startedAtRef.current = null;
      setPlaying(false);
    }
  };

  // TAP logic
  const handleTap = () => {
    const now = Date.now();
    setTapTimes((prev) => {
      if (prev.length && now - prev[prev.length - 1] > 2000) return [now];
      const next = [...prev, now].slice(-10);
      if (next.length >= 2) {
        const diffs = next.slice(1).map((t, i) => (t - next[i]) / 1000);
        const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
        if (avg > 0) setTapBpm((60 / avg).toFixed(1));
      }
      return next;
    });
  };
  const resetTap = () => {
    setTapTimes([]);
    setTapBpm('—');
  };
  const useTapAsBpm = () => {
    if (tapBpm !== '—') setOriginalBpm(tapBpm);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 't') {
        e.preventDefault();
        handleTap();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---------------- EXPORT WAV PITCHED ----------------

  const exportPitchedWav = async () => {
    const buffer = bufferRef.current;
    if (!buffer) {
      alert('Carica un WAV prima di esportare.');
      return;
    }

    const rate = effectiveRate;
    if (rate <= 0) {
      alert('Playback rate non valido.');
      return;
    }

    // Durata ricampionata tipo giradischi
    const renderedLength = Math.ceil(buffer.length / rate);

    const offline = new OfflineAudioContext(
      buffer.numberOfChannels,
      renderedLength,
      buffer.sampleRate
    );

    const src = offline.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(offline.destination);
    src.start(0);

    const rendered = await offline.startRendering();

    const wav = audioBufferToWav(rendered);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);

    const safeName =
      (fileName ?? 'track').replace(/[^\w\-]+/g, '_') || 'track';

    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}_PITCHED_${rate.toFixed(4)}.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen w-full bg-neutral-950 text-neutral-100 p-4 sm:p-8">
      {/* isolate = niente overlay tra stack diversi */}
      <div className="mx-auto max-w-9xl rounded-2xl bg-gradient-to-b from-neutral-900 to-neutral-950 shadow-2xl ring-1 ring-neutral-800 isolate overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800">
          <div className="flex items-center gap-3">
            <div className="h-3 w-3 rounded-full bg-green-400 shadow-[0_0_12px_2px_rgba(74,222,128,0.7)]" />
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
              PitchLab MK2
            </h1>
            <span className="text-xs px-2 py-0.5 rounded bg-neutral-800/70 border border-neutral-700">
              Prototype
            </span>
          </div>
          <div className="text-xs text-neutral-400">
            File: {fileName ?? 'nessun file'}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1.25fr_0.95fr] gap-8 p-6">
          {/* Colonna sinistra */}
          <div className="flex flex-col gap-4">
            {/* Dropzone */}
            <label
              htmlFor="file"
              className="group relative grid place-items-center h-56 sm:h-64 rounded-xl border border-neutral-800 bg-neutral-900/60 hover:bg-neutral-900 cursor-pointer overflow-hidden"
            >
              <input
                id="file"
                type="file"
                accept="audio/wav,audio/x-wav"
                className="hidden"
                onChange={async (e) => {
                  await handleFile(e.target.files?.[0]);
                }}
              />
              {/* layer decorativo che non prende click */}
              <div className="absolute inset-0 opacity-30 [mask-image:linear-gradient(to_right,transparent,black,transparent)] pointer-events-none">
                <div className="h-full w-[200%] bg-[repeating-linear-gradient(90deg,theme(colors.neutral.700)_0px,theme(colors.neutral.700)_1px,transparent_1px,transparent_4px)] translate-x-[-25%]" />
              </div>
              <div className="relative z-10 flex flex-col items-center gap-2 text-center">
                <svg
                  width="36"
                  height="36"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="opacity-90"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
                <p className="text-sm text-neutral-300">
                  Trascina un file WAV qui o clicca per selezionare
                </p>
                <p className="text-xs text-neutral-500">
                  {loaded
                    ? 'File caricato ✓'
                    : 'Supporto audio attivo — carica un WAV'}
                </p>
              </div>
            </label>

            {/* Box comandi: sopra a tutto */}
            <div className="flex items-center justify-between gap-3 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 relative z-10">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <button
                    className="px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 active:scale-95"
                    onClick={() =>
                      setPitch((p) => Math.max(-8, p - 0.1))
                    }
                  >
                    - Nudge
                  </button>
                  <button
                    className="px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 active:scale-95"
                    onClick={() =>
                      setPitch((p) => Math.min(8, p + 0.1))
                    }
                  >
                    + Nudge
                  </button>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-neutral-400">Origine</span>
                  <button
                    className={`px-2.5 py-1.5 rounded-lg border text-sm ${
                      rpmOrigin === 33
                        ? 'bg-green-500/10 border-green-500/50'
                        : 'bg-neutral-800 border-neutral-700'
                    }`}
                    onClick={() => setRpmOrigin(33)}
                  >
                    33
                  </button>
                  <button
                    className={`px-2.5 py-1.5 rounded-lg border text-sm ${
                      rpmOrigin === 45
                        ? 'bg-green-500/10 border-green-500/50'
                        : 'bg-neutral-800 border-neutral-700'
                    }`}
                    onClick={() => setRpmOrigin(45)}
                  >
                    45
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-neutral-400">
                    Riproduzione
                  </span>
                  <button
                    className={`px-2.5 py-1.5 rounded-lg border text-sm ${
                      rpmPlay === 33
                        ? 'bg-green-500/10 border-green-500/50'
                        : 'bg-neutral-800 border-neutral-700'
                    }`}
                    onClick={() => setRpmPlay(33)}
                  >
                    33
                  </button>
                  <button
                    className={`px-2.5 py-1.5 rounded-lg border text-sm ${
                      rpmPlay === 45
                        ? 'bg-green-500/10 border-green-500/50'
                        : 'bg-neutral-800 border-neutral-700'
                    }`}
                    onClick={() => setRpmPlay(45)}
                  >
                    45
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className="h-12 w-12 rounded-full border border-neutral-700 grid place-items-center active:scale-95 transition bg-neutral-800"
                    onClick={togglePause}
                    disabled={!loaded}
                    title="Play/Pausa"
                  >
                    {playing ? '⏸' : '▶'}
                  </button>
                  <button
                    className="px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-xs active:scale-95 disabled:opacity-40"
                    onClick={exportPitchedWav}
                    disabled={!loaded}
                    title="Esporta WAV con pitch attuale"
                  >
                    Esporta WAV pitched
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Colonna destra */}
          <div className="grid grid-cols-1 md:grid-cols-[1.1fr_1.1fr] gap-6">
            {/* Pannello Pitch */}
            <div className="relative z-0 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
              <h2 className="text-sm font-medium text-neutral-300 mb-2">
                Pitch
              </h2>
              <div className="flex items-center gap-4">
                <div className="relative h-72 w-10 hidden sm:block">
                  <div className="absolute inset-0 mx-auto w-px bg-gradient-to-b from-transparent via-neutral-700 to-transparent" />
                  {Array.from({ length: 17 }).map((_, i) => {
                    const y = (i / 16) * 100;
                    const val = -8 + i; // da -8 a +8
                    const isMajor = i % 2 === 0;
                    return (
                      <div
                        key={i}
                        className="absolute left-0 right-0"
                        style={{ top: `${y}%` }}
                      >
                        <div
                          className={`${
                            isMajor ? 'w-6' : 'w-3'
                          } h-px bg-neutral-600 mx-auto`}
                        />
                        {isMajor && (
                          <div className="text-[10px] text-center text-neutral-400 mt-1">
                            {val}%
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <div className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-neutral-800 border border-neutral-700" />
                </div>

                <div className="flex flex-col items-center gap-3">
                  <input
                    type="range"
                    min={-8}
                    max={8}
                    step={0.1}
                    value={pitch}
                    onChange={(e) =>
                      setPitch(parseFloat(e.target.value))
                    }
                    className="h-72 w-6 appearance-none bg-transparent"
                    style={{
                      WebkitAppearance: 'slider-vertical',
                      writingMode: 'vertical-lr',
                    }}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      className="px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 active:scale-95"
                      onClick={() => setPitch(0)}
                    >
                      Reset
                    </button>
                    <div className="flex items-center gap-2 text-xs text-neutral-400">
                      <span>Quartz</span>
                      <span
                        className={`h-2 w-2 rounded-full ${
                          detent ? 'bg-green-400' : 'bg-neutral-700'
                        }`}
                      />
                    </div>
                  </div>
                </div>

                <div className="ml-auto grid gap-2 text-right">
                  <div className="text-sm text-neutral-400">Pitch</div>
                  <div className="text-4xl font-bold tracking-tight tabular-nums">
                    {displayPitch}%
                  </div>
                  <div className="text-xs text-neutral-500">
                    Range ±8%
                  </div>
                </div>
              </div>
            </div>

            {/* Pannello Info traccia */}
            <div className="relative z-0 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
              <h2 className="text-sm font-medium text-neutral-300 mb-3">
                Info traccia
              </h2>
              <div className="grid gap-3">
                <label className="grid gap-1 text-sm">
                  <span className="text-neutral-400">
                    BPM originale (opzionale)
                  </span>
                  <div className="flex gap-2">
                    <input
                      inputMode="decimal"
                      placeholder="es. 126.0"
                      className="flex-1 px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 outline-none focus:ring-2 focus:ring-neutral-600"
                      value={originalBpm}
                      onChange={(e) => setOriginalBpm(e.target.value)}
                    />
                    <button
                      className="px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700"
                      onClick={handleTap}
                      title="Tap (T)"
                    >
                      TAP
                    </button>
                    <button
                      className="px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 disabled:opacity-40"
                      onClick={useTapAsBpm}
                      disabled={tapBpm === '—'}
                    >
                      Usa BPM
                    </button>
                    <button
                      className="px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700"
                      onClick={resetTap}
                    >
                      Reset
                    </button>
                  </div>
                </label>
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-lg border border-neutral-700 bg-neutral-800/60 p-3">
                    <div className="text-xs text-neutral-400">
                      BPM attuale
                    </div>
                    <div className="text-2xl font-semibold tabular-nums">
                      {computedBpm}
                    </div>
                  </div>
                  <div className="rounded-lg border border-neutral-700 bg-neutral-800/60 p-3">
                    <div className="text-xs text-neutral-400">
                      BPM (Tap)
                    </div>
                    <div className="text-2xl font-semibold tabular-nums">
                      {tapBpm}
                    </div>
                  </div>
                  <div className="rounded-lg border border-neutral-700 bg-neutral-800/60 p-3">
                    <div className="text-xs text-neutral-400">
                      Base RPM
                    </div>
                    <div className="text-sm font-medium">
                      Orig: {rpmOrigin} • Play: {rpmPlay}
                    </div>
                  </div>
                </div>
                <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3 text-xs text-neutral-400">
                  <ul className="list-disc pl-4 space-y-1">
                    <li>
                      Imposta l'RPM di <strong>origine</strong> del disco e
                      l'RPM di <strong>riproduzione</strong> del piatto.
                    </li>
                    <li>
                      TAP tempo (o tasto <kbd>T</kbd>) per stimare il BPM e
                      usarlo come BPM originale.
                    </li>
                    <li>
                      Pitch ±8% lavora sopra il rapporto RPM
                      (Origine→Riproduzione).
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-neutral-800 text-xs text-neutral-500 flex flex-wrap items-center gap-3">
          <span>© {new Date().getFullYear()} PitchLab</span>
          <span className="opacity-60">•</span>
          <span>
            MK2 prototype · WebAudio playbackRate · Paolo Olivieri · Cristo
            Morto
          </span>
        </div>
      </div>
    </div>
  );
}
