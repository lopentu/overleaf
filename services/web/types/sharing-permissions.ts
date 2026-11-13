// Public sharing policy persisted by the Subscription schema.
export type SharingPermissions = {
  byEmail: 'anyone_in_x' | 'anyone'
  byLinkSharing: 'no_one' | 'anyone_in_x' | 'anyone'
}
