import os
import sys
import re
import time
import requests
import numpy as np
from collections import deque
from typing import Optional
from dotenv import load_dotenv
import subprocess
import platform

# Audio processing
import pyaudio

# Speech Recognition
import whisper
import torch
from silero_vad import get_speech_timestamps, load_silero_vad

# Configuration
load_dotenv()

class VoiceActivationListener:
    def __init__(
        self,
        keyword: str = "lisa",
        language: Optional[str] = None,
        api_url: Optional[str] = None,
        api_key: Optional[str] = None,
        device_id: Optional[int] = None,
        sample_rate: int = 16000,
        chunk_size: int = 1024,
        energy_threshold: float = 0.01,
        speech_trigger_rms: float = 0.008,
        wake_check_interval: float = 1.0,
        min_trigger_interval: float = 2.5,
        wake_prepend_seconds: float = 3.0,
        wake_model_name: Optional[str] = None,
        transcription_model_name: Optional[str] = None,
        calibrate_seconds: float = 1.5,
    ):
        self.keyword = keyword.lower()
        self.normalized_keyword = self._normalize_text(self.keyword)
        self.language = language.lower() if language else None
        self.api_url = api_url or os.getenv("ASSISTANT_API_URL", "http://localhost:3000")
        self.api_key = api_key or os.getenv("ASSISTANT_API_KEY", "")
        self.device_id = device_id
        self.sample_rate = sample_rate
        self.chunk_size = chunk_size
        self.energy_threshold = energy_threshold
        self.speech_trigger_rms = speech_trigger_rms
        self.wake_check_interval = wake_check_interval
        self.min_trigger_interval = min_trigger_interval
        self.wake_prepend_seconds = wake_prepend_seconds
        self.calibrate_seconds = calibrate_seconds
        self.wake_model_name = wake_model_name or os.getenv("WAKE_MODEL", "tiny")
        self.transcription_model_name = transcription_model_name or os.getenv("TRANSCRIPTION_MODEL", "small")
        self.device = self._pick_torch_device()
        self.fp16 = self.device == "cuda"
        
        # Audio configuration
        self.FORMAT = pyaudio.paFloat32
        self.CHANNELS = 1
        
        # Initialize audio stream
        self.audio = pyaudio.PyAudio()
        self.stream = None
        self.is_listening = False
        
        print(f"[INFO] Loading Whisper wake model ({self.wake_model_name}) on {self.device}...")
        self.wake_model = whisper.load_model(self.wake_model_name, device=self.device)

        print(f"[INFO] Loading Whisper transcription model ({self.transcription_model_name}) on {self.device}...")
        self.whisper_model = whisper.load_model(self.transcription_model_name, device=self.device)

        print("[INFO] Loading Silero VAD model...")
        self.vad_model = load_silero_vad()
        
        print("[INFO] Voice activation listener initialized")
        print(f"[INFO] Keyword: '{self.keyword}'")
        print(f"[INFO] Language: {self.language or 'auto'}")
        print(f"[INFO] API URL: {self.api_url}")
        print(f"[INFO] Silence threshold (RMS): {self.energy_threshold}")

    def _pick_torch_device(self) -> str:
        """Choose the fastest usable Whisper device."""
        if torch.cuda.is_available():
            return "cuda"

        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            # openai-whisper still has rough edges on MPS; opt in explicitly.
            if os.getenv("WHISPER_DEVICE", "").lower() == "mps":
                return "mps"

        return os.getenv("WHISPER_DEVICE", "cpu")

    def _get_audio_energy(self, audio_chunk: np.ndarray) -> float:
        """Calculate RMS energy of audio chunk"""
        if len(audio_chunk) == 0:
            return 0.0
        return float(np.sqrt(np.mean(np.square(audio_chunk))))

    def _normalize_text(self, text: str) -> str:
        """Normalize text to improve wake-phrase matching."""
        normalized = re.sub(r"[^a-z0-9\s]", " ", text.lower())
        return " ".join(normalized.split())

    def _to_audio_array(self, audio_buffer) -> np.ndarray:
        """Convert buffered audio into a contiguous float32 array."""
        return np.asarray(audio_buffer, dtype=np.float32).copy()

    def _prepare_audio(self, audio: np.ndarray, trim_silence: bool = True) -> np.ndarray:
        """Normalize and optionally trim audio before sending it to Whisper."""
        if len(audio) == 0:
            return np.array([], dtype=np.float32)

        audio = np.asarray(audio, dtype=np.float32)
        audio = np.nan_to_num(audio, nan=0.0, posinf=0.0, neginf=0.0)
        audio = np.clip(audio, -1.0, 1.0)
        audio = audio - float(np.mean(audio))

        if trim_silence:
            audio = self._trim_to_speech(audio)

        peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
        if peak > 0:
            audio = audio * min(1.0 / peak, 8.0)

        return np.clip(audio, -1.0, 1.0).astype(np.float32)

    def _trim_to_speech(self, audio: np.ndarray) -> np.ndarray:
        """Use Silero VAD to remove leading/trailing non-speech for cleaner transcripts."""
        if len(audio) < int(self.sample_rate * 0.2):
            return audio

        try:
            speech = get_speech_timestamps(
                torch.from_numpy(audio),
                self.vad_model,
                sampling_rate=self.sample_rate,
                threshold=0.35,
                min_speech_duration_ms=160,
                min_silence_duration_ms=180,
                speech_pad_ms=220,
                return_seconds=False,
            )
            if not speech:
                return audio

            start = max(0, int(speech[0]["start"]))
            end = min(len(audio), int(speech[-1]["end"]))
            return audio[start:end]
        except Exception as e:
            print(f"[WARN] VAD trim failed, using raw audio: {e}")
            return audio

    def _calibrate_ambient_noise(self) -> None:
        """Measure the room floor briefly so fixed thresholds do not punish quiet/loud microphones."""
        if self.calibrate_seconds <= 0 or self.stream is None:
            return

        print(f"[INFO] Calibrating ambient noise for {self.calibrate_seconds:.1f}s...")
        energies = []
        chunks = max(1, int((self.sample_rate / self.chunk_size) * self.calibrate_seconds))

        for _ in range(chunks):
            try:
                data = self.stream.read(self.chunk_size, exception_on_overflow=False)
                audio_chunk = np.frombuffer(data, dtype=np.float32)
                energies.append(self._get_audio_energy(audio_chunk))
            except Exception as e:
                print(f"[WARN] Ambient calibration failed: {e}")
                return

        if not energies:
            return

        noise_floor = float(np.percentile(energies, 80))
        old_energy = self.energy_threshold
        old_speech = self.speech_trigger_rms
        self.energy_threshold = max(self.energy_threshold, noise_floor * 2.5)
        self.speech_trigger_rms = max(self.speech_trigger_rms, noise_floor * 3.0)

        print(
            "[INFO] Ambient RMS "
            f"{noise_floor:.5f}; silence threshold {old_energy:.5f}->{self.energy_threshold:.5f}; "
            f"wake trigger {old_speech:.5f}->{self.speech_trigger_rms:.5f}"
        )

    def _tail_audio(self, audio: np.ndarray, duration_seconds: float) -> np.ndarray:
        """Keep only the tail of an audio buffer so command capture starts near the wake word."""
        if len(audio) == 0 or duration_seconds <= 0:
            return np.array([], dtype=np.float32)

        tail_samples = int(self.sample_rate * duration_seconds)
        if tail_samples <= 0:
            return np.array([], dtype=np.float32)

        return audio[-tail_samples:]

    def _is_keyword_detected(self, audio: np.ndarray) -> bool:
        """Detect wake phrase by transcribing a short window and matching text."""
        try:
            if len(audio) == 0:
                return False

            audio = self._prepare_audio(audio, trim_silence=True)
            if len(audio) < int(self.sample_rate * 0.25):
                return False

            result: dict = self.wake_model.transcribe(
                audio,
                language=self.language,
                fp16=self.fp16,
                temperature=0.0,
                no_speech_threshold=0.6,
                logprob_threshold=-1.0,
                compression_ratio_threshold=2.4,
                initial_prompt=f"The wake word is {self.keyword}.",
            )

            transcribed = self._normalize_text(result.get("text", ""))
            if not transcribed:
                return False

            detected = self.normalized_keyword in transcribed
            if detected:
                print(f"[INFO] Wake phrase match: '{transcribed}'")
            return detected
        except Exception as e:
            print(f"[ERROR] Error in keyword detection: {e}")
            return False

    def _strip_wake_phrase(self, text: str) -> str:
        """Remove wake phrase from transcription and return only the command."""
        pattern = re.compile(rf"\b{re.escape(self.keyword)}\b", re.IGNORECASE)
        stripped = pattern.sub("", text, count=1).strip(" ,.!?;:")
        if stripped != text.strip(" ,.!?;:") and stripped:
            return stripped

        normalized_text = self._normalize_text(text)

        if self.normalized_keyword in normalized_text:
            parts = normalized_text.split(self.normalized_keyword, 1)
            return parts[1].strip(" ,.!?;:")

        return stripped or normalized_text

    def _record_audio_until_silence(self, timeout_seconds: int = 10, prepend_audio: Optional[np.ndarray] = None) -> np.ndarray:
        """Record audio until silence is detected"""
        print("[RECORDING] Listening for voice input...")
        
        frames = []
        if prepend_audio is not None and len(prepend_audio) > 0:
            frames.append(prepend_audio)

        silent_chunks = 0
        max_silent_chunks = int((self.sample_rate / self.chunk_size) * 1.0)  # 1 second of silence
        
        try:
            start_time = time.monotonic()
            
            while True:
                try:
                    if self.stream is None:
                        print("[ERROR] Audio stream is not initialized")
                        break

                    data = self.stream.read(self.chunk_size, exception_on_overflow=False)
                    audio_chunk = np.frombuffer(data, dtype=np.float32)
                    frames.append(audio_chunk)
                    
                    # Check for silence
                    energy = self._get_audio_energy(audio_chunk)
                    if energy < self.energy_threshold:
                        silent_chunks += 1
                    else:
                        silent_chunks = 0
                    
                    # Stop if silence detected or timeout
                    elapsed = time.monotonic() - start_time
                    if silent_chunks > max_silent_chunks or elapsed > timeout_seconds:
                        print(f"[RECORDING] Finished recording ({elapsed:.1f}s)")
                        break
                        
                except Exception as e:
                    print(f"[ERROR] Error reading audio: {e}")
                    break
            
            if frames:
                return np.concatenate(frames)
            return np.array([])
            
        except KeyboardInterrupt:
            print("[INFO] Recording interrupted by user")
            return np.array([])

    def _transcribe_audio(self, audio: np.ndarray) -> str:
        """Transcribe audio using Whisper"""
        try:
            print("[INFO] Transcribing audio...")
            
            # Transcribe
            prepared_audio = self._prepare_audio(audio, trim_silence=True)
            if len(prepared_audio) < int(self.sample_rate * 0.25):
                print("[INFO] Audio contained no clear speech")
                return ""

            result: dict = self.whisper_model.transcribe(
                prepared_audio,
                language=self.language,
                fp16=self.fp16,
                temperature=0.0,
                condition_on_previous_text=False,
                no_speech_threshold=0.6,
                logprob_threshold=-1.0,
                compression_ratio_threshold=2.4,
                initial_prompt=f"This is a short voice command to a local assistant named {self.keyword}.",
            )
            text = result.get("text", "").strip()
            
            print(f"[INFO] Transcribed: {text}")
            return text
            
        except Exception as e:
            print(f"[ERROR] Error transcribing audio: {e}")
            return ""

    def _send_to_assistant(self, text: str) -> dict:
        """Send transcribed text to LocalAssistant API"""
        try:
            print("[INFO] Sending to assistant API...")
            
            payload = {
                "content": text,
            }
            
            response = requests.post(
                f"{self.api_url}/requests/create",
                json=payload,
                headers={"Authorization": f"Bearer {self.api_key}"} if self.api_key else {},
                timeout=30,
            )

            response.raise_for_status()
            print("[INFO] Request sent successfully")

            result = response.json()

            # Speak assistant reply if available
            try:
                assistant_text = None
                if isinstance(result, dict):
                    assistant_text = result.get("content")
                if assistant_text:
                    self._speak_text(assistant_text)
            except Exception as e:
                print(f"[WARN] TTS failed: {e}")

            return result
            
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
            # Open audio stream
            self.stream = self.audio.open(
                format=self.FORMAT,
                channels=self.CHANNELS,
                rate=self.sample_rate,
                input=True,
                input_device_index=self.device_id,
                frames_per_buffer=self.chunk_size,
            )

            self._calibrate_ambient_noise()
            
            keyword_window = 3  # seconds of audio for keyword matching
            keyword_samples = int(self.sample_rate * keyword_window)
            keyword_buffer: deque[float] = deque(maxlen=keyword_samples)
            last_wake_check = 0.0
            last_trigger = 0.0
            
            while self.is_listening:
                try:
                    data = self.stream.read(self.chunk_size, exception_on_overflow=False)
                    audio_chunk = np.frombuffer(data, dtype=np.float32)
                    
                    keyword_buffer.extend(audio_chunk)

                    if len(keyword_buffer) >= self.chunk_size:
                        buffer_array = self._to_audio_array(keyword_buffer)

                        now = time.monotonic()
                        window_energy = self._get_audio_energy(buffer_array)
                        should_check = (
                            window_energy >= self.speech_trigger_rms
                            and now - last_wake_check >= self.wake_check_interval
                            and now - last_trigger >= self.min_trigger_interval
                        )

                        if should_check:
                            last_wake_check = now

                        if should_check and self._is_keyword_detected(buffer_array):
                            last_trigger = time.monotonic()
                            print("\n[WAKE WORD DETECTED] 🎤")
                            
                            audio_input = self._record_audio_until_silence(
                                prepend_audio=self._tail_audio(buffer_array, self.wake_prepend_seconds)
                            )
                            
                            if len(audio_input) > 0:
                                text = self._transcribe_audio(audio_input)

                                command_text = self._strip_wake_phrase(text)
                                if command_text:
                                    self._send_to_assistant(command_text)
                                else:
                                    print("[INFO] Wake word detected but no command captured after it")
                            
                            keyword_buffer.clear()
                            print("\n[LISTENING] Ready for next command...\n")
                            
                except KeyboardInterrupt:
                    print("\n[INFO] Stopping listener...")
                    break
                    
        except Exception as e:
            print(f"[ERROR] Error in listening loop: {e}")
        finally:
            self.stop()

    def stop(self):
        """Stop listening"""
        self.is_listening = False
        
        if self.stream:
            self.stream.stop_stream()
            self.stream.close()
        
        self.audio.terminate()
        print("[INFO] Voice activation listener stopped")

    def _speak_text(self, text: str) -> None:
        """Speak text using macOS `say` command or fall back to pyttsx3 if available."""
        try:
            system = platform.system()
            if system == "Darwin":
                # Use macOS built-in TTS
                subprocess.run(["say", text], check=False)
                return

            # Try pyttsx3 as a fallback for other platforms
            try:
                import pyttsx3

                engine = pyttsx3.init()
                engine.say(text)
                engine.runAndWait()
                return
            except Exception:
                print("[WARN] pyttsx3 unavailable or failed to play audio")

            print(f"[INFO] Assistant: {text}")
        except Exception as e:
            print(f"[ERROR] Error speaking text: {e}")

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
            marker = " \u2190 DEFAULT" if (default_index is not None and i == default_index) else ""
            print(f"[{i}] {info['name']}{marker}")
            print(f"    Channels: {max_input_channels}, Sample Rate: {int(info['defaultSampleRate'])}")
    
    print("-" * 50 + "\n")
    audio.terminate()

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Voice Activation Listener")
    # Prefer environment variables when CLI args aren't provided
    parser.add_argument("--keyword", default=os.getenv("WAKE_WORD", "lisa"), help="Wake word to listen for")
    parser.add_argument("--language", default=os.getenv("LISTENER_LANGUAGE"), help="Whisper language code, for example en or it. Leave unset for auto-detect")
    parser.add_argument("--api-url", help="LocalAssistant API URL")
    parser.add_argument("--device", type=int, help="Audio device ID to use")
    parser.add_argument("--list-devices", action="store_true", help="List available audio devices")
    parser.add_argument("--threshold", type=float, default=float(os.getenv("DETECTION_THRESHOLD", 0.01)), help="Silence RMS threshold (default: 0.01)")
    parser.add_argument("--speech-trigger", type=float, default=float(os.getenv("SPEECH_TRIGGER_RMS", 0.008)), help="Minimum RMS to run wake-word check")
    
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
        language=args.language,
        api_url=args.api_url,
        device_id=args.device,
        energy_threshold=args.threshold,
        speech_trigger_rms=args.speech_trigger,
    )
    
    try:
        listener.start()
    except KeyboardInterrupt:
        print("\n[INFO] Exiting...")
        listener.stop()
