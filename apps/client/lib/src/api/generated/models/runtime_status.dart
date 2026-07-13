// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'runtime_status_install_mode.dart';

part 'runtime_status.g.dart';

@JsonSerializable()
class RuntimeStatus {
  const RuntimeStatus({
    required this.platform,
    required this.arch,
    required this.dataDir,
    required this.binaryPath,
    required this.logPath,
    required this.installMode,
    required this.installed,
    required this.installedVersion,
    required this.latestVersion,
    required this.updateAvailable,
    required this.running,
    required this.pid,
    required this.host,
    required this.port,
    required this.modelsMax,
    required this.sleepIdleSeconds,
    required this.activeModelId,
    required this.lastError,
  });

  factory RuntimeStatus.fromJson(Map<String, Object?> json) =>
      _$RuntimeStatusFromJson(json);

  final String platform;
  final String arch;
  final String dataDir;
  final String? binaryPath;
  final String logPath;
  final RuntimeStatusInstallMode installMode;
  final bool installed;
  final String? installedVersion;
  final String? latestVersion;
  final bool updateAvailable;
  final bool running;
  final num? pid;
  final String host;
  final num port;
  final num modelsMax;
  final num sleepIdleSeconds;
  final String? activeModelId;
  final String? lastError;

  Map<String, Object?> toJson() => _$RuntimeStatusToJson(this);
}
