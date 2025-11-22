import { useMemo, useState, useRef, useEffect } from 'react';
import './App.css';

/* ---------------- WAV ENCODER HELPERS ---------------- */

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

  // RIFF
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  // fmt
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  // data
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

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

/* ---------------- LOCAL DECK COMPONENT ---------------- */

export default function PitchFaderMK2UI() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [pitch, setPitch] = useState(0); // -8 .. +8
  const [rpmOrigin, setRpmOrigin] = useState<33 | 45>(33);
  const [rpmPlay, setRpmPlay] = useState<33 | 45>(33);
  const [playing, setPlaying] = useState(false);
  const [originalBpm, setOriginalBpm] = useState<string>('');
  const [loaded, setLoaded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const ctxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);

  // pause/resume timeline
  const pausedAtRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);
  const rateRef = useRef(1);

  // TAP tempo
  const [_tapTimes, setTapTimes] = useState<number[]>([]);
  const [tapBpm, setTapBpm] = useState<string>('—');

  const detent = Math.abs(pitch) < 0.05;

  const displayPitch = useMemo(() => pitch.toFixed(2), [pitch]);

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
    return (orig * effectiveRate).toFixed(2);
  }, [originalBpm, effectiveRate]);

  // ---------- slider track ----------
  const minPitch = -8;
  const maxPitch = 8;

  function toTrackPos(value: number): number {
    const pct = ((value - minPitch) / (maxPitch - minPitch)) * 100;
    return 100 - pct; // flip verticale
  }

  const zeroPos = toTrackPos(0);
  const currentPos = toTrackPos(pitch);

  let sliderTrack = `linear-gradient(to top,
    #e5e5e5 0%,
    #e5e5e5 100%
  )`;

  if (pitch >= 0) {
    sliderTrack = `linear-gradient(to top,
      #e5e5e5 0%,
      #e5e5e5 ${currentPos}%,
      #059669 ${currentPos}%,
      #059669 ${zeroPos}%,
      #e5e5e5 ${zeroPos}%,
      #e5e5e5 100%
    )`;
  } else {
    sliderTrack = `linear-gradient(to top,
      #e5e5e5 0%,
      #e5e5e5 ${zeroPos}%,
      #059669 ${zeroPos}%,
      #059669 ${currentPos}%,
      #e5e5e5 ${currentPos}%,
      #e5e5e5 100%
    )`;
  }

  // ---------- audio engine ----------

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

    const offset = Math.max(
      0,
      Math.min(pausedAtRef.current, buffer.duration - 0.001)
    );
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

  // EXPORT pitched WAV
  const exportPitchedWav = async () => {
    const buffer = bufferRef.current;
    if (!buffer) {
      alert('Load a WAV file before exporting.');
      return;
    }

    const rate = effectiveRate;
    if (rate <= 0) {
      alert('Invalid playback rate.');
      return;
    }

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

  /* ---------------- UI ---------------- */

  return (
    <div className="min-h-screen w-full bg-neutral-950 text-neutral-100 p-4 sm:p-8">
      <div className="mx-auto max-w-[1600px] rounded-2xl bg-gradient-to-b from-neutral-900 to-neutral-950 shadow-2xl ring-1 ring-neutral-800 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800">
          <div className="flex items-center gap-3">
            <div className="h-3 w-3 rounded-full bg-green-400 shadow-[0_0_12px_2px_rgba(74,222,128,0.7)]" />
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
              PitchLab MK2
            </h1>
            <span className="text-xs px-2 py-0.5 rounded bg-neutral-800/70 border border-neutral-700">
              Local Deck
            </span>
          </div>
          <div className="text-xs text-neutral-400">
            File: {fileName ?? 'no file loaded'}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1.25fr_0.95fr] gap-8 p-6">
          {/* LEFT COLUMN */}
          <div className="flex flex-col gap-4">
           {/* Dropzone con glow */}
<label
  htmlFor="file"
  className={`group relative grid place-items-center h-56 sm:h-64 rounded-xl cursor-pointer overflow-hidden border transition-all duration-300 ease-out ${
    isDragging
      ? 'border-emerald-400 bg-neutral-900 shadow-[0_0_40px_rgba(16,185,129,0.9)]'
      : loaded
      ? 'border-emerald-500/70 bg-neutral-900/70 shadow-[0_0_26px_rgba(16,185,129,0.55)]'
      : 'border-neutral-800 bg-neutral-900/60 hover:bg-neutral-900 hover:border-neutral-500'
  }`}
  onDragEnter={(e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }}
  onDragOver={(e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }}
  onDragLeave={(e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }}
  onDrop={(e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      void handleFile(file);
    }
  }}
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

  {/* overlay “scanline” */}
  <div
    className={`absolute inset-0 pointer-events-none transition-opacity duration-300 ${
      isDragging ? 'opacity-80' : 'opacity-30'
    } [mask-image:linear-gradient(to_right,transparent,black,transparent)]`}
  >
    <div className="h-full w-[200%] bg-[repeating-linear-gradient(90deg,theme(colors.neutral.700)_0px,theme(colors.neutral.700)_1px,transparent_1px,transparent_4px)] translate-x-[-25%]" />
  </div>

  {/* contenuto centrale */}
  <div className="relative z-10 flex flex-col items-center gap-2 text-center">
    {/* icona + glow */}
    <div className="relative">
      <div
        className={`absolute inset-0 rounded-full ${
          isDragging ? 'animate-ping bg-emerald-400/40' : 'hidden'
        }`}
      />
      <div className="grid h-12 w-12 place-items-center rounded-full border border-neutral-700 bg-neutral-900/80">
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={isDragging ? 'text-emerald-300' : 'text-neutral-200'}
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </div>
    </div>

    <p
      className={`text-sm ${
        isDragging ? 'text-emerald-300' : 'text-neutral-300'
      }`}
    >
      {isDragging ? 'Drop it on the deck' : 'Drag a WAV file here or click to select'}
    </p>

    <p className="text-xs text-neutral-500">
      {loaded
        ? 'File loaded ✓ — pitch ready'
        : 'Audio engine ready — load a WAV'}
    </p>
  </div>
</label>

            {/* Transport + RPM + Export */}
            <div className="flex items-center justify-between gap-3 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 relative z-10">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <button
                    className="px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-xs active:scale-95"
                    onClick={() => setPitch((p) => Math.max(-8, p - 0.1))}
                  >
                    Nudge −
                  </button>
                  <button
                    className="px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-xs active:scale-95"
                    onClick={() => setPitch((p) => Math.min(8, p + 0.1))}
                  >
                    Nudge +
                  </button>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-neutral-400">Origin</span>
                  <button
                    className={`px-2.5 py-1.5 rounded-lg border text-xs ${
                      rpmOrigin === 33
                        ? 'bg-green-500/10 border-green-500/50 text-green-300'
                        : 'bg-neutral-800 border-neutral-700'
                    }`}
                    onClick={() => setRpmOrigin(33)}
                  >
                    33
                  </button>
                  <button
                    className={`px-2.5 py-1.5 rounded-lg border text-xs ${
                      rpmOrigin === 45
                        ? 'bg-green-500/10 border-green-500/50 text-green-300'
                        : 'bg-neutral-800 border-neutral-700'
                    }`}
                    onClick={() => setRpmOrigin(45)}
                  >
                    45
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-xs text-neutral-400">Playback</span>
                  <button
                    className={`px-2.5 py-1.5 rounded-lg border text-xs ${
                      rpmPlay === 33
                        ? 'bg-green-500/10 border-green-500/50 text-green-300'
                        : 'bg-neutral-800 border-neutral-700'
                    }`}
                    onClick={() => setRpmPlay(33)}
                  >
                    33
                  </button>
                  <button
                    className={`px-2.5 py-1.5 rounded-lg border text-xs ${
                      rpmPlay === 45
                        ? 'bg-green-500/10 border-green-500/50 text-green-300'
                        : 'bg-neutral-800 border-neutral-700'
                    }`}
                    onClick={() => setRpmPlay(45)}
                  >
                    45
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    className="h-11 w-11 rounded-full border border-neutral-700 grid place-items-center active:scale-95 transition bg-neutral-800"
                    onClick={togglePause}
                    disabled={!loaded}
                    title="Play / Pause"
                  >
                    {playing ? '⏸' : '▶'}
                  </button>
                  <button
                    className="px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-xs active:scale-95 disabled:opacity-40"
                    onClick={exportPitchedWav}
                    disabled={!loaded}
                  >
                    Export pitched WAV
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN */}
          <div className="grid grid-cols-1 md:grid-cols-[1.1fr_1.1fr] gap-6">
            {/* Pitch panel */}
            <div className="relative rounded-xl border border-neutral-800 bg-neutral-900/60 px-4 pt-4 pb-8">
              <h2 className="text-sm font-medium text-neutral-300 mb-2">
                Pitch
              </h2>

              <div className="flex h-full flex-col">
                {/* parte alta: scala + slider + numerico */}
                <div className="flex items-center gap-4 flex-1">
                  {/* scale */}
                  <div className="relative h-72 w-10 hidden sm:block">
                    <div className="absolute inset-0 mx-auto w-px bg-gradient-to-b from-transparent via-neutral-700 to-transparent" />
                    {Array.from({ length: 17 }).map((_, i) => {
                      const y = (i / 16) * 100;
                      const val = -8 + i;
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
                            <div className="mt-1 text-center text-[10px] text-neutral-400">
                              {val}%
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* zero marker */}
                    <div className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-neutral-700 bg-neutral-800" />
                  </div>

                  {/* slider */}
                  <div className="flex flex-col items-center">
                    <input
                      type="range"
                      min={-8}
                      max={8}
                      step={0.1}
                      value={pitch}
                      onChange={(e) => setPitch(parseFloat(e.target.value))}
                      className="h-72 w-2 bg-transparent"
                      style={{
                        WebkitAppearance: 'none',
                        writingMode: 'vertical-lr',
                        backgroundImage: sliderTrack,
                        backgroundRepeat: 'no-repeat',
                        backgroundSize: '100% 100%',
                        borderRadius: '999px',
                      }}
                    />
                  </div>

                  {/* numerico */}
                  <div className="ml-auto grid gap-2 text-right">
                    <div className="text-sm text-neutral-400">Pitch</div>
                    <div className="text-4xl font-bold tracking-tight tabular-nums">
                      {pitch >= 0 ? '+' : ''}
                      {displayPitch}%
                    </div>
                    <div className="text-xs text-neutral-500">
                      Range ±8% • Rate {effectiveRate.toFixed(4)}x
                    </div>
                  </div>
                </div>

                {/* parte bassa: reset + quartz, allineati a destra */}
                <div className="mt-4 flex items-center justify-end gap-3">
                  <button
                    className="px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-xs active:scale-95"
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
            </div>

            {/* Track info / BPM panel */}
            <div className="relative rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
              <h2 className="text-sm font-medium text-neutral-300 mb-3">
                Track info & BPM
              </h2>
              <div className="grid gap-3">
                <label className="grid gap-1 text-sm">
                  <span className="text-neutral-400">
                    Original BPM (optional)
                  </span>
                  <div className="flex gap-2">
                    <input
                      inputMode="decimal"
                      placeholder="e.g. 126.0"
                      className="flex-1 px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 outline-none focus:ring-2 focus:ring-neutral-600"
                      value={originalBpm}
                      onChange={(e) => setOriginalBpm(e.target.value)}
                    />
                    <button
                      className="px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-xs"
                      onClick={handleTap}
                      title="Tap tempo (key: T)"
                    >
                      TAP
                    </button>
                    <button
                      className="px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-xs disabled:opacity-40"
                      onClick={useTapAsBpm}
                      disabled={tapBpm === '—'}
                    >
                      Use BPM
                    </button>
                    <button
                      className="px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-xs"
                      onClick={resetTap}
                    >
                      Reset TAP
                    </button>
                  </div>
                </label>

                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-lg border border-neutral-700 bg-neutral-800/60 p-3">
                    <div className="text-xs text-neutral-400">Current BPM</div>
                    <div className="text-2xl font-semibold tabular-nums">
                      {computedBpm}
                    </div>
                  </div>
                  <div className="rounded-lg border border-neutral-700 bg-neutral-800/60 p-3">
                    <div className="text-xs text-neutral-400">BPM (Tap)</div>
                    <div className="text-2xl font-semibold tabular-nums">
                      {tapBpm}
                    </div>
                  </div>
                  <div className="rounded-lg border border-neutral-700 bg-neutral-800/60 p-3">
                    <div className="text-xs text-neutral-400">Base RPM</div>
                    <div className="text-sm font-medium">
                      Origin: {rpmOrigin} • Playback: {rpmPlay}
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3 text-xs text-neutral-400">
                  <ul className="list-disc pl-4 space-y-1">
                    <li>
                      Set <strong>Origin</strong> RPM (record) and{' '}
                      <strong>Playback</strong> RPM (deck).
                    </li>
                    <li>
                      Use TAP (or <kbd>T</kbd>) to estimate BPM and set it as
                      original BPM.
                    </li>
                    <li>
                      Pitch ±8% works on top of the RPM ratio (Origin → Playback),
                      just like a real turntable.
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-neutral-800 text-xs text-neutral-500 flex flex-wrap items-center gap-3">
          <span>© {new Date().getFullYear()} PitchLab MK2</span>
          <span className="opacity-60">•</span>
          <span>Local Deck</span>
          <span className="opacity-60">•</span>
          <span>Paolo Olivieri</span>
        </div>
      </div>
    </div>
  );
}