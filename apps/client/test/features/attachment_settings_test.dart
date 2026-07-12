import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/features/settings/attachment_settings.dart';

import '../helpers/fake_dio.dart';

ProviderContainer _container(ResponseBody Function(RequestOptions) responder) {
  final c = ProviderContainer(
    overrides: [dioProvider.overrideWithValue(stubDio(responder))],
  );
  addTearDown(c.dispose);
  return c;
}

void main() {
  test('the threshold comes from the server, not from a constant', () async {
    final c = _container(
      (o) => jsonResponse({
        'pasteToFileCharacters': 100,
        'maxImageMegapixels': 1.5,
      }),
    );

    final settings = await c.read(attachmentSettingsProvider.future);
    expect(settings.pasteToFileCharacters, 100);
    expect(settings.maxImageMegapixels, 1.5);
    expect(settings.shouldPasteToFile(101), isTrue);
    expect(settings.shouldPasteToFile(100), isFalse);
  });

  test('until the server answers, every paste stays in the message', () async {
    // The client ships no copy of the default (2500). A stale constant would silently
    // turn someone's paste into a file attachment against a server that had disabled it.
    const unknown = AttachmentSettings();
    expect(unknown.pasteToFileCharacters, isNull);
    expect(unknown.shouldPasteToFile(1000000), isFalse);
  });

  test('0 disables paste-to-file, exactly as the setting says', () async {
    const off = AttachmentSettings(pasteToFileCharacters: 0);
    expect(off.shouldPasteToFile(1000000), isFalse);
  });

  test('a settings read that fails leaves the threshold unknown, not broken', () async {
    // Nobody should be unable to type because a settings request 500'd.
    final c = _container((o) => jsonResponse({'error': 'nope'}, status: 500));

    final settings = await c.read(attachmentSettingsProvider.future);
    expect(settings.pasteToFileCharacters, isNull);
    expect(settings.shouldPasteToFile(1000000), isFalse);
  });
}
