import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/hugging_face_model_result.dart';
import '../../api/generated/models/hugging_face_quant.dart';
import 'huggingface_repository.dart';
import 'router_models_notifier.dart';
import 'models_controller.dart';

/// Search Hugging Face and import a GGUF.
///
/// Every quant offered here is one llama.cpp would actually resolve: `mmproj`, `imatrix` and
/// `mtp-` files are its **accessories** — downloaded alongside whatever model you chose — and
/// offering one as a quant offers the accessory instead of the thing. That filtering is the
/// server's, and it is a faithful port of llama.cpp's own rule; the client renders what it is
/// given and adds no rule of its own.
class HuggingFaceScreen extends ConsumerStatefulWidget {
  const HuggingFaceScreen({super.key});

  @override
  ConsumerState<HuggingFaceScreen> createState() => _HuggingFaceScreenState();
}

class _HuggingFaceScreenState extends ConsumerState<HuggingFaceScreen> {
  final _query = TextEditingController(text: 'gemma gguf');
  List<HuggingFaceModelResult> _results = const [];
  bool _searching = false;
  String? _busyQuant;
  String? _notice;

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    setState(() {
      _searching = true;
      _notice = null;
    });
    try {
      final results = await ref
          .read(huggingFaceRepositoryProvider)
          .search(_query.text.trim());
      setState(() => _results = results);
    } catch (error) {
      setState(() => _notice = '$error');
    } finally {
      if (mounted) setState(() => _searching = false);
    }
  }

  Future<void> _use(String repoId, HuggingFaceQuant quant) async {
    setState(() {
      _busyQuant = '$repoId:${quant.quant}';
      _notice = null;
    });
    try {
      await ref
          .read(huggingFaceRepositoryProvider)
          .use(repoId: repoId, quant: quant.quant);
      await ref.read(modelCatalogProvider.notifier).refresh();
      // The server writes the preset and reloads the router, so the new section is *in* the
      // router's list -- but this client's cached copy predates the import. Refresh it, or the
      // model sits there saying "not listed yet" until something else happens to move it.
      await ref.read(routerModelsProvider.notifier).refresh();
      if (mounted) Navigator.of(context).pop();
    } catch (error) {
      setState(() => _notice = '$error');
    } finally {
      if (mounted) setState(() => _busyQuant = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return FScaffold(
      header: FHeader.nested(
        title: const Text('Add a model'),
        prefixes: [
          FHeaderAction.back(
            key: const ValueKey('k-hf-back'),
            onPress: Navigator.of(context).pop,
          ),
        ],
      ),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
            children: [
              FTextField(
                key: const ValueKey('k-hf-query'),
                control: FTextFieldControl.managed(controller: _query),
                label: const Text('Search Hugging Face'),
                hint: 'qwen coder gguf',
              ),
              const SizedBox(height: 8),
              FButton(
                key: const ValueKey('k-hf-search'),
                onPress: _searching ? null : _search,
                child: Text(_searching ? 'Searching…' : 'Search'),
              ),
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  // The server walks eight repositories over the network. Saying so beats a
                  // spinner that looks stuck.
                  'The server reads eight repositories from Hugging Face. This takes a few '
                  'seconds.',
                  style: TextStyle(
                    fontSize: 11,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),

              if (_notice != null)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text(
                    _notice!,
                    key: const ValueKey('k-hf-notice'),
                    style: TextStyle(
                      fontSize: 12,
                      color: theme.colorScheme.error,
                    ),
                  ),
                ),

              const SizedBox(height: 16),
              for (final result in _results)
                _Result(
                  key: ValueKey('k-hf-result-${result.id}'),
                  result: result,
                  busyQuant: _busyQuant,
                  onUse: (quant) => _use(result.id, quant),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Result extends StatelessWidget {
  const _Result({
    super.key,
    required this.result,
    required this.busyQuant,
    required this.onUse,
  });

  final HuggingFaceModelResult result;
  final String? busyQuant;
  final void Function(HuggingFaceQuant) onUse;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    // What Hugging Face already parsed out of the GGUF, on a request Nelle was making anyway. A
    // repo whose header it could not read says only what it can.
    final summary = [
      if (result.downloads != null) '${result.downloads!.toInt()} downloads',
      if (result.architecture != null) result.architecture!,
      if (result.parameterCount != null)
        '${(result.parameterCount! / 1e9).toStringAsFixed(1)}B params',
      if (result.contextTrain != null) '${result.contextTrain!.toInt()} ctx',
    ].join(' · ');

    return Padding(
      padding: const EdgeInsets.only(bottom: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            result.id,
            style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
          ),
          if (summary.isNotEmpty)
            Text(
              summary,
              style: TextStyle(
                fontSize: 11,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          const SizedBox(height: 8),
          for (final quant in result.quants)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Row(
                children: [
                  Expanded(
                    flex: 3,
                    child: Text(
                      quant.quant,
                      style: const TextStyle(
                        fontSize: 12,
                        fontFamily: 'monospace',
                      ),
                    ),
                  ),
                  Expanded(
                    flex: 3,
                    child: Text(
                      // More than one file is normal: a large quant is *sharded*
                      // (`…-00001-of-00002.gguf`) and llama.cpp downloads every shard.
                      '${formatBytes(quant.size)}'
                      '${quant.files.length > 1 ? ' · ${quant.files.length} files' : ''}',
                      style: TextStyle(
                        fontSize: 11,
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                  FButton(
                    key: ValueKey('k-hf-use-${result.id}-${quant.quant}'),
                    onPress: busyQuant != null ? null : () => onUse(quant),
                    child: Text(
                      busyQuant == '${result.id}:${quant.quant}'
                          ? 'Adding…'
                          : 'Use',
                    ),
                  ),
                ],
              ),
            ),
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              // Importing writes a models.ini section and returns at once. The weights arrive on
              // the model's *first load* -- which is why that load takes minutes and shows a
              // "Loading weights NN%" row in the transcript.
              'Adding a model does not download it. The weights arrive the first time it loads.',
              style: TextStyle(
                fontSize: 10,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
