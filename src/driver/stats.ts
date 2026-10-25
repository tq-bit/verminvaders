// Session and per-wave statistics (spec section 8: one-line wave summaries,
// session summary with games, best score, shots fired, hits).

import type { WaveSummary } from "../types/index.d.ts";

export class Stats {
  gamesStarted = 0;
  bestScore = 0;
  shotsFired = 0;
  hits = 0;
  roombaHits = 0;
  livesLost = 0;
  private startTime = 0;
  private lastWave = 0;
  private waveStart = 0;
  private waveStartScore = 0;
  private waveStartLives = 3;
  private gameStart = 0;

  sessionStart(now: number): void {
    this.startTime = now;
  }

  gameStartEvent(now: number, wave: number, lives: number): void {
    this.gamesStarted++;
    this.gameStart = now;
    this.waveStartEvent(now, wave, lives, 0);
  }

  waveStartEvent(now: number, wave: number, lives: number, score: number): void {
    this.lastWave = wave;
    this.waveStart = now;
    this.waveStartScore = score;
    this.waveStartLives = lives;
  }

  waveSummary(now: number, score: number, lives: number): WaveSummary {
    return {
      wave: this.lastWave,
      score,
      lives,
      durationS: Math.round(((now - this.waveStart) / 1000) * 10) / 10,
    };
  }

  noteShot(): void {
    this.shotsFired++;
  }

  noteHit(scoreDelta: number): void {
    this.hits++;
    if (scoreDelta >= 200) this.roombaHits++;
  }

  noteLifeLost(): void {
    this.livesLost++;
  }

  noteBestScore(score: number): void {
    if (score > this.bestScore) this.bestScore = score;
  }

  sessionSummary(now: number): string {
    const durS = Math.round(((now - this.startTime) / 1000) * 10) / 10;
    const acc = this.shotsFired ? Math.round((this.hits / this.shotsFired) * 100) : 0;
    return (
      `games=${this.gamesStarted} best=${this.bestScore} ` +
      `shots=${this.shotsFired} hits=${this.hits} (${acc}%) ` +
      `roombas=${this.roombaHits} livesLost=${this.livesLost} ` +
      `duration=${durS}s`
    );
  }
}
