// Reimagined · Cabinet tab (AK-197). Real, Firestore-backed screens replacing
// the Phase-1 placeholder. Navigation between the grouped list (Cabinet) and a
// single medicine (MedDetail) is local state — no router needed.

import { useState } from 'react'
import { Cabinet } from './Cabinet'
import { MedDetail } from './MedDetail'

export function CabinetScreen() {
  const [selectedTrackedId, setSelectedTrackedId] = useState<string | null>(null)

  if (selectedTrackedId) {
    return <MedDetail trackedId={selectedTrackedId} onBack={() => setSelectedTrackedId(null)} />
  }
  return <Cabinet onSelect={setSelectedTrackedId} />
}
