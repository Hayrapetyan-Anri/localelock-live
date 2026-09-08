import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSrt, cuesToSrt, formatTimecode, sha256Hex, srtFilename, slugifyTitle } from '../src/domain/srt.js';

test('timecode formatting', () => {
  assert.equal(formatTimecode(0), '00:00:00,000');
  assert.equal(formatTimecode(171_000), '00:02:51,000');
  assert.equal(formatTimecode(3_600_000 + 61_001), '01:01:01,001');
});

test('SRT is deterministic, sorted by start, ends with one newline, and hashes stably', () => {
  const cues = [
    { cue_id: 2, start_ms: 2000, end_ms: 3000, text: 'Segundo\nlínea dos' },
    { cue_id: 1, start_ms: 0, end_ms: 1000, text: 'Primero' },
  ];
  const srt = cuesToSrt(cues);
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,000\nPrimero\n\n2\n00:00:02,000 --> 00:00:03,000\nSegundo\nlínea dos\n');
  assert.ok(srt.endsWith('\n') && !srt.endsWith('\n\n'), 'single trailing newline');
  assert.ok(!srt.startsWith('﻿'));
  assert.ok(!srt.includes('\r'));
  assert.equal(cuesToSrt([...cues].reverse()), srt);
  const a = buildSrt(cues, 'The Last Tram', 'es', 8);
  const b = buildSrt([...cues].reverse(), 'The Last Tram', 'es', 8);
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.sha256, sha256Hex(new TextEncoder().encode(srt)));
  assert.equal(a.filename, 'the-last-tram.es.v8.approved.srt');
  assert.equal(a.cue_count, 2);
  assert.equal(a.byteLength, Buffer.byteLength(srt, 'utf8'));
});

test('filename + slug helpers', () => {
  assert.equal(slugifyTitle('The Last Tram'), 'the-last-tram');
  assert.equal(slugifyTitle('Último Tranvía!'), 'ultimo-tranvia');
  assert.equal(srtFilename('the-last-tram', 'es', 8), 'the-last-tram.es.v8.approved.srt');
});
