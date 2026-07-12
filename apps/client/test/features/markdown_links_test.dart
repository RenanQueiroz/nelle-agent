import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/features/chat/markdown_links.dart';

void main() {
  group('a link in model output is only opened if its scheme was vetted', () {
    test('the web and mail are fine', () {
      expect(isSafeLink('https://dart.dev'), isTrue);
      expect(isSafeLink('http://127.0.0.1:8787/api/health'), isTrue);
      expect(isSafeLink('mailto:someone@example.com'), isTrue);
      // Scheme comparison is case-insensitive, per RFC 3986.
      expect(isSafeLink('HTTPS://dart.dev'), isTrue);
      expect(isSafeLink('  https://dart.dev  '), isTrue);
    });

    test('anything that reaches off the web is refused', () {
      // The visible text of a markdown link says whatever the model wants; the target
      // is what actually runs. An allowlist means an unvetted scheme simply does
      // nothing, rather than handing the OS a local file or another app's deep link.
      expect(isSafeLink('file:///etc/passwd'), isFalse);
      expect(isSafeLink('javascript:alert(1)'), isFalse);
      expect(isSafeLink('data:text/html;base64,PHNjcmlwdD4='), isFalse);
      expect(isSafeLink('tel:+15551234'), isFalse);
      expect(isSafeLink('some-app://do/something'), isFalse);
    });

    test('a link with nowhere to go is refused', () {
      expect(isSafeLink('/relative/path'), isFalse);
      expect(isSafeLink('dart.dev'), isFalse);
      expect(isSafeLink(''), isFalse);
    });
  });
}
