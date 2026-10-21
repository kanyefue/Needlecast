"""Unit tests for the music DSP used by the capture agent.

Run with: python -m unittest discover -s tests -p "test_audio_processing.py"
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

AGENT_DIR = Path(__file__).resolve().parents[1] / "capture-agent"
sys.path.insert(0, str(AGENT_DIR))

from audio_processing import AudioProcessor, LIMITER_CEILING  # noqa: E402


class AudioProcessorTests(unittest.TestCase):
    def make_sine(self, frequency: float, seconds: float = 1.0, amplitude: float = 0.2) -> np.ndarray:
        time = np.arange(int(48_000 * seconds), dtype=np.float64) / 48_000
        tone = amplitude * np.sin(2 * np.pi * frequency * time)
        return np.column_stack((tone, tone))

    @staticmethod
    def measured_rms(samples: np.ndarray) -> float:
        # Skip filter startup transient, retaining the steady-state portion.
        stable = samples[int(0.2 * 48_000):]
        return float(np.sqrt(np.mean(np.square(stable))))

    def test_flat_equalizer_preserves_midrange_amplitude(self):
        signal = self.make_sine(1_000)
        processor = AudioProcessor({"rumbleFilter": False, "limiterEnabled": False})
        output = processor.process(signal, 0.0)
        ratio = self.measured_rms(output) / self.measured_rms(signal)
        self.assertAlmostEqual(ratio, 1.0, delta=0.015)

    def test_bass_shelf_boosts_low_frequencies(self):
        signal = self.make_sine(60)
        flat = AudioProcessor({"rumbleFilter": False, "limiterEnabled": False}).process(signal, 0.0)
        boosted = AudioProcessor({"bassDb": 4, "rumbleFilter": False, "limiterEnabled": False}).process(signal, 0.0)
        self.assertGreater(self.measured_rms(boosted) / self.measured_rms(flat), 1.25)

    def test_treble_shelf_boosts_high_frequencies(self):
        signal = self.make_sine(12_000)
        flat = AudioProcessor({"rumbleFilter": False, "limiterEnabled": False}).process(signal, 0.0)
        boosted = AudioProcessor({"trebleDb": 4, "rumbleFilter": False, "limiterEnabled": False}).process(signal, 0.0)
        self.assertGreater(self.measured_rms(boosted) / self.measured_rms(flat), 1.25)

    def test_rumble_filter_attenuates_subsonic_signal(self):
        signal = self.make_sine(10)
        flat = AudioProcessor({"rumbleFilter": False, "limiterEnabled": False}).process(signal, 0.0)
        filtered = AudioProcessor({"rumbleFilter": True, "limiterEnabled": False}).process(signal, 0.0)
        self.assertLess(self.measured_rms(filtered) / self.measured_rms(flat), 0.4)

    def test_peak_protection_caps_output_below_zero_dbfs(self):
        signal = self.make_sine(1_000, amplitude=1.8)
        processor = AudioProcessor({"rumbleFilter": False, "limiterEnabled": True})
        output = processor.process(signal, 6.0)
        self.assertLessEqual(float(np.max(np.abs(output))), LIMITER_CEILING + 1e-6)
        self.assertGreater(processor.limiter_reduction_db, 0.0)

    def test_output_is_stereo_float32_safe_for_pcm_conversion(self):
        signal = self.make_sine(440)
        output = AudioProcessor().process(signal, -12.0)
        self.assertEqual(output.shape, signal.shape)
        self.assertEqual(output.dtype, np.float32)
        self.assertTrue(np.all(np.isfinite(output)))
        self.assertLessEqual(float(np.max(np.abs(output))), 1.0)

    def test_50hz_hum_filter_attenuates_mains_tone(self):
        signal = self.make_sine(50, seconds=3.0)
        filtered = AudioProcessor({"rumbleFilter": False, "humFilterHz": 50, "limiterEnabled": False}).process(signal, 0.0)
        # A narrow high-Q notch takes several cycles to settle; measure after one second.
        start = 48_000
        ratio = self.measured_rms(filtered[start:]) / self.measured_rms(signal[start:])
        self.assertLess(ratio, 0.01)

    def test_50hz_hum_filter_also_attenuates_100hz_harmonic(self):
        signal = self.make_sine(100, seconds=3.0)
        filtered = AudioProcessor({"rumbleFilter": False, "humFilterHz": 50, "limiterEnabled": False}).process(signal, 0.0)
        start = 48_000
        ratio = self.measured_rms(filtered[start:]) / self.measured_rms(signal[start:])
        self.assertLess(ratio, 0.01)

    def test_hum_filter_can_be_disabled(self):
        signal = self.make_sine(50)
        flat = AudioProcessor({"rumbleFilter": False, "humFilterHz": 0, "limiterEnabled": False}).process(signal, 0.0)
        ratio = self.measured_rms(flat) / self.measured_rms(signal)
        self.assertAlmostEqual(ratio, 1.0, delta=0.015)

    def test_hum_filter_leaves_midrange_nearly_unchanged(self):
        signal = self.make_sine(440, seconds=2.0)
        filtered = AudioProcessor({"rumbleFilter": False, "humFilterHz": 50, "limiterEnabled": False}).process(signal, 0.0)
        start = 48_000
        ratio = self.measured_rms(filtered[start:]) / self.measured_rms(signal[start:])
        self.assertAlmostEqual(ratio, 1.0, delta=0.01)


if __name__ == "__main__":
    unittest.main()
