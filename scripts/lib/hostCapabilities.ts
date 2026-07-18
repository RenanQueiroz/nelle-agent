/**
 * What this machine can actually build and test.
 *
 * **One module, two consumers.** `doctor` reports this and `build` enforces it. If they each worked
 * it out for themselves they would drift, and `build` would eventually offer a target that `doctor`
 * says is impossible — which is worse than either being wrong alone.
 *
 * The constraints are the toolchains', not ours:
 * - **Flutter desktop targets need their own OS.** There is no cross-compilation: a macOS build
 *   needs a Mac, a Windows build needs Windows. Saying so *before* invoking Gradle is the single
 *   most useful thing this file does — the alternative is the user discovering it from a CMake stack
 *   trace three minutes in.
 * - **iOS needs Xcode**, so macOS only.
 * - **Android and web build anywhere** the SDK is present.
 * - **The server binary cross-compiles freely** (`bun build --compile --target=…` downloads the
 *   target runtime — verified: a Darwin arm64 binary builds fine from Linux). But see the warning on
 *   `serverCrossTargets`.
 */

export type HostOs = 'linux' | 'macos' | 'windows';

/** A thing `bun run build` can produce. */
export type BuildTarget = 'server' | 'linux' | 'macos' | 'windows' | 'apk' | 'ipa' | 'web';

/** A device the Flutter integration suite can run on. */
export type DeviceTarget = 'linux' | 'macos' | 'windows' | 'android' | 'ios' | 'chrome';

export type HostCapabilities = {
  os: HostOs;
  arch: string;
  /** Targets this host can build. Anything absent is impossible *here*, not merely unconfigured. */
  buildTargets: BuildTarget[];
  /** Devices the device suite can drive here. */
  deviceTargets: DeviceTarget[];
  /**
   * Whether a **physical phone on the LAN** can reach this server.
   *
   * `false` under WSL2, and that is not a misconfiguration to fix: WSL2 is NAT'd, so Nelle binds the
   * VM's `172.31.x.x` while the phone sits on the host's `192.168.x.x` and the two never meet
   * without `networkingMode=mirrored` or a `netsh portproxy`. The Android *emulator* is unaffected —
   * it runs inside WSL and shares the network namespace.
   */
  lanReachableByPhone: boolean;
  /** True when running inside WSL — several traps in the AGENTS files and skills are specific to it. */
  isWsl: boolean;
};

function detectOs(): HostOs {
  switch (process.platform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      return 'linux';
  }
}

function detectWsl(): boolean {
  if (process.platform !== 'linux') {
    return false;
  }
  // The kernel release carries it: `6.18.x-microsoft-standard-WSL2`.
  return /microsoft|wsl/i.test(process.env.WSL_DISTRO_NAME ?? '') || wslFromRelease();
}

function wslFromRelease(): boolean {
  try {
    return /microsoft/i.test(require('node:os').release());
  } catch {
    return false;
  }
}

/**
 * What this host can build.
 *
 * The **server** is always buildable (Bun runs everywhere and cross-compiles). The Flutter targets
 * are gated by the OS, and by whether the relevant SDK is present — which `doctor` reports, so this
 * returns what is *possible on this OS*, not what is currently *installed*. `build` must still fail
 * gracefully if the toolchain is missing; that is a different message from "impossible here".
 */
export function hostCapabilities(): HostCapabilities {
  const os = detectOs();
  const isWsl = detectWsl();

  const buildTargets: BuildTarget[] = ['server', 'apk', 'web'];
  const deviceTargets: DeviceTarget[] = ['android', 'chrome'];

  if (os === 'linux') {
    buildTargets.push('linux');
    deviceTargets.push('linux');
  }
  if (os === 'macos') {
    buildTargets.push('macos', 'ipa');
    deviceTargets.push('macos', 'ios');
  }
  if (os === 'windows') {
    buildTargets.push('windows');
    deviceTargets.push('windows');
  }

  return {
    os,
    arch: process.arch,
    buildTargets: buildTargets.sort(),
    deviceTargets: deviceTargets.sort(),
    // A phone can reach a normal LAN host; it cannot reach a NAT'd WSL2 VM.
    lanReachableByPhone: !isWsl,
    isWsl,
  };
}

/**
 * Why a target is impossible here — a sentence, not a boolean.
 *
 * Returns `null` when the target *is* possible. The point is that `build --target=macos` on Linux
 * must fail with "macOS builds require a Mac (Flutter cannot cross-compile desktop targets)" rather
 * than a CMake error, and the reason belongs beside the capability rather than in the caller.
 */
export function whyImpossible(target: BuildTarget, host = hostCapabilities()): string | null {
  if (host.buildTargets.includes(target)) {
    return null;
  }
  switch (target) {
    case 'macos':
      return 'macOS builds require a Mac — Flutter cannot cross-compile desktop targets.';
    case 'ipa':
      return 'iOS builds require a Mac with Xcode.';
    case 'windows':
      return 'Windows builds require Windows — Flutter cannot cross-compile desktop targets.';
    case 'linux':
      return 'Linux desktop builds require Linux.';
    default:
      return `\`${target}\` cannot be built on ${host.os}.`;
  }
}

/**
 * Server binaries this host can cross-compile.
 *
 * ⚠ **These carry a caveat.** `bun build --compile --target=…` happily produces a foreign binary,
 * but `@napi-rs/canvas`'s native Skia binding is per-platform and only the *host's* is in
 * `node_modules`. A cross-compiled server therefore ships without the binding the PDF path needs —
 * the exact class of bug that made the compiled binary unable to read a PDF at all (see
 * `tests/unit/compiledBinary.test.ts`). **Build the server natively on each OS** (CI does) rather
 * than cross-compiling, until that is solved per target.
 */
export const serverCrossTargets = [
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-darwin-x64',
  'bun-darwin-arm64',
  'bun-windows-x64',
] as const;
