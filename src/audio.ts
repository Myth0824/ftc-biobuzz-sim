import sounds from 'virtual:sounds';
import type { MatchEvent } from './sim/world';

/**
 * Plays the FIELD audio cues of Table 9-1. A file in `public/sounds/` named after the cue wins, for example
 * `match_start.wav`. Without a file, the cue is synthesized with WebAudio, and speech uses the browser's voice.
 * FIRST's own sound files aren't bundled here.
 */
export class MatchAudio {
  enabled = true;
  private ctx: AudioContext | null = null; private files = new Map<string, HTMLAudioElement>();

  constructor() {
    for (const f of sounds) { const cue = f.replace(/\.\w+$/, ''); if (!this.files.has(cue)) this.files.set(cue, new Audio(`/sounds/${f}`)); }
  }

  private tone(freq: number, at: number, dur: number, type: OscillatorType = 'sine', gain = 0.18, slideTo?: number) {
    const ctx = (this.ctx ??= new AudioContext()), o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + at;
    o.type = type; o.frequency.setValueAtTime(freq, t); if (slideTo) o.frequency.linearRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + dur + 0.05);
  }
  private say(text: string, rate = 1.05) { try { const u = new SpeechSynthesisUtterance(text); u.rate = rate; speechSynthesis.speak(u); } catch { /* No speech support: the tones still play. */ } }

  play(cue: MatchEvent | 'start_countdown') {
    if (!this.enabled) return;
    const f = this.files.get(cue); if (f) { f.currentTime = 0; void f.play().catch(() => {}); return; }
    if (cue === 'start_countdown') { this.say('3. 2. 1. Go!', 1.0); [0, 1, 2].forEach(i => this.tone(660, i * 0.95, 0.18)); }
    // "Cavalry Charge": a rising bugle call.
    else if (cue === 'match_start') [392, 523, 659, 784, 659, 784].forEach((hz, i) => this.tone(hz, i * 0.13, 0.16, 'square', 0.1));
    else if (cue === 'auto_end' || cue === 'match_end') this.tone(175, 0, cue === 'match_end' ? 2.2 : 1.1, 'sawtooth', 0.22);
    else if (cue === 'pick_up_controllers') this.say('Drivers, pick up your controllers.');
    else if (cue === 'countdown') { this.say('3. 2. 1.', 1.0); [0, 1, 2].forEach(i => this.tone(660, i * 0.95, 0.18)); }
    else if (cue === 'teleop_start') [0, 0.22, 0.44].forEach(at => { this.tone(1568, at, 0.9, 'sine', 0.16); this.tone(2093, at, 0.6, 'sine', 0.07); });
    else if (cue === 'flowers_unlock') [880, 1175].forEach((hz, i) => this.tone(hz, i * 0.18, 0.5, 'triangle', 0.14));
    else if (cue === 'foul') [0, 0.16].forEach(at => this.tone(988, at, 0.12, 'square', 0.09));
    // "Train Whistle": two detuned tones that sag in pitch.
    else if (cue === 'endgame') [0, 0.75].forEach(at => { this.tone(740, at, 0.6, 'square', 0.07, 700); this.tone(932, at, 0.6, 'square', 0.06, 880); });
  }
}
