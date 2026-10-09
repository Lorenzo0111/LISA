import json
import os
import sys
import re
import time
import queue
import threading
import unicodedata
import wave
from difflib import SequenceMatcher
from pathlib import Path
import requests
import numpy as np
from collections import deque
from typing import List, Optional
from dotenv import load_dotenv

# Audio processing
import pyaudio

# Speech Recognition
from faster_whisper import WhisperModel
from faster_whisper.vad import get_vad_model

from tts import Speaker

# Configuration
load_dotenv()

# Whisper and Silero VAD both work on 16 kHz mono audio
SAMPLE_RATE = 16000
# Silero VAD consumes fixed 32 ms frames, carrying 64 samples of context between them
VAD_FRAME_SAMPLES = 512
VAD_CONTEXT_SAMPLES = 64

DEBUG_DIR = Path(__file__).resolve().parent / "debug"


class StreamingVAD:
    """Frame-by-frame Silero VAD on ONNX Runtime (no PyTorch required)."""

    def __init__(self):
        # Reuse the Silero model that ships with faster-whisper
        self.session = get_vad_model().session
        self.reset()

    def reset(self) -> None:
        self.h = np.zeros((1, 1, 128), dtype=np.float32)
        self.c = np.zeros((1, 1, 128), dtype=np.float32)
        self.context = np.zeros((1, VAD_CONTEXT_SAMPLES), dtype=np.float32)

    def __call__(self, frame: np.ndarray) -> float:
        """Return the speech probability of a single 512-sample frame."""
        x = np.concatenate([self.context, frame.reshape(1, -1)], axis=1)
        probs, self.h, self.c = self.session.run(None, {"input": x, "h": self.h, "c": self.c})
        self.context = x[:, -VAD_CONTEXT_SAMPLES:]
        return float(probs[0])


class Microphone:
    """Reads the microphone on a background thread and exposes 16 kHz VAD-sized frames.

    Capturing on its own thread means no audio is lost while Whisper is busy,
    which matters on slow boards where a transcription can take a second or two.
    """

    def __init__(self, audio: pyaudio.PyAudio, device_id: Optional[int] = None, max_queue_seconds: float = 30.0):
        self.audio = audio
        # Use PCM int16 for input because some macOS/PortAudio builds crash when
        # reading float32 microphone streams, even though the rest of the pipeline
        # expects float32 values internally.
        self.FORMAT = pyaudio.paInt16
        self.CHANNELS = 1
        self.device_id = self._validate_input_device(device_id)
        self.input_rate = self._resolve_input_sample_rate()
        self.resampler = None
        if self.input_rate != SAMPLE_RATE:
            import soxr

            self.resampler = soxr.ResampleStream(self.input_rate, SAMPLE_RATE, 1, dtype="float32")
            print(f"[INFO] Microphone runs at {self.input_rate} Hz; resampling to {SAMPLE_RATE} Hz")

        # Read ~32 ms at a time so each read yields about one VAD frame
        self.chunk_size = int(VAD_FRAME_SAMPLES * self.input_rate / SAMPLE_RATE)
        self.frames: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=int(max_queue_seconds * SAMPLE_RATE / VAD_FRAME_SAMPLES))
        self.muted = False
        self.stream = None
        self.thread: Optional[threading.Thread] = None
        self.running = False

    def _validate_input_device(self, device_id: Optional[int]) -> Optional[int]:
        """Fall back to the default mic when the configured device is missing.

        PyAudio segfaults instead of raising when asked to open a device index
        that does not exist, and macOS indices shift as devices come and go.
        """
        if device_id is None:
            return None

        if 0 <= device_id < self.audio.get_device_count():
            info = self.audio.get_device_info_by_index(device_id)
            if int(info.get("maxInputChannels", 0) or 0) > 0:
                return device_id
            reason = f"'{info.get('name')}' has no input channels"
        else:
            reason = "no such device"

        print(f"[WARN] Audio device {device_id} is not usable ({reason}); using the default input device")
        print("[WARN] Run with --list-devices and update AUDIO_DEVICE_ID")
        return None

    def _resolve_input_sample_rate(self) -> int:
        """Capture at 16 kHz when the mic supports it, otherwise at its native rate.

        Many USB microphones on Linux/ALSA only offer 44.1 or 48 kHz.
        """
        try:
            if self.device_id is None:
                info = self.audio.get_default_input_device_info()
            else:
                info = self.audio.get_device_info_by_index(self.device_id)
        except Exception:
            return SAMPLE_RATE

        try:
            self.audio.is_format_supported(
                SAMPLE_RATE,
                input_device=int(info["index"]),
                input_channels=self.CHANNELS,
                input_format=self.FORMAT,
            )
            return SAMPLE_RATE
        except ValueError:
            return int(float(info.get("defaultSampleRate") or SAMPLE_RATE))

    def start(self) -> None:
        self.stream = self.audio.open(
            format=self.FORMAT,
            channels=self.CHANNELS,
            rate=self.input_rate,
            input=True,
            input_device_index=self.device_id,
            frames_per_buffer=self.chunk_size,
        )
        self.running = True
        self.thread = threading.Thread(target=self._capture_loop, name="microphone", daemon=True)
        self.thread.start()

    def _capture_loop(self) -> None:
        pending = np.array([], dtype=np.float32)

        while self.running and self.stream is not None:
            try:
                data = self.stream.read(self.chunk_size, exception_on_overflow=False)
            except Exception as exc:
                if self.running:
                    print(f"[ERROR] Error reading audio: {exc}")
                    time.sleep(0.1)
                continue

            if self.muted:
                pending = np.array([], dtype=np.float32)
                continue

            samples = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
            if self.resampler is not None:
                samples = self.resampler.resample_chunk(samples)

            pending = np.concatenate([pending, samples])
            while len(pending) >= VAD_FRAME_SAMPLES:
                self._push(pending[:VAD_FRAME_SAMPLES])
                pending = pending[VAD_FRAME_SAMPLES:]

    def _push(self, frame: np.ndarray) -> None:
        try:
            self.frames.put_nowait(frame)
        except queue.Full:
            # The consumer fell far behind; drop the oldest audio
            try:
                self.frames.get_nowait()
            except queue.Empty:
                pass
            self.frames.put_nowait(frame)

    def read_frame(self, timeout: float = 0.5) -> Optional[np.ndarray]:
        try:
            return self.frames.get(timeout=timeout)
        except queue.Empty:
            return None

    def mute(self) -> None:
        """Discard microphone input, e.g. while the assistant itself is speaking."""
        self.muted = True

    def unmute(self) -> None:
        self.flush()
        self.muted = False

    def flush(self) -> None:
        while True:
            try:
                self.frames.get_nowait()
            except queue.Empty:
                return

    def stop(self) -> None:
        self.running = False
        if self.thread is not None:
            self.thread.join(timeout=1.0)
            self.thread = None

        if self.stream is not None:
            self.stream.stop_stream()
            self.stream.close()
            self.stream = None


class VoiceActivationListener:
    def __init__(
        self,
        keyword: str = "lisa",
        language: Optional[str] = None,
        api_url: Optional[str] = None,
        api_key: Optional[str] = None,
        device_id: Optional[int] = None,
        vad_threshold: float = 0.5,
        end_silence_seconds: Optional[float] = None,
        max_utterance_seconds: float = 15.0,
        follow_up_seconds: float = 6.0,
        wake_model_name: Optional[str] = None,
        transcription_model_name: Optional[str] = None,
        keyword_aliases: Optional[List[str]] = None,
        debug: bool = False,
    ):
        self.keyword = keyword.lower()
        # Aliases cover spellings Whisper tends to produce for the wake word (e.g. "liza")
        self.keywords = [k for k in (self._normalize_text(k) for k in [self.keyword, *(keyword_aliases or [])]) if k]
        self.language = language.lower() if language else None
        self.api_url = api_url or os.getenv("ASSISTANT_API_URL", "http://localhost:3000")
        self.api_key = api_key or os.getenv("ASSISTANT_API_KEY", "")
        # Name this listener registers under to receive notifications (timers, reminders)
        self.channel = os.getenv("ASSISTANT_CHANNEL", "voice")
        self.notifications: "queue.Queue[str]" = queue.Queue()
        self.vad_threshold = vad_threshold
        # Hysteresis: once speaking, require a clearly lower probability to count as silence
        self.vad_end_threshold = max(vad_threshold - 0.15, 0.05)
        if end_silence_seconds is None:
            end_silence_seconds = float(os.getenv("END_SILENCE_SECONDS", 0.8))
        self.end_silence_frames = self._seconds_to_frames(end_silence_seconds)
        self.debug = debug
        self.max_utterance_frames = self._seconds_to_frames(max_utterance_seconds)
        self.min_speech_frames = self._seconds_to_frames(0.25)
        self.follow_up_seconds = follow_up_seconds
        self.wake_model_name = wake_model_name or os.getenv("WAKE_MODEL", "tiny")
        self.transcription_model_name = transcription_model_name or os.getenv("TRANSCRIPTION_MODEL", "small")
        self.device = os.getenv("WHISPER_DEVICE", "auto")
        # int8 quantization roughly halves memory and is the fastest option on CPUs
        self.compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "default" if self.device == "cuda" else "int8")
        self.cpu_threads = int(os.getenv("WHISPER_THREADS", 0))
        self.beam_size = int(os.getenv("WHISPER_BEAM_SIZE", 5))

        self.audio = pyaudio.PyAudio()
        self.microphone = Microphone(self.audio, device_id)
        self.is_listening = False

        print(f"[INFO] Loading Whisper wake model ({self.wake_model_name}, {self.compute_type})...")
        self.wake_model = self._load_whisper(self.wake_model_name)

        if self.transcription_model_name == self.wake_model_name:
            self.whisper_model = self.wake_model
        else:
            print(f"[INFO] Loading Whisper transcription model ({self.transcription_model_name}, {self.compute_type})...")
            self.whisper_model = self._load_whisper(self.transcription_model_name)

        print("[INFO] Loading Silero VAD model...")
        self.vad = StreamingVAD()

        self.speaker = Speaker(self.audio, language=self.language)

        # Utterance segmentation state
        self.pre_roll: "deque[np.ndarray]" = deque(maxlen=self._seconds_to_frames(0.3))
        self.utterance: List[np.ndarray] = []
        self.speech_frames = 0
        self.silent_frames = 0
        self.awaiting_command_until = 0.0

        print("[INFO] Voice activation listener initialized")
        print(f"[INFO] Keyword: '{self.keyword}'")
        print(f"[INFO] Language: {self.language or 'auto'}")
        print(f"[INFO] API URL: {self.api_url}")

    def _seconds_to_frames(self, seconds: float) -> int:
        return max(1, int(seconds * SAMPLE_RATE / VAD_FRAME_SAMPLES))

    def _load_whisper(self, name: str) -> WhisperModel:
        return WhisperModel(name, device=self.device, compute_type=self.compute_type, cpu_threads=self.cpu_threads)

    def _normalize_text(self, text: str) -> str:
        """Normalize text to improve wake-phrase matching."""
        text = unicodedata.normalize("NFKD", text.lower())
        text = "".join(ch for ch in text if not unicodedata.combining(ch))
        normalized = re.sub(r"[^a-z0-9\s]", " ", text)
        return " ".join(normalized.split())

    def _contains_keyword(self, text: str) -> bool:
        """Match the wake word as whole words so 'lisa' does not fire on 'elisabetta'."""
        padded = f" {self._normalize_text(text)} "
        return any(f" {keyword} " in padded for keyword in self.keywords)

    def _maybe_keyword(self, text: str) -> bool:
        """Loose match for the wake model, which often misspells names ('liza', 'elisa').

        A loose match only earns a second opinion from the transcription model,
        which still has to hear the exact wake word.
        """
        if self._contains_keyword(text):
            return True

        words = self._normalize_text(text).split()
        for keyword in self.keywords:
            size = len(keyword.split())
            for i in range(len(words) - size + 1):
                candidate = " ".join(words[i:i + size])
                if SequenceMatcher(None, keyword, candidate).ratio() >= 0.7:
                    return True
        return False

    def _prepare_audio(self, audio: np.ndarray) -> np.ndarray:
        """Remove DC offset and bring quiet microphones up to a level Whisper handles well."""
        audio = audio - float(np.mean(audio))
        peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
        if peak > 0:
            audio = audio * min(0.9 / peak, 20.0)
        return audio.astype(np.float32)

    def _save_debug_audio(self, audio: np.ndarray) -> Path:
        DEBUG_DIR.mkdir(exist_ok=True)
        path = DEBUG_DIR / f"{time.strftime('%H%M%S')}-{int(time.time() * 1000) % 1000:03d}.wav"
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            wav.writeframes((np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16).tobytes())
        return path

    def _strip_wake_phrase(self, text: str) -> str:
        """Remove wake phrase from transcription and return only the command."""
        for keyword in self.keywords:
            # Tolerate punctuation/accents between the words of a multi-word wake phrase
            pattern = re.compile(r"\b" + r"\W+".join(re.escape(word) for word in keyword.split()) + r"\b[\s,.!?;:]*", re.IGNORECASE)
            stripped, count = pattern.subn(" ", text, count=1)
            if count:
                return " ".join(stripped.split()).strip(" ,.!?;:")

        return text.strip(" ,.!?;:")

    def _transcribe(self, model: WhisperModel, audio: np.ndarray, beam_size: int) -> str:
        """Transcribe a single VAD-trimmed utterance."""
        started = time.monotonic()
        segments, _ = model.transcribe(
            self._prepare_audio(audio),
            language=self.language,
            beam_size=beam_size,
            temperature=0.0,
            condition_on_previous_text=False,
            without_timestamps=True,
            # Bias decoding towards the wake word spelling
            hotwords=self.keyword,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
        if self.debug:
            name = self.wake_model_name if model is self.wake_model else self.transcription_model_name
            print(f"[DEBUG] {name} took {time.monotonic() - started:.2f}s for {len(audio) / SAMPLE_RATE:.1f}s of audio")
        return text

    def _feed_frame(self, frame: np.ndarray) -> Optional[np.ndarray]:
        """Feed one microphone frame to the VAD; return a full utterance when one just ended."""
        probability = self.vad(frame)

        if not self.utterance:
            if probability < self.vad_threshold:
                self.pre_roll.append(frame)
                return None

            # Speech started: keep a little audio from before the trigger so
            # the first syllable is not clipped
            self.utterance = [*self.pre_roll, frame]
            self.pre_roll.clear()
            self.speech_frames = 1
            self.silent_frames = 0
            return None

        self.utterance.append(frame)
        if probability >= self.vad_end_threshold:
            self.speech_frames += 1
            self.silent_frames = 0
        else:
            self.silent_frames += 1

        if self.silent_frames < self.end_silence_frames and len(self.utterance) < self.max_utterance_frames:
            return None

        audio = np.concatenate(self.utterance)
        enough_speech = self.speech_frames >= self.min_speech_frames
        self.utterance = []
        self.vad.reset()
        return audio if enough_speech else None

    def _handle_utterance(self, audio: np.ndarray) -> None:
        """Check a finished utterance for the wake word and dispatch the command."""
        try:
            if time.monotonic() < self.awaiting_command_until:
                # The wake word was said on its own; this utterance is the command
                self.awaiting_command_until = 0.0
                command_text = self._transcribe(self.whisper_model, audio, self.beam_size)
            else:
                # Cheap greedy pass with the small model, once per utterance
                wake_text = self._transcribe(self.wake_model, audio, beam_size=1)
                if self.debug:
                    peak = float(np.max(np.abs(audio)))
                    print(f"[DEBUG] Heard '{wake_text}' ({len(audio) / SAMPLE_RATE:.1f}s, peak {peak:.3f}) -> {self._save_debug_audio(audio).name}")

                if not self._maybe_keyword(wake_text):
                    return

                exact = self._contains_keyword(wake_text)
                if self.whisper_model is self.wake_model or (exact and not self._strip_wake_phrase(wake_text)):
                    # Nothing more to learn from the bigger model
                    text = wake_text
                else:
                    text = self._transcribe(self.whisper_model, audio, self.beam_size)
                    if self.debug:
                        print(f"[DEBUG] Transcription model heard '{text}'")

                if not exact and not self._contains_keyword(text):
                    return

                print(f"\n[WAKE WORD DETECTED] 🎤 '{text}'")

                command_text = self._strip_wake_phrase(text)
                if not command_text:
                    self.awaiting_command_until = time.monotonic() + self.follow_up_seconds
                    print("[LISTENING] Wake word heard, waiting for a command...")
                    return
        except Exception as e:
            print(f"[ERROR] Error transcribing audio: {e}")
            return

        if not command_text:
            return

        print(f"[INFO] Transcribed: {command_text}")
        started = time.monotonic()
        result = self._send_to_assistant(command_text)
        if self.debug:
            print(f"[DEBUG] Assistant API took {time.monotonic() - started:.2f}s")
        assistant_text = result.get("content") if isinstance(result, dict) else None
        if assistant_text:
            print(f"[INFO] Assistant: {assistant_text}")
            self._speak(assistant_text)

        print("\n[LISTENING] Ready for next command...\n")

    def _speak(self, text: str) -> None:
        """Speak with the microphone muted so the assistant does not hear itself."""
        self.microphone.mute()
        try:
            self.speaker.speak(text)
        finally:
            self.microphone.unmute()
            self.vad.reset()

    def _auth_headers(self) -> dict:
        return {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}

    def _notification_loop(self) -> None:
        """Keep a server-sent events stream open and queue what the assistant pushes."""
        while self.is_listening:
            try:
                with requests.get(
                    f"{self.api_url}/notifications/stream",
                    params={"channel": self.channel},
                    headers=self._auth_headers(),
                    stream=True,
                    # The server pings every 15s; a silent stream is a dead one
                    timeout=(5, 45),
                ) as response:
                    response.raise_for_status()
                    print(f"[INFO] Receiving notifications as '{self.channel}'")

                    event = None
                    for line in response.iter_lines(decode_unicode=True):
                        if not self.is_listening:
                            return
                        if not line:
                            event = None
                        elif line.startswith("event:"):
                            event = line[6:].strip()
                        elif line.startswith("data:") and event == "notification":
                            message = json.loads(line[5:]).get("message")
                            if message:
                                self.notifications.put(message)
            except (requests.exceptions.RequestException, ValueError) as e:
                if self.debug:
                    print(f"[DEBUG] Notification stream dropped: {e}")

            time.sleep(5)

    def _speak_notifications(self) -> None:
        """Speak pending notifications, unless the user is in the middle of talking."""
        if self.utterance or time.monotonic() < self.awaiting_command_until:
            return

        while True:
            try:
                message = self.notifications.get_nowait()
            except queue.Empty:
                return

            print(f"[NOTIFICATION] {message}")
            self._speak(message)

    def _send_to_assistant(self, text: str) -> dict:
        """Send transcribed text to LocalAssistant API"""
        try:
            print("[INFO] Sending to assistant API...")

            payload = {
                "content": text,
                # Lets the assistant route timer results back to this listener
                "context": {"source": self.channel},
            }

            response = requests.post(
                f"{self.api_url}/requests/create",
                json=payload,
                headers=self._auth_headers(),
                timeout=30,
            )

            response.raise_for_status()
            print("[INFO] Request sent successfully")

            return response.json()

        except requests.exceptions.RequestException as e:
            print(f"[ERROR] Error sending to API: {e}")
            return {}

    def start(self):
        """Start listening for wake word"""
        print("\n" + "="*50)
        print("Voice Activation Listener Started")
        print("="*50)
        print(f"Listening for keyword: '{self.keyword}'")
        print("Press Ctrl+C to exit\n")

        self.is_listening = True

        try:
            self.microphone.start()
            threading.Thread(target=self._notification_loop, daemon=True).start()

            while self.is_listening:
                self._speak_notifications()

                frame = self.microphone.read_frame()
                if frame is None:
                    continue

                audio = self._feed_frame(frame)
                if audio is not None:
                    self._handle_utterance(audio)

        except KeyboardInterrupt:
            print("\n[INFO] Stopping listener...")
        except Exception as e:
            print(f"[ERROR] Error in listening loop: {e}")
        finally:
            self.stop()

    def stop(self):
        """Stop listening"""
        if not self.is_listening:
            return

        self.is_listening = False
        self.microphone.stop()
        self.audio.terminate()
        print("[INFO] Voice activation listener stopped")

def list_audio_devices():
    """List available audio input devices"""
    audio = pyaudio.PyAudio()
    print("\nAvailable audio devices:")
    print("-" * 50)

    try:
        default_index = audio.get_default_input_device_info().get('index')
    except Exception:
        default_index = None

    for i in range(audio.get_device_count()):
        info = audio.get_device_info_by_index(i)
        max_input_channels = int(info.get('maxInputChannels', 0) or 0)

        if max_input_channels > 0:
            marker = " ← DEFAULT" if (default_index is not None and i == default_index) else ""
            print(f"[{i}] {info['name']}{marker}")
            print(f"    Channels: {max_input_channels}, Sample Rate: {int(info['defaultSampleRate'])}")

    print("-" * 50 + "\n")
    audio.terminate()

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Voice Activation Listener")
    # Prefer environment variables when CLI args aren't provided
    parser.add_argument("--keyword", default=os.getenv("WAKE_WORD", "lisa"), help="Wake word to listen for")
    parser.add_argument("--aliases", default=os.getenv("WAKE_WORD_ALIASES", ""), help="Comma-separated alternative spellings of the wake word, for example liza,lysa")
    parser.add_argument("--language", default=os.getenv("LISTENER_LANGUAGE"), help="Whisper language code, for example en or it. Leave unset for auto-detect")
    parser.add_argument("--api-url", help="LocalAssistant API URL")
    parser.add_argument("--device", type=int, help="Audio device ID to use")
    parser.add_argument("--list-devices", action="store_true", help="List available audio devices")
    parser.add_argument("--debug", action="store_true", default=os.getenv("LISTENER_DEBUG", "") == "1", help="Print everything that is heard and save each utterance to worker/debug")
    parser.add_argument("--threshold", type=float, default=float(os.getenv("VAD_THRESHOLD", 0.5)), help="Speech probability (0-1) needed to start capturing (default: 0.5)")

    args = parser.parse_args()

    if args.list_devices:
        list_audio_devices()
        sys.exit(0)

    # If a device ID is set in the environment and not passed on CLI, use it
    if args.device is None:
        env_device = os.getenv("AUDIO_DEVICE_ID")
        if env_device:
            try:
                args.device = int(env_device)
            except ValueError:
                print(f"[WARN] Invalid AUDIO_DEVICE_ID in environment: {env_device}")

    # Start listener
    listener = VoiceActivationListener(
        keyword=args.keyword,
        keyword_aliases=[alias for alias in args.aliases.split(",") if alias.strip()],
        language=args.language,
        api_url=args.api_url,
        device_id=args.device,
        vad_threshold=args.threshold,
        debug=args.debug,
    )

    listener.start()
