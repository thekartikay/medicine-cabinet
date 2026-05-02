import { signOut } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { auth } from '../lib/firebase'

interface Props {
  user: User
}

export function Welcome({ user }: Props) {
  const displayName = user.displayName ?? user.phoneNumber ?? 'there'

  return (
    <div className="welcome-root">
      <div className="welcome-card">
        <div className="signin-logo" aria-hidden="true">💊</div>
        <h1 className="welcome-title">Welcome, {displayName}!</h1>
        <p className="welcome-sub">MediCab is ready.</p>
        <button className="btn btn-secondary" onClick={() => signOut(auth)}>
          Sign out
        </button>
      </div>
    </div>
  )
}
