'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseNote, wordCount } = require('../services/noteParser');

function sentences(count, prefix) {
  return Array.from(
    { length: count },
    (_, index) =>
      `${prefix} example ${index + 1} explains a useful concept clearly for learners today.`,
  ).join(' ');
}

test('parses Markdown headings, detects definitions and examples, and ranks keywords', () => {
  const parsed = parseNote(
    `# Networking\nA network is a group of connected devices. ${sentences(10, 'Network')} For example, devices can share information.\n\n# Storage\nA database refers to organized information. ${sentences(10, 'Storage')} For example, records can be searched.`,
  );

  assert.deepEqual(parsed.topics, ['Networking', 'Storage']);
  assert.ok(parsed.chunks.length > 0);
  assert.ok(parsed.chunks.every(({ text }) => wordCount(text) >= 80 && wordCount(text) <= 200));
  assert.ok(parsed.chunks.some(({ hasDefinition }) => hasDefinition));
  assert.ok(parsed.chunks.some(({ hasExample }) => hasExample));
  assert.ok(parsed.chunks.every(({ keywords }) => keywords.length <= 8));
  assert.ok(parsed.chunks.every(({ keywords }) => keywords.every((word) => word === word.toLowerCase())));
});

test('uses paragraph first sentences as topics when headings are absent', () => {
  const firstParagraph = `A process is a running program. ${sentences(12, 'Process')}`;
  const secondParagraph = `Memory is temporary working space. ${sentences(12, 'Memory')}`;
  const parsed = parseNote(`${firstParagraph}\n\n${secondParagraph}`);

  assert.equal(parsed.topics.length, 2);
  assert.equal(parsed.topics[0], 'A process is a running program.');
  assert.equal(parsed.topics[1], 'Memory is temporary working space.');
  assert.ok(parsed.chunks.every(({ text }) => wordCount(text) >= 80 && wordCount(text) <= 200));
});

test('splits long notes at sentence boundaries and balances the final chunk', () => {
  const parsed = parseNote(`# Long Note\n${sentences(30, 'Sentence')}`);
  const sourceSentences = new Set(sentences(30, 'Sentence').match(/[^.!?]+[.!?]/g).map((text) => text.trim()));

  assert.ok(parsed.chunks.length >= 2);
  assert.ok(parsed.chunks.every(({ text }) => wordCount(text) >= 80 && wordCount(text) <= 200));
  for (const chunk of parsed.chunks) {
    for (const sentence of chunk.text.match(/[^.!?]+[.!?]/g) || []) {
      assert.ok(sourceSentences.has(sentence.trim()), `unexpected sentence fragment: ${sentence}`);
    }
  }
});

test('rejects documents too short to produce a valid chunk', () => {
  assert.throws(() => parseNote('# Short\nOnly a few words.'), {
    code: 'CONTENT_TOO_SHORT',
  });
});
