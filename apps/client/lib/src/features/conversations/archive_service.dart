import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

/// Getting a `.nelle-chat.zip` **out of** the app, and back in.
///
/// The interesting half is out, and it splits by platform for a reason that is not a preference:
///
/// **`file_selector` cannot save a file on a phone.** `file_selector_android` implements exactly
/// three methods — `openFile`, `openFiles`, `getDirectoryPath` — and `getSaveLocation` is
/// implemented on linux/windows/macOS/web and **nowhere else**, where the platform interface's
/// default throws `UnimplementedError`. (`getDirectoryPath` is not a way around it either: on
/// Android it hands back a SAF content URI, which `dart:io` cannot write to.)
///
/// So: a **Save dialog** on the desktop, and the **OS share sheet** on mobile — which is the
/// idiomatic mobile affordance anyway, and the only one that actually reaches the user's storage.
/// `share_plus` is plain platform channels, not one of the cargokit-backed plugins that cannot
/// build under Gradle 9 (see `super_clipboard` in AGENTS.md).
///
/// **Import is uniform**: `openFiles` works everywhere, including Android, where it opens the SAF
/// picker.
abstract class ArchiveService {
  /// Puts [bytes] somewhere the user can find them, and answers where — or `null` if they backed
  /// out. The string is for a confirmation, not a path to open: on mobile there is no path.
  Future<String?> save(Uint8List bytes, String filename);

  /// Picks a `.nelle-chat.zip` and reads it. `null` if the user backed out.
  Future<Uint8List?> pick();
}

/// The desktop half: a real Save dialog, a real path.
class DesktopArchiveService implements ArchiveService {
  const DesktopArchiveService();

  @override
  Future<String?> save(Uint8List bytes, String filename) async {
    final location = await getSaveLocation(
      suggestedName: filename,
      acceptedTypeGroups: const [_archiveTypeGroup],
    );
    if (location == null) return null;
    await File(location.path).writeAsBytes(bytes, flush: true);
    return location.path;
  }

  @override
  Future<Uint8List?> pick() => _pickArchive();
}

/// The mobile half: the share sheet.
///
/// The bytes go to a temporary file first because that is what the share sheet takes — and the
/// name matters, since it is what the user will see in Files, or Drive, or the mail they send it
/// in. The temp copy is the OS's to clean up; deleting it here would race the share sheet, which
/// reads the file *after* this future completes.
class MobileArchiveService implements ArchiveService {
  const MobileArchiveService();

  @override
  Future<String?> save(Uint8List bytes, String filename) async {
    final directory = await getTemporaryDirectory();
    final file = File(p.join(directory.path, filename));
    await file.writeAsBytes(bytes, flush: true);

    final result = await SharePlus.instance.share(
      ShareParams(
        files: [XFile(file.path, mimeType: 'application/zip', name: filename)],
        fileNameOverrides: [filename],
      ),
    );
    // Dismissing the sheet is backing out, not a failure.
    return result.status == ShareResultStatus.dismissed ? null : filename;
  }

  @override
  Future<Uint8List?> pick() => _pickArchive();
}

const _archiveTypeGroup = XTypeGroup(
  label: 'Nelle chat archive',
  extensions: ['zip'],
  // A UTI and a MIME type as well: on macOS/iOS an extension alone greys out every file, and on
  // Android the picker filters by MIME.
  uniformTypeIdentifiers: ['public.zip-archive'],
  mimeTypes: ['application/zip'],
);

Future<Uint8List?> _pickArchive() async {
  final file = await openFile(acceptedTypeGroups: const [_archiveTypeGroup]);
  if (file == null) return null;
  return file.readAsBytes();
}

/// Desktop saves to a path; mobile shares. There is no third option, because there is no third
/// way to get a file out of a phone.
final archiveServiceProvider = Provider<ArchiveService>((ref) {
  if (kIsWeb) {
    // `getSaveLocation` *is* implemented on web (it downloads), so the desktop path is right.
    return const DesktopArchiveService();
  }
  return switch (defaultTargetPlatform) {
    TargetPlatform.android || TargetPlatform.iOS => const MobileArchiveService(),
    _ => const DesktopArchiveService(),
  };
});
