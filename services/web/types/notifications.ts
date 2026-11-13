type GlobalNotificationPreferences = {
  muteAllNotifications: boolean
}

export type UserNotificationPreferences = {
  newsletter: boolean
} & GlobalNotificationPreferences

// Comment and tracked-change preferences for an individual project. These are
// independent from the user's newsletter subscription.
export type NotificationPreferencesSchema = {
  commentOnOwnProject: boolean
  commentOnInvitedProject: boolean
  repliesOnAuthoredThread: boolean
  repliesOnParticipatingThread: boolean
  mentionsInThread: boolean
  commentResolvedOnAuthoredThread: boolean
  commentResolvedOnParticipatingThread: boolean
  commentReopenedOnAuthoredThread: boolean
  commentReopenedOnParticipatingThread: boolean
  trackedChangesOnOwnProject: boolean
  trackedChangesOnInvitedProject: boolean
  trackChangesAcceptedOnAuthoredChange: boolean
  trackChangesRejectedOnAuthoredChange: boolean
}

export type GlobalNotificationPreferencesSchema =
  NotificationPreferencesSchema & GlobalNotificationPreferences
