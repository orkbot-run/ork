// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 material is preserved. Native auth and pairing are Ork additions.
// Modified by Ork contributors to remove the legacy setup bridge.

import type { WorkspaceTarget } from "./workspace-selection.js";

/** A native host can share its server session with an SSO popup without exposing commands. */
export interface OrkNativeAuth {
  readonly ssoPopup: true;
}

/**
 * `unsupported` covers an unpackaged build and a repository with no published releases, which is
 * the normal state for a fork. It is not an error the user needs to act on. Configured installs
 * retry an empty feed on the next background check so the first release can arrive later.
 */
export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "unsupported"
  | "error";

export interface DesktopUpdateState {
  phase: DesktopUpdatePhase;
  /** The installed desktop release, which can drift from the server this app points at. */
  currentVersion: string;
  availableVersion: string | null;
  /** Download progress 0-100, only while `downloading`. */
  percent: number | null;
  message: string | null;
  checkedAt: string | null;
  channel?: "stable" | "beta";
  betaAvailable?: boolean;
}

export interface OrkDesktopUpdate {
  state: () => Promise<DesktopUpdateState>;
  check: () => Promise<DesktopUpdateState>;
  download: () => Promise<DesktopUpdateState>;
  /** Quits and relaunches into the downloaded release; only useful once `phase` is `ready`. */
  install: () => Promise<DesktopUpdateState>;
  setChannel?: (channel: "stable" | "beta") => Promise<DesktopUpdateState>;
}

export interface OrkDesktopOAuthCallback {
  code: string;
  state?: string;
  iss?: string;
}

/** Public identity metadata. Native credentials never cross the bridge. */
export interface OrkDesktopAccount {
  issuer: string;
  subject: string;
  userinfo: Record<string, unknown>;
  /** Unix timestamp in seconds. */
  expiresAt: number;
}

export interface OrkDesktopDevice {
  /** Null until paired. */
  deviceId: string | null;
  name: string;
  allowed: boolean;
}

/**
 * What the system recognizer reports for one listening session, shaped after Web Speech:
 * `result` carries the session's whole text so far, `error` a Web Speech error code,
 * and `end` always comes last.
 */
export type OrkDesktopSpeechEvent =
  | { session: number; type: "result"; text: string }
  | { session: number; type: "error"; error: string }
  | { session: number; type: "end" };

/** App menu items the page carries out; each matches a shortcut the page also handles itself. */
export const DESKTOP_MENU_COMMANDS = [
  "new",
  "command-menu",
  "search",
  "toggle-sidebar",
  "back",
  "forward",
  "next-bot",
  "previous-bot",
  "new-group",
  "integrations",
  "chat-panel",
  "shortcuts",
  "find",
] as const;

export type DesktopMenuCommand = (typeof DESKTOP_MENU_COMMANDS)[number];

export function isDesktopMenuCommand(value: unknown): value is DesktopMenuCommand {
  return (DESKTOP_MENU_COMMANDS as readonly unknown[]).includes(value);
}

export interface OrkDesktop {
  /** Optional native identity connection, separate from the selected server's session. */
  accounts?: {
    signIn: () => Promise<OrkDesktopAccount>;
    session: () => Promise<OrkDesktopAccount | null>;
    workspaceTarget?: () => Promise<WorkspaceTarget | null>;
    logout: () => Promise<void>;
    /** Retry only captured retired credentials; live credentials remain native. */
    retryRevocations?: () => Promise<void>;
    /** Only an audience-bound proof crosses the bridge; the central bearer stays native. */
    createServerLoginGrant?: (request: {
      origin: string;
      challenge: string;
    }) => Promise<{ grant: string; expiresAt: number }>;
    /** Native orchestration keeps installation sessions and device proofs outside the renderer. */
    signInToServer?: () => Promise<void>;
    /** Released once to the confirmed server document, never persisted in its bookmark. */
    consumeServerInitializationSecret?: () => Promise<string | null>;
  };
  /** Optional for compatibility with hosts without native device pairing. */
  pairing?: {
    /** Native code derives the current server and account from the window session. */
    sync: () => Promise<void>;
    /** Revokes and removes native device access before the web session signs out. */
    clear: () => Promise<void>;
  };
  /** Optional for compatibility with older desktop releases. */
  badge?: {
    set: (count: number) => Promise<boolean>;
  };
  computer?: {
    /** Native main persists host choice through its local capability, never a user session. */
    managesHostChoice?: boolean;
    requestAccess: () => Promise<boolean>;
    revokeAccess: () => Promise<void>;
    onConfigure: (listener: () => void) => () => void;
  };
  /** Optional for compatibility with older desktop releases. */
  device?: {
    /** Null when the app shows its own local server. */
    state: () => Promise<OrkDesktopDevice | null>;
    /** Turning it on asks with a native prompt the page cannot answer. */
    setAllowed: (allowed: boolean) => Promise<OrkDesktopDevice | null>;
  };
  /** Absent on older desktop releases, whose menus carry no app commands. */
  menu?: {
    onCommand: (listener: (command: DesktopMenuCommand) => void) => () => void;
  };
  /** False for local builds, whose errors must not reach production reporting. Absent on older releases. */
  monitoring?: {
    enabled: () => Promise<boolean>;
  };
  /** Optional for compatibility with older desktop releases. */
  locale?: {
    /** The language the page shows, so the app's own menus, dialogs and setup window follow it. */
    set: (locale: string) => Promise<void>;
  };
  /** Optional for compatibility with older desktop releases. */
  passkeys?: {
    /** Relying parties this build is associated with for system passkeys (macOS); others fail. */
    rpIds: () => Promise<string[]>;
  };
  /** Absent on older desktop releases. */
  server?: {
    /** Opens the desktop setup window to pick another Ork server. */
    change: () => Promise<void>;
    /** Saves a confirmed connection only after native verification of its product session. */
    remember?: () => Promise<void>;
  };
  /** Absent on older desktop releases, which have no Settings… menu item. */
  settings?: {
    /** The app menu's Settings… item; the OS claims Cmd+, before any page keydown can. */
    onOpen: (listener: () => void) => () => void;
  };
  /**
   * The operating system's own speech recognition, so dictation needs no provider key.
   * Absent on platforms without one and on older desktop releases.
   */
  speech?: {
    /** Listens in `language` until stopped. False when refused; no events follow then. */
    start: (language: string, session: number) => Promise<boolean>;
    /** Ends the utterance: its final text and `end` still arrive. */
    stop: (session: number) => Promise<void>;
    abort: (session: number) => Promise<void>;
    onEvent: (listener: (event: OrkDesktopSpeechEvent) => void) => () => void;
  };
  platform: string;
  /** Absent on older frameless releases, which still need in-app controls. */
  nativeWindowFrame?: boolean;
  window: {
    close: () => Promise<void>;
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    state: () => Promise<{ minimized: boolean; maximized: boolean; fullScreen: boolean }>;
  };
  update: OrkDesktopUpdate;
  oauth: {
    /**
     * Open system-browser auth. A redirect_uri must be HTTP loopback with state;
     * URLs without a redirect use backend polling. Optional for older desktops.
     */
    open?: (authorizationUrl: string) => Promise<void>;
    cancel?: (authorizationUrl: string) => Promise<void>;
    /**
     * Authorization codes captured from the system browser or a legacy popup.
     * Returns an unsubscribe function.
     */
    onCallback: (listener: (callback: OrkDesktopOAuthCallback) => void) => () => void;
  };
}

/** Version probe shared by the web development server and native desktop setup. */
export interface DesktopStackProbeResponse {
  ok: true;
  imageTag: string;
}
