interface Props {
  onCreate: () => void
  onJoin: () => void
}

// Shown to a signed-in user whose Firestore /users/{uid} document has no
// householdId. Two equally-weighted options: create a new household (→ admin)
// or join an existing one with the 6-digit code (→ member).
export function ChoosePath({ onCreate, onJoin }: Props) {
  return (
    <div className="si-root">
      <div className="si-hero">
        <div className="si-icon-circle" aria-hidden="true">
          <SparkleIcon />
        </div>
        <h1 className="si-app-name">MediCab</h1>
        <p className="si-app-sub">Welcome — let's get you set up</p>
      </div>

      <div className="si-panel">
        <h2 className="si-panel-title">How will you use MediCab?</h2>

        <button
          type="button"
          className="si-pill-btn"
          onClick={onCreate}
        >
          <span className="si-pill-icon-wrap si-pill-icon--phone">
            <HouseIcon />
          </span>
          <span className="si-pill-label">
            Create a household
            <span className="si-pill-sub">I'm setting up for my family</span>
          </span>
          <span className="si-pill-chevron" aria-hidden="true">›</span>
        </button>

        <button
          type="button"
          className="si-pill-btn"
          onClick={onJoin}
        >
          <span className="si-pill-icon-wrap si-pill-icon--google">
            <KeyIcon />
          </span>
          <span className="si-pill-label">
            Join with a code
            <span className="si-pill-sub">Someone already invited me</span>
          </span>
          <span className="si-pill-chevron" aria-hidden="true">›</span>
        </button>

        <p className="si-footer">🔒 Secure Encrypted Access</p>
      </div>
    </div>
  )
}

function SparkleIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3l2.4 5.6L20 11l-5.6 2.4L12 19l-2.4-5.6L4 11l5.6-2.4L12 3z"
        fill="#0D9488" />
    </svg>
  )
}

function HouseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
        stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="9,22 9,12 15,12 15,22"
        stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function KeyIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"
        stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
