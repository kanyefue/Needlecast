"""Low-latency music-oriented processing for Needlecast's live audio input."""
from __future__ import annotations

import math
from typing import Any

import numpy as np
from scipy.signal import butter, iirnotch, sosfilt, tf2sos

SAMPLE_RATE = 48_000
LIMITER_CEILING = 10.0 ** (-1.0 / 20.0)  # -1 dBFS headroom before Opus encoding.
LIMITER_RELEASE_SECONDS = 0.100

DEFAULT_PROCESSING: dict[str, Any] = {
    "bassDb": 0.0,
    "midDb": 0.0,
    "trebleDb": 0.0,
    "rumbleFilter": True,
    "humFilterHz": 50,  # 50 Hz mains hum is typical in Europe.
    "limiterEnabled": True,
}


def _biquad_sos(b0: float, b1: float, b2: float, a0: float, a1: float, a2: float) -> np.ndarray:
    """Return one normalized second-order section in SciPy SOS format."""
    return np.asarray(
        [[b0 / a0, b1 / a0, b2 / a0, 1.0, a1 / a0, a2 / a0]],
        dtype=np.float64,
    )


def _shelf_sos(frequency: float, gain_db: float, kind: str) -> np.ndarray:
    """RBJ cookbook low/high shelf filter, slope S=1."""
    amplitude = 10.0 ** (gain_db / 40.0)
    omega = 2.0 * math.pi * frequency / SAMPLE_RATE
    cosine = math.cos(omega)
    sine = math.sin(omega)
    alpha = sine / math.sqrt(2.0)
    root_amplitude = math.sqrt(amplitude)

    if kind == "low":
        b0 = amplitude * ((amplitude + 1.0) - (amplitude - 1.0) * cosine + 2.0 * root_amplitude * alpha)
        b1 = 2.0 * amplitude * ((amplitude - 1.0) - (amplitude + 1.0) * cosine)
        b2 = amplitude * ((amplitude + 1.0) - (amplitude - 1.0) * cosine - 2.0 * root_amplitude * alpha)
        a0 = (amplitude + 1.0) + (amplitude - 1.0) * cosine + 2.0 * root_amplitude * alpha
        a1 = -2.0 * ((amplitude - 1.0) + (amplitude + 1.0) * cosine)
        a2 = (amplitude + 1.0) + (amplitude - 1.0) * cosine - 2.0 * root_amplitude * alpha
    elif kind == "high":
        b0 = amplitude * ((amplitude + 1.0) + (amplitude - 1.0) * cosine + 2.0 * root_amplitude * alpha)
        b1 = -2.0 * amplitude * ((amplitude - 1.0) + (amplitude + 1.0) * cosine)
        b2 = amplitude * ((amplitude + 1.0) + (amplitude - 1.0) * cosine - 2.0 * root_amplitude * alpha)
        a0 = (amplitude + 1.0) - (amplitude - 1.0) * cosine + 2.0 * root_amplitude * alpha
        a1 = 2.0 * ((amplitude - 1.0) - (amplitude + 1.0) * cosine)
        a2 = (amplitude + 1.0) - (amplitude - 1.0) * cosine - 2.0 * root_amplitude * alpha
    else:
        raise ValueError(f"Unsupported shelf filter type: {kind}")
    return _biquad_sos(b0, b1, b2, a0, a1, a2)


def _peaking_sos(frequency: float, gain_db: float, q: float = 0.85) -> np.ndarray:
    """RBJ peaking EQ section."""
    amplitude = 10.0 ** (gain_db / 40.0)
    omega = 2.0 * math.pi * frequency / SAMPLE_RATE
    cosine = math.cos(omega)
    alpha = math.sin(omega) / (2.0 * q)
    b0 = 1.0 + alpha * amplitude
    b1 = -2.0 * cosine
    b2 = 1.0 - alpha * amplitude
    a0 = 1.0 + alpha / amplitude
    a1 = -2.0 * cosine
    a2 = 1.0 - alpha / amplitude
    return _biquad_sos(b0, b1, b2, a0, a1, a2)


class AudioProcessor:
    """Stateful stereo EQ + rumble/mains-hum filtering + peak protection.

    Narrow mains-frequency notches can reduce tonal hum (50 Hz in Europe or
    60 Hz in some regions) and its first four harmonics. They do not remove
    broadband hiss or fix a hardware ground loop. There is deliberately no
    gate or voice-style denoiser, because the source is music.
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        settings = {**DEFAULT_PROCESSING, **(config or {})}
        self.config = {
            "bassDb": float(np.clip(settings["bassDb"], -6.0, 6.0)),
            "midDb": float(np.clip(settings["midDb"], -6.0, 6.0)),
            "trebleDb": float(np.clip(settings["trebleDb"], -6.0, 6.0)),
            "rumbleFilter": bool(settings["rumbleFilter"]),
            "humFilterHz": int(settings.get("humFilterHz", 50)) if int(settings.get("humFilterHz", 50)) in (0, 50, 60) else 50,
            "limiterEnabled": bool(settings["limiterEnabled"]),
        }
        sections: list[np.ndarray] = []
        if self.config["rumbleFilter"]:
            sections.extend(butter(2, 30.0, btype="highpass", fs=SAMPLE_RATE, output="sos"))
        # Narrow notches remove mains hum and its low harmonics while changing
        # nearby musical content as little as a fixed-frequency filter allows.
        # They cannot distinguish hum from a musical tone at the exact same frequency.
        hum_base = self.config["humFilterHz"]
        if hum_base in (50, 60):
            for harmonic in range(1, 6):
                frequency = float(hum_base * harmonic)
                if frequency < SAMPLE_RATE / 2:
                    numerator, denominator = iirnotch(frequency, Q=35.0, fs=SAMPLE_RATE)
                    sections.extend(tf2sos(numerator, denominator))
        if self.config["bassDb"] != 0:
            sections.extend(_shelf_sos(120.0, self.config["bassDb"], "low"))
        if self.config["midDb"] != 0:
            sections.extend(_peaking_sos(1_000.0, self.config["midDb"], q=0.85))
        if self.config["trebleDb"] != 0:
            sections.extend(_shelf_sos(8_000.0, self.config["trebleDb"], "high"))
        self.sos = np.asarray(sections, dtype=np.float64) if sections else np.empty((0, 6), dtype=np.float64)
        self.zi = np.zeros((len(self.sos), 2, 2), dtype=np.float64)
        self.limiter_gain = 1.0
        self.limiter_reduction_db = 0.0

    def process(self, samples: np.ndarray, gain_db: float) -> np.ndarray:
        audio = np.asarray(samples, dtype=np.float64)
        gain = 10.0 ** (float(gain_db) / 20.0)
        audio = audio * gain

        if len(self.sos):
            audio, self.zi = sosfilt(self.sos, audio, axis=0, zi=self.zi)

        if self.config["limiterEnabled"] and audio.size:
            peak = float(np.max(np.abs(audio)))
            target_gain = min(1.0, LIMITER_CEILING / peak) if peak > 0.0 else 1.0
            if target_gain < self.limiter_gain:
                # Immediate attack prevents a peak from clipping the PCM/Opus path.
                self.limiter_gain = target_gain
            else:
                block_seconds = audio.shape[0] / SAMPLE_RATE
                release = math.exp(-block_seconds / LIMITER_RELEASE_SECONDS)
                self.limiter_gain = 1.0 - (1.0 - self.limiter_gain) * release
            audio = audio * self.limiter_gain
            self.limiter_reduction_db = max(0.0, -20.0 * math.log10(max(self.limiter_gain, 1e-12)))
        else:
            self.limiter_gain = 1.0
            self.limiter_reduction_db = 0.0

        # Int16 PCM must not wrap. The limiter normally keeps this below ±1.
        return np.clip(audio, -1.0, 0.9999695).astype(np.float32, copy=False)
