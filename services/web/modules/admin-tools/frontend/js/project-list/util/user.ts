import { UserRef } from '../../../../types/project/api'
export function getUserName(user: UserRef | null | undefined) {
  if (!user) return '[N/A]'

  const { firstName, lastName, email } = user
  if (firstName || lastName) {
    return [firstName, lastName].filter(n => n != null).join(' ')
  }
  if (email) {
    return email
  }

  return '[Noname]'
}
