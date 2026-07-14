import assert from 'node:assert/strict';
import {test} from 'bun:test';

import {
  ATTACHMENT_MESSAGES,
  classifyAttachment,
  dataUrlByteLength,
  isBinaryText,
  isImageAttachment,
  isPdfAttachment,
  isTextAttachment,
  mimeTypeFromName,
  renderedPdfPageName,
  truncateAttachmentText,
} from '../../../apps/server/src/contracts/attachmentRules.ts';
import {ATTACHMENT_LIMITS} from '../../../apps/server/src/contracts/attachments.ts';

test('a file is classified by its MIME type even when the name says nothing', () => {
  // A pasted screenshot arrives as `image.png` with a type, but a downloaded
  // file can arrive named `photo` with only its type to go on. Reading the wrong
  // field silently degrades every check to extension matching.
  assert.equal(isImageAttachment({name: 'photo', mimeType: 'image/png'}), true);
  assert.equal(isPdfAttachment({name: 'report', mimeType: 'application/pdf'}), true);
  assert.equal(isTextAttachment({name: 'notes', mimeType: 'text/plain'}), true);
  assert.equal(classifyAttachment({name: 'photo', mimeType: 'image/png'}), 'image');
});

test('a file is classified by its extension when the MIME type is missing', () => {
  // Browsers routinely report an empty `File.type`.
  assert.equal(isImageAttachment({name: 'shot.JPEG'}), true);
  assert.equal(isPdfAttachment({name: 'Report.PDF'}), true);
  assert.equal(isTextAttachment({name: 'query.sql'}), true);
  assert.equal(classifyAttachment({name: 'notes.md'}), 'text');
});

test('an unsupported file is classified as nothing, not as text', () => {
  assert.equal(classifyAttachment({name: 'archive.zip', mimeType: 'application/zip'}), null);
  assert.equal(classifyAttachment({name: 'clip.mp4', mimeType: 'video/mp4'}), null);
  assert.equal(classifyAttachment({name: 'song.mp3', mimeType: 'audio/mpeg'}), null);
});

test('image beats PDF beats text, the order the composer checked them in', () => {
  assert.equal(classifyAttachment({name: 'scan.pdf', mimeType: 'image/png'}), 'image');
  assert.equal(classifyAttachment({name: 'notes.pdf'}), 'pdf');
});

test('a missing MIME type is inferred from the extension', () => {
  assert.equal(mimeTypeFromName('a.pdf'), 'application/pdf');
  assert.equal(mimeTypeFromName('a.PNG'), 'image/png');
  assert.equal(mimeTypeFromName('a.jpg'), 'image/jpeg');
  assert.equal(mimeTypeFromName('a.jpeg'), 'image/jpeg');
  assert.equal(mimeTypeFromName('a.webp'), 'image/webp');
  assert.equal(mimeTypeFromName('a.gif'), 'image/gif');
  assert.equal(mimeTypeFromName('a.txt'), undefined);
});

test('a NUL byte marks a file as binary, and ordinary text does not', () => {
  assert.equal(isBinaryText('hello\u0000world'), true);
  assert.equal(isBinaryText('hello world'), false);
  // A space is not a NUL byte. Confusing the two rejects every prose file.
  assert.equal(isBinaryText(' '), false);
  assert.equal(isBinaryText(''), false);
});

test('text is truncated only past the limit, and says so', () => {
  const exact = 'a'.repeat(ATTACHMENT_LIMITS.maxTextCharacters);
  assert.deepEqual(truncateAttachmentText(exact), {text: exact, truncated: false});

  const over = 'a'.repeat(ATTACHMENT_LIMITS.maxTextCharacters + 1);
  const result = truncateAttachmentText(over);
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, ATTACHMENT_LIMITS.maxTextCharacters);
});

test('a rendered PDF page is named after the document', () => {
  assert.equal(renderedPdfPageName('Report.pdf', 3), 'Report page 3.png');
  assert.equal(renderedPdfPageName('Report.PDF', 1), 'Report page 1.png');
  // A file called exactly ".pdf" still needs a name.
  assert.equal(renderedPdfPageName('.pdf', 1), 'PDF page 1.png');
});

test('base64 byte length accounts for padding, with or without a data URL prefix', () => {
  assert.equal(dataUrlByteLength('data:image/png;base64,AAAA'), 3);
  assert.equal(dataUrlByteLength('AAAA'), 3);
  assert.equal(dataUrlByteLength('AAA='), 2);
  assert.equal(dataUrlByteLength('AA=='), 1);
  assert.equal(dataUrlByteLength(''), 0);
});

test('the refusal messages name the file the user chose', () => {
  assert.equal(
    ATTACHMENT_MESSAGES.binaryFile('a.bin'),
    'a.bin looks like a binary file. Attach text, PDF, or image files only.',
  );
  assert.equal(ATTACHMENT_MESSAGES.emptyFile('a.txt'), 'a.txt is empty.');
  assert.match(ATTACHMENT_MESSAGES.truncated('a.txt'), /truncated to 200,000 characters/);
});
