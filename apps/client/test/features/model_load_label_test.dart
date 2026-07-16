import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/features/chat/chat_controller.dart';
import 'package:nelle_agent/src/features/chat/chat_view.dart';

/// Every wording the transcript's model-load line can show. A first load *downloads* the
/// weights — multi-GB, minutes on an ordinary connection — and the original bug was this line
/// saying "Loading weights…" for all of it, indistinguishable from a hung load.
void main() {
  test('nothing known yet is the generic placeholder', () {
    expect(modelLoadLabel(null), 'Loading weights…');
    expect(modelLoadLabel(const ModelLoad()), 'Loading weights…');
  });

  test('a download with totals shows percent and both sizes', () {
    expect(
      modelLoadLabel(
        const ModelLoad(
          phase: 'downloading',
          downloadedBytes: 1100000000,
          totalBytes: 2620000000,
          progress: 0.42,
        ),
      ),
      'Downloading model… 42% (1.1 GB / 2.6 GB)',
    );
  });

  test('a download with no total shows bytes and never invents a percent', () {
    // What a b10021-class router yields: the server measures the repo dir on disk, so it
    // has bytes but no total.
    expect(
      modelLoadLabel(
        const ModelLoad(phase: 'downloading', downloadedBytes: 890000000),
      ),
      'Downloading model… 890 MB',
    );
  });

  test('a download with nothing measured yet still says what is happening', () {
    expect(
      modelLoadLabel(const ModelLoad(phase: 'downloading')),
      'Downloading model…',
    );
  });

  test('the loading phase keeps its stage percentage', () {
    expect(
      modelLoadLabel(const ModelLoad(phase: 'loading', progress: 0.77)),
      'Loading weights 77%',
    );
    expect(modelLoadLabel(const ModelLoad(phase: 'loading')), 'Loading weights…');
  });

  test('an unknown phase from a newer server degrades to the generic placeholder', () {
    expect(
      modelLoadLabel(const ModelLoad(phase: 'verifying', progress: 0.5)),
      'Loading weights 50%',
    );
  });

  test('a percent computed from bytes when the server sent no fraction', () {
    expect(
      modelLoadLabel(
        const ModelLoad(
          phase: 'downloading',
          downloadedBytes: 750000000,
          totalBytes: 1500000000,
        ),
      ),
      'Downloading model… 50% (750 MB / 1.5 GB)',
    );
  });
}
