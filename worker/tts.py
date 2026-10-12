import os
import re
import shutil
import subprocess
import platform
import unicodedata
from pathlib import Path
from typing import Optional

import pyaudio

VOICES_DIR = Path(__file__).resolve().parent / "voices"

# Default Piper voice per language, used when PIPER_VOICE is not set.
# Full list: https://huggingface.co/rhasspy/piper-voices
DEFAULT_VOICES = {
    "en": "en_US-lessac-medium",
    "it": "it_IT-paola-medium",
    "es": "es_ES-davefx-medium",
    "fr": "fr_FR-siwis-medium",
    "de": "de_DE-thorsten-medium",
}


def clean_for_speech(text: str) -> str:
    """Strip markdown, links and emoji that a TTS engine would read out loud."""
    text = re.sub(r"```.*?```", " ", text, flags=re.DOTALL)
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"^\s*(#{1,6}|[-*+]|>)\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"[*_`~#|]", "", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) not in ("So", "Sk", "Cs"))
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    return " ".join(text.split())


class Speaker:
    """Speaks assistant replies with a local TTS engine.

    Engines: "piper" (neural, default), "system" (`say` / `espeak-ng`), "none".
    """

    def __init__(
        self,
        audio: pyaudio.PyAudio,
        engine: Optional[str] = None,
        voice: Optional[str] = None,
        language: Optional[str] = None,
        output_device_id: Optional[int] = None,
        speed: Optional[float] = None,
    ):
        self.audio = audio
        self.engine = (engine or os.getenv("TTS_ENGINE", "piper")).lower()
        self.voice_name = voice or os.getenv("PIPER_VOICE") or DEFAULT_VOICES.get(language or "en", DEFAULT_VOICES["en"])
        self.output_device_id = output_device_id
        self.speed = speed if speed is not None else float(os.getenv("TTS_SPEED", 1.0))
        self.voice = None
        self.syn_config = None

        if self.engine == "piper":
            try:
                self._load_piper()
            except Exception as e:
                print(f"[WARN] Piper TTS unavailable ({e}); falling back to the system voice")
                self.engine = "system"

        print(f"[INFO] TTS engine: {self.engine}" + (f" ({self.voice_name})" if self.engine == "piper" else ""))

    def _load_piper(self) -> None:
        from piper import PiperVoice, SynthesisConfig

        # PIPER_VOICE can be a voice name (downloaded on first use) or a path to an .onnx file
        model_path = Path(self.voice_name)
        if model_path.suffix != ".onnx":
            model_path = VOICES_DIR / f"{self.voice_name}.onnx"
            if not model_path.exists():
                from piper.download_voices import download_voice

                print(f"[INFO] Downloading Piper voice '{self.voice_name}'...")
                VOICES_DIR.mkdir(parents=True, exist_ok=True)
                download_voice(self.voice_name, VOICES_DIR)

        print(f"[INFO] Loading Piper voice ({model_path.name})...")
        self.voice = PiperVoice.load(str(model_path))
        # length_scale > 1 is slower, so invert the user-facing speed
        self.syn_config = SynthesisConfig(length_scale=1.0 / max(self.speed, 0.1))

    def speak(self, text: str) -> None:
        """Speak text, blocking until playback is finished."""
        text = clean_for_speech(text)
        if not text:
            return

        try:
            if self.engine == "piper":
                self._speak_piper(text)
            elif self.engine == "system":
                self._speak_system(text)
        except Exception as e:
            print(f"[ERROR] Error speaking text: {e}")

    def _speak_piper(self, text: str) -> None:
        if self.voice is None:
            return

        stream = None
        try:
            # Piper yields one chunk per sentence, so playback starts before
            # the whole reply has been synthesized.
            for chunk in self.voice.synthesize(text, syn_config=self.syn_config):
                if stream is None:
                    stream = self.audio.open(
                        format=self.audio.get_format_from_width(chunk.sample_width),
                        channels=chunk.sample_channels,
                        rate=chunk.sample_rate,
                        output=True,
                        output_device_index=self.output_device_id,
                    )
                stream.write(chunk.audio_int16_bytes)
        finally:
            if stream is not None:
                stream.stop_stream()
                stream.close()

    def _speak_system(self, text: str) -> None:
        if platform.system() == "Darwin":
            subprocess.run(["say"], input=text, text=True, check=False)
            return

        espeak = shutil.which("espeak-ng") or shutil.which("espeak")
        if espeak:
            subprocess.run([espeak, "--stdin"], input=text, text=True, check=False)
            return

        print("[WARN] No system TTS command found (install espeak-ng or use TTS_ENGINE=piper)")
