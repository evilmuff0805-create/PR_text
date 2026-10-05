import assert from 'node:assert/strict';
import test from 'node:test';
import { processSegmentsWithTiming } from '../src/services/postprocess.js';
import { filterSilentSegments, mergeShortSegments } from '../src/services/transcription-processing.js';
import { generateASS, generateSRT } from '../src/services/subtitle.js';

test('Korean diarized correction and export preserve pauses while keeping quoted questions together', async () => {
  const source = [
    { start: 10, end: 10.3, text: '네', speaker: 0 },
    { start: 10.5, end: 16.2, text: '아니 아빠한테도 전화는 드렸는데 그냥 뭐라고 그러셨더라?', speaker: 0 },
    { start: 18, end: 18.5, text: '그랬죠', speaker: 1 },
  ];
  const original = structuredClone(source);
  const filtered = mergeShortSegments(filterSilentSegments(source));
  // Keep the real Korean correction mapping while supplying an offline corrector.
  const corrected = await processSegmentsWithTiming(filtered, 'ko', async (text) => text);
  assert.equal(corrected.timings.eligible, true);
  assert.deepEqual(corrected.segments, original);
  const colors = { 0: '#39FF14', 1: '#FFE600' };

  const blocks = generateSRT(corrected.segments, colors).split('\n\n').slice(1);
  assert.equal(blocks.length, 4);
  assert.equal(blocks[0], '2\n00:00:10,000 --> 00:00:10,300\n<font color="#39FF14">네</font>');
  assert.match(blocks[1], /^3\n00:00:10,500 --> /);
  assert.match(blocks[1], /<font color="#39FF14">아니 아빠한테도 전화는 드렸는데<\/font>$/);
  assert.match(blocks[2], / --> 00:00:16,200\n<font color="#39FF14">그냥 뭐라고 그러셨더라\?<\/font>$/);
  assert.equal(blocks[3], '5\n00:00:18,000 --> 00:00:18,500\n<font color="#FFE600">그랬죠</font>');

  const ass = generateASS(corrected.segments, {}, colors);
  assert.match(ass, /Dialogue: 0,0:00:10\.00,0:00:10\.30,Speaker0/);
  assert.match(ass, /Dialogue: 0,0:00:10\.50,/);
  assert.match(ass, /,Speaker0,,0,0,0,,그냥 뭐라고 그러셨더라\?/);
  assert.match(ass, /Dialogue: 0,0:00:18\.00,0:00:18\.50,Speaker1/);
  assert.deepEqual(source, original);
});
