export type Dictionary = {
  productName: string
  artifacts: {
    outputs: string
    empty: string
    open: string
    copy: string
    copied: string
    copyFailed: string
    download: string
    close: string
    loading: string
    loadFailed: string
    unavailable: string
    missing: string
    missingDetail: string
    downloadFailed: string
    audio: string
    video: string
    retry: string
    unsupported: string
    fileTooLarge: string
    textTooLarge: string
    preview: string
    source: string
    htmlView: string
    htmlPreviewTitle: string
    pdfPreviewTitle: string
    csvTruncated: string
    viewerLabel: string
  }
  activity: {
    title: string
    unread: string
    needsAttention: string
    earlier: string
    emptyAttention: string
    emptyEarlier: string
    open: string
    markAllRead: string
    unavailable: string
    resolved: string
    agentFallback: string
    sessionFallback: string
    runFinished: string
    runFailed: string
    inputRequested: string
    agentReady: string
    activationFailed: string
    routineNotice: string
    urgentNotice: string
    dismiss: string
    settings: string
    browserNotifications: string
    liveTab: string
    notConfigured: string
    permissionDefault: string
    permissionGranted: string
    permissionDenied: string
    unsupported: string
    activeSessionOnly: string
    activityUnavailable: string
    connectionError: string
    completion: string
    failure: string
    input: string
  }
  workspace: {
    agents: string
    sessions: string
    agentDetails: string
    recentSessions: string
    manageAgents: string
    conversation: string
    resizeArtifact: string
    fixtureLabel: string
  }
  mobileNavigation: {
    backToAgents: string
    searchAgents: string
    searchSessions: string
    openSessions: string
    history: string
    preferences: string
    clearSearch: string
    noSearchResults: string
    removeOpenSession: string
    selected: string
    lastSelected: string
  }
  actions: {
    newAgent: string
    newSession: string
    openAgents: string
    openAgentDetails: string
    closePanel: string
    closeSession: string
    closeTab: string
    sessionActions: string
    undo: string
    tabClosed: string
    openSession: string
    showAgentDetails: string
    hideAgentDetails: string
    switchToEnglish: string
    switchToHebrew: string
  }
  appearance: {
    label: string
    light: string
    system: string
    dark: string
  }
  status: {
    active: string
    unknown: string
    label: string
    idle: string
    running: string
    attention: string
    waitingForInput: string
    failed: string
    unread: string
  }
  /** Localized copy for the normalized `AOS_*` run failure codes. */
  runErrors: {
    AOS_RECONNECT_EXHAUSTED: string
    AOS_CONNECTION_INTERRUPTED: string
    AOS_SEND_UNCERTAIN: string
    AOS_INTERACTION_UNCERTAIN: string
    AOS_INTERACTION_FAILED: string
    AOS_INTERACTION_EXPIRED: string
    AOS_PROVIDER_RUN_FAILED: string
    AOS_PROVIDER_AGENT_UNAVAILABLE: string
    AOS_PROVIDER_BILLING_FAILED: string
    AOS_PROVIDER_RETRYABLE_FAILURE: string
    AOS_PROVIDER_UNAVAILABLE: string
    AOS_SESSION_BUSY: string
    AOS_RESET_REQUIRED: string
    AOS_STOP_UNCERTAIN: string
    AOS_STREAM_OVERFLOW: string
    AOS_COMMAND_WITH_ATTACHMENTS: string
    AOS_REWIND_CONFLICT: string
    // Generic codes the guest boundary substitutes for a private failure.
    temporarily_unavailable: string
    rate_limited: string
    request_failed: string
  }
  /**
   * The System Notice headline a failed turn falls back to when neither a
   * normalized code nor provider text named the failure.
   */
  turnFailed: string
  empty: {
    addAgentTitle: string
    addAgentDescription: string
    noAgentSelected: string
    noAgents: string
    noSessions: string
    agentBuilderUnavailable: string
  }
  agentManagement: {
    description: string
    showInWorkspace: string
    managedByProvider: string
    shownInWorkspace: string
    hiddenFromWorkspace: string
    loading: string
    loadFailed: string
    updateFailed: string
    providerActive: string
    pendingReload: string
    retry: string
  }
  accessibility: {
    selectedAgent: string
    skipToConversation: string
  }
}
