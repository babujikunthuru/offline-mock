'use strict';

const STOPWORDS = new Set(
  [
    'a',
    'about',
    'after',
    'all',
    'also',
    'am',
    'an',
    'and',
    'any',
    'are',
    'as',
    'at',
    'be',
    'because',
    'been',
    'before',
    'being',
    'between',
    'both',
    'but',
    'by',
    'can',
    'could',
    'did',
    'do',
    'does',
    'each',
    'for',
    'from',
    'get',
    'had',
    'has',
    'have',
    'he',
    'her',
    'here',
    'hers',
    'him',
    'his',
    'how',
    'i',
    'if',
    'in',
    'into',
    'is',
    'it',
    'its',
    'just',
    'may',
    'me',
    'more',
    'most',
    'must',
    'my',
    'no',
    'not',
    'of',
    'on',
    'one',
    'or',
    'our',
    'out',
    'over',
    'same',
    'she',
    'should',
    'so',
    'some',
    'such',
    'than',
    'that',
    'the',
    'their',
    'them',
    'then',
    'there',
    'these',
    'they',
    'this',
    'those',
    'through',
    'to',
    'too',
    'under',
    'up',
    'us',
    'very',
    'was',
    'we',
    'were',
    'what',
    'when',
    'where',
    'which',
    'while',
    'who',
    'will',
    'with',
    'would',
    'you',
    'your',
  ],
);

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function firstSentence(text) {
  const result = (tokenizeSentences(text)[0] || text).replace(/\s+/g, ' ').trim();
  return result.length > 80 ? `${result.slice(0, 77).trimEnd()}...` : result;
}

function tokenizeSentences(text) {
  const sentences = [];
  const protectedText = text
    .replace(/\b(?:e\.g|i\.e|mr|mrs|ms|dr|prof|vs|etc)\./gi, (match) =>
      match.replace(/\./g, '\uE000'),
    )
    .replace(/(\d)\.(\d)/g, '$1\uE000$2');
  const pattern = /```[\s\S]*?```|[^.!?]+(?:[.!?]+["')\]]*|$)/g;
  for (const match of protectedText.matchAll(pattern)) {
    const sentence = match[0].replace(/\uE000/g, '.').trim();
    if (sentence) {
      sentences.push(sentence);
    }
  }
  return sentences;
}

function splitTopics(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  let current = null;
  let foundHeading = false;

  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line.trim());
    if (heading) {
      foundHeading = true;
      if (current && current.text.trim()) {
        sections.push(current);
      }
      current = { topic: heading[2].trim(), text: '' };
    } else if (current) {
      current.text += `${line}\n`;
    } else if (line.trim()) {
      current = { topic: '', text: `${line}\n` };
    } else if (current) {
      current.text += '\n';
    }
  }

  if (current && current.text.trim()) {
    sections.push(current);
  }

  if (foundHeading) {
    return sections.map((section) => ({
      topic: section.topic || firstSentence(section.text) || 'Introduction',
      paragraphs: section.text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean),
    }));
  }

  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => ({
      topic: firstSentence(paragraph) || 'Untitled topic',
      paragraphs: [paragraph],
    }));
}

function getTerms(text) {
  return (text.toLowerCase().match(/[a-z][a-z0-9'-]*/g) || []).filter(
    (term) => term.length > 1 && !STOPWORDS.has(term),
  );
}

function assignKeywords(chunks) {
  const documentFrequency = new Map();
  const termsByChunk = chunks.map((chunk) => {
    const terms = getTerms(chunk.text);
    for (const term of new Set(terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
    return terms;
  });

  return chunks.map((chunk, index) => {
    const terms = termsByChunk[index];
    const termFrequency = new Map();
    for (const term of terms) {
      termFrequency.set(term, (termFrequency.get(term) || 0) + 1);
    }

    const ranked = Array.from(termFrequency, ([term, frequency]) => ({
      term,
      score:
        (frequency / Math.max(terms.length, 1)) *
        (Math.log((chunks.length + 1) / (documentFrequency.get(term) + 1)) + 1),
    }))
      .sort((left, right) => right.score - left.score || left.term.localeCompare(right.term))
      .slice(0, 8)
      .map(({ term }) => term);

    return {
      ...chunk,
      keywords: ranked,
      hasDefinition:
        /\b(?:is a|is an|refers to|is defined as|means)\b/i.test(chunk.text),
      hasExample:
        /\b(?:for example|e\.g\.|for instance)\b/i.test(chunk.text) ||
        /```/.test(chunk.text),
    };
  });
}

function chunkSentences(sentences) {
  const grouped = [];
  let current = [];
  let currentWords = 0;

  for (const sentence of sentences) {
    const count = wordCount(sentence.text);
    if (count > 200) {
      const error = new Error('A single sentence exceeds the 200-word chunk limit.');
      error.code = 'CONTENT_SENTENCE_TOO_LONG';
      error.statusCode = 400;
      throw error;
    }
    if (currentWords + count > 200 && current.length) {
      grouped.push(current);
      current = [];
      currentWords = 0;
    }
    current.push(sentence);
    currentWords += count;
  }
  if (current.length) {
    grouped.push(current);
  }

  if (
    grouped.length &&
    wordCount(grouped[grouped.length - 1].map((item) => item.text).join(' ')) < 80
  ) {
    const last = grouped[grouped.length - 1];
    const previous = grouped[grouped.length - 2];
    if (previous) {
      if (
        wordCount(
          previous.map((item) => item.text).join(' ') +
            ' ' +
            last.map((item) => item.text).join(' '),
        ) <= 200
      ) {
        grouped.splice(grouped.length - 2, 2, [...previous, ...last]);
      } else {
        while (
          wordCount(last.map((item) => item.text).join(' ')) < 80 &&
          previous.length > 1
        ) {
          const moved = previous.pop();
          last.unshift(moved);
        }
        if (
          wordCount(last.map((item) => item.text).join(' ')) > 200 ||
          wordCount(previous.map((item) => item.text).join(' ')) < 80
        ) {
          const error = new Error(
            'The note cannot be divided into chunks of 80 to 200 words without cutting a sentence.',
          );
          error.code = 'CONTENT_CANNOT_BE_CHUNKED';
          error.statusCode = 400;
          throw error;
        }
      }
    } else {
      const error = new Error('Notes must contain at least 80 words to create a chunk.');
      error.code = 'CONTENT_TOO_SHORT';
      error.statusCode = 400;
      throw error;
    }
  }

  for (const group of grouped) {
    const count = wordCount(group.map((item) => item.text).join(' '));
    if (count < 80 || count > 200) {
      const error = new Error(
        'The note cannot be divided into chunks of 80 to 200 words without cutting a sentence.',
      );
      error.code = 'CONTENT_CANNOT_BE_CHUNKED';
      error.statusCode = 400;
      throw error;
    }
  }

  return grouped.map((group) => ({
    topic: group[0].topic,
    text: group.map((item) => item.text).join(' '),
  }));
}

function parseNote(text) {
  if (typeof text !== 'string' || !text.trim()) {
    const error = new Error('The document contains no readable text.');
    error.code = 'EMPTY_DOCUMENT';
    error.statusCode = 400;
    throw error;
  }

  const topics = splitTopics(text);
  const sentences = [];
  for (const topic of topics) {
    for (const paragraph of topic.paragraphs) {
      for (const sentence of tokenizeSentences(paragraph)) {
        sentences.push({ topic: topic.topic, text: sentence });
      }
    }
  }

  if (!sentences.length) {
    const error = new Error('The document contains no readable text.');
    error.code = 'EMPTY_DOCUMENT';
    error.statusCode = 400;
    throw error;
  }

  const chunks = assignKeywords(chunkSentences(sentences));
  return {
    topics: topics.map(({ topic }) => topic),
    chunks,
  };
}

module.exports = { parseNote, splitTopics, tokenizeSentences, wordCount };
