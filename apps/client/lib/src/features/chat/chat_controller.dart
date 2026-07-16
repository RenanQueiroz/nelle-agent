import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/api_exception.dart';
import '../../api/chat_stream_event.dart';
import '../../api/generated/models/conversation_context_usage.dart';
import '../../api/generated/models/conversation_message.dart';
import '../../api/generated/models/conversation_message_role.dart';
import '../../api/generated/models/conversation_snapshot.dart';
import '../../api/generated/models/conversation_status.dart';
import '../../api/generated/models/fork_kind.dart';
import '../models/active_runs.dart';
import '../../api/generated/models/reasoning_level.dart';
import '../attachments/attachment_draft.dart';
import '../models/router_models_notifier.dart';
import 'chat_repository.dart';
import 'sse_transport.dart';

/// What the chat pane renders. `messages` is the snapshot's rendered list;
/// `pending` holds the optimistic user turn + the streaming assistant turn during
/// a run, and is cleared when the run finishes and the snapshot is reloaded.
/// A model load in flight, with however much llama.cpp has said about it.
///
/// [progress] is null while llama.cpp is loading but has not measured anything yet —
/// its first frames carry no value at all. That is "loading, amount unknown", which is
/// not zero: rendering it as 0% would invent a number the server never sent.
class ModelLoad {
  const ModelLoad({this.progress, this.phase, this.downloadedBytes, this.totalBytes});

  final double? progress;

  /// `downloading` while the weights are still arriving, `loading` while llama.cpp reads
  /// them in, null before the server has evidence of either. A first load downloads
  /// multi-GB blobs — minutes, not seconds — and the transcript must say so rather than
  /// look hung.
  final String? phase;
  final int? downloadedBytes;
  final int? totalBytes;

  bool get downloading => phase == 'downloading';
}

class ChatState {
  const ChatState({
    required this.snapshot,
    required this.messages,
    required this.context,
    this.pending = const [],
    this.running = false,
    this.modelLoad,
    this.runError,
    this.refusedMessage,
    this.compacting = false,
    this.compactNote,
    this.runWarning,
  });

  factory ChatState.fromSnapshot(ConversationSnapshot snapshot) => ChatState(
    snapshot: snapshot,
    messages: snapshot.messages,
    context: snapshot.context,
  );

  final ConversationSnapshot snapshot;
  final List<ConversationMessage> messages;
  final ConversationContextUsage context;
  final List<ConversationMessage> pending;
  final bool running;

  /// Non-null while llama.cpp is loading the model's weights for this run.
  final ModelLoad? modelLoad;
  final String? runError;

  /// A message the server refused before it became a turn (no `run.started`), so
  /// the composer can put the text back rather than making the user retype it.
  final String? refusedMessage;

  /// A compaction is running. The conversation is `compacting` server-side: it cannot
  /// send, and the stop button aborts the compaction rather than an answer.
  final bool compacting;

  /// A **non-blocking** warning from the run: the reply budget was exhausted, the model
  /// spent its whole reasoning budget, Pi fell back to direct llama.cpp. The answer still
  /// arrived (or did not) and the run completed — but without this the user is left
  /// staring at a truncated or empty reply with no explanation at all.
  final String? runWarning;

  /// What the compaction is doing, rendered as a system row.
  ///
  /// **Synthesized here, because it exists nowhere else.** The compaction summary is a
  /// `compaction` entry with no role, and `buildConversationMessages` drops it — so
  /// `snapshot.messages` never contains it and reloading will not make it appear.
  final String? compactNote;

  String get title => snapshot.conversation.title;

  /// This conversation was **branched from another one**, and which way.
  ///
  /// A `fork` started at one message of its parent; a `clone` copied the whole thing. Saying so
  /// matters because a fork's transcript *looks like* an ordinary chat that happens to begin
  /// mid-thought -- and without this the user has no way to know where it came from, or that the
  /// original is still there, untouched.
  ForkKind? get forkKind => snapshot.conversation.forkKind;

  /// The Pi session file that **is** this conversation's history is missing or unreadable.
  ///
  /// SQLite holds only a projection of it, so the transcript is empty -- and rendering that as an
  /// ordinary empty chat tells the user their conversation is gone, when it is recoverable. There
  /// are three explicit ways out (repair, rebuild, delete) and no implicit ones: no read path may
  /// conjure a replacement session, because that would be Nelle inventing a history it has not
  /// got.
  bool get unavailable =>
      snapshot.conversation.status == ConversationStatus.unavailable;

  /// The model **this conversation** runs on. Not `models.selectedModelId`, which is
  /// the global default new chats inherit — reading that would show the wrong model.
  String? get modelId => snapshot.conversation.defaultModelId;

  /// How hard the model thinks on this conversation. Server truth, off the snapshot.
  ReasoningLevel get reasoningLevel => snapshot.conversation.reasoningLevel;

  /// Whether this conversation's model can think at all — a **tri-state**.
  ///
  /// llama.cpp answers `/props` only for a model it has loaded at least once, so
  /// `null` means "not known yet" and the control must stay editable. Only `false` —
  /// a chat template that provably has no thinking mode — locks it to `off`.
  bool? get canReason => snapshot.capabilities.canReason;

  /// Whether weights are loading — true even before llama.cpp has measured anything,
  /// which is why it is not derived from [modelLoadProgress].
  bool get loadingModel => modelLoad != null;

  /// 0..1 across the whole load, or null when llama.cpp has not measured it yet.
  double? get modelLoadProgress => modelLoad?.progress;

  List<ConversationMessage> get rendered => [...messages, ...pending];

  ChatState copyWith({
    List<ConversationMessage>? messages,
    ConversationContextUsage? context,
    List<ConversationMessage>? pending,
    bool? running,
    ModelLoad? modelLoad,
    bool clearModelLoad = false,
    String? runError,
    bool clearError = false,
    String? refusedMessage,
    bool clearRefused = false,
    bool? compacting,
    String? compactNote,
    String? runWarning,
    bool clearWarning = false,
  }) => ChatState(
    snapshot: snapshot,
    messages: messages ?? this.messages,
    context: context ?? this.context,
    pending: pending ?? this.pending,
    running: running ?? this.running,
    modelLoad: clearModelLoad ? null : (modelLoad ?? this.modelLoad),
    runError: clearError ? null : (runError ?? this.runError),
    refusedMessage: clearRefused
        ? null
        : (refusedMessage ?? this.refusedMessage),
    compacting: compacting ?? this.compacting,
    compactNote: compactNote ?? this.compactNote,
    runWarning: clearWarning ? null : (runWarning ?? this.runWarning),
  );
}

final chatControllerProvider =
    AsyncNotifierProvider.family<ChatController, ChatState, String>(
      ChatController.new,
    );

class ChatController extends FamilyAsyncNotifier<ChatState, String> {
  StreamSubscription<ChatStreamEvent>? _sub;
  CancelToken? _cancel;

  /// The message this run is sending, and whether the server ever turned it into
  /// a run. If it did not (`run.started` never arrived) and the run failed, the
  /// message was refused and its text goes back to the composer.
  String? _sentMessage;
  bool _runStarted = false;

  /// The active run's id, so an abort can use the run-scoped route — the only one that
  /// answers with a `warning` (`/compact/abort` has none).
  String? _runId;

  @override
  Future<ChatState> build(String conversationId) async {
    ref.onDispose(() {
      _sub?.cancel();
      _cancel?.cancel();
    });
    final snapshot = await ref
        .read(chatRepositoryProvider)
        .getSnapshot(conversationId);
    return ChatState.fromSnapshot(snapshot);
  }

  /// Sends [text] with the conversation's staged attachments, appends an optimistic user
  /// turn + empty assistant turn, and folds the SSE stream into the assistant turn until
  /// the run finishes.
  ///
  /// Attachments are referenced, never embedded: the bytes went to `POST /api/uploads`
  /// when they were staged, so the request carries `{uploadId}` and nothing else. The
  /// draft is cleared when the run *starts*, not when the message is sent — a message the
  /// server refuses before it becomes a turn keeps its chips, because the uploads are
  /// still up there, unbound.
  Future<void> send(String text) async {
    final current = state.valueOrNull;
    final message = text.trim();
    if (current == null || current.running || message.isEmpty) {
      return;
    }
    final attachments = ref.read(attachmentDraftProvider(arg)).uploadIds;
    final now = DateTime.now().toUtc().toIso8601String();
    final user = ConversationMessage(
      id: 'local-user-$now',
      role: ConversationMessageRole.user,
      content: message,
      createdAt: now,
    );
    final assistant = ConversationMessage(
      id: 'local-assistant-$now',
      role: ConversationMessageRole.assistant,
      content: '',
      createdAt: now,
    );
    state = AsyncData(
      current.copyWith(
        pending: [user, assistant],
        running: true,
        clearError: true,
        clearModelLoad: true,
        clearRefused: true,
        clearWarning: true,
      ),
    );
    _claimModel(current);

    _sentMessage = message;
    _runStarted = false;
    _cancel = CancelToken();
    _sub = ref
        .read(sseTransportProvider)
        .stream(
          '/api/conversations/${Uri.encodeComponent(arg)}/chat/stream',
          body: {
            'message': message,
            // `chatRequestSchema` is `.strict()` at both levels: an id and nothing else.
            if (attachments.isNotEmpty)
              'attachments': [
                for (final uploadId in attachments) {'uploadId': uploadId},
              ],
          },
          cancelToken: _cancel,
        )
        .listen(
          _onEvent,
          onError: _onStreamError,
          onDone: _finish,
          cancelOnError: false,
        );
  }

  /// Re-answers [messageId] — an **assistant** message — and keeps the old answer.
  ///
  /// The server branches the Pi session before the original user turn and replays it,
  /// so the new answer becomes a *variant* of the old one rather than replacing it.
  /// Nothing is removed from the transcript here: the streaming answer is appended,
  /// and the reload afterwards returns both, labelled `variant N/M`.
  ///
  /// [modelId] overrides the model for this answer only (a footer model change); the
  /// conversation's own model is used when it is null.
  Future<void> regenerate(String messageId, {String? modelId}) async {
    final current = state.valueOrNull;
    if (current == null || current.running) {
      return;
    }
    final now = DateTime.now().toUtc().toIso8601String();
    final assistant = ConversationMessage(
      id: 'local-assistant-$now',
      role: ConversationMessageRole.assistant,
      content: '',
      createdAt: now,
    );
    state = AsyncData(
      current.copyWith(
        pending: [assistant],
        running: true,
        clearError: true,
        clearModelLoad: true,
        clearRefused: true,
      ),
    );
    _claimModel(current);

    // A regenerate replays a turn that is already in the transcript, so there is no
    // typed message to hand back to the composer if the server refuses it.
    _sentMessage = null;
    _runStarted = false;
    _cancel = CancelToken();
    _sub = ref
        .read(sseTransportProvider)
        .stream(
          '/api/conversations/${Uri.encodeComponent(arg)}'
          '/messages/${Uri.encodeComponent(messageId)}/regenerate',
          body: {'modelId': ?modelId},
          cancelToken: _cancel,
        )
        .listen(
          _onEvent,
          onError: _onStreamError,
          onDone: _finish,
          cancelOnError: false,
        );
  }

  /// Compacts the conversation's context.
  ///
  /// `/compact` has its own endpoint and the chat route will **not** refuse it: it is on
  /// the server's allowlist, so posting it to `chat/stream` would send the model the
  /// literal text "/compact". Intercepting it is the client's job.
  ///
  /// The stream carries the same Nelle envelopes as a chat run, so the transport and the
  /// fold are the ones already here.
  Future<void> compact(String instructions) async {
    final current = state.valueOrNull;
    if (current == null || current.running || current.compacting) {
      return;
    }
    state = AsyncData(
      current.copyWith(
        running: true,
        compacting: true,
        compactNote: 'Compacting conversation context…',
        clearError: true,
        clearRefused: true,
      ),
    );
    // A compaction runs the model too -- it summarizes the conversation with it -- so the
    // model is just as unsafe to unload as during an answer.
    _claimModel(current);

    // A compaction replays nothing and sends no message, so there is no typed text to
    // hand back if it is refused.
    _sentMessage = null;
    _runStarted = false;
    _cancel = CancelToken();
    _sub = ref
        .read(sseTransportProvider)
        .stream(
          '/api/conversations/${Uri.encodeComponent(arg)}/compact/stream',
          body: {if (instructions.isNotEmpty) 'instructions': instructions},
          cancelToken: _cancel,
        )
        .listen(
          _onEvent,
          onError: _onStreamError,
          onDone: _finish,
          cancelOnError: false,
        );
  }

  /// Stops the active run: aborts the upstream fetch and tells the server.
  ///
  /// Prefers the **run-scoped** abort when the run id is known, because it is the only
  /// one that answers with a `warning` — `/compact/abort` does not carry the field at
  /// all, and a slot still processing is worth saying out loud.
  Future<void> abort() async {
    if (_sub == null) {
      return;
    }
    _cancel?.cancel();
    final runId = _runId;
    final compacting = state.valueOrNull?.compacting ?? false;
    final path = runId != null
        ? '/api/conversations/${Uri.encodeComponent(arg)}/runs/${Uri.encodeComponent(runId)}/abort'
        : compacting
        ? '/api/conversations/${Uri.encodeComponent(arg)}/compact/abort'
        : '/api/conversations/${Uri.encodeComponent(arg)}/abort';
    try {
      await ref.read(dioProvider).post<Map<String, dynamic>>(path);
    } catch (_) {
      // The stream cancel already stopped the client; _finish reloads state.
    }
  }

  Future<void> reload() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() => build(arg));
  }

  /// Pins this conversation to [modelId] and applies the server's snapshot.
  ///
  /// Does **not** wait for the model to load and does not block sending: the
  /// server's `ensureModelReadyForRun()` loads the conversation's model when a run
  /// starts, and the run waits. Anything in flight is preserved — changing the model
  /// must not wipe a streaming reply.
  Future<void> setModel(String modelId) async {
    final current = state.valueOrNull;
    if (current == null || current.modelId == modelId) {
      return;
    }
    _applyPreservingRun(
      await ref.read(chatRepositoryProvider).setModel(arg, modelId),
      current,
    );
  }

  /// Sets this conversation's reasoning level and applies the server's snapshot.
  ///
  /// Takes effect on the *next* prompt (Pi is told the level before each one), so a
  /// run already streaming is left alone rather than restarted.
  Future<void> setReasoningLevel(ReasoningLevel level) async {
    final current = state.valueOrNull;
    if (current == null ||
        current.reasoningLevel == level ||
        // A level only a newer server knows. Echoing it back would throw, and we have
        // no idea what it means anyway.
        level == ReasoningLevel.$unknown) {
      return;
    }
    _applyPreservingRun(
      await ref.read(chatRepositoryProvider).setReasoningLevel(arg, level),
      current,
    );
  }

  /// Applies a server snapshot without disturbing the live run: a snapshot describes
  /// the conversation, and it does not know about the reply currently streaming into
  /// `pending`.
  void _applyPreservingRun(ConversationSnapshot snapshot, ChatState current) {
    state = AsyncData(
      ChatState.fromSnapshot(snapshot).copyWith(
        pending: current.pending,
        running: current.running,
        modelLoad: current.modelLoad,
        runError: current.runError,
        refusedMessage: current.refusedMessage,
      ),
    );
  }

  void _onEvent(ChatStreamEvent event) {
    final s = state.valueOrNull;
    if (s == null) {
      return;
    }
    switch (event) {
      case RunStartedEvent(:final runId):
        // The message became a turn, so it is no longer the composer's to keep — and
        // neither are its attachments, which the server has now bound to it. Clearing
        // here rather than at send is what lets a refused message keep its chips: no
        // `run.started`, no clear, and the uploads are still on the server, unbound.
        _runStarted = true;
        _runId = runId;
        ref.read(attachmentDraftProvider(arg).notifier).clear();
      case CompactStartedEvent():
        state = AsyncData(
          s.copyWith(compactNote: 'Compacting conversation context…'),
        );
      case CompactCompletedEvent(:final compacted):
        state = AsyncData(
          s.copyWith(
            compactNote: compacted
                ? 'Conversation compacted.'
                : 'Nothing to compact.',
          ),
        );
      case CompactFailedEvent(:final error):
        state = AsyncData(s.copyWith(runError: error.message));
      case ModelLoadingEvent(
        :final status,
        :final progress,
        :final phase,
        :final downloadedBytes,
        :final totalBytes,
      ):
        // The last of these can carry a runnable status: the server polls until the
        // model is up and reports what it saw. Showing "Loading weights" past that
        // would leave the placeholder on screen until the first token arrives.
        state = AsyncData(
          isRunnableRouterStatus(status)
              ? s.copyWith(clearModelLoad: true)
              // `progress` is null on llama.cpp's first frames — loading, not 0%.
              : s.copyWith(
                  modelLoad: ModelLoad(
                    progress: progress,
                    phase: phase,
                    downloadedBytes: downloadedBytes,
                    totalBytes: totalBytes,
                  ),
                ),
        );
      case AssistantDeltaEvent(:final delta):
        state = AsyncData(
          s.copyWith(
            clearModelLoad: true,
            pending: _appendToAssistant(s.pending, content: delta),
          ),
        );
      case AssistantReasoningDeltaEvent(:final delta):
        state = AsyncData(
          s.copyWith(
            clearModelLoad: true,
            pending: _appendToAssistant(s.pending, reasoning: delta),
          ),
        );
      case ContextUpdatedEvent(:final usage):
        state = AsyncData(s.copyWith(context: usage));
      case RunWarningEvent(:final warning):
        // Not an error: the run completed. But an answer that stops mid-sentence
        // because the reply budget ran out is not something to leave unexplained.
        state = AsyncData(s.copyWith(runWarning: warning.message));
      case StreamErrorEvent(:final error):
        state = AsyncData(s.copyWith(runError: error.message));
      case RunCompletedEvent(:final status, :final error):
        _finish(
          // A specific error already on the state — `compact.failed`, a stream `error` —
          // is the one the server bothered to write. "The run failed." is what we say
          // when nobody said anything better.
          errorMessage:
              error?.message ??
              s.runError ??
              (status == 'failed' ? 'The run failed.' : null),
        );
      case RunAbortedEvent():
        if (s.compacting) {
          state = AsyncData(s.copyWith(compactNote: 'Compaction stopped.'));
        }
        _finish();
      default:
        // run.started, message.*, performance, tool_call, conversation.updated,
        // run.warning, unknown — not folded in M1.
        break;
    }
  }

  List<ConversationMessage> _appendToAssistant(
    List<ConversationMessage> pending, {
    String? content,
    String? reasoning,
  }) {
    if (pending.isEmpty) {
      return pending;
    }
    final list = [...pending];
    final last = list.last;
    list[list.length - 1] = _reconstruct(
      last,
      content: content == null ? null : '${last.content}$content',
      reasoning: reasoning == null ? null : '${last.reasoning ?? ''}$reasoning',
    );
    return list;
  }

  ConversationMessage _reconstruct(
    ConversationMessage m, {
    String? content,
    String? reasoning,
  }) => ConversationMessage(
    id: m.id,
    role: m.role,
    content: content ?? m.content,
    createdAt: m.createdAt,
    parentPiEntryId: m.parentPiEntryId,
    modelId: m.modelId,
    modelRuntimeId: m.modelRuntimeId,
    modelAliasSnapshot: m.modelAliasSnapshot,
    regeneratesPiEntryId: m.regeneratesPiEntryId,
    displayGroupId: m.displayGroupId,
    variantLabel: m.variantLabel,
    performance: m.performance,
    toolCalls: m.toolCalls,
    reasoning: reasoning ?? m.reasoning,
    attachments: m.attachments,
  );

  void _onStreamError(Object error, StackTrace stackTrace) {
    final s = state.valueOrNull;
    final message = error is NelleApiException
        ? error.message
        : error.toString();
    _finish(errorMessage: s?.runError ?? message);
  }

  /// Runs once per run: cancels the subscription, then reloads the authoritative
  /// snapshot. If the reload fails, the streamed `pending` turns are merged into
  /// `messages` so nothing is lost.
  /// Marks this conversation's model as *in use*, so Settings will not unload, re-parameterize
  /// or delete it out from under the answer the user is watching. Released in [_finish], which
  /// every terminal path goes through — completed, aborted, failed, or the stream simply ending.
  void _claimModel(ChatState state) {
    ref.read(activeRunsProvider.notifier).start(arg, state.modelId);
  }

  Future<void> _finish({String? errorMessage}) async {
    final sub = _sub;
    if (sub == null) {
      return;
    }
    _sub = null;
    await sub.cancel();
    _cancel = null;
    // The run is over however it ended, so the model is free. This is the *only* release, and
    // it must stay that way: a claim that outlives its run locks a model out of Settings for
    // the rest of the session, and there is nothing the user could do about it.
    ref.read(activeRunsProvider.notifier).end(arg);

    final s = state.valueOrNull;
    final error = errorMessage ?? s?.runError;
    // The compaction row is synthesized and lives nowhere else: `buildConversationMessages`
    // drops compaction entries, so reloading the snapshot would silently erase it.
    //
    // A compaction that ended badly must not leave "Compacting conversation context…" on
    // screen for the rest of the session. The server's own sentence goes in the row --
    // it says *why* ("Nothing to compact (session too small)"), and a toast is gone in
    // three seconds.
    final compactNote = s == null
        ? null
        : (s.compacting && error != null ? error : s.compactNote);
    // Survives the reload for the same reason the compaction row does: the snapshot has
    // never heard of it.
    final runWarning = s?.runWarning;
    // The server refused the message before it became a turn (it never sent
    // run.started), so the text is still the composer's -- hand it back rather
    // than making the user retype it.
    final refused = (!_runStarted && error != null) ? _sentMessage : null;
    _sentMessage = null;
    try {
      final snapshot = await ref.read(chatRepositoryProvider).getSnapshot(arg);
      final next = ChatState.fromSnapshot(
        snapshot,
      ).copyWith(compactNote: compactNote, runWarning: runWarning);
      state = AsyncData(
        error == null
            ? next
            : next.copyWith(runError: error, refusedMessage: refused),
      );
    } catch (_) {
      if (s != null) {
        state = AsyncData(
          s.copyWith(
            running: false,
            compacting: false,
            clearModelLoad: true,
            // A refused message never became a turn, so it must not be left in the
            // transcript as if it had been sent.
            messages: refused != null
                ? s.messages
                : [...s.messages, ...s.pending],
            pending: const [],
            runError: error,
            refusedMessage: refused,
          ),
        );
      }
    }
  }

  /// Clears the refused message once the composer has taken its text back.
  void consumeRefusedMessage() {
    final s = state.valueOrNull;
    if (s?.refusedMessage != null) {
      state = AsyncData(s!.copyWith(clearRefused: true));
    }
  }
}
