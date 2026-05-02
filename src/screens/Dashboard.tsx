import { signOut } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { auth } from '../lib/firebase'

interface Props {
  user: User
  household: { hId: string; name: string }
}

export function Dashboard({ user, household }: Props) {
  const displayName = user.displayName ?? user.phoneNumber ?? 'there'

  return (
    <div className="db-root">
      <header className="db-header">
        <span className="db-logo" aria-hidden="true">💊</span>
        <span className="db-brand">MediCab</span>
        <button className="db-signout btn-secondary" onClick={() => signOut(auth)}>
          Sign out
        </button>
      </header>

      <main className="db-main">
        <p className="db-eyebrow">Welcome to</p>
        <h1 className="db-household">{household.name}</h1>
        <p className="db-user">Signed in as {displayName}</p>
        <div className="db-placeholder">
          <p>Dashboard coming soon.</p>
        </div>
      </main>
    </div>
  )
}
