import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/features/attachments/attachment_draft.dart';

import '../helpers/fake_dio.dart';

Map<String, dynamic> _upload(String id, {String name = 'note.txt'}) => {
  'uploadId': id,
  'kind': 'text',
  'name': name,
  'mimeType': 'text/plain',
  'sizeBytes': 12,
  'warnings': <String>[],
};

void main() {
  test('an added file is uploaded and staged for THIS conversation', () async {
    final calls = <RequestOptions>[];
    final c = ProviderContainer(
      overrides: [
        dioProvider.overrideWithValue(
          stubDio((o) {
            calls.add(o);
            return jsonResponse(_upload('u1'), status: 201);
          }),
        ),
      ],
    );
    addTearDown(c.dispose);

    await c
        .read(attachmentDraftProvider('chat-a').notifier)
        .addBytes(
          bytes: Uint8List.fromList(utf8.encode('hello')),
          filename: 'note.txt',
          mimeType: 'text/plain',
        );

    final draft = c.read(attachmentDraftProvider('chat-a'));
    expect(draft.uploadIds, ['u1']);
    expect(draft.uploading, 0);
    expect(calls.single.path, '/api/uploads');
    // The conversation goes with the bytes: the server gates the image on *that*
    // conversation's model, not on whichever model is globally active.
    final form = calls.single.data! as FormData;
    expect(form.fields.map((f) => '${f.key}=${f.value}'), contains('conversationId=chat-a'));
    expect(form.files.single.key, 'file');

    // And another conversation's draft is untouched -- an image staged in one chat has
    // no business appearing in another, whose model may not even see images.
    expect(c.read(attachmentDraftProvider('chat-b')).uploads, isEmpty);
  });

  test('the server refusal is surfaced verbatim, because it names the file', () async {
    final c = ProviderContainer(
      overrides: [
        dioProvider.overrideWithValue(
          stubDio(
            (o) => jsonResponse({
              'error': {
                'code': 'unsupported_attachment',
                'message':
                    'scan.pdf has no text layer, so it can only be read as page images, '
                    'and the selected model cannot read images. Choose a vision model.',
              },
            }, status: 400),
          ),
        ),
      ],
    );
    addTearDown(c.dispose);

    await c
        .read(attachmentDraftProvider('c').notifier)
        .addBytes(
          bytes: Uint8List.fromList([1, 2, 3]),
          filename: 'scan.pdf',
          mimeType: 'application/pdf',
        );

    final draft = c.read(attachmentDraftProvider('c'));
    expect(draft.uploads, isEmpty);
    expect(draft.uploading, 0);
    expect(draft.error, contains('scan.pdf'));
    expect(draft.error, contains('Choose a vision model'));
  });

  test('removing a chip deletes the upload rather than leaving it to be swept', () async {
    final deleted = <String>[];
    final c = ProviderContainer(
      overrides: [
        dioProvider.overrideWithValue(
          stubDio((o) {
            if (o.method == 'DELETE') {
              deleted.add(o.path);
              return jsonResponse({'ok': true});
            }
            return jsonResponse(_upload('u1'), status: 201);
          }),
        ),
      ],
    );
    addTearDown(c.dispose);

    final notifier = c.read(attachmentDraftProvider('c').notifier);
    await notifier.addBytes(
      bytes: Uint8List.fromList([1]),
      filename: 'note.txt',
    );
    await notifier.remove('u1');

    expect(c.read(attachmentDraftProvider('c')).uploads, isEmpty);
    expect(deleted, ['/api/uploads/u1']);
  });

  test('clear() empties the draft WITHOUT deleting: the uploads are a message now', () async {
    final deleted = <String>[];
    final c = ProviderContainer(
      overrides: [
        dioProvider.overrideWithValue(
          stubDio((o) {
            if (o.method == 'DELETE') {
              deleted.add(o.path);
            }
            return jsonResponse(_upload('u1'), status: 201);
          }),
        ),
      ],
    );
    addTearDown(c.dispose);

    final notifier = c.read(attachmentDraftProvider('c').notifier);
    await notifier.addBytes(bytes: Uint8List.fromList([1]), filename: 'a.txt');
    notifier.clear();

    expect(c.read(attachmentDraftProvider('c')).uploads, isEmpty);
    // Deleting here would destroy the attachments of the message that was just sent.
    expect(deleted, isEmpty);
  });
}
