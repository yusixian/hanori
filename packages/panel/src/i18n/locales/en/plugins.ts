export const plugins = {
  title: "Plugins",
  description: "Install trusted plugins, then configure and enable them for each Bot.",
  loading: "Loading…",
  accessDenied: "Only owners and administrators can manage plugins.",
  refresh: "Refresh",
  installGit: "Install from GitHub",
  catalog: "Plugin catalog",
  empty: "No plugins are available.",
  installed: "Installed",
  available: "Available",
  builtin: "Built-in",
  thirdParty: "Third-party",
  configure: "Configure",
  install: "Install",
  settings: "Plugin settings",
  bot: "Bot",
  noBots: "Create a Bot to configure this plugin.",
  reloadConfiguration: "Reload saved configuration",
  conflict:
    "This plugin changed elsewhere. Reload before continuing. Reloading discards unsaved changes.",
  failed: "The request failed. Check the plugin and try again.",
  loadFailed: "Plugins could not be loaded. Try refreshing.",
  enabledNotice: "Plugin enabled for this Bot.",
  disabledNotice: "Plugin disabled for this Bot.",
  testSuccess: "Plugin configuration test passed.",
  testFailed: "Plugin configuration test failed. Check the saved configuration.",
  disable: "Disable",
  enable: "Enable",
  test: "Test saved configuration",
  reviewHint:
    "The configuration declaration changed. Review the plugin and save its configuration to confirm the new declaration before enabling or testing it.",
  runtimeError: "The plugin could not start. Check its configuration and retry.",
  savedTestHint:
    "Enabling and tests use the saved configuration. Save changes first. Tests run the plugin’s check when available; they may not verify an upstream connection.",
  installName: "Install {{name}}",
  repository: "GitHub repository URL",
  repositoryHint:
    "Use https://github.com/owner/repository without a branch, query, or credentials.",
  commit: "Full commit SHA",
  commitHint: "Enter the exact 40-character commit SHA of code you have reviewed.",
  invalidSource: "Enter a canonical GitHub repository URL and a full 40-character commit SHA.",
  invalidCommit: "Enter a full 40-character commit SHA.",
  trustNotice:
    "Plugins run with the server process permissions and can access its files, network, and secrets. Install only code you have reviewed and trust.",
  trustConfirm: "I have reviewed this code and trust it with server access.",
  cancel: "Cancel",
  login: {
    button: "Sign in with QR code",
    title: "Sign in to the platform",
    description:
      "Scan with the platform’s phone app and confirm sign-in. The server automatically encrypts and saves the Cookie for the selected Bot. Closing this window cannot undo a save that has already started.",
    draftHint:
      "Save or undo your configuration changes before signing in. Configuration editing is locked while this dialog is open.",
    qrAlt: "Platform sign-in QR code",
    account: "Connected account: {{name}}",
    retry: "Get a new QR code",
    close: "Close",
    status: {
      starting: "Preparing QR code…",
      waiting: "Waiting for you to scan and confirm…",
      scanned: "Scanned. Confirm sign-in in the phone app…",
      saving: "Saving sign-in details… Closing this window will not cancel the save.",
      save_unknown:
        "The save result could not be confirmed. Close this dialog and reload the saved configuration before trying again.",
      connected: "Connected. Credentials have been saved for this Bot.",
      expired: "This QR code has expired. Request a new one to continue.",
      cancelled: "Sign-in cancelled.",
      failed: "Sign-in could not be completed. Try again.",
      conflict:
        "Configuration changed during sign-in. Close this dialog and reload the saved configuration before trying again.",
    },
  },
  installing: "Installing…",
  installation: "Installation and versions",
  updateHint:
    "Updating or rolling back stops ongoing plugin calls. If the configuration declaration changes, each Bot must review and save its configuration again.",
  updateCommit: "New commit SHA",
  update: "Update to this commit",
  rollback: "Roll back to previous commit",
  previousCommit: "Previous: {{commit}}",
  remove: "Uninstall",
  removeTitle: "Uninstall {{name}}?",
  removeHint:
    "This disables and uninstalls the plugin for all Bots. Saved Bot configurations are retained.",
  confirmRemove: "Confirm uninstall",
  status: {
    disabled: "Disabled",
    ready: "Ready",
    needs_review: "Needs review",
    error: "Error",
  },
  jobs: {
    title: "Transcription jobs",
    description: "Up to 50 recent jobs for this Bot. Results remain available for 24 hours.",
    refresh: "Refresh jobs",
    failed: "Jobs could not be updated. Try refreshing.",
    unavailable:
      "Enable and save the transcription configuration to view results. You can still cancel jobs.",
    empty: "No transcription jobs yet. Start one from the Bot conversation.",
    resource: "Part {{part}} · {{duration}}",
    jobId: "Job {{id}}",
    cancel: "Cancel job",
    cancelling: "Cancelling…",
    view: "View transcript",
    jobFailed: "The job stopped or failed. Review its configuration before starting a new job.",
    transcript: "Transcript",
    asrNotice: "AI transcription may contain errors. Check the source before relying on it.",
    expires: "Available until {{date}}",
    noticeFailed: "The Bot notification was not delivered. You can retrieve the result here.",
    keyword: "Keyword",
    search: "Search transcript",
    transcriptFailed:
      "The transcript could not be loaded or exported. It may have expired or its configuration changed.",
    page: "Showing {{start}}–{{end}} of {{total}} cues",
    noMatches: "No transcript cues found.",
    truncated:
      "This preview is limited to 40 cues and 4,000 characters. Authorized exports include the full transcript.",
    previous: "Previous page",
    next: "Next page",
    rights: "I have the right to process and download this job’s transcript.",
    download: "Download {{format}}",
    exportDisabled: "Transcript downloads are disabled in this Bot’s configuration.",
    status: {
      queued: "Queued",
      pending_confirmation: "Awaiting administrator confirmation",
      expired: "Confirmation expired",
      downloading: "Downloading",
      converting: "Converting",
      transcribing: "Transcribing",
      completed: "Completed",
      failed: "Failed",
      cancelled: "Cancelled",
    },
    cloudCancellation: "Local waiting stopped; the cloud task may continue and incur charges.",
  },
  ytdlp: {
    startTitle: "Start with video summaries",
    startAnonymous:
      "Leave Cookies empty, keep video downloads off, and keep the other defaults. Add Cookies later if the site asks you to sign in.",
    startSave:
      "Choose “Save configuration” at the bottom, then “Enable” above. Save any later changes before they take effect.",
    startTry: "Send this Bot a link to an individual video and ask it to summarize the video.",
    subtitleHint:
      "Content summaries need accessible subtitles. Without them, the plugin can only read details such as the title and description; it does not automatically transcribe audio.",
    testHint:
      "“Test saved configuration” only checks whether the plugin can start. It does not contact YouTube or validate Cookies. Try a video link to check actual access.",
    cookiesHelpTitle: "How do I add Cookies when sign-in is needed?",
    cookiesExport:
      "Sign in to the site in your own browser. Use a Cookie export tool that supports Netscape format to export only that site’s cookies.txt. For YouTube, follow the official guide below.",
    cookiesPaste:
      "Open cookies.txt in a text editor and paste its contents above, preserving line breaks and tabs. The first line is usually # Netscape HTTP Cookie File. Do not enter a file path or a single-line Cookie request header.",
    cookiesSave:
      "Choose “Save configuration”. The field clears after saving; this is expected. “A secret is saved” confirms it was stored. Leaving the field empty keeps it.",
    cookiesPrivacy:
      "Cookies are sign-in credentials; do not send them in chat. They are encrypted per Bot and used only for matching site domains, up to 16,384 characters. Site rate limits and bot checks may still prevent access.",
    cookiesGuide: "Read yt-dlp’s official YouTube Cookie export guide",
    fields: {
      cookies: {
        label: "Site Cookies (optional)",
        description:
          "Paste Netscape-format Cookies when a video requires sign-in. Without saved Cookies, access is anonymous. Leave this empty to keep any saved Cookies.",
      },
      downloadEnabled: {
        label: "Allow video downloads and Telegram delivery",
        description:
          "Enable this to receive video files when an administrator explicitly requests a download. The server needs the media conversion service. The limits below apply only to file downloads, not subtitle summaries.",
      },
      downloadMaxSeconds: {
        label: "Maximum video duration (seconds)",
        description: "Default: {{value}} seconds. Longer videos are rejected, not trimmed.",
      },
      downloadMaxMb: {
        label: "Maximum video file size (MB)",
        description:
          "Default: {{value}} MB. Telegram’s 50 MB upload limit still applies even if you enter a larger value.",
      },
      downloadCacheMinutes: {
        label: "Keep videos on the server for (minutes)",
        description:
          "Default: {{value}} minutes. Expiry removes only the server copy; files already sent to Telegram are unaffected.",
      },
      downloadCacheMb: {
        label: "Video cache space (MB)",
        description:
          "Default: {{value}} MB for downloads and merging, shared with Bilibili downloads. Allow at least twice the effective file size limit plus 1 MiB.",
      },
      downloadMinFreeMb: {
        label: "Minimum free server disk space (MB)",
        description:
          "Default: {{value}} MB. Downloads are rejected when space is insufficient, to avoid filling the disk.",
      },
      downloadDailyJobs: {
        label: "Daily downloads per administrator",
        description:
          "Default: {{value}}. Counted per Bot and user, sharing the daily quota with Bilibili downloads.",
      },
    },
  },
  config: {
    empty: "This plugin has no configuration fields.",
    draftHint:
      "You can save a draft. Required fields must be configured before enabling the plugin.",
    required: "Required to enable",
    choose: "Choose an option",
    secretConfigured: "A secret is saved. Leave the input empty to keep it.",
    secretMissing: "No secret is saved.",
    clearSecret: "Clear saved secret",
    undoClearSecret: "Cancel clearing",
    secretClearing: "The saved secret will be cleared when you save.",
    invalidValue: "Enter a valid value for this field.",
    invalidNumber: "Enter a valid number.",
    resetDefault: "Saving an empty value resets this field to its default: {{value}}.",
    save: "Save configuration",
    saving: "Saving…",
    saved: "Configuration saved.",
    saveFailed: "Configuration could not be saved. Your changes are kept; try again.",
  },
} as const;
