import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/generated/models/upload_response.dart';
import 'package:nelle_agent/src/api/generated/models/upload_response_kind.dart';

void main() {
  test('the generated DTO parses a real POST /api/uploads response', () {
    // Captured verbatim from the running server, not written by hand. A DTO that only
    // ever parses fixtures its author invented proves nothing about the wire.
    final json =
        jsonDecode('''
      {
        "uploadId": "6b2fb02b-65a4-4a53-8d53-fa887bf488c7",
        "kind": "text",
        "name": "note.txt",
        "mimeType": "text/plain",
        "sizeBytes": 25,
        "textPreview": "hello from a real upload\\n",
        "warnings": []
      }
    ''')
            as Map<String, dynamic>;

    final upload = UploadResponse.fromJson(json);
    expect(upload.uploadId, '6b2fb02b-65a4-4a53-8d53-fa887bf488c7');
    expect(upload.kind, UploadResponseKind.text);
    expect(upload.sizeBytes, 25);
    expect(upload.warnings, isEmpty);
    // Absent for a non-PDF: `hasTextLayer` is a PDF fact, and `false` would mean "scan".
    expect(upload.hasTextLayer, isNull);
    expect(upload.pageCount, isNull);
  });

  test('a scanned PDF is the case the chip has to explain', () {
    final upload = UploadResponse.fromJson({
      'uploadId': 'u2',
      'kind': 'pdf',
      'name': 'scan.pdf',
      'sizeBytes': 90210,
      'pageCount': 6,
      'hasTextLayer': false,
      'warnings': <String>['scan.pdf was truncated to 200,000 characters.'],
    });

    expect(upload.kind, UploadResponseKind.pdf);
    // `false` means the server will send the model six page *images*, not text — which
    // costs ~1200 context tokens each, so the user has to be told.
    expect(upload.hasTextLayer, isFalse);
    expect(upload.pageCount, 6);
    expect(upload.warnings, hasLength(1));
    // A missing mime type is allowed by the contract; a client must not assume one.
    expect(upload.mimeType, isNull);
  });
}
