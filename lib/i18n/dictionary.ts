export type Dictionary = {
  productName: string
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
    fixtureLabel: string
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
    retryAgentDraft: string
    deleteAgentDraft: string
  }
  appearance: {
    label: string
    light: string
    system: string
    dark: string
  }
  agentDraft: {
    interview: string
    startFailed: string
    activating: string
    activationFailed: string
    deleteTitle: string
    deleteDescription: string
    deleteConfirm: string
    deleteCancel: string
  }
  status: {
    label: string
    idle: string
    running: string
    attention: string
    waitingForInput: string
    failed: string
  }
  empty: {
    addAgentTitle: string
    addAgentDescription: string
    noAgentSelected: string
    noAgents: string
    noSessions: string
    agentBuilderUnavailable: string
    conversationTitle: string
    conversationDescription: string
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
