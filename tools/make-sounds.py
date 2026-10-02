"""Synthesizes the soft sound theme (sounds/soft/*.wav): short, quiet mallet and bell tones.

Run from the repository root: python tools/make-sounds.py
Every sound is written from scratch here, so the theme carries no third-party rights.
"""

import math
import struct
import wave
from pathlib import Path

RATE = 44100
PEAK = 0.32  # well under full scale: these sit under speech and music
OUT = Path(__file__).resolve().parent.parent / 'sounds' / 'soft'


def note(freq, start, length, partials, decay):
    """One struck tone: a few sine partials (ratio, level), a 6 ms attack, an exponential decay."""
    return {'freq': freq, 'start': start, 'length': length, 'partials': partials, 'decay': decay}


def render(notes, tail=0.25):
    total = max(n['start'] + n['length'] for n in notes) + tail
    samples = [0.0] * int(total * RATE)
    for n in notes:
        first = int(n['start'] * RATE)
        count = int((n['length'] + tail) * RATE)
        for i in range(count):
            t = i / RATE
            attack = min(1.0, t / 0.006)
            env = attack * math.exp(-t * n['decay'])
            value = sum(level * math.sin(2 * math.pi * n['freq'] * ratio * t) * math.exp(-t * n['decay'] * ratio * 0.6) for ratio, level in n['partials'])
            if first + i < len(samples):
                samples[first + i] += env * value
    # a short fade at the end, then scale to the peak
    fade = int(0.04 * RATE)
    for i in range(fade):
        samples[-1 - i] *= i / fade
    top = max(abs(s) for s in samples) or 1.0
    return [s / top * PEAK for s in samples]


def write(name, samples):
    OUT.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUT / f'{name}.wav'), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, s)) * 32767)) for s in samples))


# a marimba-like mallet: the fundamental and its fourth harmonic, faint
MALLET = [(1.0, 1.0), (4.0, 0.12)]
# a small bell: inharmonic partials, as a struck metal bar
BELL = [(1.0, 1.0), (2.76, 0.22), (5.4, 0.06)]
# a muted wooden knock, rounder and lower
WOOD = [(1.0, 1.0), (2.0, 0.18)]

# decision: two rising mallet notes, a gentle "hm?" (A5, then E6)
write('decision', render([note(880.0, 0.0, 0.16, MALLET, 9), note(1318.5, 0.13, 0.22, MALLET, 8)]))

# error: two low falling knocks, soft rather than alarming (E4, then C4)
write('error', render([note(329.6, 0.0, 0.18, WOOD, 10), note(261.6, 0.16, 0.30, WOOD, 7)]))

# done: a quick major arpeggio ending on a ringing bell (C5, E5, G5, C6)
write('done', render([
    note(523.3, 0.0, 0.12, MALLET, 10),
    note(659.3, 0.09, 0.12, MALLET, 10),
    note(784.0, 0.18, 0.14, MALLET, 9),
    note(1046.5, 0.27, 0.45, BELL, 4.5),
], tail=0.35))

print('written to', OUT)
