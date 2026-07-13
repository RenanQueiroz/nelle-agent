import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/configured_model.dart';
import '../../api/generated/models/invalid_model_param.dart';
import '../../api/generated/models/model_param_warning.dart';
import '../../api/generated/models/llama_router_model.dart';
import 'active_runs.dart';
import 'llama_repository.dart';
import 'models_controller.dart';
import 'models_repository.dart';
import 'param_editor.dart';
import 'router_models_notifier.dart';

/// One model: what it is, what it costs, and what can be done to it.
class ModelDetailScreen extends ConsumerStatefulWidget {
  const ModelDetailScreen({super.key, required this.modelId});

  final String modelId;

  @override
  ConsumerState<ModelDetailScreen> createState() => _ModelDetailScreenState();
}

class _ModelDetailScreenState extends ConsumerState<ModelDetailScreen> {
  late final TextEditingController _name;
  Map<String, String> _params = const {};
  List<InvalidModelParam> _invalid = const [];
  List<ModelParamWarning> _warnings = const [];
  String? _busy;
  String? _notice;

  @override
  void initState() {
    super.initState();
    final model = modelById(
      ref.read(modelCatalogProvider).valueOrNull,
      widget.modelId,
    );
    _name = TextEditingController(text: model?.name ?? '');
    _params = Map.of(model?.params.extra ?? const {});
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _run(String key, Future<void> Function() action) async {
    // Busy is keyed **per model and per action**, never a shared string. `apps/web` used a bare
    // `'activate'`, so clicking one row spun every row's button.
    setState(() {
      _busy = key;
      _notice = null;
      // Both belong to the *previous* save. A warning left standing through a refused save
      // would describe a value that is no longer in force.
      _warnings = const [];
    });
    try {
      await action();
      setState(() => _invalid = const []);
    } on InvalidModelParamsException catch (error) {
      // Every offending key at once, so a form with three typos lights up three rows.
      setState(() => _invalid = error.invalidParams);
    } catch (error) {
      setState(() => _notice = '$error');
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final catalog = ref.watch(modelCatalogProvider).valueOrNull;
    final model = modelById(catalog, widget.modelId);
    final theme = Theme.of(context);

    if (model == null) {
      // Gone -- deleted, here or elsewhere. **Not a spinner**: a spinner animates for ever, so
      // the screen would sit there pretending to load a model that no longer exists (and, in a
      // test, `pumpAndSettle` never settles, which is how this was found).
      return const FScaffold(child: SizedBox.shrink());
    }

    // `null` means llama.cpp is stopped. An **empty list** means it is running and has told us
    // nothing yet — two different things, and defaulting the first to `const []` erased the
    // difference. See `routerStatusLabel`.
    final routerModels = ref.watch(routerModelsProvider).valueOrNull;
    final router = routerModels
        ?.where((item) => item.sectionId == model.id)
        .firstOrNull;
    final llamaRunning = routerModels != null;
    final isActive = model.id == catalog?.activeModelId;
    // **A model being answered on must not be touched.** Unloading evicts the weights the reply
    // is streaming out of, saving rewrites `models.ini` and reloads the router under the run,
    // and deleting removes the section entirely. The user is watching the answer all three would
    // kill. `busy` therefore locks them — and locks nothing else: renaming, making it the default
    // and duplicating are `models.ini` bookkeeping and never reach the running model.
    final busy = ref.watch(activeRunModelIdsProvider).contains(model.id);

    return FScaffold(
      header: FHeader.nested(
        title: Text(model.name, maxLines: 1, overflow: TextOverflow.ellipsis),
        prefixes: [
          FHeaderAction.back(
            key: const ValueKey('k-model-back'),
            onPress: Navigator.of(context).pop,
          ),
        ],
      ),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
            children: [
              if (_notice != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text(
                    _notice!,
                    key: const ValueKey('k-model-notice'),
                    style: TextStyle(
                      fontSize: 12,
                      color: theme.colorScheme.error,
                    ),
                  ),
                ),

              _Facts(model: model, router: router, listed: routerModels),
              const SizedBox(height: 20),

              const _Label('Name'),
              FTextField(
                key: const ValueKey('k-model-name'),
                control: FTextFieldControl.managed(controller: _name),
              ),
              const SizedBox(height: 16),

              _PinSwitch(
                model: model,
                busy: _busy == 'pin',
                onChanged: (pinned) => _run(
                  'pin',
                  () => ref
                      .read(modelCatalogProvider.notifier)
                      .setPinned(model.id, pinned),
                ),
              ),
              const SizedBox(height: 20),

              const _Label('Parameters'),
              Text(
                // The client never validates a key: an unknown key is fatal to llama-server, and
                // only its own `--help` knows which are which.
                'Written to models.ini. Sampling lives here — temp, top-k, min-p, seed — '
                'because Nelle sends none in its requests.',
                style: TextStyle(
                  fontSize: 11,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 8),
              ParamEditor(
                // A STABLE key. Keying on `params.hashCode` looks right and is a trap: Dart's
                // Map.hashCode is identity-based, so every catalog refresh would mint a new key,
                // destroy the editor and eat what the user was typing. `didUpdateWidget`
                // re-seeds on a real content change instead.
                key: const ValueKey('k-model-params'),
                initial: model.params.extra,
                invalidParams: _invalid,
                warnings: _warnings,
                onChanged: (params) => _params = params,
              ),
              const SizedBox(height: 12),
              // A run in flight blocks the save: it rewrites `models.ini` and reloads the
              // router, which would restart the model the answer is streaming out of.
              if (busy) const _RunLock(),
              FButton(
                key: const ValueKey('k-model-save'),
                onPress: _busy != null || busy
                    ? null
                    : () => _run('save', () async {
                        // The save *lands* and may still have something to say — a context
                        // past the model's trained window works only with RoPE/YaRN. Keep it.
                        final warnings = await ref
                            .read(modelCatalogProvider.notifier)
                            .saveParams(model.id, _params);
                        await ref
                            .read(modelCatalogProvider.notifier)
                            .rename(model.id, _name.text.trim());
                        if (mounted) setState(() => _warnings = warnings);
                      }),
                child: Text(_busy == 'save' ? 'Saving…' : 'Save'),
              ),

              const SizedBox(height: 24),
              const _Label('Actions'),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: FButton(
                      key: const ValueKey('k-model-activate'),
                      onPress: isActive || _busy != null
                          ? null
                          : () => _run(
                              'activate',
                              () => ref
                                  .read(modelCatalogProvider.notifier)
                                  .activate(model.id),
                            ),
                      child: Text(isActive ? 'Default' : 'Make default'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: FButton(
                      key: const ValueKey('k-model-duplicate'),
                      onPress: _busy != null
                          ? null
                          : () => _run(
                              'duplicate',
                              () => ref
                                  .read(modelCatalogProvider.notifier)
                                  .duplicate(model.id),
                            ),
                      child: const Text('Duplicate'),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: FButton(
                      key: const ValueKey('k-model-load'),
                      // Gated on llama.cpp being **up**, not on this model being in the list we
                      // happen to hold. A freshly imported model is not in it yet, and gating on
                      // `router` left its Load button dead — so the one model you had just added
                      // was the one model you could not load.
                      onPress: !llamaRunning || _busy != null
                          ? null
                          : () => _run(
                              'load',
                              () => ref
                                  .read(llamaRepositoryProvider)
                                  .load(model.id),
                            ),
                      child: const Text('Load'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: FButton(
                      key: const ValueKey('k-model-unload'),
                      onPress:
                          router == null ||
                              !isRunnableRouterStatus(router.status) ||
                              _busy != null ||
                              // Unloading evicts the weights the answer is being generated
                              // from. This is the one that kills the reply outright.
                              busy
                          ? null
                          : () => _run(
                              'unload',
                              () => ref
                                  .read(llamaRepositoryProvider)
                                  .unload(model.id),
                            ),
                      child: const Text('Unload'),
                    ),
                  ),
                ],
              ),

              const SizedBox(height: 24),
              _DeleteSection(model: model, busy: _busy != null || busy),
            ],
          ),
        ),
      ),
    );
  }
}

/// What llama.cpp knows, and what it does not know **yet**.
/// A model whose last child process died, which the router reports as `unloaded` and not as
/// `failed`. A *running* model's exit code, if it carries one, belongs to a previous life and
/// says nothing about this one.
bool _loadFailed(LlamaRouterModel? router) =>
    router != null &&
    router.status == 'unloaded' &&
    router.exitCode != null &&
    router.exitCode != 0;

/// Says *why* the controls above it are dead.
///
/// A disabled button with no explanation is a bug report: the user tries it, nothing happens,
/// and they have no way to learn that the model is mid-answer. forui's `FButton` lays its child
/// out in an unflexed `Row`, so the sentence goes *beside* the buttons rather than inside them.
class _RunLock extends StatelessWidget {
  const _RunLock();

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Text(
      'This model is answering a conversation. Saving, unloading and removing it are '
      'unavailable until the run finishes.',
      key: const ValueKey('k-model-run-lock'),
      style: TextStyle(
        fontSize: 11,
        color: Theme.of(context).colorScheme.onSurfaceVariant,
      ),
    ),
  );
}

class _Facts extends StatelessWidget {
  const _Facts({required this.model, required this.router, required this.listed});

  final ConfiguredModel model;
  final LlamaRouterModel? router;

  /// The whole router list, or `null` when llama.cpp is stopped. Needed to tell that apart from
  /// a model the list simply has not caught up with.
  final List<LlamaRouterModel>? listed;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    // The live router wins, and the catalog is the floor.
    //
    // **These must survive a stopped llama.cpp.** They are cached server-side (`model_cache` and
    // `gguf_metadata`) for exactly that reason: the router is gone, but a model that has loaded
    // once still knows what it is. Reading only `router` blanked all of it the moment llama.cpp
    // stopped — and then told the user they were "unknown until this model has loaded once",
    // which by then was a lie. Absent from *both* means the model has genuinely never loaded,
    // and saying so is right.
    final architecture = router?.architecture ?? model.architecture;
    final parameterCount = router?.parameterCount ?? model.parameterCount;
    final contextTrain = router?.contextTrain ?? model.contextTrain;
    final contextWindow = router?.contextWindow ?? model.contextWindow;

    final facts = <String>[
      ?architecture,
      if (parameterCount != null)
        '${(parameterCount / 1e9).toStringAsFixed(1)}B params',
      if (contextTrain != null) 'Full window: ${_thousands(contextTrain)}',
      if (contextWindow != null) 'running at ${_thousands(contextWindow)}',
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _Fact(label: 'Hugging Face', value: model.hfRef ?? model.presetName),
        if (router?.routerModelId != null)
          _Fact(label: 'Router id', value: router!.routerModelId!),
        _Fact(label: 'Status', value: routerStatusLabel(router, listed: listed)),
        _Fact(label: 'On disk', value: formatBytes(model.diskBytes)),
        // **The only evidence a load failed.** llama.cpp answers `{success: true}` to a load —
        // it accepted the *request* — and a child that then dies before it loads a byte (a bad
        // `ctk` value, a preset it will not parse) leaves the model at `unloaded`, never
        // `failed`, carrying only this exit code. Without it, pressing Load on a broken model
        // looks exactly like pressing a button that does nothing.
        if (_loadFailed(router))
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              'Last load failed (llama-server exited with code ${router!.exitCode!.toInt()}). '
              'The reason is in the llama.cpp log — see Settings › llama.cpp.',
              key: const ValueKey('k-model-load-failed'),
              style: TextStyle(fontSize: 11, color: theme.colorScheme.error),
            ),
          ),
        if (facts.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              facts.join(' · '),
              key: const ValueKey('k-model-facts'),
              style: TextStyle(
                fontSize: 11,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          )
        else
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              'Architecture and context window are unknown until this model has loaded once.',
              key: const ValueKey('k-model-facts-unknown'),
              style: TextStyle(
                fontSize: 11,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
      ],
    );
  }

  String _thousands(num value) => value.toInt().toString().replaceAllMapped(
    RegExp(r'(\d)(?=(\d{3})+$)'),
    (m) => '${m[1]},',
  );
}

/// The pin: a **switch**, not a param row.
class _PinSwitch extends StatelessWidget {
  const _PinSwitch({
    required this.model,
    required this.busy,
    required this.onChanged,
  });

  final ConfiguredModel model;
  final bool busy;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // **`diskBytes`, not `pinned`.** They are different questions, and conflating them told a
    // model with 4.8 GB on disk that it was "not downloaded yet". Nelle pins a model the moment
    // it *loads* — a successful load is proof its blobs are complete — so weights can be present
    // while the pin is not.
    final hasWeights = model.diskBytes != null;

    return Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('Pinned to the weights on disk'),
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  model.pinned
                      // llama.cpp re-resolves `hf-repo` on *every* load, and only falls back to
                      // the cache when the repo listing comes back empty. A repo that still
                      // exists but has dropped your quant kills a working model. This is what
                      // stops that.
                      ? 'Hugging Face is not re-checked. Turn this off to check for an '
                            'update — it re-pins itself once the model loads.'
                      : hasWeights
                      // Weights on disk, but never loaded *by this server*. Nelle will not pin on
                      // the strength of some bytes being present: only a successful load proves
                      // they are complete.
                      ? 'Weights are on disk. Nelle pins it the next time it loads.'
                      : 'Not downloaded yet. The weights arrive the first time it loads.',
                  style: TextStyle(
                    fontSize: 11,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 12),
        // FSwitch, not Material's Switch: this app has no Material ancestor, so a Material-only
        // widget throws "No Material widget found" and paints a red box.
        // Only un-pinning is offered. Pinning is Nelle's to do, and it does it on a successful
        // load -- pinning on the strength of "some bytes exist" could pin a half-finished
        // download, and `offline` also means *never fetch*, so the model could never repair
        // itself.
        FSwitch(
          key: const ValueKey('k-model-pinned'),
          value: model.pinned,
          onChange: model.pinned && !busy ? onChanged : null,
        ),
      ],
    );
  }
}

class _DeleteSection extends ConsumerStatefulWidget {
  const _DeleteSection({required this.model, required this.busy});

  final ConfiguredModel model;
  final bool busy;

  @override
  ConsumerState<_DeleteSection> createState() => _DeleteSectionState();
}

class _DeleteSectionState extends ConsumerState<_DeleteSection> {
  bool _withWeights = false;
  bool _confirming = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final model = widget.model;
    final hasWeights = model.diskBytes != null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const _Label('Remove'),
        const SizedBox(height: 8),
        if (hasWeights)
          Row(
            children: [
              Expanded(
                child: Text(
                  // Deleting a section has always left the weights on disk for ever, invisibly.
                  // This is the first time Nelle can offer them back, and it is only safe
                  // because the cache is Nelle's now.
                  'Also delete ${formatBytes(model.diskBytes)} of weights',
                  style: const TextStyle(fontSize: 12),
                ),
              ),
              FSwitch(
                key: const ValueKey('k-model-delete-weights'),
                value: _withWeights,
                onChange: (value) => setState(() => _withWeights = value),
              ),
            ],
          ),
        if (_confirming)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              // The warning is its own line, not the button's label. forui's FButton lays its
              // child out in an unflexed Row, so a long label overflows the button by 94px --
              // which is how M6's composer overflowed on Android, in a different costume.
              _withWeights
                  ? 'This removes the model and deletes its weights. It cannot be undone.'
                  : 'This removes the model. It cannot be undone.',
              key: const ValueKey('k-model-delete-warning'),
              style: TextStyle(fontSize: 11, color: theme.colorScheme.error),
            ),
          ),
        const SizedBox(height: 8),
        FButton(
          key: const ValueKey('k-model-delete'),
          onPress: widget.busy ? null : _delete,
          child: Text(_confirming ? 'Confirm' : 'Remove model'),
        ),
      ],
    );
  }

  Future<void> _delete() async {
    if (!_confirming) {
      setState(() => _confirming = true);
      return;
    }

    final response = await ref
        .read(modelCatalogProvider.notifier)
        .remove(widget.model.id, withWeights: _withWeights);

    if (!mounted) return;

    // The model is gone either way, so this screen goes with it and the *result* comes back —
    // because the server may have **kept** the weights. A Hugging Face repo directory holds every
    // quant of that repo, so a sibling model can be holding them alive, and claiming a reclaim
    // that never happened would be a lie about the user's disk.
    final message = !_withWeights
        ? null
        : response.weightsRemoved
        ? 'Model removed. Reclaimed ${formatBytes(response.reclaimedBytes)}.'
        : 'Model removed. Its weights were kept — '
              '${response.sharedWithModelIds.join(', ')} still uses them.';
    Navigator.of(context).pop(message);
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 4),
    child: Text(
      text.toUpperCase(),
      style: const TextStyle(
        fontSize: 11,
        fontWeight: FontWeight.w600,
        letterSpacing: 0.5,
      ),
    ),
  );
}

class _Fact extends StatelessWidget {
  const _Fact({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            flex: 2,
            child: Text(
              label,
              style: TextStyle(
                fontSize: 12,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          Expanded(
            flex: 5,
            child: Text(
              value,
              textAlign: TextAlign.right,
              style: const TextStyle(fontSize: 12, fontFamily: 'monospace'),
            ),
          ),
        ],
      ),
    );
  }
}
