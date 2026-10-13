"""Japanese lyric to audio alignment worker.

The Node server passes one JSON input and expects one JSON output. Heavy model
dependencies are loaded only after the request is validated, so failures leave
the browser's explicitly labelled line-time estimate available for playback.
"""

from __future__ import annotations

import importlib.util
import json
import math
import os
import subprocess
import sys
import tempfile
import unicodedata
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "vendor"))


SAMPLE_RATE = 16000
DEFAULT_MODEL = "NextFire/mms-300m-ForcedAligner-karaoke-ja-Latn"


def graphemes(text: str) -> list[str]:
    """Group combining marks and Japanese variation selectors with a base."""
    result: list[str] = []
    for char in text:
        if result and (unicodedata.combining(char) or char in "\ufe0e\ufe0f"):
            result[-1] += char
        else:
            result.append(char)
    return result


def normalized_latin(text: str) -> str:
    folded = unicodedata.normalize("NFKD", text).lower()
    return "".join(char for char in folded if "a" <= char <= "z")


def japanese_target(text: str, kakasi) -> tuple[str, list[tuple[int, int]]]:
    """Return romaji target and a target-letter span for each visible glyph.

    A multi-kanji word has no unique acoustic boundary per written character.
    Its pronunciation letters are allocated proportionally across glyphs; the
    UI keeps the original text and reports these times as estimates.
    """
    target = ""
    spans: list[tuple[int, int]] = []
    for chunk in kakasi.convert(text):
        original = graphemes(chunk["orig"])
        reading = normalized_latin(chunk.get("hepburn", ""))
        base = len(target)
        target += reading
        for index in range(len(original)):
            start = base + round(len(reading) * index / len(original))
            end = base + round(len(reading) * (index + 1) / len(original))
            spans.append((start, end))
    # pykakasi's chunks normally partition the input exactly. Keep a safe
    # fallback for unusual Unicode sequences so the original lyrics survive.
    visible = graphemes(text)
    if len(spans) != len(visible):
        spans = [(round(len(target) * i / len(visible)), round(len(target) * (i + 1) / len(visible))) for i in range(len(visible))]
    return target, spans


class SudachiReading:
    def __init__(self, romanizer):
        from sudachipy import dictionary
        self.tokenizer = dictionary.Dictionary().tokenizer()
        self.romanizer = romanizer

    def convert(self, text: str) -> list[dict[str, str]]:
        chunks = []
        for morpheme in self.tokenizer.tokenize(text):
            surface = morpheme.surface()
            reading = morpheme.reading_form()
            if reading == "*":
                reading = surface
            latin = "".join(part.get("hepburn", "") for part in self.romanizer.convert(reading))
            chunks.append({"orig": surface, "hepburn": latin})
        return chunks


def roman_target(text: str) -> tuple[str, list[tuple[int, int]]]:
    target = ""
    spans: list[tuple[int, int]] = []
    for glyph in graphemes(text):
        start = len(target)
        target += normalized_latin(glyph)
        spans.append((start, len(target)))
    return target, spans


def forced_ctc(log_probs, labels: list[int], blank_id: int) -> tuple[list[int], float]:
    """Viterbi alignment over the CTC trellis; returns one frame per letter."""
    import numpy as np

    frame_count = log_probs.shape[0]
    if not labels or frame_count < len(labels) * 2:
        raise ValueError("音频时间窗太短，无法容纳这一行歌词")
    states = [blank_id]
    for label in labels:
        states.extend((label, blank_id))
    state_count = len(states)
    previous = np.full(state_count, -np.inf, dtype=np.float64)
    previous[0] = float(log_probs[0, blank_id])
    previous[1] = float(log_probs[0, labels[0]])
    back = np.zeros((frame_count, state_count), dtype=np.int32)
    for frame in range(1, frame_count):
        current = np.full(state_count, -np.inf, dtype=np.float64)
        for state, label in enumerate(states):
            best_state = state
            best = previous[state]
            if state > 0 and previous[state - 1] > best:
                best, best_state = previous[state - 1], state - 1
            if state > 1 and label != blank_id and label != states[state - 2] and previous[state - 2] > best:
                best, best_state = previous[state - 2], state - 2
            current[state] = best + float(log_probs[frame, label])
            back[frame, state] = best_state
        previous = current
    state = state_count - 1 if previous[-1] >= previous[-2] else state_count - 2
    positions: list[list[int]] = [[] for _ in labels]
    strengths: list[float] = []
    for frame in range(frame_count - 1, -1, -1):
        if state % 2 == 1:
            label_index = state // 2
            positions[label_index].append(frame)
            strengths.append(math.exp(float(log_probs[frame, labels[label_index]])))
        state = int(back[frame, state]) if frame else state
    if any(not position for position in positions):
        raise ValueError("部分读音没有找到可靠的音频位置")
    centers = [round(sum(position) / len(position)) for position in positions]
    return centers, sum(strengths) / max(1, len(strengths))


def units_from_centers(text: str, spans: list[tuple[int, int]], centers: list[int],
                       window_start: float, window_end: float, frame_count: int,
                       line_start: float, line_end: float) -> list[dict]:
    visible = graphemes(text)
    scale = (window_end - window_start) / frame_count
    char_times = [window_start + (center + 0.5) * scale for center in centers]
    glyph_centers: list[float | None] = []
    for start, end in spans:
        glyph_centers.append(sum(char_times[start:end]) / (end - start) if end > start else None)
    for index, center in enumerate(glyph_centers):
        if center is not None:
            continue
        before = next((glyph_centers[i] for i in range(index - 1, -1, -1) if glyph_centers[i] is not None), None)
        after = next((glyph_centers[i] for i in range(index + 1, len(glyph_centers)) if glyph_centers[i] is not None), None)
        glyph_centers[index] = (before + after) / 2 if before is not None and after is not None else (before or after or line_start)
    center_values = [float(value) for value in glyph_centers]
    if not center_values:
        return []
    raw_boundaries = [max(line_start, center_values[0] - 0.08)]
    raw_boundaries.extend((left + right) / 2 for left, right in zip(center_values, center_values[1:]))
    raw_boundaries.append(min(line_end, center_values[-1] + 0.28))
    minimum = min(0.01, max(0.001, (line_end - line_start) / (len(visible) + 1)))
    boundaries = [min(raw_boundaries[0], line_end - len(visible) * minimum)]
    for index in range(1, len(visible)):
        boundaries.append(max(boundaries[-1] + minimum,
                              min(raw_boundaries[index], line_end - (len(visible) - index) * minimum)))
    boundaries.append(min(line_end, max(raw_boundaries[-1], boundaries[-1] + minimum)))
    units = []
    for index, glyph in enumerate(visible):
        start = max(line_start, boundaries[index])
        end = boundaries[index + 1]
        units.append({"text": glyph, "start": round(start, 3), "end": round(end, 3)})
    return units


def ffmpeg_executable() -> str:
    configured = os.environ.get("FFMPEG_PATH")
    if configured:
        return configured
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return "ffmpeg"


def load_audio(audio_path: str, ffmpeg: str):
    import numpy as np

    command = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-i", audio_path,
               "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1"]
    process = subprocess.run(command, capture_output=True, check=False)
    if process.returncode:
        raise RuntimeError(process.stderr.decode("utf-8", "replace")[-1200:] or "FFmpeg 音频解码失败")
    return np.frombuffer(process.stdout, dtype="<f4").copy()


def maybe_separate(audio_path: str, ffmpeg: str) -> tuple[str, str | None, tempfile.TemporaryDirectory | None]:
    if os.environ.get("ALIGN_SKIP_SEPARATION") == "1":
        return audio_path, "已跳过人声分离；复杂伴奏可能降低校时准确度。", None
    if importlib.util.find_spec("demucs") is None:
        return audio_path, "未安装 Demucs，已使用原始音频校时；安装后可重新校时。", None
    temporary = tempfile.TemporaryDirectory(prefix="ktv-stems-", dir=Path(audio_path).parent)
    try:
        import numpy as np
        import torch
        from demucs.apply import apply_model
        from demucs.pretrained import get_model

        model = get_model(name="htdemucs")
        device = "cuda" if torch.cuda.is_available() and os.environ.get("ALIGN_CPU") != "1" else "cpu"
        model.to(device).eval()
        channels = model.audio_channels
        command = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-i", audio_path,
                   "-ac", str(channels), "-ar", str(model.samplerate), "-f", "f32le", "pipe:1"]
        process = subprocess.run(command, capture_output=True, check=False)
        if process.returncode:
            raise RuntimeError(process.stderr.decode("utf-8", "replace")[-1000:])
        samples = np.frombuffer(process.stdout, dtype="<f4").copy().reshape(-1, channels).T
        wave_tensor = torch.from_numpy(samples)
        reference = wave_tensor.mean(0)
        mean, std = reference.mean(), reference.std().clamp(min=1e-6)
        normalized = (wave_tensor - mean) / std
        with torch.inference_mode():
            sources = apply_model(model, normalized[None], device=device, split=True, overlap=0.25)[0]
        vocals = sources[model.sources.index("vocals")] * std + mean
        mono = vocals.mean(0).clamp(-1, 1).cpu().numpy()
        output = Path(temporary.name) / "vocals.wav"
        with wave.open(str(output), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(model.samplerate)
            handle.writeframes((mono * 32767).astype("<i2").tobytes())
        return str(output), None, temporary
    except Exception as error:
        print(f"Demucs separation failed: {error}", file=sys.stderr)
        temporary.cleanup()
        return audio_path, "人声分离失败，已改用原始音频校时。", None


def main(input_path: str, output_path: str) -> None:
    request = json.loads(Path(input_path).read_text(encoding="utf-8"))
    lines = request["lines"]
    if not lines:
        Path(output_path).write_text(json.dumps({"lines": []}), encoding="utf-8")
        return
    import numpy as np
    import torch
    from pykakasi import kakasi
    from transformers import AutoModelForCTC, AutoProcessor

    ffmpeg = ffmpeg_executable()
    source, warning, temp = maybe_separate(request["audio"], ffmpeg)
    try:
        waveform = load_audio(source, ffmpeg)
        model_name = os.environ.get("ALIGN_MODEL", DEFAULT_MODEL)
        processor = AutoProcessor.from_pretrained(model_name)
        model = AutoModelForCTC.from_pretrained(model_name)
        device = "cuda" if torch.cuda.is_available() and os.environ.get("ALIGN_CPU") != "1" else "cpu"
        model.to(device).eval()
        blank_id = model.config.pad_token_id
        if blank_id is None:
            blank_id = processor.tokenizer.pad_token_id
        if blank_id is None:
            raise RuntimeError("声学模型没有提供 CTC blank token")
        converter = SudachiReading(kakasi())
        results = []
        for index, line in enumerate(lines):
            start = float(line["start"])
            end = float(line["end"])
            start_sample = max(0, int((start - 0.25) * SAMPLE_RATE))
            end_sample = min(len(waveform), int((end + 0.1) * SAMPLE_RATE))
            if end_sample - start_sample < SAMPLE_RATE // 3:
                continue
            clip = waveform[start_sample:end_sample]
            inputs = processor(clip, sampling_rate=SAMPLE_RATE, return_tensors="pt")
            with torch.inference_mode():
                output = model(**{key: value.to(device) for key, value in inputs.items()})
                log_probs = output.logits[0].log_softmax(-1).cpu().numpy()
            unit_groups = [("units", line["text"], japanese_target(line["text"], converter))]
            if line.get("romaji"):
                unit_groups.append(("romajiUnits", line["romaji"], roman_target(line["romaji"])))
            result = {"index": index, "confidence": 0.0, "method": "estimated"}
            scores = []
            for key, display, (target, spans) in unit_groups:
                if not target:
                    continue
                labels = processor.tokenizer(target, add_special_tokens=False).input_ids
                if len(labels) != len(target) or any(label == processor.tokenizer.unk_token_id for label in labels):
                    continue
                try:
                    centers, score = forced_ctc(log_probs, labels, int(blank_id))
                    units = units_from_centers(display, spans, centers, start_sample / SAMPLE_RATE,
                                               end_sample / SAMPLE_RATE, len(log_probs), start, end)
                    if len(units) == len(graphemes(display)):
                        result[key] = units
                        scores.append(score)
                except ValueError:
                    continue
            if "units" in result:
                result["confidence"] = round(float(np.mean(scores)), 3)
                if line.get("romaji") and "romajiUnits" not in result:
                    result["confidence"] = min(result["confidence"], 0.4)
                if result["confidence"] >= 0.1:
                    result["method"] = "aligned"
                    results.append(result)
        Path(output_path).write_text(json.dumps({"lines": results, "warning": warning}, ensure_ascii=False), encoding="utf-8")
    finally:
        if temp:
            temp.cleanup()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: align.py INPUT_JSON OUTPUT_JSON")
    try:
        main(sys.argv[1], sys.argv[2])
    except Exception as error:
        print(f"ALIGN_ERROR:{str(error).splitlines()[0]}", file=sys.stderr)
        raise SystemExit(1)
