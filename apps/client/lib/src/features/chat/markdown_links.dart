import 'package:url_launcher/url_launcher.dart';

/// Schemes a link in *model output* may open.
///
/// A markdown link is text the model wrote, and handing it to the OS is handing the OS
/// something untrusted. `file:` would open a local file, and a custom scheme can launch
/// another installed application with an attacker-chosen payload — from a link whose
/// visible text says something else entirely. So this is an allowlist, not a blocklist:
/// a scheme nobody vetted does nothing.
const _allowedSchemes = {'http', 'https', 'mailto'};

/// Whether [href] is something we are willing to hand to the operating system.
///
/// Pure, so the rule can be tested without a platform channel.
bool isSafeLink(String href) {
  final url = Uri.tryParse(href.trim());
  if (url == null || !url.hasScheme) {
    // A relative link has nowhere to go in a chat transcript.
    return false;
  }
  return _allowedSchemes.contains(url.scheme.toLowerCase());
}

/// Opens [href] if its scheme is allowed. Returns false when it was refused or the
/// platform could not open it.
Future<bool> openMarkdownLink(String href) async {
  if (!isSafeLink(href)) {
    return false;
  }
  final url = Uri.parse(href.trim());
  try {
    return await launchUrl(url, mode: LaunchMode.externalApplication);
  } catch (_) {
    // No handler installed, or the platform refused. Not worth an exception in a chat.
    return false;
  }
}
